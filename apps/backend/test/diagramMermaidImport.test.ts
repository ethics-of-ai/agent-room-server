import { describe, expect, it } from "vitest";
import { composeDiagram } from "../src/scene/diagram/compose";
import {
  MAX_MERMAID_SOURCE_BYTES,
  convertMermaidToDiagram,
  mermaidDiagramSlug,
  type MermaidImportResult
} from "../src/scene/diagram/mermaidImport";
import {
  MAX_DIAGRAM_EDGES,
  diagramDocumentSchema,
  type DiagramDocument
} from "../src/scene/diagram/schemas";

function convertedDocument(source: string, name?: string): DiagramDocument {
  const result = convertMermaidToDiagram(source, name === undefined ? {} : { name });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result.document;
}

function conversionErrors(source: string): Array<{ line?: number; message: string }> {
  const result = convertMermaidToDiagram(source);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  return result.errors;
}

function warningMessages(result: MermaidImportResult): string[] {
  if (!result.ok) {
    throw new Error(`expected success: ${JSON.stringify(result)}`);
  }
  return result.warnings.map((warning) => warning.message);
}

describe("convertMermaidToDiagram", () => {
  it("converts a flowchart with shapes, edge labels, and a subgraph", () => {
    const document = convertedDocument(
      [
        "flowchart TD",
        "  api[API Gateway] -->|REST| orders(Order Service)",
        "  orders --> db[(Orders DB)]",
        "  user((Customer)) --> api",
        "  worker[[Charge worker]] -.-> stripe",
        "  subgraph core[Core services]",
        "    orders",
        "    worker",
        "  end"
      ].join("\n")
    );

    expect(document).toEqual({
      schemaVersion: 3,
      kind: "solution",
      name: "Imported diagram",
      nodes: [
        { id: "api", label: "API Gateway", role: "service" },
        { id: "orders", label: "Order Service", role: "service", group: "core" },
        { id: "db", label: "Orders DB", role: "datastore" },
        { id: "user", label: "Customer", role: "actor" },
        { id: "worker", label: "Charge worker", role: "function", group: "core" },
        { id: "stripe", label: "stripe", role: "service" }
      ],
      edges: [
        { id: "e1", from: "api", to: "orders", kind: "sync", label: "REST" },
        { id: "e2", from: "orders", to: "db", kind: "sync" },
        { id: "e3", from: "user", to: "api", kind: "sync" },
        { id: "e4", from: "worker", to: "stripe", kind: "async" }
      ],
      groups: [{ id: "core", label: "Core services" }]
    });
  });

  it("parses legacy graph headers with semicolon-separated statements", () => {
    const document = convertedDocument("graph LR; a-->b; b-->c;");
    expect(document.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(document.edges).toEqual([
      { id: "e1", from: "a", to: "b", kind: "sync" },
      { id: "e2", from: "b", to: "c", kind: "sync" }
    ]);
  });

  it("emits one edge per hop of a chained statement", () => {
    const document = convertedDocument("flowchart LR\n  a --> b --> c --> d");
    expect(document.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      "a>b",
      "b>c",
      "c>d"
    ]);
  });

  it("expands ampersand lists into the cartesian product per hop", () => {
    const document = convertedDocument("flowchart TD\n  a & b --> c & d");
    expect(document.edges.map((edge) => `${edge.from}>${edge.to}`)).toEqual([
      "a>c",
      "a>d",
      "b>c",
      "b>d"
    ]);
  });

  it("rejects an oversized endpoint-list expansion before materializing its cartesian product", () => {
    const endpoints = Array.from({ length: MAX_DIAGRAM_EDGES + 1 }, () => "a").join("&");
    const errors = conversionErrors(`flowchart TD\n  ${endpoints} --> ${endpoints}`);

    expect(errors).toEqual([
      {
        line: 2,
        message: `Diagram has ${(MAX_DIAGRAM_EDGES + 1) ** 2} edges after expanding list endpoints; the maximum is ${MAX_DIAGRAM_EDGES}`
      }
    ]);
  });

  it("counts endpoint-list expansions across statements before allocating more edge records", () => {
    const endpoints = Array.from({ length: 10 }, () => "a").join("&");
    const errors = conversionErrors(
      ["flowchart TD", `  ${endpoints} --> ${endpoints}`, `  ${endpoints} --> ${endpoints}`].join("\n")
    );

    expect(errors).toEqual([
      {
        line: 3,
        message: `Diagram has 200 edges after expanding list endpoints; the maximum is ${MAX_DIAGRAM_EDGES}`
      }
    ]);
  });

  it("reads inline edge labels in both stroke families", () => {
    const document = convertedDocument(
      "flowchart LR\n  a -- reads --> b\n  a -. polls .-> c\n  a == pushes ==> d"
    );
    expect(document.edges).toEqual([
      { id: "e1", from: "a", to: "b", kind: "sync", label: "reads" },
      { id: "e2", from: "a", to: "c", kind: "async", label: "polls" },
      { id: "e3", from: "a", to: "d", kind: "sync", label: "pushes" }
    ]);
  });

  it("maps link families to kinds, including reversed and bidirectional arrows", () => {
    const document = convertedDocument(
      [
        "flowchart LR",
        "  a --> b",
        "  a ==> c",
        "  a --- d",
        "  a -.-> e",
        "  a <--> f",
        "  a <-.-> g",
        "  h <-- a"
      ].join("\n")
    );
    expect(document.edges).toEqual([
      { id: "e1", from: "a", to: "b", kind: "sync" },
      { id: "e2", from: "a", to: "c", kind: "sync" },
      { id: "e3", from: "a", to: "d", kind: "sync" },
      { id: "e4", from: "a", to: "e", kind: "async" },
      { id: "e5", from: "a", to: "f", kind: "read_write" },
      { id: "e6", from: "a", to: "g", kind: "read_write" },
      { id: "e7", from: "a", to: "h", kind: "sync" }
    ]);
  });

  it("maps circle/cross arrow ends with warnings and drops invisible links", () => {
    const result = convertMermaidToDiagram(
      "flowchart LR\n  a --o b\n  c x--x d\n  e ~~~ f"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.document.edges).toEqual([
      { id: "e1", from: "a", to: "b", kind: "sync" },
      { id: "e2", from: "c", to: "d", kind: "read_write" }
    ]);
    // The invisible link's endpoints still exist as nodes.
    expect(result.document.nodes.map((node) => node.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f"
    ]);
    expect(warningMessages(result)).toEqual([
      "Circle/cross arrow end imported as a plain connection",
      "Circle/cross arrow ends imported as a read/write connection",
      "Invisible link dropped; it is a layout hint and layout is engine-owned"
    ]);
  });

  it("flattens nested subgraphs to flat groups with innermost membership", () => {
    const result = convertMermaidToDiagram(
      [
        "flowchart TD",
        "  subgraph outer[Outer]",
        "    a",
        "    subgraph inner[Inner]",
        "      b",
        "    end",
        "  end",
        "  a --> b"
      ].join("\n")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.document.groups).toEqual([
      { id: "outer", label: "Outer" },
      { id: "inner", label: "Inner" }
    ]);
    expect(result.document.nodes).toEqual([
      { id: "a", label: "a", role: "service", group: "outer" },
      { id: "b", label: "b", role: "service", group: "inner" }
    ]);
    expect(warningMessages(result)).toEqual([
      'Nested subgraph "inner" flattened; the diagram contract keeps groups flat'
    ]);
  });

  it("drops subgraph-endpoint edges and self-loops while keeping edge ids dense", () => {
    const result = convertMermaidToDiagram(
      [
        "flowchart TD",
        "  subgraph core[Core]",
        "    a",
        "  end",
        "  core --> b",
        "  a --> a",
        "  a --> b"
      ].join("\n")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.document.edges).toEqual([{ id: "e1", from: "a", to: "b", kind: "sync" }]);
    expect(warningMessages(result)).toEqual([
      'Edge from "core" to "b" connects a subgraph and was dropped; diagram edges connect nodes',
      'Self-loop on "a" dropped; edge endpoints must differ'
    ]);
  });

  it("assigns membership from subgraph mentions, later subgraph winning with a warning", () => {
    const result = convertMermaidToDiagram(
      [
        "flowchart TD",
        "  a --> b",
        "  subgraph one[One]",
        "    a",
        "    b",
        "  end",
        "  subgraph two[Two]",
        "    b",
        "  end"
      ].join("\n")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.document.nodes).toEqual([
      { id: "a", label: "a", role: "service", group: "one" },
      { id: "b", label: "b", role: "service", group: "two" }
    ]);
    expect(warningMessages(result)).toEqual([
      'Node "b" is listed in more than one subgraph; the later one wins'
    ]);
  });

  it("sanitizes ids into the diagram grammar with deterministic collision suffixes", () => {
    // Node ids cannot contain spaces (the statement grammar splits there, as
    // Mermaid's own does); spaces reach the sanitizer through free-text
    // subgraph names.
    const result = convertMermaidToDiagram(
      [
        "flowchart TD",
        "  ☃☃[Snow] --> Api",
        "  Api --> user.db[(One)]",
        "  Api --> user-db[Two]",
        "  subgraph Core services",
        "    Api",
        "  end"
      ].join("\n")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.document.nodes).toEqual([
      { id: "n", label: "Snow", role: "service" },
      { id: "api", label: "Api", role: "service", group: "core-services" },
      { id: "user-db", label: "One", role: "datastore" },
      { id: "user-db-2", label: "Two", role: "service" }
    ]);
    expect(result.document.groups).toEqual([
      { id: "core-services", label: "Core services" }
    ]);
    expect(warningMessages(result)).toEqual([
      'Renamed "☃☃" to "n"',
      'Renamed "user.db" to "user-db"',
      'Renamed "user-db" to "user-db-2"',
      'Renamed "Core services" to "core-services"'
    ]);
  });

  it("suffixes ids that collide after sanitization and shares one namespace with groups", () => {
    const result = convertMermaidToDiagram(
      [
        "flowchart TD",
        "  order.service[One] --> b",
        "  order/service[Two] --> b",
        "  subgraph order_service[Group]",
        "    b",
        "  end"
      ].join("\n")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.document.nodes.map((node) => node.id)).toEqual([
      "order-service",
      "b",
      "order-service-2"
    ]);
    expect(result.document.groups).toEqual([{ id: "order_service", label: "Group" }]);
    expect(warningMessages(result)).toEqual([
      'Renamed "order.service" to "order-service"',
      'Renamed "order/service" to "order-service-2"'
    ]);
  });

  it("processes labels: entities, line breaks, quotes, truncation, and empty fallback", () => {
    const longLabel = "x".repeat(200);
    const result = convertMermaidToDiagram(
      [
        "flowchart TD",
        '  a["#quot;hi#quot; #amp; bye<br/>next #8594; done"] --> b[`ticked`]',
        `  c[${longLabel}] --> d[" "]`
      ].join("\n")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    const labels = new Map(result.document.nodes.map((node) => [node.id, node.label]));
    expect(labels.get("a")).toBe('"hi" & bye next → done');
    expect(labels.get("b")).toBe("ticked");
    expect(labels.get("c")).toBe("x".repeat(120));
    // An explicitly empty label falls back to the id.
    expect(labels.get("d")).toBe("d");
    expect(warningMessages(result)).toEqual(["Label truncated to 120 characters"]);
  });

  it("takes the name from options, then frontmatter title, then the default", () => {
    const withFrontmatter = ["---", "title: Checkout", "---", "flowchart TD", "  a --> b"].join(
      "\n"
    );
    expect(convertedDocument(withFrontmatter).name).toBe("Checkout");
    expect(convertedDocument(withFrontmatter, "Requested name").name).toBe("Requested name");
    expect(convertedDocument("flowchart TD\n  a --> b").name).toBe("Imported diagram");
  });

  it("rejects unsupported diagram types, missing headers, and empty sources", () => {
    expect(conversionErrors("sequenceDiagram\n  A->>B: hi")[0]!.message).toBe(
      'Unsupported Mermaid diagram type "sequencediagram"; only flowchart/graph diagrams can be imported'
    );
    expect(conversionErrors("a --> b")[0]!.message).toBe("Missing flowchart/graph header");
    expect(conversionErrors("")[0]!.message).toBe("Missing flowchart/graph header");
    expect(conversionErrors("flowchart TD")[0]!.message).toBe("Diagram contains no nodes");
  });

  it("rejects over-cap documents with a structured error instead of truncating", () => {
    const nodes = Array.from({ length: 65 }, (_, index) => `  n${index}[Node ${index}]`);
    const nodeErrors = conversionErrors(["flowchart TD", ...nodes].join("\n"));
    expect(nodeErrors[0]!.message).toBe("Diagram has 65 nodes; the maximum is 64");

    const subgraphs = Array.from({ length: 17 }, (_, index) => [
      `  subgraph g${index}[Group ${index}]`,
      `    m${index}`,
      "  end"
    ]).flat();
    const groupErrors = conversionErrors(["flowchart TD", ...subgraphs].join("\n"));
    expect(groupErrors[0]!.message).toBe("Diagram has 17 groups; the maximum is 16");
  });

  it("rejects a source over the byte cap", () => {
    const huge = `flowchart TD\n  a --> b\n%% ${"x".repeat(MAX_MERMAID_SOURCE_BYTES)}`;
    expect(conversionErrors(huge)[0]!.message).toBe(
      `Mermaid source exceeds ${MAX_MERMAID_SOURCE_BYTES} bytes`
    );
  });

  it("reports strict statement errors with 1-based lines counting skipped frontmatter", () => {
    const source = [
      "---",
      "title: Broken",
      "---",
      "flowchart TD",
      "  a --> b",
      "  a -> c"
    ].join("\n");
    const errors = conversionErrors(source);
    expect(errors).toEqual([
      {
        line: 6,
        message: expect.stringContaining("Could not parse statement on line 6")
      }
    ]);

    const v11 = conversionErrors("flowchart TD\n  a@{ shape: cyl } --> b");
    expect(v11[0]!.line).toBe(2);
    expect(v11[0]!.message).toContain('the "@{…}" node syntax is not supported');
  });

  it("reports unbalanced subgraphs with their lines", () => {
    expect(conversionErrors("flowchart TD\n  a --> b\n  end")[0]).toEqual({
      line: 3,
      message: '"end" without an open subgraph'
    });
    expect(conversionErrors("flowchart TD\n  subgraph core[Core]\n  a --> b")[0]).toEqual({
      line: 2,
      message: 'Subgraph "core" is never closed'
    });
  });

  it("lets the last explicit declaration win and never overrides from a bare mention", () => {
    const result = convertMermaidToDiagram(
      ["flowchart TD", "  a[One] --> b", "  a[(Two)] --> c", "  a --> d"].join("\n")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.document.nodes[0]).toEqual({ id: "a", label: "Two", role: "datastore" });
    expect(warningMessages(result)).toEqual([
      'Node "a" is declared more than once; the later declaration wins'
    ]);
  });

  it("keeps every successful conversion inside the schema and the closed vocabulary", () => {
    const corpus = [
      "flowchart TD\n  a[API] --> b[(DB)]",
      "graph LR; one-->two; two-->three;",
      "flowchart TB\n  a((Actor)) & b[[Fn]] --> c{Decision} & d{{Hex}}",
      "flowchart RL\n  a([Stadium]) --> b>Asym]\n  c[/Trapezoid/] --> d[\\Other\\]",
      'flowchart TD\n  a["quoted [bracket] label"] -->|"quoted | label"| b',
      "flowchart TD\n  a -- inline label --> b\n  b -. dotted .-> c\n  c == thick ==> d",
      "flowchart LR\n  a <--> b\n  b <-.-> c\n  d <-- a\n  a --o e\n  f o--o g\n  h ~~~ i\n  h --> i",
      [
        "---",
        "title: Full house",
        "---",
        "flowchart TD",
        "  %% comment line",
        "  subgraph outer[Outer]",
        "    direction LR",
        "    a",
        "    subgraph inner[Inner]",
        "      b",
        "    end",
        "  end",
        "  a --> b --> c",
        "  style a fill:#f9f",
        "  classDef default fill:#fff",
        "  linkStyle 0 stroke:red",
        "  click a callback"
      ].join("\n"),
      "flowchart TD\n  UserService[Svc] --> User-Service[Other] --> user_service[Third]",
      "flowchart TD\n  a[One] --> a[(Two)]\n  a --> a\n  subgraph a2[Group]\n    b\n  end\n  a2 --> b",
      "flowchart TD\n  ☃[Snow] --> ❄[Flake]",
      "flowchart TD\n  x --> y & z\n  y & z --> w",
      `flowchart TD\n  long[${"y".repeat(200)}] --> other`,
      "graph TD; a-->b",
      "flowchart TD\n  lonely[Only node] --> second\n  second --> lonely"
    ];
    const supportedRoles = new Set(["service", "datastore", "actor", "function"]);
    const supportedKinds = new Set(["sync", "async", "read_write"]);
    for (const source of corpus) {
      const result = convertMermaidToDiagram(source);
      expect(result.ok, `${source}\n${JSON.stringify(result)}`).toBe(true);
      if (!result.ok) {
        continue;
      }
      const parsed = diagramDocumentSchema.safeParse(result.document);
      expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
      for (const node of result.document.nodes) {
        expect(supportedRoles.has(node.role), `role ${node.role}`).toBe(true);
      }
      for (const edge of result.document.edges) {
        expect(supportedKinds.has(edge.kind), `kind ${edge.kind}`).toBe(true);
      }
      // The composed render document carries no unknown-vocabulary warnings for
      // an imported diagram, and composing never throws.
      const composed = composeDiagram(result.document, undefined);
      expect(
        composed.warnings.filter((warning) => warning.startsWith("Unknown"))
      ).toEqual([]);
    }
  });

  it("is deterministic: identical input produces identical output", () => {
    const source = [
      "flowchart TD",
      "  a[API] --> b[(DB)]",
      "  subgraph core[Core]",
      "    b",
      "  end"
    ].join("\n");
    const first = convertMermaidToDiagram(source);
    const second = convertMermaidToDiagram(source);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("mermaidDiagramSlug", () => {
  it("derives a bounded filename stem with the id sanitizer", () => {
    expect(mermaidDiagramSlug("Checkout flow")).toBe("checkout-flow");
    expect(mermaidDiagramSlug("Imported diagram")).toBe("imported-diagram");
    expect(mermaidDiagramSlug("☃☃")).toBe("imported-diagram");
  });
});
