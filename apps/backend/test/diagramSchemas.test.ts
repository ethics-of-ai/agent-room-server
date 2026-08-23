import { describe, expect, it } from "vitest";
import {
  DIAGRAM_BASE_SUFFIX,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_FLOWS,
  MAX_DIAGRAM_FLOW_STEPS,
  diagramBasePathForHumanPath,
  diagramDocumentSchema,
  diagramHumanDocumentSchema,
  diagramHumanPathForBasePath,
  isDiagramBasePath,
  isDiagramHumanPath
} from "../src/scene/diagram/schemas";

function validDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "solution",
    name: "Checkout flow",
    nodes: [
      { id: "api", label: "API", role: "service", group: "core" },
      { id: "db", label: "Database", role: "datastore", group: "core" }
    ],
    edges: [{ id: "writes", from: "api", to: "db", kind: "read_write" }],
    groups: [{ id: "core", label: "Core" }]
  };
}

describe("diagramDocumentSchema", () => {
  it("accepts a valid semantic diagram and forward-compatible vocabulary values", () => {
    const document = validDocument();
    (document.nodes as Array<Record<string, unknown>>)[0]!.role = "ml_model";
    (document.edges as Array<Record<string, unknown>>)[0]!.kind = "event_stream";

    expect(diagramDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("rejects duplicate ids and broken references", () => {
    const document = validDocument();
    (document.nodes as Array<Record<string, unknown>>).push({
      id: "api",
      label: "Duplicate",
      role: "service",
      group: "missing"
    });
    (document.edges as Array<Record<string, unknown>>)[0]!.to = "missing";

    const parsed = diagramDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'Duplicate node id "api"',
        'Unknown group id "missing"',
        'Unknown target node id "missing"'
      ]));
    }
  });

  it("rejects node/group id collisions because human override ids are bare", () => {
    const document = validDocument();
    (document.groups as Array<Record<string, unknown>>)[0]!.id = "api";
    (document.nodes as Array<Record<string, unknown>>).forEach((node) => {
      node.group = "api";
    });

    const parsed = diagramDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'Node id "api" conflicts with a group id'
      );
    }
  });

  it("rejects self-loop edges that cannot produce a straight connector", () => {
    const document = validDocument();
    (document.edges as Array<Record<string, unknown>>)[0]!.to = "api";

    const parsed = diagramDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        "Edge endpoints must be different"
      );
    }
  });

  it("keeps structural fields strict and enforces collection caps", () => {
    const withUnknownField = validDocument();
    (withUnknownField.nodes as Array<Record<string, unknown>>)[0]!.position = [0, 0, 0];
    expect(diagramDocumentSchema.safeParse(withUnknownField).success).toBe(false);

    const overCap = validDocument();
    overCap.edges = Array.from({ length: MAX_DIAGRAM_EDGES + 1 }, (_, index) => ({
      id: `edge-${index}`,
      from: "api",
      to: "db",
      kind: "sync"
    }));
    expect(diagramDocumentSchema.safeParse(overCap).success).toBe(false);
  });
});

describe("diagramHumanDocumentSchema", () => {
  it("accepts bounded field-wise overrides without a removed list", () => {
    expect(diagramHumanDocumentSchema.safeParse({
      schemaVersion: 1,
      baseline: "abc123",
      overrides: [
        { id: "api", transform: { position: [0.4, 0.2, -0.1] }, visible: false, locked: true }
      ]
    }).success).toBe(true);

    expect(diagramHumanDocumentSchema.safeParse({
      schemaVersion: 1,
      overrides: [],
      removed: ["api"]
    }).success).toBe(false);
  });

  it("accepts a collapsed flag on a group entry and still rejects unknown fields", () => {
    expect(diagramHumanDocumentSchema.safeParse({
      schemaVersion: 1,
      overrides: [{ id: "core", collapsed: true }]
    }).success).toBe(true);

    expect(diagramHumanDocumentSchema.safeParse({
      schemaVersion: 1,
      overrides: [{ id: "core", expanded: true }]
    }).success).toBe(false);
  });

  it("rejects duplicate override ids", () => {
    const parsed = diagramHumanDocumentSchema.safeParse({
      schemaVersion: 1,
      overrides: [{ id: "api" }, { id: "api" }]
    });
    expect(parsed.success).toBe(false);
  });
});

describe("diagram flows", () => {
  function flowDocument(flows: unknown): Record<string, unknown> {
    return { ...validDocument(), schemaVersion: 2, flows };
  }

  it("accepts named ordered edge sequences at the version that added them", () => {
    const parsed = diagramDocumentSchema.safeParse(
      flowDocument([{ id: "place-order", label: "Place an order", edges: ["writes"] }])
    );
    expect(parsed.success).toBe(true);
  });

  // A committed diagram authored against an older engine must keep rendering:
  // the version is a capability marker, not a tripwire.
  it("still accepts a schemaVersion 1 document with no flows", () => {
    expect(diagramDocumentSchema.safeParse(validDocument()).success).toBe(true);
  });

  it("refuses flows on a document that declares the version before them", () => {
    const parsed = diagramDocumentSchema.safeParse({
      ...flowDocument([{ id: "place-order", label: "Place an order", edges: ["writes"] }]),
      schemaVersion: 1
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        '"flows" requires schemaVersion 2'
      );
    }
  });

  it("rejects an unknown version rather than guessing what it meant", () => {
    expect(diagramDocumentSchema.safeParse({ ...validDocument(), schemaVersion: 4 }).success)
      .toBe(false);
  });

  it("rejects a step that names an edge the document does not declare", () => {
    const parsed = diagramDocumentSchema.safeParse(
      flowDocument([{ id: "place-order", label: "Place an order", edges: ["writes", "missing"] }])
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(
        "flows.0.edges.1"
      );
    }
  });

  it("rejects duplicate flow ids and an empty step list", () => {
    expect(diagramDocumentSchema.safeParse(flowDocument([
      { id: "place-order", label: "One", edges: ["writes"] },
      { id: "place-order", label: "Two", edges: ["writes"] }
    ])).success).toBe(false);

    expect(diagramDocumentSchema.safeParse(
      flowDocument([{ id: "place-order", label: "Empty", edges: [] }])
    ).success).toBe(false);
  });

  it("caps flows and their steps", () => {
    const flow = (index: number) => ({ id: `f${index}`, label: `Flow ${index}`, edges: ["writes"] });
    expect(diagramDocumentSchema.safeParse(
      flowDocument(Array.from({ length: MAX_DIAGRAM_FLOWS + 1 }, (_, index) => flow(index)))
    ).success).toBe(false);

    expect(diagramDocumentSchema.safeParse(flowDocument([{
      id: "long",
      label: "Long",
      edges: Array.from({ length: MAX_DIAGRAM_FLOW_STEPS + 1 }, () => "writes")
    }])).success).toBe(false);
  });

  // Unlike node and group ids, a flow id is never an override target, so
  // sharing a name with the service it exercises is ordinary rather than
  // ambiguous.
  it("lets a flow id match a node id", () => {
    const document = flowDocument([{ id: "api", label: "API traffic", edges: ["writes"] }]);
    expect(diagramDocumentSchema.safeParse(document).success).toBe(true);
  });

  it("lets a flow cross the same edge twice", () => {
    const document = flowDocument([
      { id: "round-trip", label: "Round trip", edges: ["writes", "writes"] }
    ]);
    expect(diagramDocumentSchema.safeParse(document).success).toBe(true);
  });
});

describe("diagram descriptions", () => {
  function describedDocument(): Record<string, unknown> {
    const document = { ...validDocument(), schemaVersion: 3 };
    document.description = "Order lifecycle from checkout to fulfilment.";
    (document.nodes as Array<Record<string, unknown>>)[0]!.description =
      "Owns order state; the only writer of the database.";
    (document.edges as Array<Record<string, unknown>>)[0]!.description = "Writes order rows.";
    (document.groups as Array<Record<string, unknown>>)[0]!.description = "The core domain.";
    return document;
  }

  it("accepts descriptions on the document, nodes, edges, and groups at version 3", () => {
    expect(diagramDocumentSchema.safeParse(describedDocument()).success).toBe(true);
  });

  it("still accepts a version 3 document with no descriptions", () => {
    expect(diagramDocumentSchema.safeParse({ ...validDocument(), schemaVersion: 3 }).success)
      .toBe(true);
  });

  // The version stays an honest capability marker: like flows at 2, a document
  // may only carry descriptions once it declares 3.
  it("refuses descriptions on a document that declares an earlier version", () => {
    const parsed = diagramDocumentSchema.safeParse({ ...describedDocument(), schemaVersion: 2 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issues = parsed.error.issues.filter(
        (issue) => issue.message === '"description" requires schemaVersion 3'
      );
      expect(issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
        "description",
        "nodes.0.description",
        "edges.0.description",
        "groups.0.description"
      ]));
    }
  });

  it("bounds a description and refuses an empty one", () => {
    const blank = describedDocument();
    (blank.nodes as Array<Record<string, unknown>>)[0]!.description = "   ";
    expect(diagramDocumentSchema.safeParse(blank).success).toBe(false);

    const oversized = describedDocument();
    (oversized.nodes as Array<Record<string, unknown>>)[0]!.description = "x".repeat(501);
    expect(diagramDocumentSchema.safeParse(oversized).success).toBe(false);

    const trimmed = describedDocument();
    (trimmed.nodes as Array<Record<string, unknown>>)[0]!.description = `  padded  `;
    const parsed = diagramDocumentSchema.safeParse(trimmed);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.nodes[0]!.description).toBe("padded");
    }
  });
});

describe("diagram path helpers", () => {
  it("classifies and maps base and human paths", () => {
    expect(DIAGRAM_BASE_SUFFIX).toBe(".diagram.json");
    expect(isDiagramBasePath("docs/diagrams/system.diagram.json")).toBe(true);
    expect(isDiagramBasePath("system.diagram.human.json")).toBe(false);
    expect(isDiagramHumanPath("system.diagram.human.json")).toBe(true);
    expect(diagramHumanPathForBasePath("docs/system.diagram.json")).toBe(
      "docs/system.diagram.human.json"
    );
    expect(diagramBasePathForHumanPath("docs/system.diagram.human.json")).toBe(
      "docs/system.diagram.json"
    );
  });
});
