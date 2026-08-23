import { describe, expect, it } from "vitest";
import { DIAGRAM_GROUP_LANE_Z, layoutDiagram } from "../src/scene/diagram/layout";
import type { DiagramDocument } from "../src/scene/diagram/schemas";

function document(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    schemaVersion: 1,
    kind: "solution",
    name: "Test diagram",
    nodes: [
      { id: "actor", label: "Actor", role: "actor", group: "edge" },
      { id: "api", label: "API", role: "service", group: "core" },
      { id: "db", label: "DB", role: "datastore", group: "data" }
    ],
    edges: [
      { id: "calls", from: "actor", to: "api", kind: "sync" },
      { id: "writes", from: "api", to: "db", kind: "read_write" }
    ],
    groups: [
      { id: "edge", label: "Edge" },
      { id: "core", label: "Core" },
      { id: "data", label: "Data" }
    ],
    ...overrides
  };
}

// Proper intersections between node-centre segments, excluding pairs that
// share an endpoint — the same definition the orderer's acceptance metric
// uses, applied to the layout's real output positions.
function countCrossings(
  layout: ReturnType<typeof layoutDiagram>,
  edges: DiagramDocument["edges"]
): number {
  const positions = new Map(layout.nodes.map((node) => [node.id, node.position]));
  const orient = (p: number[], q: number[], r: number[]): number => {
    const value = (q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!);
    return Math.abs(value) < 1e-9 ? 0 : Math.sign(value);
  };
  let count = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i]!;
      const b = edges[j]!;
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      const [p, q, r, s] = [
        positions.get(a.from)!,
        positions.get(a.to)!,
        positions.get(b.from)!,
        positions.get(b.to)!
      ];
      const o1 = orient(p, q, r);
      const o2 = orient(p, q, s);
      const o3 = orient(r, s, p);
      const o4 = orient(r, s, q);
      if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4) count += 1;
    }
  }
  return count;
}

describe("layoutDiagram", () => {
  it("is deterministic and places longest-path tiers top-down", () => {
    const input = document();
    const first = layoutDiagram(input);
    const second = layoutDiagram(input);

    expect(second).toEqual(first);
    expect(first.nodes.map((node) => [node.id, node.tier, node.position[1]])).toEqual([
      ["actor", 0, 0],
      ["api", 1, -0.28],
      ["db", 2, -0.56]
    ]);
    expect(first.groups.map((group) => group.position[1])).toEqual([-0.06, -0.34, -0.62]);
  });

  it("keeps grouped nodes atomic and wraps after eight nodes", () => {
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      role: "service",
      group: "core"
    }));
    const result = layoutDiagram(document({
      nodes,
      edges: [],
      groups: [{ id: "core", label: "Core" }]
    }));

    expect(new Set(result.nodes.map((node) => node.tier))).toEqual(new Set([0]));
    expect(result.groups[0]).toMatchObject({ tier: 0, width: 1.46, depth: 0.35 });
    expect(new Set(result.nodes.map((node) => node.position[2])).size).toBe(2);
  });

  it("drops document-order DFS back edges to lay out cycles deterministically", () => {
    const result = layoutDiagram(document({
      nodes: [
        { id: "a", label: "A", role: "service" },
        { id: "b", label: "B", role: "service" },
        { id: "c", label: "C", role: "service" }
      ],
      edges: [
        { id: "ab", from: "a", to: "b", kind: "sync" },
        { id: "bc", from: "b", to: "c", kind: "sync" },
        { id: "ca", from: "c", to: "a", kind: "sync" }
      ],
      groups: []
    }));

    expect(result.nodes.map((node) => [node.id, node.tier])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2]
    ]);
  });

  // The seeding sweep cannot fix this one: a source tier has no parents, so it
  // stays in document order [a, b, c], and tier 1's best answer against that
  // order still crosses (a→y over b→x). The upward sweep reorders the sources
  // by their children — [b, a, c] — and the crossing disappears; the final
  // downward sweep then confirms tier 1's order rather than undoing the fix.
  it("uncrosses edges a single downward barycenter pass leaves crossed", () => {
    const input = document({
      nodes: [
        { id: "a", label: "A", role: "service" },
        { id: "b", label: "B", role: "service" },
        { id: "c", label: "C", role: "service" },
        { id: "x", label: "X", role: "service" },
        { id: "y", label: "Y", role: "service" }
      ],
      edges: [
        { id: "ay", from: "a", to: "y", kind: "sync" },
        { id: "bx", from: "b", to: "x", kind: "sync" },
        { id: "cy", from: "c", to: "y", kind: "sync" }
      ],
      groups: []
    });
    const result = layoutDiagram(input);
    const x = (id: string): number => result.nodes.find((node) => node.id === id)!.position[0];

    // Deterministic across recomputes, like the single pass before it.
    expect(layoutDiagram(input)).toEqual(result);
    // Sources reordered by their children: b's only child sits left of y.
    expect(x("b")).toBeLessThan(x("a"));
    expect(x("a")).toBeLessThan(x("c"));
    expect(x("x")).toBeLessThan(x("y"));
    // No edge crosses another: every edge now runs to the same side.
    expect(Math.sign(x("y") - x("a"))).toBe(Math.sign(x("x") - x("b")));
  });

  // Barycenter refinement is not monotone: comparing a rank in one tier
  // against a rank in another can pull an atom toward a "matching" rank that
  // sits somewhere else entirely once widths are laid out. In this found
  // regression, the up sweep drags n6 leftward toward n5 (both rank 0 in
  // their tiers) and crosses n0→n4 over n6→n5 — an ordering the seeded pass
  // drew crossing-free. The orderer must reject a candidate that crosses
  // more than the best ordering so far.
  it("never accepts a refinement that crosses more than the seeded order", () => {
    const input = document({
      nodes: Array.from({ length: 7 }, (_, index) => ({
        id: `n${index}`,
        label: `N${index}`,
        role: "service"
      })),
      edges: [
        { id: "e0", from: "n4", to: "n5", kind: "sync" },
        { id: "e1", from: "n0", to: "n4", kind: "sync" },
        { id: "e2", from: "n6", to: "n5", kind: "sync" }
      ],
      groups: []
    });
    const result = layoutDiagram(input);

    expect(layoutDiagram(input)).toEqual(result);
    expect(countCrossings(result, input.edges)).toBe(0);
  });

  // The refinement sweeps must not move what they know nothing about: an atom
  // with no neighbour on the sweep's side keeps its slot, so the final
  // downward pass cannot dump every source at the end and undo the upward one.
  it("keeps atoms without sweep-side neighbours in their seeded position", () => {
    const result = layoutDiagram(document({
      nodes: [
        { id: "solo", label: "Solo", role: "service" },
        { id: "a", label: "A", role: "service" },
        { id: "x", label: "X", role: "service" }
      ],
      edges: [{ id: "ax", from: "a", to: "x", kind: "sync" }],
      groups: []
    }));
    const x = (id: string): number => result.nodes.find((node) => node.id === id)!.position[0];

    // Document order seeded solo before a, and no sweep had reason to move it.
    expect(x("solo")).toBeLessThan(x("a"));
  });

  // Phase 4: groups take alternating ± z lanes by document order, so a
  // grouped document has depth to walk around instead of standing as a flat
  // poster. Ungrouped atoms stay on the z = 0 plane the palette drop and the
  // rest of the layout reason about.
  it("separates groups into alternating z lanes and keeps ungrouped nodes on the plane", () => {
    const result = layoutDiagram(document({
      nodes: [
        { id: "actor", label: "Actor", role: "actor", group: "edge" },
        { id: "api", label: "API", role: "service", group: "core" },
        { id: "solo", label: "Solo", role: "service" }
      ],
      edges: [{ id: "calls", from: "actor", to: "api", kind: "sync" }],
      groups: [
        { id: "edge", label: "Edge" },
        { id: "core", label: "Core" }
      ]
    }));
    const nodeZ = (id: string): number => result.nodes.find((node) => node.id === id)!.position[2];
    const groupZ = (id: string): number => result.groups.find((group) => group.id === id)!.position[2];

    expect(groupZ("edge")).toBe(DIAGRAM_GROUP_LANE_Z);
    expect(groupZ("core")).toBe(-DIAGRAM_GROUP_LANE_Z);
    // Members stand on their group's lane; a single row adds no local spread.
    expect(nodeZ("actor")).toBe(DIAGRAM_GROUP_LANE_Z);
    expect(nodeZ("api")).toBe(-DIAGRAM_GROUP_LANE_Z);
    expect(nodeZ("solo")).toBe(0);
  });

  // The lane is a document-order assignment over groups, so a third group
  // shares the first's lane rather than walking deeper — two lanes carry the
  // depth reading; a staircase would leave the container.
  it("reuses the two lanes rather than deepening with every group", () => {
    const result = layoutDiagram(document());

    expect(result.groups.map((group) => group.position[2])).toEqual([
      DIAGRAM_GROUP_LANE_Z,
      -DIAGRAM_GROUP_LANE_Z,
      DIAGRAM_GROUP_LANE_Z
    ]);
  });

  it("uses document order as the stable fallback for disconnected nodes", () => {
    const result = layoutDiagram(document({
      nodes: [
        { id: "z", label: "Z", role: "service" },
        { id: "a", label: "A", role: "service" }
      ],
      edges: [],
      groups: []
    }));

    expect(result.nodes[0]!.position[0]).toBeLessThan(result.nodes[1]!.position[0]);
  });
});
