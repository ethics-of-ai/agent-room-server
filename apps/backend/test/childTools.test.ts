import { afterEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { agentToolByLogicalId } from "../src/agentTools/catalog";
import { MAX_AGENT_TOOL_RESULT_CHARS, advertisedAgentTools } from "../src/agentTools/dispatch";
import { advertisedJsonSchema } from "../src/agentTools/jsonSchema";
import { QUESTIONS_ASK_LOGICAL_ID } from "../src/agentTools/questionAsk";
import { CHILD_TOOLS_INSTRUCTION, CHILD_TOOL_LIMITS, childToolInputSchemas } from "../src/children/agent/childToolContract";
import { CHILD_TOOL_IDS } from "../src/domain/childThreads";
import type { LocalWorkspace, ServiceConfig } from "../src/domain/models";
import { PLAN_TOOL_IDS } from "../src/plans/planTools";
import type { AgentRunner, AgentRunnerInput } from "../src/runner/AgentRunner";
import { agentStartParamsSchema } from "../src/runner/cursor/protocol";
import { AGENTROOM_TOOLS_MAX_FRAME_BYTES, encodeToolMessage } from "../src/runner/deepseek/cordis/protocol";
import { registerExternalRunnerDescriptors, type RunnerDescriptor } from "../src/runner/registry";
import { buildServer } from "../src/server";
import { SKETCH_TOOL_IDS } from "../src/sketch/agent/sketchToolContract";
import { config, createGitWorkspace, git } from "./support/agentSessionHarness";

// The parent agent's child tools against a real server and real temporary
// repositories. The fake runner settles every run at once unless `hold`
// holds it, and records every input, so a test calls the bound tools of a
// held parent turn the way an adapter relays a model's call.

const slow = 30_000;
const NAMES = Object.fromEntries(CHILD_TOOL_IDS.map((id) => [id, agentToolByLogicalId(id)!.name])) as Record<(typeof CHILD_TOOL_IDS)[number], string>;

function toolRunner(kind: string) {
  const inputs: AgentRunnerInput[] = [];
  const gates = new Map<string, () => void>();
  const state = { hold: (_input: AgentRunnerInput) => false, reply: (_input: AgentRunnerInput) => "Done" };
  const runner: AgentRunner = {
    async getCapabilities() {
      return { runnerKind: kind, settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      inputs.push(input);
      if (state.hold(input)) await new Promise<void>((resolve) => gates.set(input.runId, resolve));
      yield { type: "run_succeeded", message: state.reply(input) };
    },
    async cancel(runId) {
      gates.get(runId)?.();
    }
  };
  return Object.assign(state, {
    runner,
    inputs,
    release(runId: string) {
      gates.get(runId)?.();
      gates.delete(runId);
    },
    inputsOf: (sessionId: string) => inputs.filter((input) => input.sessionId === sessionId)
  });
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  registerExternalRunnerDescriptors([]);
  for (const close of closers.splice(0)) await close();
});

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

let callCount = 0;
async function call(input: AgentRunnerInput, name: string, args: unknown): Promise<any> {
  if (!input.tools) throw new Error("no tools were bound");
  const text = await input.tools.binding.invoke({ callId: `call-${callCount++}`, name, arguments: args, signal: new AbortController().signal });
  expect(text.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_RESULT_CHARS);
  return JSON.parse(text);
}

/** A server whose parent runs on Claude Code, with a person's turn held open so its tools stay live. */
async function parentStack(options: { configOverrides?: Partial<ServiceConfig>; parentRunner?: string; extraRunners?: string[] } = {}) {
  const fake = toolRunner("claude_code");
  const deepseek = toolRunner("deepseek");
  const serviceConfig = await config({ runnerKind: "claude_code", ...options.configOverrides });
  const extra = Object.fromEntries((options.extraRunners ?? []).map((kind) => [kind, fake.runner]));
  const built = await buildServer({ config: serviceConfig, runners: { claude_code: fake.runner, deepseek: deepseek.runner, codex: fake.runner, ...extra } });
  closers.push(() => built.app.close());
  const { app } = built;
  const workspacePath = await createGitWorkspace();
  const workspace = (await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: workspacePath } })).json().workspace as LocalWorkspace;
  const newParent = async (title = "Parent") => (await app.inject({
    method: "POST", url: "/api/agent-sessions", payload: { workspaceId: workspace.id, title, runnerKind: options.parentRunner ?? "claude_code" }
  })).json().session.id as string;
  const parentId = await newParent();
  /** Starts a person's turn on a parent and holds it; resolves with the runner input carrying its tools. */
  const holdParentTurn = async (sessionId = parentId, message = "Please hand these to worktree threads.") => {
    const before = fake.inputsOf(sessionId).length;
    const previous = fake.hold;
    fake.hold = (input) => input.sessionId === sessionId || previous(input);
    const turn = await app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message } });
    expect(turn.statusCode).toBe(202);
    await until(() => fake.inputsOf(sessionId).length > before);
    fake.hold = previous;
    return fake.inputsOf(sessionId).at(-1)!;
  };
  const session = (id: string) => built.agentSessions.getSession(id)!;
  const idle = (id: string) => until(() => session(id).status !== "running" && !session(id).activeTurnId);
  return { ...built, fake, deepseek, workspace, workspacePath, parentId, newParent, holdParentTurn, session, idle };
}

const task = (title: string, extra: Record<string, unknown> = {}) => ({ title, task: `Do ${title}.`, reason: "It touches other files.", ...extra });

describe("child tool catalog", () => {
  it("registers strict definitions under the children capability, derived from the canonical schemas", () => {
    expect(Object.values(NAMES)).toEqual([
      "agentroom_child_start", "agentroom_child_list", "agentroom_child_read", "agentroom_child_message", "agentroom_child_stop"
    ]);
    for (const logicalId of CHILD_TOOL_IDS) {
      const definition = agentToolByLogicalId(logicalId);
      expect(definition).toMatchObject({ requiredCapability: "children", outputSchema: { maxLength: MAX_AGENT_TOOL_RESULT_CHARS } });
      expect(definition?.inputSchema).toEqual(advertisedJsonSchema(childToolInputSchemas[logicalId]));
      expect(definition?.inputSchema.additionalProperties).toBe(false);
    }
    const start = agentToolByLogicalId("children.start")!.inputSchema as any;
    expect(start.properties.tasks).toMatchObject({ minItems: 1, maxItems: 4 });
    expect(Object.keys(start.properties.tasks.items.properties)).toEqual(["title", "task", "runnerKind", "reason"]);
    expect(start.properties.initiation).toMatchObject({ enum: ["offer", "person_asked"], default: "offer" });
    // No posture field: the agent may name a runner and nothing else (rule 3).
    expect(childToolInputSchemas["children.start"].safeParse({
      tasks: [task("A", { permissionMode: "bypassPermissions" })], initiation: "person_asked", operationId: "op"
    }).success).toBe(false);
    expect(childToolInputSchemas["children.start"].safeParse({ tasks: [1, 2, 3, 4, 5].map((n) => task(`T${n}`)), operationId: "op" }).success).toBe(false);
    expect(childToolInputSchemas["children.start"].safeParse({ tasks: [task("   ")], operationId: "op" }).success).toBe(false);
    expect(childToolInputSchemas["children.start"].parse({ tasks: [task("A")], operationId: "op" }).initiation).toBe("offer");
  });

  it("fits every transport's catalog limits beside the question, plan and sketch tools", () => {
    const catalog = advertisedAgentTools([QUESTIONS_ASK_LOGICAL_ID, ...PLAN_TOOL_IDS, ...SKETCH_TOOL_IDS, ...CHILD_TOOL_IDS]);
    expect(agentStartParamsSchema.shape.tools.safeParse(catalog).success).toBe(true);
    const frame = encodeToolMessage({ version: 1, type: "catalog", catalog });
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThan(AGENTROOM_TOOLS_MAX_FRAME_BYTES);
    for (const tool of catalog) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("child tool binding", () => {
  it("binds the child tools and their instruction to a parent, records them on its thread, and binds none to a child", async () => {
    const stack = await parentStack();
    // Before its first turn the thread would start with what the runner offers now.
    const fresh = await stack.app.inject({ method: "GET", url: `/api/agent-sessions/${stack.parentId}/children` });
    expect(fresh.json().parentToolsAvailable).toBe(true);
    const parentTurn = await stack.holdParentTurn();
    const names = parentTurn.tools!.binding.allowedNames;
    expect(names).toEqual(expect.arrayContaining(Object.values(NAMES)));
    expect(parentTurn.tools!.instructions).toContain(CHILD_TOOLS_INSTRUCTION);
    expect(stack.session(stack.parentId).threadAgentToolIds).toEqual(expect.arrayContaining([...CHILD_TOOL_IDS]));
    const listed = await stack.app.inject({ method: "GET", url: `/api/agent-sessions/${stack.parentId}/children` });
    expect(listed.json().parentToolsAvailable).toBe(true);

    const started = await call(parentTurn, NAMES["children.start"], { tasks: [task("Level one")], initiation: "person_asked", operationId: "op-one" });
    const childId = started.tasks[0].child.sessionId as string;
    await until(() => stack.fake.inputsOf(childId).length > 0);
    const childNames = stack.fake.inputsOf(childId)[0]!.tools?.binding.allowedNames ?? [];
    expect(childNames.some((name) => name.startsWith("agentroom_child_"))).toBe(false);
    expect(stack.fake.inputsOf(childId)[0]!.tools?.instructions ?? "").not.toContain(CHILD_TOOLS_INSTRUCTION);
    expect(stack.session(childId).threadAgentToolIds?.some((id) => id.startsWith("children."))).toBe(false);
    stack.fake.release(parentTurn.runId);
  }, slow);

  it("binds none on a runner whose transport is off, and refuses a runner whose descriptor lacks the capability as a child", async () => {
    const exec = await parentStack({ configOverrides: { codexRunnerProtocol: "exec" }, parentRunner: "codex" });
    const codexTurn = await exec.holdParentTurn();
    expect(codexTurn.tools).toBeUndefined();
    expect((await exec.app.inject({ method: "GET", url: `/api/agent-sessions/${exec.parentId}/children` })).json().parentToolsAvailable).toBe(false);
    exec.fake.release(codexTurn.runId);

    // An ACP adapter declares no AgentRoom tool transport, so it can be
    // neither; the admission reads the descriptor, never the id.
    const fixture = (id: string, agentTools: RunnerDescriptor["agentTools"]): RunnerDescriptor => ({
      id, displayName: `Fixture ${id}`, promptDelivery: "turn", turnDiffSource: "settle_time_git",
      clarifyingQuestions: { mode: "none" }, workspaceSkills: { mode: "none" }, agentTools,
      skillSourceDirs: [], skillInvocationPrefix: "/", settingsKeyPrefix: id.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      settings: [], restoreStrategy: "native_resume", isConfigured: () => true
    });
    registerExternalRunnerDescriptors([
      fixture("acp_fixture", { mode: "none" }),
      fixture("children_fixture", { mode: "custom_tools", capabilities: ["plans", "children"] })
    ]);
    const stack = await parentStack({ extraRunners: ["acp_fixture", "children_fixture"] });
    const parentTurn = await stack.holdParentTurn();
    const started = await call(parentTurn, NAMES["children.start"], {
      tasks: [task("On ACP", { runnerKind: "acp_fixture" }), task("On a fixture", { runnerKind: "children_fixture" })],
      initiation: "person_asked", operationId: "op-acp"
    });
    expect(started.tasks[0]).toMatchObject({ outcome: "refused", code: "runner_unsupported" });
    expect(started.tasks[1]).toMatchObject({ outcome: "created", child: { runnerKind: "children_fixture" } });
    expect(stack.agentSessions.listSessions().filter((session) => session.parent)).toHaveLength(1);

    const acpParent = await stack.app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: stack.workspace.id, runnerKind: "acp_fixture" } });
    const acpTurn = await stack.holdParentTurn(acpParent.json().session.id);
    expect(acpTurn.tools).toBeUndefined();
    stack.fake.release(parentTurn.runId);
    stack.fake.release(acpTurn.runId);
  }, slow);
});

describe("agentroom_child_start", () => {
  it("creates one child per task for person_asked, records the initiation and replays without creating again", async () => {
    const stack = await parentStack();
    const changes: any[] = [];
    stack.eventBus.subscribe((event) => { if (event.type === "agent_child_changed") changes.push(event.payload); });
    const parentTurn = await stack.holdParentTurn();
    const input = { tasks: [task("Fix the flag"), task("Fix the docs")], initiation: "person_asked", operationId: "op-start" };

    const started = await call(parentTurn, NAMES["children.start"], input);
    expect(started).toMatchObject({ ok: true, operationId: "op-start" });
    expect(started.replayed).toBeUndefined();
    expect(started.tasks.map((entry: any) => [entry.title, entry.outcome])).toEqual([["Fix the flag", "created"], ["Fix the docs", "created"]]);
    const ids = started.tasks.map((entry: any) => entry.child.sessionId as string);
    expect(ids.map((id: string) => stack.session(id).parent?.operationId)).toEqual(["op-start:0", "op-start:1"]);
    expect(changes.map((change) => [change.change, change.initiation])).toEqual([["created", "person_asked"], ["created", "person_asked"]]);
    await until(() => ids.every((id: string) => stack.fake.inputsOf(id).length > 0));
    expect(stack.fake.inputsOf(ids[0])[0]!.prompt).toContain("Do Fix the flag.");

    const replay = await call(parentTurn, NAMES["children.start"], input);
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(replay.tasks.map((entry: any) => entry.child.sessionId)).toEqual(ids);
    expect(stack.agentSessions.listSessions().filter((session) => session.parent)).toHaveLength(2);
    expect(changes).toHaveLength(2);

    const conflict = await call(parentTurn, NAMES["children.start"], { ...input, tasks: [task("Something else")] });
    expect(conflict.error.code).toBe("operation_conflict");
    stack.fake.release(parentTurn.runId);
  }, slow);

  it("replays a task whose title has surrounding whitespace, which the child stores trimmed", async () => {
    const stack = await parentStack();
    const parentTurn = await stack.holdParentTurn();
    const input = { tasks: [task(" Padded title ")], initiation: "person_asked", operationId: "op-padded" };

    const started = await call(parentTurn, NAMES["children.start"], input);
    const childId = started.tasks[0].child.sessionId as string;
    expect(stack.session(childId).title).toBe("Padded title");
    const replay = await call(parentTurn, NAMES["children.start"], input);
    expect(replay).toMatchObject({ ok: true, replayed: true, tasks: [{ outcome: "created", child: { sessionId: childId } }] });
    expect(stack.agentSessions.listSessions().filter((session) => session.parent)).toHaveLength(1);
    stack.fake.release(parentTurn.runId);
  }, slow);

  it("refuses person_asked in a turn the person did not start, creating nothing", async () => {
    const stack = await parentStack();
    const parentTurn = await stack.holdParentTurn();
    // A child's report wakes the parent; its turn carries a trigger.
    const created = await call(parentTurn, NAMES["children.start"], { tasks: [task("Wakes")], initiation: "person_asked", operationId: "op-wake" });
    const childId = created.tasks[0].child.sessionId as string;
    await stack.idle(childId);
    stack.fake.hold = (input) => input.sessionId === stack.parentId;
    stack.fake.release(parentTurn.runId);
    await until(() => stack.fake.inputsOf(stack.parentId).length === 2);
    const wake = stack.fake.inputsOf(stack.parentId)[1]!;
    expect(wake.prompt).toContain("finished a turn");
    const fromWake = await call(wake, NAMES["children.start"], { tasks: [task("From a wake")], initiation: "person_asked", operationId: "op-from-wake" });
    expect(fromWake).toMatchObject({ ok: false, error: { code: "offer_required" } });
    expect(stack.agentSessions.listSessions().filter((session) => session.parent)).toHaveLength(1);
    stack.fake.hold = () => false;
    stack.fake.release(wake.runId);
  }, slow);

  it("refuses the whole call with the free count when it names more tasks than free slots", async () => {
    const stack = await parentStack();
    const parentTurn = await stack.holdParentTurn();
    await call(parentTurn, NAMES["children.start"], { tasks: [task("One"), task("Two"), task("Three")], initiation: "person_asked", operationId: "op-three" });
    const over = await call(parentTurn, NAMES["children.start"], { tasks: [task("Four"), task("Five")], initiation: "person_asked", operationId: "op-two" });
    expect(over).toMatchObject({ ok: false, error: { code: "child_limit_reached", freeSlots: 1 } });
    expect(stack.agentSessions.listSessions().filter((session) => session.parent)).toHaveLength(3);
    stack.fake.release(parentTurn.runId);
  }, slow);
});

describe("child tool scoping and turns", () => {
  it("resolves only the caller's own children; every other id is unknown_child", async () => {
    const stack = await parentStack();
    const parentTurn = await stack.holdParentTurn();
    const mine = await call(parentTurn, NAMES["children.start"], { tasks: [task("Mine")], initiation: "person_asked", operationId: "op-mine" });
    const childId = mine.tasks[0].child.sessionId as string;
    await stack.idle(childId);

    const otherId = await stack.newParent("Other parent");
    const otherTurn = await stack.holdParentTurn(otherId);
    for (const [name, args] of [
      [NAMES["children.read"], { childSessionId: childId }],
      [NAMES["children.message"], { childSessionId: childId, message: "Hi", operationId: "op-x" }],
      [NAMES["children.stop"], { childSessionId: childId }],
      [NAMES["children.read"], { childSessionId: stack.parentId }],
      [NAMES["children.read"], { childSessionId: "agent-session-nope" }]
    ] as const) {
      expect((await call(otherTurn, name, args)).error.code).toBe("unknown_child");
    }
    expect((await call(otherTurn, NAMES["children.list"], {})).children).toEqual([]);
    const listed = await call(parentTurn, NAMES["children.list"], {});
    expect(listed.children.map((child: any) => child.sessionId)).toEqual([childId]);
    stack.fake.release(parentTurn.runId);
    stack.fake.release(otherTurn.runId);
  }, slow);

  it("messages an idle child with a parent_task turn, replays by turn, and refuses a busy child; stop ends a running turn", async () => {
    const stack = await parentStack();
    const triggers: any[] = [];
    stack.eventBus.subscribe((event) => { if (event.type === "agent_turn_started") triggers.push(event.payload); });
    const parentTurn = await stack.holdParentTurn();
    const created = await call(parentTurn, NAMES["children.start"], { tasks: [task("Talk")], initiation: "person_asked", operationId: "op-talk" });
    const childId = created.tasks[0].child.sessionId as string;
    await stack.idle(childId);

    stack.fake.hold = (input) => input.sessionId === childId;
    const sent = await call(parentTurn, NAMES["children.message"], { childSessionId: childId, message: "Cover the empty case.", operationId: "op-msg" });
    expect(sent).toMatchObject({ ok: true, outcome: "started" });
    expect(triggers.find((turn) => turn.turnId === sent.turnId)?.trigger).toEqual({ kind: "parent_task", parentSessionId: stack.parentId, tasks: [] });
    await until(() => stack.fake.inputsOf(childId).length === 2);
    expect(stack.fake.inputsOf(childId)[1]!.prompt).toContain("Cover the empty case.");
    const childMessages = (await stack.app.inject({ method: "GET", url: `/api/agent-sessions/${childId}/messages` })).json().messages;
    expect(childMessages.filter((message: any) => message.role === "system").map((message: any) => message.origin)).toEqual(["parent_task", "parent_message"]);

    const replay = await call(parentTurn, NAMES["children.message"], { childSessionId: childId, message: "Cover the empty case.", operationId: "op-msg" });
    expect(replay).toMatchObject({ ok: true, outcome: "started", turnId: sent.turnId, replayed: true });
    const busy = await call(parentTurn, NAMES["children.message"], { childSessionId: childId, message: "And another.", operationId: "op-msg-2" });
    expect(busy.error.code).toBe("child_busy");

    const stopped = await call(parentTurn, NAMES["children.stop"], { childSessionId: childId });
    expect(stopped).toMatchObject({ ok: true, outcome: "stopped", turnId: sent.turnId, continuable: true });
    await stack.idle(childId);
    expect((await call(parentTurn, NAMES["children.stop"], { childSessionId: childId })).error.code).toBe("not_running");
    stack.fake.hold = () => false;
    stack.fake.release(parentTurn.runId);
  }, slow);

  it("reports a stopped child on a runner with no restore path as unable to continue", async () => {
    const stack = await parentStack();
    const parentTurn = await stack.holdParentTurn();
    stack.deepseek.hold = () => true;
    const created = await call(parentTurn, NAMES["children.start"], {
      tasks: [task("On DeepSeek", { runnerKind: "deepseek" })], initiation: "person_asked", operationId: "op-deepseek"
    });
    expect(created.tasks[0]).toMatchObject({ outcome: "created", child: { runnerKind: "deepseek", continuable: true } });
    const childId = created.tasks[0].child.sessionId as string;
    await until(() => stack.deepseek.inputsOf(childId).length === 1);

    const stopped = await call(parentTurn, NAMES["children.stop"], { childSessionId: childId });
    expect(stopped).toMatchObject({ outcome: "stopped", continuable: false });
    await stack.idle(childId);
    const refused = await call(parentTurn, NAMES["children.message"], { childSessionId: childId, message: "Again.", operationId: "op-again" });
    expect(refused.error.code).toBe("child_cannot_continue");
    expect((await call(parentTurn, NAMES["children.read"], { childSessionId: childId })).child.continuable).toBe(false);
    stack.fake.release(parentTurn.runId);
  }, slow);
});

describe("agentroom_child_read", () => {
  it("returns the transcript tail first within its cap and the whole result within the dispatch cap", async () => {
    const stack = await parentStack();
    const parentTurn = await stack.holdParentTurn();
    stack.fake.reply = (input) => (input.sessionId === stack.parentId ? "Done" : `${"older ".repeat(4_000)}THE END`);
    const created = await call(parentTurn, NAMES["children.start"], { tasks: [task("Talkative")], initiation: "person_asked", operationId: "op-long" });
    const childId = created.tasks[0].child.sessionId as string;
    await stack.idle(childId);
    for (let index = 0; index < 3; index += 1) {
      await call(parentTurn, NAMES["children.message"], { childSessionId: childId, message: `Round ${index} ${"x".repeat(12_000)}`, operationId: `op-round-${index}` });
      await stack.idle(childId);
    }
    stack.fake.reply = (input) => (input.sessionId === stack.parentId ? "Done" : `${"y".repeat(50_000)} SECRET_TOKEN=abc123 THE LAST WORDS`);
    await call(parentTurn, NAMES["children.message"], { childSessionId: childId, message: "Finish.", operationId: "op-finish" });
    await stack.idle(childId);

    const read = await call(parentTurn, NAMES["children.read"], { childSessionId: childId, include: ["transcript", "diff"] });
    const { messages, omittedMessages } = read.transcript;
    expect(JSON.stringify(messages).length).toBeLessThanOrEqual(CHILD_TOOL_LIMITS.transcriptChars);
    expect(omittedMessages).toBeGreaterThan(0);
    // The newest message is too long alone, so its end is kept.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "assistant", truncated: true });
    expect(messages[0].content.endsWith("THE LAST WORDS")).toBe(true);
    expect(messages[0].content).not.toContain("abc123");
    expect(read.child.sessionId).toBe(childId);
    stack.fake.release(parentTurn.runId);
  }, slow);

  it("lists changed files without hidden or secret paths, capped at 200", async () => {
    const stack = await parentStack();
    const parentTurn = await stack.holdParentTurn();
    const created = await call(parentTurn, NAMES["children.start"], { tasks: [task("Files")], initiation: "person_asked", operationId: "op-files" });
    const childId = created.tasks[0].child.sessionId as string;
    await stack.idle(childId);
    const workspaces = (await stack.app.inject({ method: "GET", url: "/api/workspaces" })).json().workspaces as LocalWorkspace[];
    const worktreePath = workspaces.find((entry) => entry.id === stack.session(childId).workspaceId)!.worktree!.worktreePath;
    await writeFile(join(worktreePath, "README.md"), "# Workspace\nedited\n");
    await writeFile(join(worktreePath, ".env"), "SECRET=1\n");
    await writeFile(join(worktreePath, "server.pem"), "key\n");
    await mkdir(join(worktreePath, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(worktreePath, "node_modules", "pkg", "index.js"), "x\n");
    await mkdir(join(worktreePath, "notes"));
    await writeFile(join(worktreePath, "notes", "plan.md"), "plan\n");

    const read = await call(parentTurn, NAMES["children.read"], { childSessionId: childId, include: ["diff"] });
    expect(read.transcript).toBeUndefined();
    expect(read.files.files).toEqual([{ path: "README.md", insertions: 1, deletions: 0 }, { path: "notes/plan.md", untracked: true }]);
    expect(read.files).toMatchObject({ hidden: 3, truncated: false });

    for (let index = 0; index < 220; index += 1) await writeFile(join(worktreePath, "notes", `n${index}.md`), "n\n");
    const many = await call(parentTurn, NAMES["children.read"], { childSessionId: childId, include: ["diff"] });
    expect(many.files.files).toHaveLength(200);
    expect(many.files.truncated).toBe(true);
    expect(JSON.stringify(many.files.files)).not.toMatch(/\.env|\.pem|node_modules/);
    await git(worktreePath, "status", "--porcelain");
    stack.fake.release(parentTurn.runId);
  }, slow);
});
