import { expect } from "vitest";
import type { AgentRoomEvent } from "../../src/events/eventTypes";
import type { AgentRunner, AgentRunnerInput, AgentRunnerToolSet } from "../../src/runner/AgentRunner";
import { registerExternalRunnerDescriptors, type RunnerDescriptor } from "../../src/runner/registry";
import { buildServer } from "../../src/server";
import type { ServiceConfig } from "../../src/domain/models";
import { config, registerWorkspaceOffline, waitForSession } from "./agentSessionHarness";

/**
 * A fixture runner whose descriptor declares the `sketches` capability, run
 * against a real server, a registered workspace, and one sketch named
 * "Board". Each queued script is one turn and drives the bound tool set the
 * way an adapter would.
 */

export const WRITABLE = "sketch_fixture";
export const READ_ONLY = "sketch_read_only_fixture";
export const UNREADABLE = "sketch_unreadable_fixture";

function descriptor(id: string, posture: RunnerDescriptor["workspaceWritePosture"]): RunnerDescriptor {
  return {
    id,
    displayName: `Fixture ${id}`,
    promptDelivery: "turn",
    turnDiffSource: "runner",
    clarifyingQuestions: { mode: "none" },
    workspaceSkills: { mode: "none" },
    agentTools: { mode: "custom_tools", capabilities: ["plans", "sketches"] },
    ...(posture ? { workspaceWritePosture: posture } : {}),
    skillSourceDirs: [],
    skillInvocationPrefix: "/",
    settingsKeyPrefix: id.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    settings: [],
    restoreStrategy: "native_resume",
    isConfigured: () => true
  };
}

export type Script = (input: AgentRunnerInput) => Promise<void>;
function scriptedRunner(kind: string, scripts: Script[]): AgentRunner & { inputs: AgentRunnerInput[] } {
  const inputs: AgentRunnerInput[] = [];
  return {
    inputs,
    async getCapabilities() {
      return { runnerKind: kind, settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      inputs.push(input);
      await scripts.shift()?.(input);
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {}
  };
}

let callCount = 0;
export function call(tools: AgentRunnerToolSet | undefined, name: string, args: unknown): Promise<string> {
  if (!tools) throw new Error("no tools were bound");
  return tools.binding.invoke({ callId: `call-${callCount++}`, name, arguments: args, signal: new AbortController().signal });
}
export const box = (objectId: string, x = 0) => ({
  op: "create", objectId, kind: "box", size: [0.1, 0.1, 0.1],
  transform: { translation: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
});
export const moveTo = (objectId: string, x: number) => ({
  op: "transform", objectId, transform: { translation: [x, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
});

export async function start(kind: string, scripts: Script[], options: { serviceConfig?: ServiceConfig; workspace?: { id: string; path: string }; sketchName?: string } = {}) {
  registerExternalRunnerDescriptors([
    descriptor(WRITABLE, () => "writable"),
    descriptor(READ_ONLY, () => "read_only"),
    descriptor(UNREADABLE, undefined)
  ]);
  const serviceConfig = options.serviceConfig ?? await config();
  const workspace = options.workspace ?? await registerWorkspaceOffline(serviceConfig);
  const runner = scriptedRunner(kind, scripts);
  const server = await buildServer({ config: serviceConfig, runners: { [kind]: runner } });
  const events: AgentRoomEvent[] = [];
  server.eventBus.subscribe((event) => events.push(event));
  const session = (await server.app.inject({
    method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, runnerKind: kind }
  })).json().session;
  const sketch = (await server.app.inject({
    method: "POST", url: `/api/workspaces/${workspace.id}/sketch`, payload: { name: options.sketchName ?? "Board" }
  })).json().sketch;
  const base = `/api/workspaces/${workspace.id}/sketch`;
  const query = `?path=${encodeURIComponent(sketch.path)}`;
  const human = async (requestId: string, operations: unknown[]) => {
    const current = (await server.app.inject({ method: "GET", url: base + query })).json().sketch;
    const response = await server.app.inject({ method: "POST", url: `${base}/commits${query}`, payload: {
      requestId, baseRevision: current.revision, fileVersion: current.fileVersion, operations
    } });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const read = async () => (await server.app.inject({ method: "GET", url: base + query })).json().sketch;
  const turn = async (message = "work on the board") => {
    const response = await server.app.inject({ method: "POST", url: `/api/agent-sessions/${session.id}/turns`, payload: { message } });
    expect(response.statusCode).toBe(202);
    await waitForSession(server.app, session.id, "idle");
  };
  return { server, runner, events, workspace, session, sketch, path: sketch.path as string, human, read, turn, serviceConfig };
}

