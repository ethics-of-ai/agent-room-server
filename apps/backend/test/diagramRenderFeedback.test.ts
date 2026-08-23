import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../src/domain/models";
import { EventBus } from "../src/events/EventBus";
import { DiagramRenderFeedbackTracker } from "../src/scene/diagram/renderFeedback";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";

const diagramPath = "docs/diagrams/checkout.diagram.json";

// A schema-valid document whose vocabulary is entirely inside the palette, so
// it composes with no warnings.
const cleanBase = {
  schemaVersion: 2,
  kind: "solution",
  name: "Checkout flow",
  nodes: [
    { id: "api", label: "API Gateway", role: "gateway" },
    { id: "orders", label: "Orders Service", role: "service" },
    { id: "db", label: "Orders DB", role: "datastore" }
  ],
  edges: [
    { id: "e1", from: "api", to: "orders", kind: "sync" },
    { id: "e2", from: "orders", to: "db", kind: "read_write" }
  ],
  groups: []
};

// Open-vocabulary values the schema accepts but compose renders as generics
// plus warnings — the exact case the feedback loop exists for.
const warningBase = {
  ...cleanBase,
  nodes: [...cleanBase.nodes, { id: "redis", label: "Redis", role: "cacheish" }],
  edges: [...cleanBase.edges, { id: "e3", from: "orders", to: "redis", kind: "grpc" }]
};

// A reference failure the strict schema rejects: renders as an error card.
const invalidBase = {
  ...cleanBase,
  edges: [{ id: "e1", from: "api", to: "missing", kind: "sync" }]
};

describe("diagram render feedback tracker", () => {
  it("says nothing when no settled turn wrote a diagram", async () => {
    const fixture = await createFeedbackFixture();

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("relays compose warnings from the settled turn's diagram write", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    const summary = await fixture.acceptedSummary();

    expect(summary).toContain(diagramPath);
    expect(summary).toContain("rendered with 2 warnings");
    expect(summary).toContain('Unknown role "cacheish" on node "redis"');
    expect(summary).toContain('Unknown edge kind "grpc" on edge "e3"');
  });

  it("relays validation errors that render as an error card", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, invalidBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "modified" }] });

    const summary = await fixture.acceptedSummary();

    expect(summary).toContain("does not render; validation errors:");
    expect(summary).toContain('base.edges.0.to: Unknown target node id "missing"');
  });

  it("relays a diagram that is not valid JSON", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeRaw(diagramPath, "{ not json");
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    expect(await fixture.acceptedSummary()).toContain("does not render: file is not valid JSON");
  });

  it("relays a diagram past the 256 KB cap, which cannot render at all", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeRaw(diagramPath, `{"padding":"${"x".repeat(300 * 1024)}"}`);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    expect(await fixture.acceptedSummary()).toContain("exceeds the 256 KB cap and cannot render");
  });

  it("stays silent for a clean render", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, cleanBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("ignores non-diagram files and turns it never saw start", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeRaw("README.md", "# hi");
    await fixture.settleTurn({
      files: [
        { path: "README.md", status: "modified" },
        { path: "docs/diagrams/checkout.diagram.human.json", status: "modified" },
        { path: "main.scene.json", status: "added" }
      ]
    });
    // A diff for a turn with no recorded start (another process's id) is inert.
    fixture.eventBus.publish("coding_diff_updated", {
      sessionId: fixture.session.id,
      turnId: "agent-turn-unknown",
      files: [{ path: diagramPath, status: "added" }]
    });
    fixture.eventBus.publish("coding_turn_completed", {
      sessionId: fixture.session.id,
      turnId: "agent-turn-unknown"
    });
    await fixture.tracker.settled();

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("skips a diagram the diff names but the workspace cannot read", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.settleTurn({ files: [{ path: "docs/diagrams/ghost.diagram.json", status: "added" }] });

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("delivers feedback once and keeps it for a rejected turn's retry", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    const rejected = await fixture.tracker.prepareSummaryForTurn(fixture.session);
    expect(rejected?.summary).toContain("rendered with 2 warnings");
    // A rejected turn never invokes acknowledge(), so a retry is told again.
    expect((await fixture.tracker.prepareSummaryForTurn(fixture.session))?.summary).toContain("rendered with 2 warnings");

    rejected?.acknowledge();
    expect(await fixture.tracker.prepareSummaryForTurn(fixture.session)).toBeUndefined();
  });

  it("lets a later clean settle supersede a pending report before delivery", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    await fixture.writeDiagram(diagramPath, cleanBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "modified" }] });

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("drops a pending report when a later turn deletes the diagram", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    await fixture.removeFile(diagramPath);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "deleted" }] });

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("reports a cancelled turn's partial diagram write too", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }], terminal: "coding_turn_cancelled" });

    expect(await fixture.acceptedSummary()).toContain("rendered with 2 warnings");
  });

  it("takes the turn's latest diff summary rather than unioning the stream", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    const turnId = fixture.startTurn();
    // Codex streams the whole turn diff cumulatively; an early event naming a
    // diagram the final diff no longer contains must not settle it.
    fixture.publishDiff(turnId, [{ path: diagramPath, status: "added" }]);
    fixture.publishDiff(turnId, [{ path: "README.md", status: "modified" }]);
    fixture.publishTerminal(turnId, "coding_turn_completed");
    await fixture.tracker.settled();

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("bounds how many diagrams one settlement validates and counts the rest", async () => {
    const fixture = await createFeedbackFixture();
    const paths: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const path = `docs/diagrams/d${index}.diagram.json`;
      paths.push(path);
      await fixture.writeDiagram(path, warningBase);
    }
    await fixture.settleTurn({ files: paths.map((path) => ({ path, status: "added" })) });

    const summary = await fixture.acceptedSummary();

    expect(summary).toContain("docs/diagrams/d0.diagram.json");
    expect(summary).toContain("docs/diagrams/d3.diagram.json");
    expect(summary).not.toContain("docs/diagrams/d4.diagram.json");
    expect(summary).toContain("(+2 more diagram writes not checked)");
  });

  it("keeps sessions independent and releases a deleted session's feedback", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });
    const other = { id: "agent-session-other" };

    expect(await fixture.tracker.prepareSummaryForTurn(other)).toBeUndefined();

    fixture.eventBus.publish("agent_session_deleted", { sessionId: fixture.session.id });
    expect(await fixture.tracker.prepareSummaryForTurn(fixture.session)).toBeUndefined();
  });

  it("stops subscribing once disposed", async () => {
    const fixture = await createFeedbackFixture();
    fixture.tracker.dispose();
    await fixture.writeDiagram(diagramPath, warningBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("waits out the settling turn's validation when the next prompt assembles immediately", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    const turnId = fixture.startTurn();
    fixture.publishDiff(turnId, [{ path: diagramPath, status: "added" }]);
    fixture.publishTerminal(turnId, "coding_turn_completed");

    // No settled() drain: a queued turn can assemble its prompt the instant the
    // terminal event lands, and preparation must await the in-flight reads.
    expect(await fixture.acceptedSummary()).toContain("rendered with 2 warnings");
  });

  it("acknowledges only the reports the capped summary actually delivered", async () => {
    const fixture = await createFeedbackFixture();
    // Four diagrams whose validation-error lines are each ~500 characters, so
    // the 1200-char cap fits only the first per delivery.
    const longId = (index: number): string => `${"x".repeat(58)}-${index}`;
    const paths: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const path = `docs/diagrams/very-long-diagram-name-number-${index}.diagram.json`;
      paths.push(path);
      await fixture.writeDiagram(path, {
        ...cleanBase,
        nodes: [{ id: "api", label: "API Gateway", role: "gateway" }],
        edges: Array.from({ length: 4 }, (_, edge) => ({
          id: `e${edge}`,
          from: "api",
          to: longId(edge),
          kind: "sync"
        }))
      });
    }
    await fixture.settleTurn({ files: paths.map((path) => ({ path, status: "added" })) });

    const first = await fixture.acceptedSummary();
    expect(first!.length).toBeLessThanOrEqual(1200);
    expect(first).toContain(paths[0]!);
    expect(first).not.toContain(paths[1]!);
    expect(first).toContain("(+3 more diagrams with pending feedback)");

    // The squeezed-out reports were not consumed; the next turn gets the next one.
    const second = await fixture.acceptedSummary();
    expect(second).toContain(paths[1]!);
    expect(second).not.toContain(paths[0]!);
  });

  it("does not resurrect feedback for a session deleted mid-validation", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, warningBase);
    const turnId = fixture.startTurn();
    fixture.publishDiff(turnId, [{ path: diagramPath, status: "added" }]);
    fixture.publishTerminal(turnId, "coding_turn_completed");
    // Deletion lands while the settlement read is still in flight.
    fixture.eventBus.publish("agent_session_deleted", { sessionId: fixture.session.id });
    await fixture.tracker.settled();

    expect(await fixture.acceptedSummary()).toBeUndefined();
  });

  it("clears a renamed-away diagram's pending report and validates the destination", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, invalidBase);
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    const renamedPath = "docs/diagrams/checkout-v2.diagram.json";
    await fixture.writeDiagram(renamedPath, warningBase);
    await fixture.removeFile(diagramPath);
    await fixture.settleTurn({
      files: [{ path: renamedPath, oldPath: diagramPath, status: "renamed" }]
    });

    const summary = await fixture.acceptedSummary();

    expect(summary).toContain(renamedPath);
    expect(summary).toContain("rendered with 2 warnings");
    expect(summary).not.toContain(`- ${diagramPath}`);
    expect(summary).not.toContain("does not render");
  });

  it("caps how many details one diagram's report names", async () => {
    const fixture = await createFeedbackFixture();
    await fixture.writeDiagram(diagramPath, {
      ...cleanBase,
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `n${index}`,
        label: `Node ${index}`,
        role: `mystery-${index}`
      })),
      edges: []
    });
    await fixture.settleTurn({ files: [{ path: diagramPath, status: "added" }] });

    const summary = await fixture.acceptedSummary();

    expect(summary).toContain("rendered with 6 warnings");
    expect(summary).toContain('Unknown role "mystery-3"');
    expect(summary).not.toContain('Unknown role "mystery-4"');
    expect(summary).toContain("(+2 more)");
  });
});

async function serviceConfig(): Promise<ServiceConfig> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-diagram-render-feedback-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    codexRunnerProtocol: "exec"
  };
}

async function createFeedbackFixture(): Promise<{
  tracker: DiagramRenderFeedbackTracker;
  eventBus: EventBus;
  session: { id: string; workspaceId: string };
  startTurn(): string;
  publishDiff(turnId: string, files: Array<{ path: string; oldPath?: string; status: string }>): void;
  publishTerminal(turnId: string, type: "coding_turn_completed" | "coding_turn_failed" | "coding_turn_cancelled"): void;
  settleTurn(input: {
    files: Array<{ path: string; oldPath?: string; status: string }>;
    terminal?: "coding_turn_completed" | "coding_turn_failed" | "coding_turn_cancelled";
  }): Promise<void>;
  writeDiagram(path: string, document: unknown): Promise<void>;
  writeRaw(path: string, content: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  acceptedSummary(): Promise<string | undefined>;
}> {
  const config = await serviceConfig();
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "agentroom-diagram-render-feedback-workspace-"));
  await mkdir(join(workspaceDirectory, "docs", "diagrams"), { recursive: true });
  const registry = new LocalWorkspaceRegistry(config);
  const registered = await registry.register({ path: workspaceDirectory });
  const explorer = new WorkspaceExplorer(registry);
  const eventBus = new EventBus();
  const tracker = new DiagramRenderFeedbackTracker({ eventBus, explorer });
  const session = { id: "agent-session-test", workspaceId: registered.workspace.id };
  let turnCounter = 0;

  const startTurn = (): string => {
    turnCounter += 1;
    const turnId = `agent-turn-${turnCounter}`;
    // The shapes the session service publishes today.
    eventBus.publish("agent_turn_started", {
      sessionId: session.id,
      turnId,
      workspaceId: session.workspaceId,
      workspacePath: workspaceDirectory,
      runnerKind: "codex"
    });
    return turnId;
  };
  const publishDiff = (turnId: string, files: Array<{ path: string; oldPath?: string; status: string }>): void => {
    eventBus.publish("coding_diff_updated", {
      version: 1,
      sessionId: session.id,
      turnId,
      runnerKind: "codex",
      files
    });
  };
  const publishTerminal = (
    turnId: string,
    type: "coding_turn_completed" | "coding_turn_failed" | "coding_turn_cancelled"
  ): void => {
    eventBus.publish(type, { version: 1, sessionId: session.id, turnId, runnerKind: "codex" });
  };

  return {
    tracker,
    eventBus,
    session,
    startTurn,
    publishDiff,
    publishTerminal,
    async settleTurn(input) {
      const turnId = startTurn();
      publishDiff(turnId, input.files);
      publishTerminal(turnId, input.terminal ?? "coding_turn_completed");
      await tracker.settled();
    },
    async writeDiagram(path, document) {
      await writeFile(join(workspaceDirectory, path), JSON.stringify(document), "utf8");
    },
    async writeRaw(path, content) {
      await writeFile(join(workspaceDirectory, path), content, "utf8");
    },
    async removeFile(path) {
      await rm(join(workspaceDirectory, path));
    },
    async acceptedSummary() {
      const prepared = await tracker.prepareSummaryForTurn(session);
      prepared?.acknowledge();
      return prepared?.summary;
    }
  };
}
