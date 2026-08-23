import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import { CodexAppServerRunner } from "../src/runner/codex/CodexAppServerRunner";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-coding-agent-settings-"));
  const workspaceRoot = join(root, "workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot,
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: [],
    codexRunnerProtocol: "jsonrpc",
    ...overrides
  };
};

describe("coding agent settings", () => {
  it("exposes Codex model, intelligence, and speed choices from the runner", async () => {
    const fakeServer = await writeSettingsCodexAppServer();
    const serviceConfig = await config({ codexExecutable: fakeServer.path, codexArgs: [] });
    const { app } = await buildServer({ config: serviceConfig });

    const response = await app.inject({ method: "GET", url: "/api/coding-agent/capabilities" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      runnerKind: "codex",
      settings: {
        models: [
          {
            id: "gpt-fast",
            label: "GPT Fast",
            description: "Fast local fake model",
            contextWindowTokens: 128000,
            isDefault: true,
            reasoningEfforts: [
              { id: "minimal", label: "Minimal", description: "Minimal reasoning" },
              { id: "high", label: "High", description: "High reasoning" }
            ],
            defaultReasoningEffort: "minimal",
            serviceTiers: [
              { id: "standard", label: "Standard", description: "Standard Codex speed" },
              { id: "fast", label: "Fast", description: "1.5x speed, increased usage" }
            ],
            defaultServiceTier: "standard"
          },
          {
            id: "gpt-deep",
            label: "GPT Deep",
            description: "Deeper fake model",
            contextWindowTokens: 200000,
            isDefault: false,
            reasoningEfforts: [
              { id: "medium", label: "Medium", description: "Medium reasoning" },
              { id: "xhigh", label: "Xhigh", description: "Extra high reasoning" }
            ],
            defaultReasoningEffort: "medium",
            serviceTiers: [
              { id: "standard", label: "Standard", description: "Standard Codex speed" }
            ],
            defaultServiceTier: "standard"
          }
        ],
        defaultSettings: {
          model: "gpt-fast",
          reasoningEffort: "minimal",
          serviceTier: "standard"
        }
      }
    });

    await app.close();
  });

  it("passes selected settings to Codex JSON-RPC turns", async () => {
    const fakeServer = await writeSettingsCodexAppServer();
    const serviceConfig = await config({ codexArgs: [fakeServer.path, fakeServer.logPath] });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "agentroom-turn-settings",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Use selected settings",
      settings: {
        model: "gpt-deep",
        reasoningEffort: "xhigh",
        serviceTier: "fast"
      }
    } as Parameters<CodexAppServerRunner["run"]>[0] & {
      settings: { model: string; reasoningEffort: string; serviceTier: string };
    })) {
      events.push(event);
    }

    const messages = (await readFile(fakeServer.logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const threadStart = messages.find((message) => message.method === "thread/start");
    const turnStart = messages.find((message) => message.method === "turn/start");

    expect(threadStart?.params).toMatchObject({
      model: "gpt-deep",
      serviceTier: "fast"
    });
    expect(turnStart?.params).toMatchObject({
      model: "gpt-deep",
      effort: "xhigh",
      serviceTier: "fast"
    });
    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex app-server turn completed"
    });

    await runner.dispose();
  });

  it("uses configured Codex JSON-RPC args when reading capabilities", async () => {
    const fakeServer = await writeSettingsCodexAppServer();
    const serviceConfig = await config({ codexArgs: [fakeServer.path, fakeServer.logPath] });
    const runner = new CodexAppServerRunner(serviceConfig);

    const capabilities = await runner.getCapabilities();

    const messages = (await readFile(fakeServer.logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(capabilities.settings.models.map((model) => model.id)).toEqual(["gpt-fast", "gpt-deep"]);
    expect(messages.map((message) => message.method)).toContain("model/list");

    await runner.dispose();
  });

  it("omits the standard speed setting when starting Codex JSON-RPC turns", async () => {
    const fakeServer = await writeSettingsCodexAppServer();
    const serviceConfig = await config({ codexArgs: [fakeServer.path, fakeServer.logPath] });
    const runner = new CodexAppServerRunner(serviceConfig);

    for await (const _event of runner.run({
      runId: "agentroom-turn-standard-speed",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Use standard speed",
      settings: {
        model: "gpt-fast",
        reasoningEffort: "minimal",
        serviceTier: "standard"
      }
    } as Parameters<CodexAppServerRunner["run"]>[0] & {
      settings: { model: string; reasoningEffort: string; serviceTier: string };
    })) {
      // Drain the runner.
    }

    const messages = (await readFile(fakeServer.logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const threadStart = messages.find((message) => message.method === "thread/start");
    const turnStart = messages.find((message) => message.method === "turn/start");

    expect(threadStart?.params).not.toHaveProperty("serviceTier");
    expect(turnStart?.params).not.toHaveProperty("serviceTier");

    await runner.dispose();
  });

  it("bounds Codex capability probes when the model list stalls", async () => {
    const fakeServer = await writeModelListStallingCodexAppServer();
    const serviceConfig = await config({ codexExecutable: fakeServer, codexArgs: [] });
    const runner = new CodexAppServerRunner(serviceConfig);
    const startedAt = performance.now();

    const capabilities = await runner.getCapabilities();

    expect(performance.now() - startedAt).toBeLessThan(3_500);
    expect(capabilities.settings.models).toEqual([]);
    expect(capabilities.error).toBe("Timed out reading Codex model list");

    await runner.dispose();
  });
});

async function writeSettingsCodexAppServer(): Promise<{ path: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-settings-"));
  const path = join(root, "fake-codex-settings.cjs");
  const logPath = join(root, "messages.log");
  await mkdir(root, { recursive: true });
  await writeFile(logPath, "");
  await writeFile(path, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const logPath = process.argv[2] && process.argv[2] !== "app-server" ? process.argv[2] : null;
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function log(message) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-settings",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-settings",
    status,
    items: [],
    error: null
  };
}

function model(input) {
  return {
    id: input.id,
    model: input.id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: input.label,
    description: input.description,
    contextWindowTokens: input.contextWindowTokens,
    hidden: false,
    supportedReasoningEfforts: input.efforts.map((effort) => ({
      reasoningEffort: effort.id,
      description: effort.description
    })),
    defaultReasoningEffort: input.defaultReasoningEffort,
    inputModalities: ["text"],
    supportsPersonality: false,
    additionalSpeedTiers: input.additionalSpeedTiers ?? [],
    serviceTiers: input.serviceTiers,
    isDefault: input.isDefault
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);

  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }

  if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [
          model({
            id: "gpt-fast",
            label: "GPT Fast",
            description: "Fast local fake model",
            contextWindowTokens: 128000,
            efforts: [
              { id: "minimal", description: "Minimal reasoning" },
              { id: "high", description: "High reasoning" }
            ],
            defaultReasoningEffort: "minimal",
            serviceTiers: [
              { id: "priority", name: "Fast", description: "1.5x speed, increased usage" }
            ],
            additionalSpeedTiers: [
              "fast"
            ],
            isDefault: true
          }),
          model({
            id: "gpt-deep",
            label: "GPT Deep",
            description: "Deeper fake model",
            contextWindowTokens: 200000,
            efforts: [
              { id: "medium", description: "Medium reasoning" },
              { id: "xhigh", description: "Extra high reasoning" }
            ],
            defaultReasoningEffort: "medium",
            serviceTiers: [],
            isDefault: false
          })
        ],
        nextCursor: null
      }
    });
    return;
  }

  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: message.params.model ?? "gpt-fast", modelProvider: "openai", serviceTier: message.params.serviceTier ?? null, cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write", reasoningEffort: null } });
    send({ method: "thread/started", params: { thread: thread(), model: message.params.model ?? "gpt-fast", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    return;
  }

  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: turn("inProgress") } });
    send({ method: "turn/started", params: { threadId: "codex-thread-settings", turn: turn("inProgress") } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-settings", turnId: "codex-turn-settings", itemId: "assistant-message-settings", delta: "settings applied" } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-settings", turn: turn("completed") } });
  }
});
`);
  await chmod(path, 0o755);
  return { path, logPath };
}

async function writeModelListStallingCodexAppServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-fake-codex-model-list-stall-"));
  const path = join(root, "fake-codex-model-list-stall.cjs");
  await writeFile(path, `#!/usr/bin/env node
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
  }
});
`);
  await chmod(path, 0o755);
  return path;
}
