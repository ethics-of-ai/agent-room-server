import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerRunner } from "../src/runner/codex/CodexAppServerRunner";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-codex-runner-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: ["-e", "process.exit(7)", "--", "--token=super-secret"],
    codexRunnerProtocol: "exec",
    ...overrides
  };
};

describe("CodexAppServerRunner", () => {
  it("emits safe structured audit events around process execution", async () => {
    const serviceConfig = await config();
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "run-1",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Do work"
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({
      type: "runner_audit",
      audit: expect.objectContaining({
        phase: "started",
        runnerKind: "codex",
        runId: "run-1",
        command: {
          executableName: basename(process.execPath),
          argsCount: 4
        }
      })
    });
    expect(events).toContainEqual({
      type: "runner_audit",
      audit: expect.objectContaining({
        phase: "completed",
        status: "failed",
        exitStatus: {
          code: 7,
          signal: null
        },
        durationMs: expect.any(Number),
        failureCategory: "process_exit"
      })
    });
    expect(JSON.stringify(events)).not.toContain("super-secret");
  });

  it("passes configured reasoning effort to Codex without auditing the value", async () => {
    const serviceConfig = await config({
      codexReasoningEffort: "high",
      codexArgs: ["-e", "console.log(process.argv.slice(2).join(' '))", "--"]
    });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "run-reasoning",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Do work"
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "agent_update",
      message: expect.stringContaining("model_reasoning_effort=high")
    });
    expect(events[0]).toEqual({
      type: "runner_audit",
      audit: expect.objectContaining({
        command: {
          executableName: basename(process.execPath),
          argsCount: 5
        }
      })
    });
    expect(JSON.stringify(events.filter((event) => event.type === "runner_audit"))).not.toContain("high");
  });

  it("does not duplicate a reasoning effort already present in Codex args", async () => {
    const serviceConfig = await config({
      codexReasoningEffort: "high",
      codexArgs: [
        "-e",
        "console.log(process.argv.slice(2).join(' '))",
        "--",
        "-c",
        "model_reasoning_effort=xhigh"
      ]
    });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "run-existing-reasoning",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Do work"
    })) {
      events.push(event);
    }

    const output = events.find((event) => event.type === "agent_update")?.message ?? "";
    expect(output).toContain("model_reasoning_effort=xhigh");
    expect(output).not.toContain("model_reasoning_effort=high");
  });

  it("extracts assistant text from Codex exec JSON output without surfacing metadata", async () => {
    const serviceConfig = await config({
      codexArgs: [
        "-e",
        `
          console.log(JSON.stringify({ type: "thread.started", threadId: "thread-1", cwd: "/tmp/workspace", model: "gpt-test" }));
          console.log(JSON.stringify({ type: "agent_message_content_delta", delta: "Only " }));
          console.log(JSON.stringify({ type: "agent_message_content_delta", delta: "the response." }));
          console.log(JSON.stringify({ type: "task_complete", last_agent_message: "Only the response.", usage: { total_tokens: 42 } }));
        `,
        "--",
        "exec",
        "--json"
      ]
    });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "run-json",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Do work"
    })) {
      events.push(event);
    }

    const updates = events.filter((event) => event.type === "agent_update");
    expect(updates).toEqual([
      { type: "agent_update", message: "Only " },
      { type: "agent_update", message: "the response." }
    ]);
    expect(JSON.stringify(updates)).not.toContain("thread.started");
    expect(JSON.stringify(updates)).not.toContain("total_tokens");
  });

  it("extracts assistant text from Codex text output without surfacing terminal metadata", async () => {
    const serviceConfig = await config({ codexArgs: ["exec"] });
    const fakeCodex = join(serviceConfig.workspaceRoot, "codex");
    const transcript = [
      "Reading prompt from stdin...",
      "OpenAI Codex v0.130.0",
      "--------",
      "workdir: /Users/example/repos/agent-room",
      "model: gpt-5.5",
      "provider: openai",
      "Instructions say WHAT, not HOW. \"Add X\" or \"Fix Y\" doesn't mean skip workflows.",
      "",
      "codex",
      "Hey. What do you want to work on in `agent-room`?",
      "",
      "tokens used",
      "17,817",
      "Hey. What do you want to work on in `agent-room`?"
    ].join("\n");
    await writeFile(fakeCodex, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(transcript)});
`);
    await chmod(fakeCodex, 0o755);
    const runner = new CodexAppServerRunner({
      ...serviceConfig,
      codexExecutable: fakeCodex
    });
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "run-text",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Do work"
    })) {
      events.push(event);
    }

    const output = events
      .filter((event) => event.type === "agent_update")
      .map((event) => event.message)
      .join("");

    expect(output.trim()).toBe("Hey. What do you want to work on in `agent-room`?");
    expect(output).not.toContain("Reading prompt from stdin");
    expect(output).not.toContain("workdir:");
    expect(output).not.toContain("model:");
    expect(output).not.toContain("tokens used");
    expect(output).not.toContain("Instructions say WHAT");
  });

  it("survives the Codex process exiting before the prompt is written", async () => {
    const serviceConfig = await config({
      codexArgs: ["-e", "process.exit(0)"]
    });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "run-early-exit",
      workspacePath: serviceConfig.workspaceRoot,
      // Far larger than the OS pipe buffer, so the child is guaranteed to die
      // with the prompt still in flight; the resulting stdin EPIPE must be
      // absorbed instead of crashing the backend as an unhandled stream error.
      prompt: "x".repeat(1024 * 1024)
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "run_succeeded",
      message: "Codex process exited successfully"
    });
  });

  it("marks signal termination as a failed audit completion", async () => {
    const serviceConfig = await config({
      codexArgs: ["-e", "console.log('ready'); setInterval(() => {}, 1000)"]
    });
    const runner = new CodexAppServerRunner(serviceConfig);
    const events: AgentRunnerEvent[] = [];

    for await (const event of runner.run({
      runId: "run-signal",
      workspacePath: serviceConfig.workspaceRoot,
      prompt: "Do work"
    })) {
      events.push(event);
      if (event.type === "agent_update" && event.message.includes("ready")) {
        await runner.cancel("run-signal");
      }
    }

    expect(events).toContainEqual({
      type: "runner_audit",
      audit: expect.objectContaining({
        phase: "completed",
        status: "failed",
        exitStatus: {
          code: null,
          signal: "SIGTERM"
        },
        failureCategory: "process_signal"
      })
    });
  });
});
