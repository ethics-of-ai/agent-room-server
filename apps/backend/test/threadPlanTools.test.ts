import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { agentToolByLogicalId, allowedAgentToolLogicalIds } from "../src/agentTools/catalog";
import { advertisedAgentTools } from "../src/agentTools/dispatch";
import { advertisedJsonSchema } from "../src/agentTools/jsonSchema";
import { QUESTIONS_ASK_LOGICAL_ID } from "../src/agentTools/questionAsk";
import { agentStartParamsSchema } from "../src/runner/cursor/protocol";
import {
  AGENTROOM_TOOLS_MAX_FRAME_BYTES,
  childToolMessageSchema,
  encodeToolMessage
} from "../src/runner/deepseek/cordis/protocol";
import { buildServer } from "../src/server";
import type { AgentRoomEvent } from "../src/events/eventTypes";
import type { AgentRunner, AgentRunnerInput, AgentRunnerToolSet } from "../src/runner/AgentRunner";
import { registerExternalRunnerDescriptors, type RunnerDescriptor } from "../src/runner/registry";
import { PLAN_LIMITS, type ThreadPlan } from "../src/plans/planModel";
import { planToolInputSchemas, planToolResultSchema } from "../src/plans/planToolContract";
import {
  PLAN_TOOLS_INSTRUCTION,
  PLAN_TOOLS_UNAVAILABLE_RESULT,
  PLAN_TOOL_IDS,
  planToolDefinitions,
  planTurnContext,
  serializePlanToolResult
} from "../src/plans/planTools";
import { ThreadPlanService } from "../src/plans/ThreadPlanService";
import { ThreadPlanTurnTools } from "../src/plans/planTurnTools";
import { config, registerWorkspaceOffline, waitForSession } from "./support/agentSessionHarness";
import { memoryPlanWriter } from "./support/planServiceHarness";

/**
 * Stage 3 of docs/plans/AGENT_PLAN_TOOLS_PLAN.md: the six catalog definitions,
 * the shared instruction and per-turn context, fresh per-turn bindings, the
 * read route, the change event, and required readiness. A fixture runner whose
 * descriptor declares the `plans` capability drives the tools through the
 * bound tool set exactly as an adapter would.
 */

const FIXTURE = "plan_fixture";
const NO_TOOLS_FIXTURE = "no_tools_fixture";

/** A runner whose descriptor declares no AgentRoom tool transport. */
const noToolsDescriptor = (): RunnerDescriptor => fixtureDescriptor({
  id: NO_TOOLS_FIXTURE, displayName: "No-tools fixture", settingsKeyPrefix: "noToolsFixture", agentTools: { mode: "none" }
});

function fixtureDescriptor(overrides: Partial<RunnerDescriptor> = {}): RunnerDescriptor {
  return {
    id: FIXTURE,
    displayName: "Plan fixture",
    promptDelivery: "turn",
    turnDiffSource: "runner",
    clarifyingQuestions: { mode: "none" },
    workspaceSkills: { mode: "none" },
    agentTools: { mode: "custom_tools", capabilities: ["plans"] },
    skillSourceDirs: [],
    skillInvocationPrefix: "/",
    settingsKeyPrefix: "planFixture",
    settings: [],
    restoreStrategy: "native_resume",
    isConfigured: () => true,
    ...overrides
  };
}

type Script = (input: AgentRunnerInput) => Promise<void>;

/** Runs one queued script per turn and records what each turn received. */
function scriptedRunner(scripts: Script[]): AgentRunner & { inputs: AgentRunnerInput[] } {
  const inputs: AgentRunnerInput[] = [];
  return {
    inputs,
    async getCapabilities() {
      return { runnerKind: FIXTURE, settings: { models: [], defaultSettings: {} } };
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
async function call(tools: AgentRunnerToolSet | undefined, name: string, args: unknown): Promise<any> {
  if (!tools) throw new Error("no tools were bound");
  const text = await tools.binding.invoke({ callId: `call-${callCount++}`, name, arguments: args, signal: new AbortController().signal });
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function startServer(runner: AgentRunner, overrides: Parameters<typeof config>[0] = {}) {
  const serviceConfig = await config(overrides);
  const workspace = await registerWorkspaceOffline(serviceConfig);
  const server = await buildServer({ config: serviceConfig, runners: { [FIXTURE]: runner, [NO_TOOLS_FIXTURE]: runner } });
  const events: AgentRoomEvent[] = [];
  server.eventBus.subscribe((event) => events.push(event));
  const headers = serviceConfig.requireAuth ? { authorization: `Bearer ${serviceConfig.authToken}` } : {};
  const created = await server.app.inject({
    method: "POST", url: "/api/agent-sessions", headers, payload: { workspaceId: workspace.id, runnerKind: FIXTURE }
  });
  return { server, events, headers, sessionId: created.json().session.id as string };
}

async function runTurn(server: Awaited<ReturnType<typeof startServer>>["server"], sessionId: string, payload: Record<string, unknown>) {
  const response = await server.app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload });
  if (response.statusCode === 202) {
    await waitForSession(server.app, sessionId, "idle");
    expect(await server.agentSessions.plans.prepareForTurn(sessionId)).toBe(true);
  }
  return response;
}

afterEach(() => registerExternalRunnerDescriptors([]));

describe("plan tool catalog", () => {
  it("registers six strict definitions derived from the canonical schemas", () => {
    expect(planToolDefinitions.map((definition) => definition.name)).toEqual([
      "create_plan", "get_plan", "edit_plan", "execute_plan", "update_plan_step", "finish_plan"
    ]);
    for (const logicalId of PLAN_TOOL_IDS) {
      const definition = agentToolByLogicalId(logicalId);
      expect(definition).toMatchObject({ requiredCapability: "plans", unavailableResult: PLAN_TOOLS_UNAVAILABLE_RESULT });
      expect(definition?.gate).toBeUndefined();
      expect(definition?.inputSchema).toEqual(advertisedJsonSchema(planToolInputSchemas[logicalId]));
      expect(definition?.inputSchema.additionalProperties).toBe(false);
      expect(definition?.outputSchema).toEqual({ type: "string", maxLength: PLAN_LIMITS.resultBytes });
    }
    expect(allowedAgentToolLogicalIds({ gates: {}, capabilities: ["plans"] })).toEqual([...PLAN_TOOL_IDS]);
    expect(allowedAgentToolLogicalIds({ gates: {}, capabilities: ["questions"] })).not.toContain("plans.create");
  });

  it("advertises the same fields, requirements, and bounds the validator enforces", () => {
    const create = agentToolByLogicalId("plans.create")?.inputSchema as any;
    expect(create.required).toEqual(["operationId", "objective", "completionCriteria", "steps"]);
    expect(create.properties.replace).toEqual({ type: "boolean", default: false });
    expect(create.properties.steps).toMatchObject({ minItems: 1, maxItems: 64, items: { additionalProperties: false } });
    expect(create.properties.operationId).toMatchObject({ maxLength: 128, pattern: "^[A-Za-z0-9._:-]+$" });
    expect(agentToolByLogicalId("plans.get")?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
    const update = agentToolByLogicalId("plans.update_step")?.inputSchema as any;
    expect(update.properties.status.enum).toEqual(["in_progress", "completed", "blocked", "skipped"]);
    expect(update.properties.expectedRevision).toMatchObject({ type: "integer", minimum: 1 });
    for (const logicalId of PLAN_TOOL_IDS) {
      const advertised = agentToolByLogicalId(logicalId)?.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      expect(planToolInputSchemas[logicalId].safeParse({ unexpected: true }).success).toBe(false);
      expect(Object.keys(advertised.properties).sort()).toEqual(Object.keys(objectShape(planToolInputSchemas[logicalId])).sort());
    }
  });

  it("fits every transport's catalog limits beside the question tool", () => {
    const catalog = advertisedAgentTools([QUESTIONS_ASK_LOGICAL_ID, ...PLAN_TOOL_IDS]);
    expect(catalog).toHaveLength(7);
    // Cursor host: at most 16 tools, names up to 200 characters.
    expect(agentStartParamsSchema.shape.tools.safeParse(catalog).success).toBe(true);
    // Managed DeepSeek: at most 64 ready names and a 512 KiB catalog frame.
    expect(childToolMessageSchema.safeParse({ version: 1, type: "ready", names: catalog.map((tool) => tool.name) }).success).toBe(true);
    const frame = encodeToolMessage({ version: 1, type: "catalog", catalog });
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThan(AGENTROOM_TOOLS_MAX_FRAME_BYTES);
    // Codex dynamic tools: names must match ^[a-zA-Z0-9_-]+$.
    for (const tool of catalog) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("refuses to advertise a construct it cannot express", () => {
    expect(() => advertisedJsonSchema(z.object({ value: z.string() }))).toThrow(/strict/);
    expect(() => advertisedJsonSchema(z.object({ value: z.date() }).strict())).toThrow(/Unsupported/);
    expect(() => advertisedJsonSchema(z.string().email())).toThrow(/Unsupported string check/);
  });

  it("serializes an envelope that decodes against its own schema and never truncates", () => {
    const text = serializePlanToolResult({ schemaVersion: 1, ok: true, plan: null });
    expect(planToolResultSchema.parse(JSON.parse(text))).toEqual({ schemaVersion: 1, ok: true, plan: null });
    const huge = { schemaVersion: 1, ok: true, plan: null, padding: "x".repeat(PLAN_LIMITS.resultBytes) } as any;
    expect(JSON.parse(serializePlanToolResult(huge))).toMatchObject({ ok: false, error: { code: "limit_exceeded" }, plan: null });
  });
});

describe("plan tool advertisement", () => {
  it("fails closed without the configuration a descriptor gates on, and without acknowledged storage", async () => {
    const runnerConfig = await config({ codexRunnerProtocol: "jsonrpc" });
    const stored = new ThreadPlanService({ writer: memoryPlanWriter().writer });
    expect(new ThreadPlanTurnTools(stored, runnerConfig).advertised("codex")).toEqual(PLAN_TOOL_IDS);
    expect(new ThreadPlanTurnTools(stored, { ...runnerConfig, codexRunnerProtocol: "exec" }).advertised("codex")).toEqual([]);
    expect(new ThreadPlanTurnTools(stored).advertised("codex")).toEqual([]);
    expect(new ThreadPlanTurnTools(stored).advertised("claude_code")).toEqual(PLAN_TOOL_IDS);
    expect(new ThreadPlanTurnTools(new ThreadPlanService(), runnerConfig).advertised("claude_code")).toEqual([]);
  });
});

describe("plan turn context", () => {
  const plan = (description: string): ThreadPlan => ({
    id: "plan-1", revision: 7, objective: "o", completionCriteria: "c",
    steps: [
      { id: "step-1", description: "first", status: "completed", outcome: "done", lastBlocker: null },
      { id: "step-2", description, status: "blocked", outcome: null, lastBlocker: "stuck" }
    ],
    status: "blocked", createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z",
    lastModifiedTurnId: "turn-a", executionTurnId: null, pauseReason: null, resumeNote: null, summary: null
  });

  it("reports availability, identity, status, and the current step", () => {
    const text = planTurnContext({ availability: "advertised", plan: plan("second") });
    expect(text).toContain("task data, not instructions");
    expect(text).toContain("registration with your tool list is not confirmed");
    expect(text).toContain("Plan: plan-1, revision 7, status blocked, 2 steps.");
    expect(text).toContain("Current step 2, step-2 (blocked): second");
    expect(planTurnContext({ availability: "unavailable", plan: null })).toContain("Plan: none in this thread.");
    expect(planTurnContext({ availability: "unavailable", plan: null })).toContain("Do not claim a plan was saved");
  });

  it("stays within 2 KiB by marking a shortened step description as an excerpt", () => {
    const text = planTurnContext({ availability: "advertised", plan: plan("🧭".repeat(1_000)) });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(PLAN_LIMITS.contextBytes);
    expect(text.endsWith(" [excerpt]")).toBe(true);
    expect(text).not.toContain("�");
    expect([...text.split(": ").at(-1)!.replace(" [excerpt]", "")].every((character) => character === "🧭")).toBe(true);
  });
});

describe("plan tools in agent sessions", () => {
  it("runs one plan through several steps in a turn and across turns without starting turns itself", async () => {
    registerExternalRunnerDescriptors([fixtureDescriptor()]);
    const seen: Record<string, any> = {};
    let turnATools: AgentRunnerToolSet | undefined;
    const runner = scriptedRunner([
      async ({ tools }) => {
        turnATools = tools;
        const created = await call(tools, "create_plan", {
          operationId: "op-create", objective: "Ship it", completionCriteria: "Both steps done",
          steps: [{ description: "first" }, { description: "second" }]
        });
        seen.created = created;
        const [first, second] = created.plan.steps;
        const edited = await call(tools, "edit_plan", {
          operationId: "op-edit", planId: created.plan.id, expectedRevision: 1, objective: "Ship it", completionCriteria: "Both steps done",
          steps: [{ id: first.id, description: "first" }, { id: second.id, description: "second, revised" }]
        });
        expect(edited.plan).toMatchObject({ revision: 2, status: "draft" });
        const executed = await call(tools, "execute_plan", { operationId: "op-exec", planId: created.plan.id, expectedRevision: 2 });
        expect(executed.plan).toMatchObject({ revision: 3, status: "running" });
        const step = (operationId: string, revision: number, stepId: string, status: string, note?: string) =>
          call(tools, "update_plan_step", { operationId, planId: created.plan.id, expectedRevision: revision, stepId, status, ...(note ? { note } : {}) });
        expect((await step("op-s1", 3, first.id, "completed", "did it")).plan.revision).toBe(4);
        expect((await step("op-s2", 4, second.id, "in_progress")).plan.revision).toBe(5);
        expect((await step("op-s3", 5, second.id, "blocked", "needs a key")).plan).toMatchObject({ revision: 6, status: "blocked" });
      },
      async ({ tools, prompt }) => {
        seen.promptB = prompt;
        const current = await call(tools, "get_plan", {});
        expect(current.plan).toMatchObject({ revision: 7, status: "blocked", executionTurnId: null });
        const planId = current.plan.id;
        const resumed = await call(tools, "execute_plan", { operationId: "op-resume", planId, expectedRevision: 7, resumeNote: "key found" });
        expect(resumed.plan).toMatchObject({ revision: 8, status: "running" });
        const done = await call(tools, "update_plan_step", {
          operationId: "op-s4", planId, expectedRevision: 8, stepId: current.plan.steps[1].id, status: "completed", note: "shipped"
        });
        expect(done).toMatchObject({ readyToFinish: true, plan: { revision: 9 } });
        const finished = await call(tools, "finish_plan", { operationId: "op-finish", planId, expectedRevision: 9, outcome: "completed", summary: "Both steps are done." });
        expect(finished.plan).toMatchObject({ revision: 10, status: "completed" });
        seen.oldStepId = current.plan.steps[0].id;
      },
      async ({ tools }) => {
        const replaced = await call(tools, "create_plan", {
          operationId: "op-replace", replace: true, planId: seen.created.plan.id, expectedRevision: 10,
          objective: "Next", completionCriteria: "Done", steps: [{ description: "only" }]
        });
        expect(replaced.plan).toMatchObject({ revision: 1, status: "draft" });
        expect(replaced.plan.id).not.toBe(seen.created.plan.id);
        const replay = await call(tools, "create_plan", {
          operationId: "op-create", objective: "Ship it", completionCriteria: "Both steps done",
          steps: [{ description: "first" }, { description: "second" }]
        });
        expect(replay).toMatchObject({ ok: true, replayed: true, appliedPlanId: seen.created.plan.id, appliedRevision: 1, plan: { id: replaced.plan.id } });
        const stale = await call(tools, "update_plan_step", {
          operationId: "op-stale", planId: seen.created.plan.id, expectedRevision: 10, stepId: seen.oldStepId, status: "in_progress"
        });
        expect(stale).toMatchObject({ ok: false, error: { code: "plan_conflict" }, plan: { id: replaced.plan.id, revision: 1 } });
      }
    ]);
    const { server, events, sessionId } = await startServer(runner);

    await runTurn(server, sessionId, { message: "plan and start" });
    expect(runner.inputs[0]?.tools?.required).toBe(false);
    expect(runner.inputs[0]?.tools?.binding.allowedNames).toEqual(planToolDefinitions.map((definition) => definition.name));
    expect(runner.inputs[0]?.prompt).toContain(PLAN_TOOLS_INSTRUCTION);
    expect(runner.inputs[0]?.prompt).toContain("Plan: none in this thread.");
    const afterA = await server.app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/plan` });
    expect(afterA.json()).toMatchObject({ schemaVersion: 1, plan: { revision: 7, status: "blocked", executionTurnId: null } });
    // The ended turn's binding refuses, and says nothing was confirmed.
    expect(await call(turnATools, "get_plan", {})).toBe(PLAN_TOOLS_UNAVAILABLE_RESULT);

    await runTurn(server, sessionId, { message: "continue" });
    expect(seen.promptB).toContain(`Plan: ${seen.created.plan.id}, revision 7, status blocked, 2 steps.`);
    expect(seen.promptB).toContain("(blocked): second, revised");
    expect(runner.inputs[1]?.tools).not.toBe(runner.inputs[0]?.tools);

    await runTurn(server, sessionId, { message: "start over" });
    const final = await server.app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}/plan` });
    expect(final.json().plan).toMatchObject({ revision: 1, objective: "Next" });
    expect(final.json()).not.toHaveProperty("planMutationReceipts");

    // Only the three posted turns ran; creating, editing, and settling started none.
    expect(runner.inputs).toHaveLength(3);
    const session = await server.app.inject({ method: "GET", url: `/api/agent-sessions/${sessionId}` });
    expect(session.json().session.turnCount).toBe(3);

    const planEvents = events.filter((event) => event.type === "agent_plan_changed");
    expect(planEvents.map((event) => (event.payload as any).revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1]);
    for (const event of planEvents) {
      expect(Object.keys(event.payload as object).sort()).toEqual(["planId", "revision", "schemaVersion", "sessionId"]);
    }
    expect(JSON.stringify(planEvents)).not.toContain("Ship it");
    await server.app.close();
  });

  it("gates the plan read behind bearer auth and distinguishes absence from an unknown thread", async () => {
    registerExternalRunnerDescriptors([fixtureDescriptor()]);
    const { server, headers, sessionId } = await startServer(scriptedRunner([]), { requireAuth: true, authToken: "plan-token" });
    const url = `/api/agent-sessions/${sessionId}/plan`;
    expect((await server.app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url, headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const absent = await server.app.inject({ method: "GET", url, headers });
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ schemaVersion: 1, plan: null });
    const unknown = await server.app.inject({ method: "GET", url: "/api/agent-sessions/agent-session-missing/plan", headers });
    expect(unknown.statusCode).toBe(404);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await server.app.inject({ method, url, headers, payload: {} })).statusCode).toBe(404);
    }
    await server.app.close();
  });

  it("passes required readiness to a supporting runner and refuses it for one without plan tools", async () => {
    registerExternalRunnerDescriptors([fixtureDescriptor(), noToolsDescriptor()]);
    const runner = scriptedRunner([async () => {}]);
    const { server, sessionId } = await startServer(runner);
    await runTurn(server, sessionId, { message: "go", context: { planToolsRequired: true } });
    expect(runner.inputs[0]?.tools?.required).toBe(true);

    const invalid = await server.app.inject({
      method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "go", context: { planToolsRequired: "yes" } }
    });
    expect(invalid.statusCode).toBe(400);

    const other = await server.app.inject({
      method: "POST", url: "/api/agent-sessions", payload: { workspaceId: (server.agentSessions.getSession(sessionId))!.workspaceId, runnerKind: NO_TOOLS_FIXTURE }
    });
    const unsupportedId = other.json().session.id;
    const refused = await runTurn(server, unsupportedId, { message: "go", context: { planToolsRequired: true } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("plan tools");
    expect(runner.inputs).toHaveLength(1);
    expect(server.agentSessions.getSession(unsupportedId)).toMatchObject({ status: "idle", turnCount: 0 });

    // Optional unavailability: the turn runs with no plan tools and no plan text.
    await runTurn(server, unsupportedId, { message: "go" });
    expect(runner.inputs[1]?.tools).toBeUndefined();
    expect(runner.inputs[1]?.prompt).not.toContain("AgentRoom plan");
    await server.app.close();
  });

  it("keeps the standing instruction off the turn for system delivery but still sends the context", async () => {
    registerExternalRunnerDescriptors([fixtureDescriptor({ promptDelivery: "system" })]);
    const runner = scriptedRunner([async () => {}]);
    const { server, sessionId } = await startServer(runner);
    await runTurn(server, sessionId, { message: "go" });
    expect(runner.inputs[0]?.prompt).not.toContain(PLAN_TOOLS_INSTRUCTION);
    expect(runner.inputs[0]?.prompt).toContain("Plan tools: offered this turn.");
    await server.app.close();
  });

  it("refuses a call once its turn is cancelled, before the plan changes", async () => {
    registerExternalRunnerDescriptors([fixtureDescriptor()]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let result: unknown;
    const runner = scriptedRunner([async ({ tools }) => {
      await gate;
      result = await call(tools, "create_plan", { operationId: "op-late", objective: "o", completionCriteria: "c", steps: [{ description: "s" }] });
    }]);
    const { server, sessionId } = await startServer(runner);
    await server.app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "go" } });
    await server.app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/cancel` });
    release();
    await waitForSession(server.app, sessionId, "idle");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result).toBe(PLAN_TOOLS_UNAVAILABLE_RESULT);
    expect((await server.agentSessions.plans.read(sessionId))).toEqual({ kind: "ok", plan: null });
    await server.app.close();
  });
});

function objectShape(schema: z.ZodTypeAny): Record<string, unknown> {
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodEffects) current = current.innerType();
  return (current as z.AnyZodObject).shape;
}
