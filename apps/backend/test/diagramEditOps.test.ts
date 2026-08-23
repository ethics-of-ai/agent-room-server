import { describe, expect, it } from "vitest";
import { serializeDiagramDocument } from "../src/scene/diagram/canonical";
import { composeDiagram } from "../src/scene/diagram/compose";
import {
  MAX_DIAGRAM_EDIT_OPS,
  applyDiagramEdits,
  type DiagramEditOp
} from "../src/scene/diagram/editOps";
import {
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_GROUPS,
  MAX_DIAGRAM_NODES,
  diagramDocumentSchema,
  type DiagramDocument
} from "../src/scene/diagram/schemas";

const baseDocument = (overrides: Partial<DiagramDocument> = {}): DiagramDocument => ({
  schemaVersion: 2,
  kind: "solution",
  name: "Checkout",
  nodes: [
    { id: "api", label: "API", role: "gateway" },
    { id: "orders", label: "Orders", role: "service", group: "core" },
    { id: "db", label: "Orders DB", role: "datastore", group: "core" }
  ],
  edges: [
    { id: "e1", from: "api", to: "orders", kind: "sync" },
    { id: "e2", from: "orders", to: "db", label: "SQL", kind: "read_write" }
  ],
  groups: [{ id: "core", label: "Core" }],
  flows: [{ id: "place-order", label: "Place order", edges: ["e1", "e2"] }],
  ...overrides
});

const asContent = (document: DiagramDocument): string => JSON.stringify(document);

const apply = (ops: DiagramEditOp[], document: DiagramDocument = baseDocument()) =>
  applyDiagramEdits({ baseContent: asContent(document), ops });

const expectOk = (result: ReturnType<typeof applyDiagramEdits>) => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result;
};

const expectError = (result: ReturnType<typeof applyDiagramEdits>) => {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  return result;
};

describe("diagram edit ops", () => {
  it("creates a document from nothing for the New Diagram path", () => {
    const result = expectOk(
      applyDiagramEdits({
        name: "Payments",
        ops: [
          { op: "addNode", label: "Payments API", role: "gateway" },
          { op: "addNode", label: "Ledger", role: "datastore" },
          { op: "addEdge", fromId: "payments-api", toId: "ledger", kind: "read_write" }
        ]
      })
    );
    expect(result.document.name).toBe("Payments");
    expect(result.document.schemaVersion).toBe(3);
    expect(result.document.nodes.map((node) => node.id)).toEqual(["payments-api", "ledger"]);
    expect(result.document.edges).toEqual([
      { id: "e1", from: "payments-api", to: "ledger", kind: "read_write" }
    ]);
    expect(result.created).toEqual([
      { opIndex: 0, type: "node", id: "payments-api" },
      { opIndex: 1, type: "node", id: "ledger" },
      { opIndex: 2, type: "edge", id: "e1" }
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("defaults the created document's name when none is given", () => {
    const result = expectOk(
      applyDiagramEdits({ ops: [{ op: "addNode", label: "Solo", role: "service" }] })
    );
    expect(result.document.name).toBe("New diagram");
  });

  it("derives node ids from labels with the collision ladder", () => {
    const result = expectOk(
      apply([
        { op: "addNode", label: "Orders", role: "service" },
        { op: "addNode", label: "Orders", role: "service" }
      ])
    );
    // "orders" is taken by the base document; the ladder appends ordinals.
    expect(result.created.map((entry) => entry.id)).toEqual(["orders-2", "orders-3"]);
  });

  it("places a created node into an existing group and rejects an unknown one", () => {
    const ok = expectOk(apply([{ op: "addNode", label: "Cache", role: "cache", groupId: "core" }]));
    expect(ok.document.nodes.find((node) => node.id === "cache")?.group).toBe("core");

    const bad = expectError(apply([{ op: "addNode", label: "Cache", role: "cache", groupId: "nope" }]));
    expect(bad.errors).toEqual([{ opIndex: 0, message: 'Unknown group id "nope"' }]);
  });

  it("allocates the smallest unused edge ordinal, refilling delete gaps", () => {
    const result = expectOk(
      apply([
        { op: "deleteEdge", edgeId: "e1" },
        { op: "addEdge", fromId: "api", toId: "db" }
      ])
    );
    const added = result.created[0]!;
    expect(added).toEqual({ opIndex: 1, type: "edge", id: "e1" });
    const edge = result.document.edges.find((candidate) => candidate.id === "e1")!;
    expect(edge.from).toBe("api");
    expect(edge.kind).toBe("sync");
  });

  it("rejects an edge with unknown or identical endpoints", () => {
    const unknown = expectError(apply([{ op: "addEdge", fromId: "api", toId: "ghost" }]));
    expect(unknown.errors[0]!.message).toBe('Unknown node id "ghost"');

    const selfLoop = expectError(apply([{ op: "addEdge", fromId: "api", toId: "api" }]));
    expect(selfLoop.errors[0]!.message).toBe("Edge endpoints must be different");
  });

  it("sets labels, roles, and kinds, and clears an edge label with null", () => {
    const result = expectOk(
      apply([
        { op: "setNodeLabel", nodeId: "api", label: "Public API" },
        { op: "setNodeRole", nodeId: "api", role: "service" },
        { op: "setEdgeKind", edgeId: "e1", kind: "async" },
        { op: "setEdgeLabel", edgeId: "e1", label: "events" },
        { op: "setEdgeLabel", edgeId: "e2", label: null }
      ])
    );
    const api = result.document.nodes.find((node) => node.id === "api")!;
    expect(api.label).toBe("Public API");
    expect(api.role).toBe("service");
    const e1 = result.document.edges.find((edge) => edge.id === "e1")!;
    expect(e1.kind).toBe("async");
    expect(e1.label).toBe("events");
    expect(result.document.edges.find((edge) => edge.id === "e2")!.label).toBeUndefined();
  });

  it("sets and clears descriptions on nodes, edges, groups, and the document", () => {
    const withDescriptions = expectOk(
      apply([
        { op: "setNodeDescription", nodeId: "orders", description: "Owns order state." },
        { op: "setEdgeDescription", edgeId: "e2", description: "Writes order rows." },
        { op: "setGroupDescription", groupId: "core", description: "The core domain." },
        { op: "setDescription", description: "Order lifecycle end to end." }
      ])
    );
    expect(withDescriptions.document.nodes.find((node) => node.id === "orders")!.description)
      .toBe("Owns order state.");
    expect(withDescriptions.document.edges.find((edge) => edge.id === "e2")!.description)
      .toBe("Writes order rows.");
    expect(withDescriptions.document.groups[0]!.description).toBe("The core domain.");
    expect(withDescriptions.document.description).toBe("Order lifecycle end to end.");
    expect(withDescriptions.warnings).toEqual([]);
    expect(withDescriptions.created).toEqual([]);

    const cleared = expectOk(
      applyDiagramEdits({
        baseContent: serializeDiagramDocument(withDescriptions.document),
        ops: [
          { op: "setNodeDescription", nodeId: "orders", description: null },
          { op: "setEdgeDescription", edgeId: "e2", description: null },
          { op: "setGroupDescription", groupId: "core", description: null },
          { op: "setDescription", description: null }
        ]
      })
    );
    expect(cleared.document.nodes.find((node) => node.id === "orders")!.description).toBeUndefined();
    expect(cleared.document.edges.find((edge) => edge.id === "e2")!.description).toBeUndefined();
    expect(cleared.document.groups[0]!.description).toBeUndefined();
    expect(cleared.document.description).toBeUndefined();
  });

  it("reports an unknown id for every set op", () => {
    const cases: DiagramEditOp[] = [
      { op: "setNodeLabel", nodeId: "ghost", label: "X" },
      { op: "setNodeRole", nodeId: "ghost", role: "service" },
      { op: "setEdgeKind", edgeId: "ghost", kind: "sync" },
      { op: "setEdgeLabel", edgeId: "ghost", label: "X" },
      { op: "setNodeGroup", nodeId: "ghost", groupId: null },
      { op: "setNodeDescription", nodeId: "ghost", description: "X" },
      { op: "setEdgeDescription", edgeId: "ghost", description: "X" },
      { op: "setGroupDescription", groupId: "ghost", description: "X" }
    ];
    for (const op of cases) {
      const result = expectError(apply([op]));
      expect(result.errors[0]!.opIndex).toBe(0);
      expect(result.errors[0]!.message).toContain("Unknown");
    }
  });

  it("deleting a node drops its edges with warnings and trims flows", () => {
    const result = expectOk(apply([{ op: "deleteNode", nodeId: "orders" }]));
    expect(result.document.nodes.map((node) => node.id)).toEqual(["api", "db"]);
    expect(result.document.edges).toEqual([]);
    // Both flow steps referenced dropped edges, so the flow is removed and the
    // canonical form omits the key entirely.
    expect(result.document.flows).toBeUndefined();
    const messages = result.warnings.map((warning) => warning.message);
    expect(messages).toContain('Edge "e1" from "api" to "orders" dropped with node "orders"');
    expect(messages).toContain('Edge "e2" from "orders" to "db" dropped with node "orders"');
    expect(messages.some((message) => message.startsWith('Flow "place-order"'))).toBe(true);
  });

  it("deleting one edge keeps the flow's surviving steps", () => {
    const result = expectOk(apply([{ op: "deleteEdge", edgeId: "e1" }]));
    expect(result.document.flows).toEqual([
      { id: "place-order", label: "Place order", edges: ["e2"] }
    ]);
    expect(result.warnings).toEqual([
      {
        opIndex: 0,
        message: 'Flow "place-order" dropped 1 step(s) that referenced deleted edge "e1"'
      }
    ]);
  });

  it("adds, reassigns, clears, and deletes groups", () => {
    const result = expectOk(
      apply([
        { op: "addGroup", label: "Edge Tier" },
        { op: "setNodeGroup", nodeId: "api", groupId: "edge-tier" },
        { op: "setNodeGroup", nodeId: "orders", groupId: null },
        { op: "deleteGroup", groupId: "core" }
      ])
    );
    expect(result.created).toEqual([{ opIndex: 0, type: "group", id: "edge-tier" }]);
    const nodes = new Map(result.document.nodes.map((node) => [node.id, node]));
    expect(nodes.get("api")!.group).toBe("edge-tier");
    expect(nodes.get("orders")!.group).toBeUndefined();
    // Only db was still in core when it was deleted.
    expect(nodes.get("db")!.group).toBeUndefined();
    expect(result.document.groups).toEqual([{ id: "edge-tier", label: "Edge Tier" }]);
    expect(result.warnings).toEqual([
      { opIndex: 3, message: '1 member node(s) of group "core" ungrouped' }
    ]);
  });

  it("renames the document with setName", () => {
    const result = expectOk(apply([{ op: "setName", name: "Checkout v2" }]));
    expect(result.document.name).toBe("Checkout v2");
  });

  it("fails fast on the first inapplicable op and applies nothing after it", () => {
    const result = expectError(
      apply([
        { op: "deleteNode", nodeId: "ghost" },
        { op: "setName", name: "Never applied" }
      ])
    );
    expect(result.errors).toEqual([{ opIndex: 0, message: 'Unknown node id "ghost"' }]);
  });

  it("enforces the document caps at op time", () => {
    const fullNodes = baseDocument({
      nodes: Array.from({ length: MAX_DIAGRAM_NODES }, (_, index) => ({
        id: `n${index}`,
        label: `Node ${index}`,
        role: "service"
      })),
      edges: [],
      groups: [],
      flows: undefined
    });
    const nodeCap = expectError(apply([{ op: "addNode", label: "One more", role: "service" }], fullNodes));
    expect(nodeCap.errors[0]!.message).toContain(`maximum of ${MAX_DIAGRAM_NODES} nodes`);

    const fullGroups = baseDocument({
      groups: Array.from({ length: MAX_DIAGRAM_GROUPS }, (_, index) => ({
        id: `g${index}`,
        label: `Group ${index}`
      })),
      nodes: [{ id: "api", label: "API", role: "service" }],
      edges: [],
      flows: undefined
    });
    const groupCap = expectError(apply([{ op: "addGroup", label: "One more" }], fullGroups));
    expect(groupCap.errors[0]!.message).toContain(`maximum of ${MAX_DIAGRAM_GROUPS} groups`);

    const twoNodes = [
      { id: "a", label: "A", role: "service" },
      { id: "b", label: "B", role: "service" }
    ];
    const fullEdges = baseDocument({
      nodes: twoNodes,
      edges: Array.from({ length: MAX_DIAGRAM_EDGES }, (_, index) => ({
        id: `e${index + 1}`,
        from: "a",
        to: "b",
        kind: "sync"
      })),
      groups: [],
      flows: undefined
    });
    const edgeCap = expectError(apply([{ op: "addEdge", fromId: "a", toId: "b" }], fullEdges));
    expect(edgeCap.errors[0]!.message).toContain(`maximum of ${MAX_DIAGRAM_EDGES} edges`);
  });

  it("upgrades an older base document on its first edit", () => {
    const v1 = baseDocument({ schemaVersion: 1, flows: undefined });
    const result = expectOk(apply([{ op: "setName", name: "Upgraded" }], v1));
    expect(result.document.schemaVersion).toBe(3);
  });

  it("rejects a base document that is not JSON or not a diagram", () => {
    const notJson = expectError(
      applyDiagramEdits({ baseContent: "{ nope", ops: [{ op: "setName", name: "X" }] })
    );
    expect(notJson.errors[0]!.message).toContain("not valid JSON");
    expect(notJson.errors[0]!.opIndex).toBeUndefined();

    const notDiagram = expectError(
      applyDiagramEdits({
        baseContent: JSON.stringify({ schemaVersion: 2, kind: "solution" }),
        ops: [{ op: "setName", name: "X" }]
      })
    );
    expect(notDiagram.errors.length).toBeGreaterThan(0);
    expect(notDiagram.errors[0]!.path).toBeDefined();
  });

  it("caps reported warnings", () => {
    // A node with 55 incident edges: deleting it warns once per edge.
    const hub = baseDocument({
      nodes: [
        { id: "hub", label: "Hub", role: "service" },
        ...Array.from({ length: 55 }, (_, index) => ({
          id: `n${index}`,
          label: `Node ${index}`,
          role: "service"
        }))
      ],
      edges: Array.from({ length: 55 }, (_, index) => ({
        id: `e${index + 1}`,
        from: "hub",
        to: `n${index}`,
        kind: "sync"
      })),
      groups: [],
      flows: undefined
    });
    const result = expectOk(apply([{ op: "deleteNode", nodeId: "hub" }], hub));
    expect(result.warnings.length).toBe(51);
    expect(result.warnings[50]!.message).toContain("more warnings");
  });

  it("is deterministic: identical input produces identical output", () => {
    const input = {
      baseContent: asContent(baseDocument()),
      ops: [
        { op: "addNode", label: "Cache", role: "cache" },
        { op: "addEdge", fromId: "orders", toId: "cache", kind: "async" }
      ] as DiagramEditOp[]
    };
    const first = applyDiagramEdits(input);
    const second = applyDiagramEdits(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("bounds an op batch at the payload schema level", () => {
    expect(MAX_DIAGRAM_EDIT_OPS).toBe(32);
  });

  // The corpus property test: every successful edit's output parses as
  // canonical text, stays schema-valid, and composes without throwing — and
  // when the ops use only the closed vocabulary, without unknown-vocab
  // warnings either.
  it("corpus: every successful edit round-trips, validates, and composes clean", () => {
    const corpus: Array<{ baseContent?: string; name?: string; ops: DiagramEditOp[] }> = [
      {
        name: "From nothing",
        ops: [
          { op: "addNode", label: "API", role: "gateway" },
          { op: "addNode", label: "Queue", role: "queue" },
          { op: "addEdge", fromId: "api", toId: "queue", kind: "async", label: "jobs" }
        ]
      },
      {
        baseContent: asContent(baseDocument()),
        ops: [
          { op: "addGroup", label: "Edge" },
          { op: "setNodeGroup", nodeId: "api", groupId: "edge" },
          { op: "setNodeLabel", nodeId: "db", label: "Primary DB" }
        ]
      },
      {
        baseContent: asContent(baseDocument()),
        ops: [
          { op: "deleteNode", nodeId: "db" },
          { op: "addNode", label: "Orders DB", role: "datastore", groupId: "core" },
          { op: "addEdge", fromId: "orders", toId: "orders-db", kind: "read_write" }
        ]
      },
      {
        baseContent: asContent(baseDocument({ schemaVersion: 1, flows: undefined })),
        ops: [
          { op: "setEdgeKind", edgeId: "e1", kind: "async" },
          { op: "setEdgeLabel", edgeId: "e1", label: "events" },
          { op: "setName", name: "Renamed" }
        ]
      },
      {
        baseContent: asContent(baseDocument()),
        ops: [
          { op: "deleteGroup", groupId: "core" },
          { op: "deleteEdge", edgeId: "e2" },
          { op: "addNode", label: "External Billing", role: "external" },
          { op: "addEdge", fromId: "orders", toId: "external-billing" }
        ]
      }
    ];
    for (const input of corpus) {
      const result = applyDiagramEdits(input);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) {
        continue;
      }
      const serialized = serializeDiagramDocument(result.document);
      expect(serialized.endsWith("\n")).toBe(true);
      const reparsed = diagramDocumentSchema.safeParse(JSON.parse(serialized));
      expect(reparsed.success, JSON.stringify(reparsed.success ? {} : reparsed.error.issues)).toBe(
        true
      );
      const composed = composeDiagram(result.document, undefined);
      expect(composed.warnings.filter((warning) => warning.startsWith("Unknown"))).toEqual([]);
    }
  });
});
