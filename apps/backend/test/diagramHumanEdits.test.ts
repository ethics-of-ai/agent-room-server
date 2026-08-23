import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../src/domain/models";
import { EventBus } from "../src/events/EventBus";
import { DiagramHumanEditTracker, describeOverrides } from "../src/scene/diagram/humanEdits";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";

const diagramPath = "docs/diagrams/checkout.diagram.json";
const humanPath = "docs/diagrams/checkout.diagram.human.json";

// A small valid base document for structure-edit tests. Tests that only exercise
// the placement half deliberately keep no base file on disk, which also covers
// the tracked-override-without-a-base state.
const checkoutBase = {
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

describe("diagram human edit tracker", () => {
  it("says nothing when the human has written no override layer", async () => {
    const fixture = await createTrackerFixture();

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
  });

  it("summarizes what the human adjusted, naming the diagram the agent edits", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([
      { id: "orders", transform: { position: [0.1, 0, 0] } },
      { id: "cache", visible: false },
      { id: "payments", locked: true },
      { id: "core", collapsed: true }
    ]);

    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain(diagramPath);
    // The base path, not the override path: the base file is the one the agent edits.
    expect(summary).not.toContain(humanPath);
    expect(summary).toContain("moved: orders");
    expect(summary).toContain("hidden: cache");
    expect(summary).toContain("locked: payments");
    expect(summary).toContain("collapsed: core");
  });

  it("frames the first delivery as on record and later ones as since your last turn", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([{ id: "orders", transform: { position: [0.1, 0, 0] } }]);

    const first = await acceptedSummary(fixture.tracker, fixture.session);
    expect(first).toContain("on record");
    expect(first).not.toContain("since your last turn");

    await fixture.writeOverride([{ id: "orders", transform: { position: [0.1, 0, 0] } }, { id: "cache", visible: false }]);
    const second = await acceptedSummary(fixture.tracker, fixture.session);
    expect(second).toContain("since your last turn");
    expect(second).toContain("hidden: cache");
    expect(second).not.toContain("moved: orders");
  });

  it("delivers a change once rather than repeating it every turn", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([{ id: "orders", locked: true }]);

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain("locked: orders");
    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
  });

  it("keeps each session's pointer independent", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([{ id: "orders", locked: true }]);
    const other = { id: "agent-session-other", workspaceId: fixture.session.workspaceId };

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain("locked: orders");
    // A second session in the same workspace has not been told yet.
    expect(await acceptedSummary(fixture.tracker, other)).toContain("locked: orders");
  });

  it("reports a cleared placement layer, which re-reading the file would not explain", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([]);

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain("placement cleared");
  });

  it("ignores writes to other files and other workspaces", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([{ id: "orders", locked: true }], { announce: false });
    fixture.announce({ workspaceId: fixture.session.workspaceId, path: "README.md" });
    fixture.announce({ workspaceId: fixture.session.workspaceId, path: "main.scene.json" });
    fixture.announce({ workspaceId: "workspace-somewhere-else", path: humanPath });

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
  });

  it("stays blind to an agent's base write, which publishes no event", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase(checkoutBase, { announce: false });

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
  });

  it("reports a human base write as a structure edit without inventing a first delta", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase(checkoutBase);

    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain(diagramPath);
    // The pre-write state was never observable, so the first report points at the
    // document instead of claiming a delta.
    expect(summary).toContain("structure: edited (re-read the document)");
  });

  it("names the structure delta once a baseline exists", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase(checkoutBase);
    await acceptedSummary(fixture.tracker, fixture.session);

    await fixture.writeBase({
      ...checkoutBase,
      name: "Checkout flow v2",
      nodes: [
        ...checkoutBase.nodes.map((node) => (node.id === "db" ? { ...node, label: "Orders Database" } : node)),
        { id: "cache", label: "Redis Cache", role: "cache" }
      ],
      edges: [...checkoutBase.edges, { id: "e3", from: "orders", to: "cache", kind: "async" }]
    });
    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain("since your last turn");
    expect(summary).toContain("added: cache");
    expect(summary).toContain("connected: orders → cache");
    expect(summary).toContain("relabelled: db");
    expect(summary).toContain("document renamed");
    expect(summary).not.toContain("edited (re-read the document)");
  });

  it("keeps a flow-only base edit salient when no compact delta category applies", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase(checkoutBase);
    await acceptedSummary(fixture.tracker, fixture.session);

    await fixture.writeBase({
      ...checkoutBase,
      flows: [{ id: "place-order", label: "Place an order", edges: ["e1", "e2"] }]
    });

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain(
      "structure: edited (re-read the document)"
    );
  });

  it("describes removals, re-roles, regrouping, kind changes, and group edits", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase({
      ...checkoutBase,
      nodes: [...checkoutBase.nodes, { id: "worker", label: "Worker", role: "function" }],
      edges: [...checkoutBase.edges, { id: "e3", from: "orders", to: "worker", kind: "async" }],
      groups: [{ id: "legacy", label: "Legacy" }]
    });
    await acceptedSummary(fixture.tracker, fixture.session);

    await fixture.writeBase({
      ...checkoutBase,
      nodes: checkoutBase.nodes.map((node) => {
        if (node.id === "db") return { ...node, role: "cache" };
        if (node.id === "orders") return { ...node, group: "core" };
        return node;
      }),
      edges: checkoutBase.edges.map((edge) => (edge.id === "e1" ? { ...edge, kind: "async" } : edge)),
      groups: [{ id: "core", label: "Core services" }]
    });
    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain("removed: worker");
    expect(summary).toContain("disconnected: orders → worker");
    expect(summary).toContain("re-roled: db");
    expect(summary).toContain("regrouped: orders");
    expect(summary).toContain("edge kind changed: api → orders");
    expect(summary).toContain("group added: core");
    expect(summary).toContain("group removed: legacy");
  });

  // Schema v3: an added, changed, or cleared description is one category —
  // "described" — naming ids only, never the text, exactly like labels.
  it("describes description edits on nodes, edges, groups, and the document", async () => {
    const fixture = await createTrackerFixture();
    const describedBase = {
      ...checkoutBase,
      schemaVersion: 3,
      groups: [{ id: "core", label: "Core" }]
    };
    await fixture.writeBase(describedBase);
    await acceptedSummary(fixture.tracker, fixture.session);

    await fixture.writeBase({
      ...describedBase,
      description: "Order lifecycle end to end.",
      nodes: describedBase.nodes.map((node) =>
        node.id === "orders" ? { ...node, description: "Owns order state." } : node
      ),
      edges: describedBase.edges.map((edge) =>
        edge.id === "e2" ? { ...edge, description: "Writes order rows." } : edge
      ),
      groups: [{ id: "core", label: "Core", description: "The core domain." }]
    });
    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain("described: orders");
    expect(summary).toContain("edge described: orders → db");
    expect(summary).toContain("group described: core");
    expect(summary).toContain("document described");
    expect(summary).not.toContain("Owns order state.");
    expect(summary).not.toContain("edited (re-read the document)");
  });

  it("merges one diagram's structure and placement edits into a single line", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase(checkoutBase);
    await fixture.writeOverride([{ id: "orders", transform: { position: [0.1, 0, 0] } }]);

    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary!.split(diagramPath).length - 1).toBe(1);
    expect(summary).toContain("structure: edited (re-read the document)");
    expect(summary).toContain(" | placement: moved: orders");
  });

  it("reports adjustments newly orphaned by an agent's base rewrite", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase({
      ...checkoutBase,
      nodes: [...checkoutBase.nodes, { id: "cache", label: "Redis Cache", role: "cache" }]
    });
    await fixture.writeOverride([{ id: "cache", transform: { position: [0.2, 0, 0] } }]);
    expect(await acceptedSummary(fixture.tracker, fixture.session)).not.toContain("orphaned");

    // The agent regenerates the base without `cache` — no event, so nothing is
    // reported until the human's next write surfaces the comparison.
    await fixture.writeBase(checkoutBase, { announce: false });
    await fixture.writeOverride([
      { id: "cache", transform: { position: [0.2, 0, 0] } },
      { id: "orders", locked: true }
    ]);
    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain("locked: orders");
    expect(summary).toContain("orphaned human adjustments (override ids the base no longer declares): cache");

    // Salience, not nagging: a standing orphan the session already learned of is
    // not repeated on the next write.
    await fixture.writeOverride([
      { id: "cache", transform: { position: [0.2, 0, 0] } },
      { id: "orders", locked: true, visible: false }
    ]);
    const next = await acceptedSummary(fixture.tracker, fixture.session);
    expect(next).toContain("hidden: orders");
    expect(next).not.toContain("orphaned");
  });

  it("reports standing orphans on a session's first delivery", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeBase(checkoutBase, { announce: false });
    await fixture.writeOverride([{ id: "ghost", locked: true }]);

    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain("locked: ghost");
    expect(summary).toContain("orphaned human adjustments (override ids the base no longer declares): ghost");
  });

  it("skips an unparseable base document instead of failing the summary", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeRawBase("{ not json");

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
    // The accepted turn advances past the broken file, so it is skipped once.
    await fixture.writeBase(checkoutBase);
    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain("structure: edited");
  });

  it("skips an unparseable override layer instead of failing or re-reporting it", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeRaw("{ not json");

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
    // The accepted turn advances past the broken file, so it is skipped once.
    await fixture.writeOverride([{ id: "orders", locked: true }]);
    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain("locked: orders");
  });

  it("skips an override layer that fails the strict schema", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeRaw(JSON.stringify({ schemaVersion: 1, overrides: [{ id: "orders", nope: true }] }));

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
  });

  it("releases a deleted session's pointer", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([{ id: "orders", locked: true }]);
    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeDefined();

    fixture.eventBus.publish("agent_session_deleted", { sessionId: fixture.session.id });

    // A fresh session reusing the id starts blind again rather than inheriting a pointer.
    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain("locked: orders");
  });

  it("bounds how many diagrams one turn reports and says how many it dropped", async () => {
    const fixture = await createTrackerFixture();
    for (let index = 0; index < 6; index += 1) {
      const base = `docs/diagrams/d${index}.diagram.json`;
      await fixture.writeOverrideAt(base, [{ id: "orders", locked: true }]);
    }

    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain("docs/diagrams/d0.diagram.json");
    expect(summary).toContain("docs/diagrams/d3.diagram.json");
    expect(summary).not.toContain("docs/diagrams/d4.diagram.json");
    expect(summary).toContain("(+2 more diagrams adjusted)");
  });

  it("stops subscribing once disposed", async () => {
    const fixture = await createTrackerFixture();
    fixture.tracker.dispose();
    await fixture.writeOverride([{ id: "orders", locked: true }]);

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toBeUndefined();
  });

  it("reports reversals and resets as changes since the accepted turn", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([
      { id: "orders", transform: { position: [0.1, 0, 0] }, locked: true },
      { id: "cache", visible: false },
      { id: "core", collapsed: true }
    ]);
    await acceptedSummary(fixture.tracker, fixture.session);

    await fixture.writeOverride([]);
    const summary = await acceptedSummary(fixture.tracker, fixture.session);

    expect(summary).toContain("placement reset: orders");
    expect(summary).toContain("shown: cache");
    expect(summary).toContain("unlocked: orders");
    expect(summary).toContain("expanded: core");
  });

  it("reports a subsequent drag of an already moved id", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([{ id: "orders", transform: { position: [0.1, 0, 0] } }]);
    await acceptedSummary(fixture.tracker, fixture.session);

    await fixture.writeOverride([{ id: "orders", transform: { position: [0.2, 0, 0] } }]);

    expect(await acceptedSummary(fixture.tracker, fixture.session)).toContain("moved: orders");
  });

  it("does not consume an edit summary until the prospective turn is acknowledged", async () => {
    const fixture = await createTrackerFixture();
    await fixture.writeOverride([{ id: "orders", locked: true }]);

    const rejected = await fixture.tracker.prepareSummaryForTurn(fixture.session);
    expect(rejected?.summary).toContain("locked: orders");
    // A rejected turn never invokes acknowledge(), so a retry is told again.
    expect((await fixture.tracker.prepareSummaryForTurn(fixture.session))?.summary).toContain("locked: orders");

    rejected?.acknowledge();
    expect(await fixture.tracker.prepareSummaryForTurn(fixture.session)).toBeUndefined();
  });
});

describe("diagram human override description", () => {
  it("caps how many ids one category names", () => {
    const overrides = Array.from({ length: 11 }, (_, index) => ({
      id: `node-${index}`,
      locked: true as const
    }));

    const described = describeOverrides({ schemaVersion: 1, overrides });

    expect(described).toContain("node-0");
    expect(described).toContain("node-7");
    expect(described).not.toContain("node-8");
    expect(described).toContain("(+3 more)");
  });

  it("lists an entry under every adjustment it carries", () => {
    const described = describeOverrides({
      schemaVersion: 1,
      overrides: [{ id: "orders", transform: { position: [0, 1, 0] }, locked: true }]
    });

    expect(described).toBe("moved: orders; locked: orders");
  });
});

async function serviceConfig(): Promise<ServiceConfig> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-diagram-human-edits-"));
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

type OverrideEntry = Parameters<typeof describeOverrides>[0]["overrides"][number];

async function createTrackerFixture(): Promise<{
  tracker: DiagramHumanEditTracker;
  eventBus: EventBus;
  session: { id: string; workspaceId: string };
  announce(payload: { workspaceId: string; path: string }): void;
  writeOverride(overrides: OverrideEntry[], options?: { announce?: boolean }): Promise<void>;
  writeOverrideAt(basePath: string, overrides: OverrideEntry[]): Promise<void>;
  writeRaw(content: string): Promise<void>;
  writeBase(document: unknown, options?: { announce?: boolean }): Promise<void>;
  writeRawBase(content: string): Promise<void>;
}> {
  const config = await serviceConfig();
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "agentroom-diagram-human-edits-workspace-"));
  await mkdir(join(workspaceDirectory, "docs", "diagrams"), { recursive: true });
  const registry = new LocalWorkspaceRegistry(config);
  const registered = await registry.register({ path: workspaceDirectory });
  const explorer = new WorkspaceExplorer(registry);
  const eventBus = new EventBus();
  const tracker = new DiagramHumanEditTracker({ eventBus, explorer });
  const session = { id: "agent-session-test", workspaceId: registered.workspace.id };

  const announce = (payload: { workspaceId: string; path: string }): void => {
    // The shape the bounded workspace PUT publishes today.
    eventBus.publish("workspace_file_written", { ...payload, sizeBytes: 1, created: false });
  };
  const writeAt = async (path: string, content: string, shouldAnnounce: boolean): Promise<void> => {
    await writeFile(join(workspaceDirectory, path), content, "utf8");
    if (shouldAnnounce) announce({ workspaceId: session.workspaceId, path });
  };

  return {
    tracker,
    eventBus,
    session,
    announce,
    async writeOverride(overrides, options = {}) {
      await writeAt(humanPath, JSON.stringify({ schemaVersion: 1, overrides }), options.announce !== false);
    },
    async writeOverrideAt(basePath, overrides) {
      const path = basePath.replace(/\.diagram\.json$/, ".diagram.human.json");
      await writeAt(path, JSON.stringify({ schemaVersion: 1, overrides }), true);
    },
    async writeRaw(content) {
      await writeAt(humanPath, content, true);
    },
    async writeBase(document, options = {}) {
      await writeAt(diagramPath, JSON.stringify(document), options.announce !== false);
    },
    async writeRawBase(content) {
      await writeAt(diagramPath, content, true);
    }
  };
}

async function acceptedSummary(
  tracker: DiagramHumanEditTracker,
  session: { id: string; workspaceId: string }
): Promise<string | undefined> {
  const prepared = await tracker.prepareSummaryForTurn(session);
  prepared?.acknowledge();
  return prepared?.summary;
}
