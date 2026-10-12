import { readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionQuestionChannel } from "../src/agent/SessionQuestionChannel";
import type { AgentRoomEvent } from "../src/events/eventTypes";
import { registerExternalRunnerDescriptors } from "../src/runner/registry";
import { buildServer } from "../src/server";
import { confirmationRefusal, confirmationSet } from "../src/sketch/agent/sketchConfirmations";
import { config, waitForSession } from "./support/agentSessionHarness";
import { WRITABLE, box, call, start, type Script } from "./support/sketchToolHarness";

// Stage 4 of docs/plans/LIVE_AGENT_SKETCH_PLAN.md: the lifecycle tools, the
// session question channel, and the confirmations before deleting a sketch
// or emptying one.

afterEach(() => registerExternalRunnerDescriptors([]));

type Fixture = Awaited<ReturnType<typeof start>>;

/** Answers the next question a backend tool raises, with the option given. */
async function answerNext(f: Fixture, optionId: "yes" | "no", before?: () => Promise<void>): Promise<void> {
  const seen = f.events.filter((event) => event.type === "coding_question_requested").length;
  await vi.waitFor(() => expect(f.events.filter((event) => event.type === "coding_question_requested").length).toBeGreaterThan(seen));
  const event = f.events.filter((entry) => entry.type === "coding_question_requested").at(-1)!;
  const payload = event.payload as { requestId: string; questionSets: Array<{ setId: string; prompt: string }> };
  await before?.();
  const answered = await f.server.app.inject({ method: "POST", url: `/api/agent-sessions/${f.session.id}/questions/${payload.requestId}`,
    payload: { answers: [{ setId: payload.questionSets[0]!.setId, selectedOptionIds: [optionId] }] } });
  expect(answered.statusCode).toBe(200);
}

function lastPrompt(f: Fixture): string {
  const event = f.events.filter((entry) => entry.type === "coding_question_requested").at(-1);
  return (event?.payload as { questionSets: Array<{ prompt: string }> } | undefined)?.questionSets[0]?.prompt ?? "";
}

const agentChanges = (events: AgentRoomEvent[]) => events
  .filter((event) => event.type === "sketch_document_changed" && (event.payload as { actorKind: string }).actorKind === "agent")
  .map((event) => event.payload as Record<string, unknown>);

describe("sketch lifecycle tools", () => {
  it("creates a sketch, edits it, and undoes and redoes only its own steps", async () => {
    const results: string[] = [];
    let f!: Fixture;
    const scripts: Script[] = [
      async ({ tools }) => {
        results.push(await call(tools, "agentroom_sketch_create", { name: "Data flow" }));
        results.push(await call(tools, "agentroom_sketch_edit", { sketch: "Data flow", baseRevision: 0, label: "add box", operations: [box("a")] }));
        results.push(await call(tools, "agentroom_sketch_history", { sketch: "data-flow.sketch.json", step: "undo" }));
        results.push(await call(tools, "agentroom_sketch_history", { sketch: "Data flow", step: "redo" }));
        await call(tools, "agentroom_sketch_list", {});
        results.push(await call(tools, "agentroom_sketch_edit", { sketch: f.path, baseRevision: 1, label: "agent box", operations: [box("agent-box")] }));
      },
      async ({ tools }) => {
        // The person drew after the agent's step, so the newest step is theirs.
        results.push(await call(tools, "agentroom_sketch_history", { sketch: f.path, step: "undo" }));
      }
    ];
    f = await start(WRITABLE, scripts);
    await f.human("person-1", [box("p1")]);
    await f.turn();
    expect(results[0]).toMatch(/^ok: created "Data flow" at data-flow\.sketch\.json, id sketch-[0-9a-f-]+, revision 0/);
    expect(results[1]).toMatch(/^ok: committed "add box" as revision 1 of data-flow\.sketch\.json/);
    expect(results[2]).toMatch(/^ok: undid your step as revision 2/);
    expect(results[3]).toMatch(/^ok: redid your step as revision 3/);
    expect(results[4]).toMatch(/^ok: committed "agent box" as revision 2/);
    expect(agentChanges(f.events).map((change) => change.kind)).toEqual(["created", "commit", "undo", "redo", "commit"]);
    expect(f.events.filter((event) => event.type === "workspace_file_written" && (event.payload as { path: string }).path === "data-flow.sketch.json")).toEqual([]);

    await f.human("person-2", [box("p2")]);
    await f.turn();
    expect(results[5]).toMatch(/^error not_own_step: The newest step to undo is "1 operation\(s\)" by the person\./);
    expect((await f.read()).document.objects.map((object: { id: string }) => object.id)).toEqual(["p1", "agent-box", "p2"]);
    await f.server.app.close();
  });

  it("refuses to undo another thread's step, and keeps knowing its own steps after a restart", async () => {
    const results: string[] = [];
    const serviceConfig = await config();
    const first = await start(WRITABLE, [
      async ({ tools }) => {
        await call(tools, "agentroom_sketch_inspect", { sketch: "Board" });
        results.push(await call(tools, "agentroom_sketch_edit", { sketch: "Board", baseRevision: 0, label: "first", operations: [box("a")] }));
      }
    ], { serviceConfig });
    await first.turn();
    expect(results[0]).toMatch(/^ok:/);
    const other = (await first.server.app.inject({ method: "POST", url: "/api/agent-sessions", payload: { workspaceId: first.workspace.id, runnerKind: WRITABLE } })).json().session;
    first.runner.inputs.length = 0;
    await first.server.app.close();

    // A restarted backend reloads the turns, so the step is still this session's.
    const scripts: Script[] = [
      async ({ tools }) => { results.push(await call(tools, "agentroom_sketch_history", { sketch: "Board", step: "undo" })); },
      async ({ tools }) => { results.push(await call(tools, "agentroom_sketch_history", { sketch: "Board", step: "undo" })); }
    ];
    const runner = { ...first.runner, async *run(input: Parameters<typeof first.runner.run>[0]) { await scripts.shift()?.(input); yield { type: "run_succeeded" as const, message: "done" }; } };
    const restarted = await buildServer({ config: serviceConfig, runners: { [WRITABLE]: runner } });
    const turn = async (sessionId: string) => {
      expect((await restarted.app.inject({ method: "POST", url: `/api/agent-sessions/${sessionId}/turns`, payload: { message: "go" } })).statusCode).toBe(202);
      await waitForSession(restarted.app, sessionId, "idle");
    };
    await turn(other.id);
    expect(results[1]).toMatch(/^error not_own_step: The newest step to undo is "first" by another agent thread\./);
    await turn(first.session.id);
    expect(results[2]).toMatch(/^ok: undid your step/);
    await restarted.app.close();
  });

  it("deletes single objects without asking, and asks before a step that empties the sketch", async () => {
    const results: string[] = [];
    let f!: Fixture;
    f = await start(WRITABLE, [
      async ({ tools }) => {
        await call(tools, "agentroom_sketch_inspect", { sketch: "Board" });
        results.push(await call(tools, "agentroom_sketch_edit", { sketch: "Board", baseRevision: 1, label: "drop a", operations: [{ op: "delete", objectId: "a" }] }));
        // Deleting every remaining object one by one in a batch is still clear-all.
        const pending = call(tools, "agentroom_sketch_edit", { sketch: "Board", baseRevision: 2, label: "drop rest", operations: [{ op: "delete", objectId: "b" }, { op: "delete", objectId: "c" }] });
        await answerNext(f, "no");
        results.push(await pending);
        const cleared = call(tools, "agentroom_sketch_edit", { sketch: "Board", baseRevision: 2, label: "wipe", operations: [{ op: "clear" }] });
        await answerNext(f, "yes");
        results.push(await cleared);
      }
    ]);
    await f.human("draw", [box("a"), box("b"), box("c")]);
    await f.turn();
    expect(results[0]).toMatch(/^ok: committed "drop a"/);
    expect(results[1]).toMatch(/^error declined: the person said no, so nothing was cleared/);
    expect(results[2]).toMatch(/^ok: committed "wipe" as revision 3/);
    expect(lastPrompt(f)).toContain('remove every object from the sketch "board" (board.sketch.json, 2 object(s)) in a step labelled "wipe"');
    expect(f.events.filter((event) => event.type === "coding_question_requested")).toHaveLength(2);
    expect((await f.read()).undoHead).toEqual({ label: "wipe", actorKind: "agent" });
    await f.server.app.close();
  });

  it("refuses a clear when the sketch changed while the question was open", async () => {
    const results: string[] = [];
    let f!: Fixture;
    f = await start(WRITABLE, [
      async ({ tools }) => {
        await call(tools, "agentroom_sketch_inspect", { sketch: "Board" });
        const pending = call(tools, "agentroom_sketch_edit", { sketch: "Board", baseRevision: 1, label: "wipe", operations: [{ op: "clear" }] });
        await answerNext(f, "yes", async () => { await f.human("drawn-meanwhile", [box("new")]); });
        results.push(await pending);
      }
    ]);
    await f.human("draw", [box("a")]);
    await f.turn();
    expect(results[0]).toMatch(/^error sketch_changed_during_confirmation/);
    expect((await f.read()).document.objects.map((object: { id: string }) => object.id)).toEqual(["a", "new"]);
    await f.server.app.close();
  });

  it("refuses a file delete when the sketch changed while the question was open", async () => {
    const results: string[] = [];
    let f!: Fixture;
    f = await start(WRITABLE, [
      async ({ tools }) => {
        const pending = call(tools, "agentroom_sketch_delete", { sketch: "Board" });
        await answerNext(f, "yes", async () => { await f.human("drawn-meanwhile", [box("new")]); });
        results.push(await pending);
      }
    ]);
    await f.human("draw", [box("a")]);
    await f.turn();
    expect(results[0]).toMatch(/^error sketch_changed_during_confirmation: .* so nothing was deleted/);
    expect((await f.read()).document.objects.map((object: { id: string }) => object.id)).toEqual(["a", "new"]);
    expect(agentChanges(f.events)).toEqual([]);
    await f.server.app.close();
  });

  it("refuses deletes and clears when questions are turned off", async () => {
    const results: string[] = [];
    const f = await start(WRITABLE, [
      async ({ tools }) => {
        await call(tools, "agentroom_sketch_list", {});
        results.push(await call(tools, "agentroom_sketch_edit", { sketch: "Board", baseRevision: 1, label: "wipe", operations: [{ op: "clear" }] }));
        results.push(await call(tools, "agentroom_sketch_delete", { sketch: "Board" }));
      }
    ], { serviceConfig: await config({ clarifyingQuestionsEnabled: false }) });
    await f.human("draw", [box("a")]);
    await f.turn();
    expect(results[0]).toMatch(/^error confirmation_unavailable: .* so nothing was cleared/);
    expect(results[1]).toMatch(/^error confirmation_unavailable: .* so nothing was deleted/);
    expect((await f.read()).document.objects).toHaveLength(1);
    await f.server.app.close();
  });

  it("deletes a sketch file only on a yes, and answers the question without reaching the runner", async () => {
    const results: string[] = [];
    let f!: Fixture;
    f = await start(WRITABLE, [
      async ({ tools }) => {
        const declined = call(tools, "agentroom_sketch_delete", { sketch: "Board" });
        await answerNext(f, "no");
        results.push(await declined);
        const accepted = call(tools, "agentroom_sketch_delete", { sketch: "Board" });
        await answerNext(f, "yes");
        results.push(await accepted);
      }
    ]);
    const runnerAnswer = vi.fn(() => "unknown_request" as const);
    (f.runner as { answerQuestionRequest?: unknown }).answerQuestionRequest = runnerAnswer;
    await f.human("draw", [box("a")]);
    await f.turn();
    expect(results[0]).toMatch(/^error declined: the person said no, so nothing was deleted/);
    expect(results[1]).toBe("ok: deleted board.sketch.json.");
    expect(lastPrompt(f)).toContain('delete the sketch "board" (board.sketch.json, 1 object(s))');
    expect(runnerAnswer).not.toHaveBeenCalled();
    expect(await readdir(f.workspace.path)).toEqual([]);
    expect(agentChanges(f.events).at(-1)).toMatchObject({ kind: "deleted", path: "board.sketch.json", sessionId: f.session.id });
    const listed = await f.server.app.inject({ method: "GET", url: `/api/workspaces/${f.workspace.id}/sketches` });
    expect(listed.json().sketches).toEqual([]);
    expect((await f.server.app.inject({ method: "GET", url: `/api/workspaces/${f.workspace.id}/sketch?path=board.sketch.json` })).json().code).toBe("file_missing");
    // An id the channel does not hold still goes to the runner.
    await f.server.app.inject({ method: "POST", url: `/api/agent-sessions/${f.session.id}/questions/question-unknown`,
      payload: { answers: [{ setId: "confirm", selectedOptionIds: ["yes"] }] } });
    expect(runnerAnswer).toHaveBeenCalledTimes(1);
    const journal = await readdir(join(f.serviceConfig.stateDir, "sketch-repository")).catch(() => []);
    expect(journal).toEqual([]);
    await f.server.app.close();
  });

  it("renames a sketch, keeping its id and the person's undo history", async () => {
    const results: string[] = [];
    let f!: Fixture;
    f = await start(WRITABLE, [
      async ({ tools }) => {
        results.push(await call(tools, "agentroom_sketch_rename", { sketch: "Board", newName: "System map" }));
        results.push(await call(tools, "agentroom_sketch_rename", { sketch: "System map", newName: "Taken" }));
        results.push(await call(tools, "agentroom_sketch_inspect", { sketch: "System map" }));
      }
    ]);
    await f.human("draw", [box("a")]);
    await f.server.app.inject({ method: "POST", url: `/api/workspaces/${f.workspace.id}/sketch`, payload: { name: "Taken" } });
    await f.turn();
    expect(results[0]).toMatch(/^ok: renamed board\.sketch\.json to system-map\.sketch\.json\. Its id sketch-/);
    expect(results[1]).toMatch(/^error name_collision/);
    expect(results[2]).toContain('Sketch "system map" at system-map.sketch.json');
    expect(agentChanges(f.events).find((change) => change.kind === "renamed")).toMatchObject({ path: "system-map.sketch.json", previousPath: "board.sketch.json" });
    const base = `/api/workspaces/${f.workspace.id}/sketch`;
    const moved = (await f.server.app.inject({ method: "GET", url: `${base}?path=system-map.sketch.json` })).json().sketch;
    expect(moved).toMatchObject({ sketchId: f.sketch.sketchId, undoDepth: 1, undoHead: { label: "1 operation(s)", actorKind: "human" }, historyReset: false });
    const undo = await f.server.app.inject({ method: "POST", url: `${base}/undo?path=system-map.sketch.json`,
      payload: { requestId: "undo-after-rename", baseRevision: moved.revision, fileVersion: moved.fileVersion } });
    expect(undo.statusCode).toBe(200);
    const listed = (await f.server.app.inject({ method: "GET", url: `/api/workspaces/${f.workspace.id}/sketches` })).json().sketches;
    expect(listed.map((entry: { path: string }) => entry.path)).toEqual(["system-map.sketch.json", "taken.sketch.json"]);
    await f.server.app.close();
  });
});

describe("sketch identity", () => {
  it("refuses to rename or delete a sketch changed outside AgentRoom since the index read it, until a list re-reads it", async () => {
    const results: string[] = [];
    const f = await start(WRITABLE, [
      async ({ tools }) => {
        results.push(await call(tools, "agentroom_sketch_rename", { sketch: "Board", newName: "Plan" }));
        results.push(await call(tools, "agentroom_sketch_delete", { sketch: "Board" }));
        await call(tools, "agentroom_sketch_list", {});
        results.push(await call(tools, "agentroom_sketch_rename", { sketch: "Board", newName: "Plan" }));
      }
    ]);
    await f.human("draw", [box("a")]);
    await f.server.app.inject({ method: "GET", url: `/api/workspaces/${f.workspace.id}/sketches` });
    // A write no AgentRoom event reports, so the index still holds the version it listed.
    const later = new Date(Date.now() + 5_000);
    await utimes(join(f.workspace.path, f.path), later, later);
    await f.turn();
    expect(results[0]).toMatch(/^error file_changed: board\.sketch\.json changed outside AgentRoom since AgentRoom last listed it, so nothing was renamed/);
    expect(results[1]).toMatch(/^error file_changed: .* so nothing was deleted/);
    expect(f.events.some((event) => event.type === "coding_question_requested")).toBe(false);
    expect(results[2]).toMatch(/^ok: renamed board\.sketch\.json to plan\.sketch\.json/);
    await f.server.app.close();
  });

  it("renames a sketch nobody has edited since it was created", async () => {
    const results: string[] = [];
    const f = await start(WRITABLE, [
      async ({ tools }) => {
        results.push(await call(tools, "agentroom_sketch_rename", { sketch: "Board", newName: "Route created" }));
        results.push(await call(tools, "agentroom_sketch_create", { name: "Fresh" }));
        results.push(await call(tools, "agentroom_sketch_rename", { sketch: "Fresh", newName: "Agent created" }));
      }
    ]);
    await f.turn();
    expect(results[0]).toMatch(/^ok: renamed board\.sketch\.json to route-created\.sketch\.json/);
    expect(results[2]).toMatch(/^ok: renamed fresh\.sketch\.json to agent-created\.sketch\.json/);
    await f.server.app.close();
  });
});

describe("session close", () => {
  it("forgets the sketch revisions a deleted session read", async () => {
    const results: string[] = [];
    const f = await start(WRITABLE, [
      async ({ tools }) => { results.push(await call(tools, "agentroom_sketch_inspect", { sketch: "Board" })); },
      async ({ tools }) => { results.push(await call(tools, "agentroom_sketch_edit", { sketch: "Board", baseRevision: 0, label: "late", operations: [box("b")] })); }
    ]);
    await f.turn();
    expect(results[0]).toContain("revision 0");
    f.server.agentSessions.turnTools.closeSession(f.session.id);
    await f.turn();
    expect(results[1]).toMatch(/^error stale_revision: revision 0 of board\.sketch\.json was not read in this session/);

    const closed = vi.spyOn(f.server.agentSessions.turnTools, "closeSession");
    expect((await f.server.app.inject({ method: "DELETE", url: `/api/agent-sessions/${f.session.id}` })).statusCode).toBe(204);
    expect(closed).toHaveBeenCalledWith(f.session.id);
    await f.server.app.close();
  });
});

describe("session question channel", () => {
  it("reports a timeout and a no as refusals, and releases what a turn left open", async () => {
    const published: string[] = [];
    const channel = new SessionQuestionChannel({ enabled: () => true, timeoutMs: 20,
      publish: (_session, _turn, activity) => published.push(`${activity.canonical?.kind}:${"status" in (activity.canonical ?? {}) ? (activity.canonical as { status: string }).status : ""}`) });
    const sets = confirmationSet("Delete it?", "Delete it");
    const timedOut = await channel.ask({ sessionId: "s", turnId: "t", sets, isLive: () => true });
    expect(confirmationRefusal(timedOut, "nothing was deleted")).toMatch(/^error confirmation_timeout/);

    const open = channel.ask({ sessionId: "s", turnId: "t", sets, isLive: () => false });
    expect(await open).toEqual({ status: "unavailable" });

    let live = true;
    const held = channel.ask({ sessionId: "s", turnId: "t", sets, isLive: () => live });
    await vi.waitFor(() => expect(published.filter((entry) => entry.startsWith("question_requested"))).toHaveLength(2));
    live = false;
    channel.release("s");
    expect(await held).toEqual({ status: "cancelled" });
    // A turn that ended already reported its open questions; nothing is published twice.
    expect(published).toEqual(["question_requested:", "question_resolved:timeout", "question_requested:"]);
    expect(channel.answer("s", "question-unknown", [])).toBeUndefined();
  });
});
