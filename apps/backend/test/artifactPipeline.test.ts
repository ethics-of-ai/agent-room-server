import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildServer } from "../src/server";
import type { ServiceConfig } from "../src/domain/models";
import type { AgentRunner, AgentRunnerEvent, AgentRunnerInput } from "../src/runner/AgentRunner";

const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-artifact-pipeline-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  };
};

// Streams prose interleaved with a single SVG artifact whose open tag and close
// marker are both split across deltas, exercising the parser's carry handling
// through the real server, event bus, and routes.
function fakeArtifactRunner(): AgentRunner {
  const deltas = [
    "Here is a diagram:\n",
    '<artifact kind="svg" tit',
    'le="Flow"><svg><rect/>',
    "</svg></arti",
    "fact> all done."
  ];
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
      const codex = { method: "item/agentMessage/delta", threadId: "thread-1", turnId: input.runId };
      for (const message of deltas) {
        yield { type: "agent_update", message, codex };
      }
      yield { type: "run_succeeded", message: "Sketch complete." };
    },
    async cancel() {}
  };
}

// Delivers the artifact only in the terminal run_succeeded message, with no
// streamed assistant deltas — exercises the terminal-message recovery path.
function terminalOnlyArtifactRunner(): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(): AsyncIterable<AgentRunnerEvent> {
      yield {
        type: "run_succeeded",
        message: 'Here is a diagram:\n<artifact kind="svg" title="Flow"><svg><rect/></svg></artifact> all done.'
      };
    },
    async cancel() {}
  };
}

// Streams an artifact open + body, then throws mid-stream without a terminal
// event — exercises the thrown-generator finalize path.
function throwingArtifactRunner(): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    // eslint-disable-next-line require-yield
    async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
      const codex = { method: "item/agentMessage/delta", threadId: "thread-1", turnId: input.runId };
      yield { type: "agent_update", message: '<artifact kind="svg"><svg><rect/>', codex };
      throw new Error("runner crashed mid-sketch");
    },
    async cancel() {}
  };
}

async function waitForEvent(
  app: Awaited<ReturnType<typeof buildServer>>["app"],
  type: string,
  timeoutMs = 2000
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const logs = await app.inject({ method: "GET", url: "/api/logs" });
    const events = logs.json().events as Array<{ type: string; payload: Record<string, unknown> }>;
    if (events.some((event) => event.type === type)) return events;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("artifact sketch pipeline", () => {
  it("splits a streamed artifact into coding_artifact_* events and keeps it out of the transcript", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-artifact-workspace-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: fakeArtifactRunner() } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id, title: "Sketch" }
    });
    const sessionId = session.json().session.id;

    const turn = await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "draw a flow" }
    });
    expect(turn.statusCode).toBe(202);
    const turnId = turn.json().turn.id;
    const events = await waitForEvent(app, "coding_turn_completed");

    const started = events.find((event) => event.type === "coding_artifact_started");
    expect(started?.payload).toMatchObject({ turnId, kind: "svg", title: "Flow", runnerKind: "codex" });
    const artifactId = started?.payload.artifactId as string;
    expect(artifactId).toBeTruthy();

    const deltaBodies = events
      .filter((event) => event.type === "coding_artifact_delta" && event.payload.artifactId === artifactId)
      .map((event) => event.payload.delta as string)
      .join("");
    expect(deltaBodies).toBe("<svg><rect/></svg>");

    const completed = events.find((event) => event.type === "coding_artifact_completed");
    expect(completed?.payload).toMatchObject({ artifactId, bytes: 18 });

    // Assistant transcript carries only the prose, not the artifact source.
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const assistant = (messages.json().messages as Array<{ role: string; content: string }>)
      .find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Here is a diagram:\n all done.");
    expect(assistant?.content).not.toContain("<svg");
    expect(assistant?.content).not.toContain("<artifact");

    // Reconnect snapshot returns the accumulated, settled artifact.
    const artifacts = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/artifacts` });
    expect(artifacts.statusCode).toBe(200);
    expect(artifacts.json().artifacts).toEqual([
      expect.objectContaining({
        id: artifactId,
        sessionId,
        turnId,
        kind: "svg",
        title: "Flow",
        content: "<svg><rect/></svg>",
        isOpen: false,
        truncated: false
      })
    ]);

    await app.close();
  });

  it("recovers an artifact delivered only in the terminal message", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-artifact-workspace-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: terminalOnlyArtifactRunner() } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const sessionId = session.json().session.id;

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "draw" } });
    const events = await waitForEvent(app, "coding_turn_completed");

    // The artifact is published even though it never streamed as deltas.
    expect(events.some((event) => event.type === "coding_artifact_started")).toBe(true);
    expect(events.some((event) => event.type === "coding_artifact_completed")).toBe(true);

    // Transcript keeps only the prose, not the raw artifact markup.
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const assistant = (messages.json().messages as Array<{ role: string; content: string }>)
      .find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("Here is a diagram:\n all done.");
    expect(assistant?.content).not.toContain("<svg");

    const artifacts = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/artifacts` });
    expect(artifacts.json().artifacts).toHaveLength(1);
    expect(artifacts.json().artifacts[0]).toMatchObject({ kind: "svg", content: "<svg><rect/></svg>", isOpen: false });

    await app.close();
  });

  it("settles an in-flight artifact when the runner throws mid-stream", async () => {
    const serviceConfig = await config();
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-artifact-workspace-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: throwingArtifactRunner() } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const sessionId = session.json().session.id;

    await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "draw" } });
    const events = await waitForEvent(app, "coding_turn_failed");

    // The dangling artifact is completed (clearing the client's streaming spinner)
    // rather than left open forever, even though no terminal event arrived.
    expect(events.some((event) => event.type === "coding_artifact_started")).toBe(true);
    expect(events.some((event) => event.type === "coding_artifact_completed")).toBe(true);

    const artifacts = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/artifacts` });
    expect(artifacts.json().artifacts[0]).toMatchObject({ content: "<svg><rect/>", isOpen: false });

    await app.close();
  });

  it("requires bearer auth for artifact and message reads when AUTH_TOKEN is set", async () => {
    const serviceConfig = await config({ requireAuth: true, authToken: "secret-token" });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-artifact-workspace-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: fakeArtifactRunner() } });
    const auth = { authorization: "Bearer secret-token" };
    const registered = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: auth,
      payload: { path: selectedDirectory }
    });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      headers: auth,
      payload: { workspaceId: registered.json().workspace.id }
    });
    const sessionId = session.json().session.id;

    expect((await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/artifacts` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/artifacts`, headers: auth })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages`, headers: auth })).statusCode
    ).toBe(200);

    await app.close();
  });

  it("returns an empty artifact list and skips artifact events when disabled", async () => {
    const serviceConfig = await config({ artifactsEnabled: false });
    const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-artifact-workspace-"));
    const { app } = await buildServer({ config: serviceConfig, runners: { codex: fakeArtifactRunner() } });
    const registered = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: selectedDirectory } });
    const session = await app.inject({
      method: "POST",
      url: "/api/agent-sessions",
      payload: { workspaceId: registered.json().workspace.id }
    });
    const sessionId = session.json().session.id;

    await app.inject({
      method: "POST",
      url: `/api/agent-sessions/${sessionId}/turns`,
      payload: { message: "draw a flow" }
    });
    const events = await waitForEvent(app, "coding_turn_completed");
    expect(events.some((event) => event.type.startsWith("coding_artifact_"))).toBe(false);

    // With artifacts disabled the raw markup stays in the assistant transcript.
    const messages = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/messages` });
    const assistant = (messages.json().messages as Array<{ role: string; content: string }>)
      .find((message) => message.role === "assistant");
    expect(assistant?.content).toContain("<svg><rect/></svg>");

    const artifacts = await app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/artifacts` });
    expect(artifacts.json().artifacts).toEqual([]);

    await app.close();
  });
});
