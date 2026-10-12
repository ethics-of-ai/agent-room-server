import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advertisedAgentTools } from "../src/agentTools/dispatch";
import { advertisedJsonSchema } from "../src/agentTools/jsonSchema";
import { QUESTIONS_ASK_LOGICAL_ID } from "../src/agentTools/questionAsk";
import { agentToolByLogicalId } from "../src/agentTools/catalog";
import type { AgentRoomEvent } from "../src/events/eventTypes";
import type { AgentRunner, AgentRunnerInput, AgentRunnerToolSet } from "../src/runner/AgentRunner";
import { agentStartParamsSchema } from "../src/runner/cursor/protocol";
import { AGENTROOM_TOOLS_MAX_FRAME_BYTES, encodeToolMessage } from "../src/runner/deepseek/cordis/protocol";
import { registerExternalRunnerDescriptors, type RunnerDescriptor } from "../src/runner/registry";
import { bindCursorTurnTools, disposeCursorTurnTools } from "../src/runner/cursor/toolRelay";
import type { CursorActiveTurn, CursorRunnerSession } from "../src/runner/cursor/types";
import { prepareDeepSeekNativeTools } from "../src/runner/deepseek/nativeTools";
import { PendingQuestionRequests } from "../src/runner/shared/PendingQuestionRequests";
import { PLAN_TOOL_IDS } from "../src/plans/planTools";
import { buildServer } from "../src/server";
import { SKETCH_TOOL_RESULT_BYTES } from "../src/sketch/agent/sketchInspect";
import {
  SKETCH_TOOLS_INSTRUCTION,
  SKETCH_TOOLS_UNAVAILABLE_RESULT,
  SKETCH_TOOL_IDS,
  sketchToolInputSchemas
} from "../src/sketch/agent/sketchToolContract";
import { repositorySketchBytes } from "../src/sketch/SketchWorkspaceFiles";
import { createSketchState } from "../src/sketch/core";
import { config, registerWorkspaceOffline, waitForSession } from "./support/agentSessionHarness";
import { READ_ONLY, UNREADABLE, WRITABLE, box, call, moveTo, start } from "./support/sketchToolHarness";

/**
 * Stage 2 of docs/plans/LIVE_AGENT_SKETCH_PLAN.md: the inspect and edit tools
 * through a fixture runner's bound tool set, against the real repository
 * sketch service, while the person edits through the HTTP routes.
 */

afterEach(() => registerExternalRunnerDescriptors([]));

describe("sketch tool catalog", () => {
  it("registers strict definitions under the sketches capability, derived from the canonical schemas", () => {
    expect(SKETCH_TOOL_IDS).toEqual([
      "sketches.list", "sketches.inspect", "sketches.create", "sketches.edit", "sketches.history", "sketches.rename", "sketches.delete"
    ]);
    for (const logicalId of SKETCH_TOOL_IDS) {
      const definition = agentToolByLogicalId(logicalId);
      expect(definition).toMatchObject({ requiredCapability: "sketches", unavailableResult: SKETCH_TOOLS_UNAVAILABLE_RESULT });
      expect(definition?.inputSchema).toEqual(advertisedJsonSchema(sketchToolInputSchemas[logicalId]));
      expect(definition?.inputSchema.additionalProperties).toBe(false);
      expect(sketchToolInputSchemas[logicalId].safeParse({ sketch: "a.sketch.json", unexpected: true }).success).toBe(false);
      expect(sketchToolInputSchemas[logicalId].safeParse({ unexpected: true }).success).toBe(false);
    }
    expect(agentToolByLogicalId("sketches.list")?.name).toBe("agentroom_sketch_list");
    expect(agentToolByLogicalId("sketches.inspect")?.name).toBe("agentroom_sketch_inspect");
    expect(agentToolByLogicalId("sketches.edit")?.name).toBe("agentroom_sketch_edit");
    const edit = agentToolByLogicalId("sketches.edit")?.inputSchema as any;
    expect(edit.required).toEqual(["sketch", "baseRevision", "label", "operations"]);
    expect(edit.properties.operations).toMatchObject({ minItems: 1, maxItems: 32 });
    // Every operation the core accepts from a caller is expressible.
    const leaves = (node: any): any[] => node.anyOf ? node.anyOf.flatMap(leaves) : [node];
    const ops = leaves(edit.properties.operations.items).map((entry) => entry.properties.op.enum[0]);
    expect([...new Set(ops)].sort()).toEqual(["clear", "create", "delete", "group", "transform", "ungroup", "update"]);
    expect(ops).toHaveLength(15);
  });

  it("fits every transport's catalog limits beside the question and plan tools", () => {
    const catalog = advertisedAgentTools([QUESTIONS_ASK_LOGICAL_ID, ...PLAN_TOOL_IDS, ...SKETCH_TOOL_IDS]);
    expect(agentStartParamsSchema.shape.tools.safeParse(catalog).success).toBe(true);
    const frame = encodeToolMessage({ version: 1, type: "catalog", catalog });
    expect(Buffer.byteLength(frame, "utf8")).toBeLessThan(AGENTROOM_TOOLS_MAX_FRAME_BYTES);
    for (const tool of catalog) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("sketch tools in agent sessions", () => {
  it("edits a sketch live by path while the person draws elsewhere, and refuses an overlapping step", async () => {
    const results: Record<string, string> = {};
    let peopleDraw: (() => Promise<void>) | undefined;
    const f = await start(WRITABLE, [
      async ({ tools }) => {
        results.inspect = await call(tools, "agentroom_sketch_inspect", { sketch: f.path });
        results.first = await call(tools, "agentroom_sketch_edit", {
          sketch: f.path, baseRevision: 1, label: "align boxes", operations: [moveTo("a", 0.3), moveTo("b", 0.6)]
        });
        await peopleDraw?.();
        // Based on revision 2, after the person drew at revision 3: disjoint, so it lands.
        results.second = await call(tools, "agentroom_sketch_edit", {
          sketch: f.path, baseRevision: 2, label: "label boxes", operations: [{
            op: "create", objectId: "caption", kind: "textBox", text: "Boxes", size: [0.4, 0.1],
            appearance: "none", fillColor: "#ffffff", outlineColor: "#000000"
          }]
        });
        // Still based on revision 2, but the person moved b at revision 3.
        results.overlap = await call(tools, "agentroom_sketch_edit", {
          sketch: f.path, baseRevision: 2, label: "nudge b", operations: [moveTo("b", 0.9)]
        });
      }
    ]);
    await f.human("draw-a", [box("a"), box("b", 0.2)]);
    peopleDraw = async () => { await f.human("person-moves-b", [moveTo("b", -1), box("person-stroke-free", 2)]); };
    await f.turn();

    expect(f.runner.inputs[0]?.tools?.binding.allowedNames).toEqual(expect.arrayContaining(["agentroom_sketch_inspect", "agentroom_sketch_edit"]));
    expect(f.runner.inputs[0]?.prompt).toContain(SKETCH_TOOLS_INSTRUCTION.split("\n")[0]);
    expect(results.inspect).toContain("revision 1, 2 object(s)");
    expect(results.inspect).toContain('"id":"a","kind":"box"');
    expect(results.first).toMatch(/^ok: committed "align boxes" as revision 2/);
    expect(results.first).toContain("Changed: a, b.");
    expect(results.second).toMatch(/^ok: committed "label boxes" as revision 4/);
    expect(results.overlap).toMatch(/^error stale_revision: Objects "b" changed after revision 2/);
    expect(results.overlap).toContain("The sketch is now at revision 4");
    expect(results.overlap).toContain('"id":"b","kind":"box"');
    expect(results.overlap).toContain("retry with baseRevision 4");

    const sketch = await f.read();
    const byId = new Map(sketch.document.objects.map((object: any) => [object.id, object]));
    expect((byId.get("a") as any).transform.translation).toEqual([0.3, 0.5, 0]);
    // The person's move of b survives the agent's refused nudge, and nothing they drew is lost.
    expect((byId.get("b") as any).transform.translation).toEqual([-1, 0.5, 0]);
    expect(byId.has("person-stroke-free")).toBe(true);
    expect(byId.has("caption")).toBe(true);
    expect(sketch.undoHead).toEqual({ label: "label boxes", actorKind: "agent" });

    const changes = f.events.filter((event) => event.type === "sketch_document_changed").map((event) => event.payload as any);
    const agentChanges = changes.filter((payload) => payload.actorKind === "agent");
    expect(agentChanges.map((payload) => payload.revision)).toEqual([2, 4]);
    for (const payload of agentChanges) {
      expect(payload).toMatchObject({ sessionId: f.session.id, turnId: f.runner.inputs[0]?.runId, kind: "commit" });
    }
    for (const payload of changes.filter((entry) => entry.actorKind === "human")) {
      expect(payload).not.toHaveProperty("sessionId");
      expect(payload).not.toHaveProperty("turnId");
    }
    // Only the person's create and two commits announce a human file write.
    expect(f.events.filter((event) => event.type === "workspace_file_written")).toHaveLength(3);
    const serialized = JSON.stringify(f.events);
    expect(serialized).not.toContain("label boxes");
    expect(serialized).not.toContain("Boxes");
    await f.server.app.close();
  });

  it("lists the workspace's sketches and finds one by title or id", async () => {
    const results: string[] = [];
    const f = await start(WRITABLE, [async ({ tools }) => {
      results.push(await call(tools, "agentroom_sketch_list", {}));
      results.push(await call(tools, "agentroom_sketch_list", { filter: "BOARD" }));
      results.push(await call(tools, "agentroom_sketch_inspect", { sketch: "Board" }));
      results.push(await call(tools, "agentroom_sketch_inspect", { sketch: f.sketch.sketchId }));
      results.push(await call(tools, "agentroom_sketch_inspect", { sketch: "Bored" }));
    }]);
    await writeFile(join(f.workspace.path, "notes.sketch.json"), "broken");
    await f.turn();
    expect(results[0]).toMatch(/^ok: 2 sketch\(es\) in this session's workspace/);
    expect(results[0]).toContain('"title":"board","path":"board.sketch.json"');
    expect(results[0]).toContain('"by":"person"');
    expect(results[0]).toContain('"path":"notes.sketch.json","state":"invalid","reason":"invalid_document"');
    expect(results[1]).toMatch(/^ok: 1 sketch\(es\) matching "BOARD"/);
    expect(results[2]).toContain('Sketch "board" at board.sketch.json');
    expect(results[3]).toContain('Sketch "board" at board.sketch.json');
    expect(results[4]).toMatch(/^error unknown_sketch: no sketch "Bored" in this session's workspace\. Closest titles: "board"/);
    await f.server.app.close();
  });

  it("acts only inside the session's own workspace", async () => {
    const results: string[] = [];
    let otherPath = "";
    const f = await start(WRITABLE, [
      async ({ tools }) => {
        for (const sketch of ["../outside.sketch.json", "/etc/passwd.sketch.json", otherPath, "linked.sketch.json", "notes.txt", "missing.sketch.json"]) {
          results.push(await call(tools, "agentroom_sketch_inspect", { sketch }));
        }
        results.push(await call(tools, "agentroom_sketch_edit", { sketch: "linked.sketch.json", baseRevision: 0, label: "x", operations: [box("z")] }));
      }
    ]);
    const other = await registerWorkspaceOffline(f.serviceConfig);
    await writeFile(join(other.path, "other-only.sketch.json"), repositorySketchBytes(createSketchState("other").document));
    otherPath = "other-only.sketch.json";
    await symlink(join(other.path, "other-only.sketch.json"), join(f.workspace.path, "linked.sketch.json"));
    await f.turn();
    for (const result of results.slice(0, 6)) expect(result).toMatch(/^error unknown_sketch/);
    expect(results[6]).toMatch(/^error unknown_sketch/);
    expect(await readFile(join(other.path, "other-only.sketch.json"), "utf8")).toBe(repositorySketchBytes(createSketchState("other").document));
    await f.server.app.close();
  });

  it.each([
    [READ_ONLY, /^error read_only: Fixture sketch_read_only_fixture is configured read-only/],
    [UNREADABLE, /^error read_only: sketch editing is not available on Fixture sketch_unreadable_fixture yet/]
  ])("refuses edits when %s cannot write, and still inspects", async (kind, refusal) => {
    const results: string[] = [];
    const f = await start(kind, [
      async ({ tools }) => {
        results.push(await call(tools, "agentroom_sketch_inspect", { sketch: f.path }));
        results.push(await call(tools, "agentroom_sketch_edit", { sketch: f.path, baseRevision: 0, label: "x", operations: [box("z")] }));
      }
    ]);
    await f.turn();
    expect(results[0]).toContain("revision 0, 0 object(s)");
    expect(results[1]).toMatch(refusal);
    expect((await f.read()).revision).toBe(0);
    await f.server.app.close();
  });

  it("keeps inspect within 48 KiB and says what it left out", async () => {
    let result = "";
    let detail = "";
    const f = await start(WRITABLE, [
      async ({ tools }) => {
        result = await call(tools, "agentroom_sketch_inspect", { sketch: f.path });
        detail = await call(tools, "agentroom_sketch_inspect", { sketch: f.path, detail: ["s0", "s1", "s2", "missing"] });
      }
    ]);
    const document = createSketchState(f.sketch.sketchId).document;
    const helix = Array.from({ length: 2000 }, (_, index) => [Math.cos(index / 10) * 0.123456, index * 0.000123, Math.sin(index / 10) * 0.123456]);
    document.objects = [
      ...Array.from({ length: 6 }, (_, index) => ({ id: `s${index}`, kind: "stroke", points: helix, width: 0.005, brush: "finePen", lineStyle: "solid" })),
      ...Array.from({ length: 900 }, (_, index) => ({ id: `box-${index}`, kind: "box", size: [0.01, 0.01, 0.01], color: "#336699" }))
    ] as never;
    await writeFile(join(f.workspace.path, f.path), repositorySketchBytes(document));
    await f.turn();
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(SKETCH_TOOL_RESULT_BYTES);
    expect(result).toMatch(/\(\d+ more object\(s\) left out to stay within the result limit\.\)/);
    expect(result).toContain('"id":"s0","kind":"stroke"');
    expect(result).toContain('"points":2000');
    expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(SKETCH_TOOL_RESULT_BYTES);
    expect(detail).toContain("Detail left out to stay within the result limit:");
    expect(detail).toContain("No object with id: missing.");
    await f.server.app.close();
  });

  it("names the field a malformed operation got wrong", async () => {
    let result = "";
    const f = await start(WRITABLE, [async ({ tools }) => {
      await call(tools, "agentroom_sketch_inspect", { sketch: f.path });
      result = await call(tools, "agentroom_sketch_edit", { sketch: f.path, baseRevision: 1, label: "move", operations: [
        { op: "transform", objectId: "a", transform: { translation: [0.2, 0, 0] } }
      ] });
    }]);
    await f.human("draw-a", [box("a")]);
    await f.turn();
    expect(result).toMatch(/^error invalid_request: operations\.0\.transform\.rotation: Required; operations\.0\.transform\.scale: Required/);
    await f.server.app.close();
  });

  it("refuses a call from a turn that has ended", async () => {
    let saved: AgentRunnerToolSet | undefined;
    const f = await start(WRITABLE, [async ({ tools }) => { saved = tools; }]);
    await f.turn();
    expect(await call(saved, "agentroom_sketch_edit", { sketch: f.path, baseRevision: 0, label: "late", operations: [box("late")] }))
      .toBe(SKETCH_TOOLS_UNAVAILABLE_RESULT);
    expect((await f.read()).revision).toBe(0);
    await f.server.app.close();
  });

  it("keeps plan and sketch tools callable through Cursor's and DeepSeek's question tool merges", async () => {
    const results: string[] = [];
    const f = await start(WRITABLE, [
      async (input) => {
        const cursorTurn = { runId: "cursor-run", completed: false } as unknown as CursorActiveTurn;
        const cursorSession = { key: "cursor-session", activeTurn: cursorTurn } as unknown as CursorRunnerSession;
        const deepseek = prepareDeepSeekNativeTools({ turn: input, questions: new PendingQuestionRequests(), isLive: () => true, emit: () => {} });
        const merges = [
          bindCursorTurnTools({ session: cursorSession, turn: cursorTurn, questionIds: [QUESTIONS_ASK_LOGICAL_ID],
            questions: new PendingQuestionRequests(), ...(input.tools ? { sessionTools: input.tools } : {}) }),
          deepseek.tools
        ];
        try {
          for (const merged of merges) {
            expect(merged.catalog.map((entry) => entry.name)).toEqual([
              "create_plan", "get_plan", "edit_plan", "execute_plan", "update_plan_step", "finish_plan",
              "agentroom_sketch_list", "agentroom_sketch_inspect", "agentroom_sketch_create", "agentroom_sketch_edit",
              "agentroom_sketch_history", "agentroom_sketch_rename", "agentroom_sketch_delete", "ask_user_question"
            ]);
            expect(merged.instructions).toContain(SKETCH_TOOLS_INSTRUCTION.split("\n")[0]);
            results.push(await call(merged, "agentroom_sketch_inspect", { sketch: f.path }));
            results.push(await call(merged, "get_plan", {}));
          }
        } finally {
          disposeCursorTurnTools(cursorSession);
          deepseek.dispose();
        }
      }
    ]);
    await f.turn();
    expect(results).toHaveLength(4);
    for (const index of [0, 2]) expect(results[index]).toContain("revision 0");
    for (const index of [1, 3]) expect(JSON.parse(results[index]!)).toMatchObject({ ok: true, plan: null });
    await f.server.app.close();
  });

  it("reports whether a session's thread has the sketch tools", async () => {
    const f = await start(WRITABLE, []);
    expect(f.session.sketchToolsAvailable).toBe(true);
    // The turn that starts the thread records the catalog it registered.
    await f.turn();
    const started = (await f.server.app.inject({ method: "GET", url: `/api/agent-sessions/${f.session.id}` })).json().session;
    expect(started.threadAgentToolIds).toEqual([...PLAN_TOOL_IDS, ...SKETCH_TOOL_IDS]);
    expect(started.sketchToolsAvailable).toBe(true);
    // A thread that already existed keeps the catalog it started with, and a
    // session from before the field existed reports false.
    const restored = { ...f.session, runner: { nativeSessionId: "native-1" } };
    delete restored.sketchToolsAvailable;
    f.server.agentSessions.turnTools.describe(restored);
    expect(restored.sketchToolsAvailable).toBe(false);
    // A thread that recorded its catalog reports from it: only a catalog with
    // every sketch tool counts.
    for (const [ids, expected] of [[SKETCH_TOOL_IDS, true], [["sketches.inspect", "sketches.edit"], false]] as const) {
      const recorded = { ...restored, threadAgentToolIds: [...PLAN_TOOL_IDS, ...ids] };
      delete recorded.sketchToolsAvailable;
      f.server.agentSessions.turnTools.describe(recorded);
      expect(recorded.sketchToolsAvailable).toBe(expected);
    }
    await f.server.app.close();
  });

  it("leaves sketchToolsAvailable off when the runner offers no sketch tools", async () => {
    // Codex offers agent tools only over JSON-RPC, so a new thread on `exec`
    // would have no sketch tools either and the client has nothing to offer.
    const f = await start(WRITABLE, [], { serviceConfig: { ...(await config()), codexRunnerProtocol: "exec" } });
    const tools = f.server.agentSessions.turnTools;
    const persisted = { ...f.session, runnerKind: "codex", sketchToolsAvailable: false };
    tools.describe(persisted);
    expect(persisted).not.toHaveProperty("sketchToolsAvailable");
    const fresh = { ...f.session, runnerKind: "codex", sketchToolsAvailable: false };
    tools.bind({ session: fresh, turnId: "turn-exec", context: undefined, isLive: () => true });
    expect(fresh.threadAgentToolIds).toEqual([]);
    expect(fresh).not.toHaveProperty("sketchToolsAvailable");
    await f.server.app.close();
  });
});

describe("sketch tool workspace setup", () => {
  it("does not create directories for an agent", async () => {
    let result = "";
    const f = await start(WRITABLE, [async ({ tools }) => { result = await call(tools, "agentroom_sketch_inspect", { sketch: "deep/dir/x.sketch.json" }); }]);
    await mkdir(join(f.workspace.path, "deep"), { recursive: true });
    await f.turn();
    expect(result).toMatch(/^error unknown_sketch/);
    await f.server.app.close();
  });
});
