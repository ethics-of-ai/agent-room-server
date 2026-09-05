import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeDiagram,
  composedDiagramVersion,
  CONNECTOR_VIA_BOW_BASE,
  CONNECTOR_VIA_BOW_MAX,
  CONNECTOR_VIA_BOW_PARALLEL_MAX,
  CONNECTOR_VIA_BOW_PARALLEL_STEP,
  CONNECTOR_VIA_CLEARANCE,
  CONNECTOR_VIA_NODE_HALF_DEPTH,
  PARALLEL_BUNDLE_MAX_HALF_WIDTH,
  PARALLEL_EDGE_SEPARATION,
  SUPPORTED_DIAGRAM_ROLES,
  type DiagramConnector,
  type SupportedDiagramRole
} from "../src/scene/diagram/compose";
import type { SpatialSceneGeometry } from "../src/scene/geometry/schemas";
import { DIAGRAM_GROUP_LANE_Z } from "../src/scene/diagram/layout";
import type { DiagramDocument, DiagramHumanDocument } from "../src/scene/diagram/schemas";

const CLIENT_BUILDER_PATH = resolve(
  __dirname,
  "../../visionos/AgentRoom/Views/SpatialScene/Rendering/SpatialSceneEntityBuilder.swift"
);
const CLIENT_CONNECTORS_PATH = resolve(
  __dirname,
  "../../visionos/AgentRoom/Views/SpatialScene/Rendering/SpatialSceneEntityBuilder+Connectors.swift"
);
const CLIENT_ROLE_BADGES_PATH = resolve(
  __dirname,
  "../../visionos/AgentRoom/Views/SpatialScene/Rendering/SpatialSceneEntityBuilder+RoleBadges.swift"
);
// The public mirror (docs/operations/OPEN_SOURCE_MIRROR.md) ships without the
// visionOS renderer, so the client-lockstep assertions run only where it is.
const clientRendererPresent = [CLIENT_BUILDER_PATH, CLIENT_CONNECTORS_PATH, CLIENT_ROLE_BADGES_PATH].every((path) =>
  existsSync(path)
);

// How far apart two connectors were pushed, measured at the endpoints that sit
// on the same node. Both endpoints of an edge shift by the same vector, so this
// is the real separation regardless of which way the offset points.
function separation(a: DiagramConnector, b: DiagramConnector): number {
  return Math.hypot(a.from[0] - b.to[0], a.from[1] - b.to[1], a.from[2] - b.to[2]);
}

function base(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    schemaVersion: 1,
    kind: "solution",
    name: "Checkout flow",
    nodes: [
      { id: "api", label: "API", role: "service" },
      { id: "db", label: "DB", role: "datastore" }
    ],
    edges: [{ id: "writes", from: "api", to: "db", kind: "read_write" }],
    groups: [],
    ...overrides
  };
}

function human(overrides: DiagramHumanDocument["overrides"]): DiagramHumanDocument {
  return { schemaVersion: 1, overrides };
}

// A group with two members and an edge crossing its boundary in each
// direction, plus one edge that stays inside it — the three cases collapsing a
// group has to answer.
function grouped(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return base({
    nodes: [
      { id: "gw", label: "Gateway", role: "gateway" },
      { id: "api", label: "API", role: "service", group: "core" },
      { id: "worker", label: "Worker", role: "function", group: "core" },
      { id: "db", label: "DB", role: "datastore" }
    ],
    edges: [
      { id: "in", from: "gw", to: "api", kind: "sync" },
      { id: "internal", from: "api", to: "worker", kind: "async" },
      { id: "out", from: "worker", to: "db", kind: "read_write" }
    ],
    groups: [{ id: "core", label: "Core" }],
    ...overrides
  });
}

function entity(document: ReturnType<typeof composeDiagram>, id: string) {
  return document.entities.find((candidate) => candidate.id === id);
}

// Local half extents of a treatment's geometry, mirroring the client's
// `localHalfExtents(for:)`.
function treatmentHalfExtents(geometry: SpatialSceneGeometry): [number, number, number] {
  switch (geometry.kind) {
    case "box":
      return [geometry.size[0] / 2, geometry.size[1] / 2, geometry.size[2] / 2];
    case "sphere":
      return [geometry.radius, geometry.radius, geometry.radius];
    case "cylinder":
    case "cone":
      return [geometry.radius, geometry.height / 2, geometry.radius];
    case "plane":
      return [geometry.width / 2, 0, geometry.depth / 2];
    case "stack": {
      const total = geometry.count * geometry.height + (geometry.count - 1) * geometry.gap;
      return [geometry.radius, total / 2, geometry.radius];
    }
  }
}

// The engine's euler contract, applied to one vector: extrinsic degrees
// [x, y, z] as qZ * qY * qX.
function rotateVector(
  vector: [number, number, number],
  [rx, ry, rz]: [number, number, number]
): [number, number, number] {
  const [x0, y0, z0] = vector;
  const y1 = y0 * Math.cos(rx) - z0 * Math.sin(rx);
  const z1 = y0 * Math.sin(rx) + z0 * Math.cos(rx);
  const x2 = x0 * Math.cos(ry) + z1 * Math.sin(ry);
  const z2 = -x0 * Math.sin(ry) + z1 * Math.cos(ry);
  const x3 = x2 * Math.cos(rz) - y1 * Math.sin(rz);
  const y3 = x2 * Math.sin(rz) + y1 * Math.cos(rz);
  return [x3, y3, z2];
}

// Axis-aligned half extents of the rotated shape: each world axis takes the
// absolute projection of every local axis — the same rotated-bounds math the
// client's fit and inset code uses.
function worldHalfExtents(
  half: [number, number, number],
  eulerDegrees: [number, number, number]
): [number, number, number] {
  const radians = eulerDegrees.map((value) => (value * Math.PI) / 180) as [number, number, number];
  const axes = [
    rotateVector([1, 0, 0], radians),
    rotateVector([0, 1, 0], radians),
    rotateVector([0, 0, 1], radians)
  ];
  return [0, 1, 2].map((world) => (
    Math.abs(axes[0]![world]!) * half[0] +
    Math.abs(axes[1]![world]!) * half[1] +
    Math.abs(axes[2]![world]!) * half[2]
  )) as [number, number, number];
}

function connector(document: ReturnType<typeof composeDiagram>, id: string) {
  return document.connectors.find((candidate) => candidate.id === id);
}

describe("composeDiagram", () => {
  it("resolves semantic roles into engine-owned primitive treatments", () => {
    const composed = composeDiagram(base({
      nodes: [...SUPPORTED_DIAGRAM_ROLES].map((role, index) => (
        { id: `node-${index}`, label: role, role }
      )),
      edges: []
    }), undefined);

    const treatment = (role: string) => {
      const index = SUPPORTED_DIAGRAM_ROLES.indexOf(role as SupportedDiagramRole);
      return entity(composed, `node:node-${index}`)!;
    };
    expect([...SUPPORTED_DIAGRAM_ROLES].map((role) => treatment(role).geometry.kind)).toEqual([
      "box",
      "stack",
      "cylinder",
      "cylinder",
      "box",
      "sphere",
      "box",
      "cone",
      "box",
      "sphere",
      "box",
      "box",
      "cylinder",
      "cone",
      "cylinder"
    ]);
    expect(treatment("queue").transform.rotationEulerDegrees).toEqual([0, 0, 90]);
    expect(treatment("gateway").transform.rotationEulerDegrees).toEqual([0, 45, 0]);
    expect(treatment("scheduler").transform.rotationEulerDegrees).toEqual([0, 0, 45]);
    expect(treatment("ml_model").transform.rotationEulerDegrees).toEqual([180, 0, 0]);
    expect(treatment("stream").transform.rotationEulerDegrees).toEqual([0, 0, 90]);
    expect(composed.warnings).toEqual([]);
  });

  it("re-maps datastore to the stacked-disk silhouette at the old cylinder's outer bounds", () => {
    const composed = composeDiagram(base(), undefined);
    const geometry = entity(composed, "node:db")!.geometry;
    expect(geometry).toEqual({ kind: "stack", count: 3, radius: 0.055, height: 0.024, gap: 0.009 });
    if (geometry.kind === "stack") {
      // Disks plus gaps reproduce the replaced cylinder's 0.09 m total
      // height, so layout spacing, fit bounds, and insets are untouched.
      const total = geometry.count * geometry.height + (geometry.count - 1) * geometry.gap;
      expect(total).toBeCloseTo(0.09);
    }
  });

  // The two envelopes the connector heuristics assume of every node
  // treatment: the via bow trusts CONNECTOR_VIA_NODE_HALF_DEPTH as the
  // deepest z half-extent anything stands with, and the parallel bundle cap
  // trusts PARALLEL_BUNDLE_MAX_HALF_WIDTH as the smallest horizontal
  // half-extent a fanned connector must still pass through. A new role that
  // leaves either envelope makes those constants silently dishonest, so the
  // whole palette is swept.
  it("keeps every role treatment inside the connector heuristics' envelopes", () => {
    const composed = composeDiagram(base({
      nodes: [...SUPPORTED_DIAGRAM_ROLES].map((role, index) => (
        { id: `node-${index}`, label: role, role }
      )),
      edges: []
    }), undefined);

    for (const composedEntity of composed.entities) {
      const world = worldHalfExtents(
        treatmentHalfExtents(composedEntity.geometry),
        composedEntity.transform.rotationEulerDegrees ?? [0, 0, 0]
      );
      expect(world[2], composedEntity.label).toBeLessThanOrEqual(CONNECTOR_VIA_NODE_HALF_DEPTH + 1e-9);
      expect(Math.min(world[0], world[2]), composedEntity.label)
        .toBeGreaterThanOrEqual(PARALLEL_BUNDLE_MAX_HALF_WIDTH - 1e-9);
    }
  });

  it("treats event and replicates as first-class edge kinds", () => {
    const composed = composeDiagram(base({
      nodes: [
        { id: "orders", label: "Orders", role: "service" },
        { id: "audit", label: "Audit", role: "service" },
        { id: "replica", label: "Replica", role: "datastore" }
      ],
      edges: [
        { id: "emits", from: "orders", to: "audit", kind: "event" },
        { id: "copies", from: "audit", to: "replica", kind: "replicates" }
      ]
    }), undefined);

    // The kinds pass through untouched with a single
    // arrowhead — fan-out delivery and replication both point one way — and
    // raise none of the unknown-vocabulary warnings they used to.
    expect(composed.connectors[0]).toMatchObject({ kind: "event", arrowheads: "to" });
    expect(composed.connectors[1]).toMatchObject({ kind: "replicates", arrowheads: "to" });
    expect(composed.warnings).toEqual([]);
  });

  // The unknown example remains distinct from registered roles, which is
  // the plan's own evidence that the warning channel surfaces the roles worth
  // adding next.
  it("falls back for unknown vocabulary and reports warnings", () => {
    const composed = composeDiagram(base({
      nodes: [
        { id: "sidecar", label: "Sidecar", role: "sidecar_proxy" },
        { id: "api", label: "API", role: "service" }
      ],
      edges: [{ id: "intercepts", from: "sidecar", to: "api", kind: "event_stream" }]
    }), undefined);

    expect(composed.entities[0]).toMatchObject({
      id: "node:sidecar",
      geometry: { kind: "box", size: [0.1, 0.08, 0.1] },
      material: { baseColor: "#8E8E93" }
    });
    expect(composed.connectors[0]).toMatchObject({ kind: "sync", arrowheads: "to" });
    expect(composed.warnings).toEqual([
      'Unknown role "sidecar_proxy" on node "sidecar"; rendered as generic',
      'Unknown edge kind "event_stream" on edge "intercepts"; rendered as sync'
    ]);
  });

  it("applies absolute human overrides after layout and preserves them across relayout", () => {
    const override = human([
      {
        id: "api",
        transform: { position: [0.4, 0.2, -0.1] },
        locked: true
      }
    ]);
    const first = composeDiagram(base(), override);
    const relaid = composeDiagram(base({
      nodes: [
        { id: "api", label: "API", role: "service" },
        { id: "worker", label: "Worker", role: "function" },
        { id: "db", label: "DB", role: "datastore" }
      ],
      edges: [
        { id: "dispatch", from: "api", to: "worker", kind: "async" },
        { id: "writes", from: "worker", to: "db", kind: "read_write" }
      ]
    }), override);

    for (const document of [first, relaid]) {
      expect(document.entities.find((entity) => entity.id === "node:api")).toMatchObject({
        transform: { position: [0.4, 0.2, -0.1] },
        locked: true,
        humanEdited: true
      });
    }
    expect(relaid.connectors.find((connector) => connector.id === "edge:dispatch")?.from).toEqual([
      0.4,
      0.2,
      -0.1
    ]);
  });

  it("ignores orphan overrides until their stable id returns", () => {
    const composed = composeDiagram(base(), human([{ id: "removed-service", locked: true }]));

    expect(composed.entities.some((entity) => entity.id === "node:removed-service")).toBe(false);
    expect(composed.entities.every((entity) => !entity.humanEdited)).toBe(true);
  });

  it("offsets parallel connectors and hides connectors attached to hidden nodes", () => {
    const parallel = composeDiagram(base({
      edges: [
        { id: "one", from: "api", to: "db", kind: "sync" },
        { id: "two", from: "api", to: "db", kind: "read_write" }
      ]
    }), undefined);

    expect(parallel.connectors[1]!.from[0] - parallel.connectors[0]!.from[0])
      .toBeCloseTo(PARALLEL_EDGE_SEPARATION);
    // The bundle is centred on the shared segment — half the separation each
    // side — rather than walking out one-sided from the first edge.
    expect(parallel.connectors[0]!.from[0]).toBeCloseTo(-PARALLEL_EDGE_SEPARATION / 2);
    expect(parallel.connectors[1]!.from[0]).toBeCloseTo(PARALLEL_EDGE_SEPARATION / 2);
    expect(parallel.connectors[1]!.arrowheads).toBe("both");
    // The client staggers parallel midpoint labels by this index; the first
    // edge of a pair omits it so unaffected documents compose byte-identically.
    expect(parallel.connectors[0]!.parallelIndex).toBeUndefined();
    expect(parallel.connectors[1]!.parallelIndex).toBe(1);

    const hidden = composeDiagram(base(), human([{ id: "db", visible: false }]));
    expect(hidden.connectors).toEqual([]);
  });

  // A→B and B→A occupy the same line, so they collide exactly as two
  // same-direction edges do. Counting collisions per *directed* pair gave both
  // offset zero and drew a request and its response on top of each other.
  it("separates opposite-direction edges between the same pair of nodes", () => {
    const composed = composeDiagram(base({
      edges: [
        { id: "writes", from: "api", to: "db", kind: "sync" },
        { id: "reads", from: "db", to: "api", kind: "sync" }
      ]
    }), undefined);

    const writes = composed.connectors.find((connector) => connector.id === "edge:writes")!;
    const reads = composed.connectors.find((connector) => connector.id === "edge:reads")!;
    // The reverse edge is nudged aside rather than sharing the segment.
    expect(separation(writes, reads)).toBeCloseTo(PARALLEL_EDGE_SEPARATION);
    // Each still connects the same two nodes, in its own direction.
    expect([writes.fromId, writes.toId]).toEqual(["node:api", "node:db"]);
    expect([reads.fromId, reads.toId]).toEqual(["node:db", "node:api"]);
  });

  // The separation has to be *perpendicular* to the shared segment. Nudging
  // along a fixed axis slides a duplicate along its own line whenever the
  // segment runs on that axis — and every intra-tier edge does, since layout
  // holds a tier at one y and spreads it along x. Two services in one group
  // calling each other is the commonest bidirectional pair there is.
  it("separates edges perpendicular to the segment they share, including within a tier", () => {
    const sameTier = composeDiagram(base({
      nodes: [
        { id: "api", label: "API", role: "service", group: "core" },
        { id: "db", label: "DB", role: "datastore", group: "core" }
      ],
      edges: [
        { id: "writes", from: "api", to: "db", kind: "sync" },
        { id: "reads", from: "db", to: "api", kind: "sync" }
      ],
      groups: [{ id: "core", label: "Core" }]
    }), undefined);

    const writes = sameTier.connectors.find((connector) => connector.id === "edge:writes")!;
    const reads = sameTier.connectors.find((connector) => connector.id === "edge:reads")!;
    // Both nodes sit at one y, spread along x, so the segment runs along x...
    expect(writes.from[1]).toBe(writes.to[1]);
    expect(writes.from[2]).toBe(writes.to[2]);
    // ...and the separation lands in z, not along the segment itself.
    expect(separation(writes, reads)).toBeCloseTo(PARALLEL_EDGE_SEPARATION);
    expect(Math.abs(reads.from[2] - writes.to[2])).toBeCloseTo(PARALLEL_EDGE_SEPARATION);
    // Separated edges stay level with each other rather than tilting.
    expect(reads.from[1]).toBe(writes.to[1]);
  });

  // Four edges between two actors used to walk out one-sided to 3 × 0.03 m —
  // past the actor sphere's 0.05 m radius, so the outer connectors' centrelines
  // missed the node entirely and the geometry-derived arrowhead inset trimmed
  // against a shape the line never touched. The bundle is now centred and its
  // half-width capped at the smallest palette shape's perpendicular extent.
  it("caps a wide bundle so the outermost connector still passes through its nodes", () => {
    const composed = composeDiagram(base({
      nodes: [
        { id: "a", label: "A", role: "actor" },
        { id: "b", label: "B", role: "actor" }
      ],
      edges: [
        { id: "p0", from: "a", to: "b", kind: "sync" },
        { id: "p1", from: "b", to: "a", kind: "sync" },
        { id: "p2", from: "a", to: "b", kind: "async" },
        { id: "p3", from: "b", to: "a", kind: "async" }
      ]
    }), undefined);

    const offsets = composed.connectors.map((connector) => connector.from[0]);
    // Symmetric about the shared segment...
    expect(offsets.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0);
    // ...and clamped: no centreline further from the segment than the
    // smallest palette shape can still catch.
    for (const offset of offsets) {
      expect(Math.abs(offset)).toBeLessThanOrEqual(PARALLEL_BUNDLE_MAX_HALF_WIDTH + 1e-6);
    }
    expect(Math.max(...offsets.map(Math.abs))).toBeCloseTo(PARALLEL_BUNDLE_MAX_HALF_WIDTH);
    // Every edge keeps its own distinct lane, opposite edges included.
    expect(new Set(offsets).size).toBe(4);
    expect(composed.connectors.map((connector) => connector.parallelIndex ?? 0)).toEqual([0, 1, 2, 3]);
  });

  // An edge spanning two or more tiers draws a straight line through
  // the tiers between — a chain plus its skip edge skewers the middle node
  // outright once barycenter centres all three. Such an edge bows toward the
  // viewer through a `via` waypoint; adjacent-tier edges stay straight and
  // carry no field at all, so an unaffected document composes byte-identically.
  it("bows a multi-tier edge through a via waypoint and leaves adjacent-tier edges straight", () => {
    const composed = composeDiagram(base({
      nodes: [
        { id: "a", label: "A", role: "service" },
        { id: "b", label: "B", role: "service" },
        { id: "c", label: "C", role: "service" }
      ],
      edges: [
        { id: "ab", from: "a", to: "b", kind: "sync" },
        { id: "bc", from: "b", to: "c", kind: "sync" },
        { id: "ac", from: "a", to: "c", kind: "sync" }
      ]
    }), undefined);

    expect(connector(composed, "edge:ab")!.via).toBeUndefined();
    expect(connector(composed, "edge:bc")!.via).toBeUndefined();

    const skip = connector(composed, "edge:ac")!;
    expect(skip.via).toBeDefined();
    expect(skip.via![0]).toBeCloseTo((skip.from[0] + skip.to[0]) / 2, 5);
    expect(skip.via![1]).toBeCloseTo((skip.from[1] + skip.to[1]) / 2, 5);
    expect(skip.via![2]).toBeCloseTo(
      (skip.from[2] + skip.to[2]) / 2 + CONNECTOR_VIA_BOW_BASE,
      5
    );
  });

  // The nearest crossed tier sits at fraction 1/span of the edge, where the
  // polyline's z is only 2·bow/span — so the same tier occupancy demands a
  // deeper bow from a longer edge, and parallel long edges take distinct bows
  // so their apexes do not meet at one point.
  it("deepens the bow with tier span and staggers parallel long edges", () => {
    const composed = composeDiagram(base({
      nodes: [
        { id: "a", label: "A", role: "service" },
        { id: "b", label: "B", role: "service" },
        { id: "c", label: "C", role: "service" },
        { id: "d", label: "D", role: "service" }
      ],
      edges: [
        { id: "ab", from: "a", to: "b", kind: "sync" },
        { id: "bc", from: "b", to: "c", kind: "sync" },
        { id: "cd", from: "c", to: "d", kind: "sync" },
        { id: "skip", from: "a", to: "d", kind: "sync" },
        { id: "back", from: "d", to: "a", kind: "async" }
      ]
    }), undefined);

    // b and c sit on the plane (z 0), crossed at fractions 1/3 and 2/3 where
    // the bow's weight is 2/3 — the clearance they demand, scaled up by it.
    const expectedBow =
      (CONNECTOR_VIA_NODE_HALF_DEPTH + CONNECTOR_VIA_CLEARANCE) / (2 / 3);
    const skip = connector(composed, "edge:skip")!;
    const back = connector(composed, "edge:back")!;
    expect(skip.via![2]).toBeCloseTo((skip.from[2] + skip.to[2]) / 2 + expectedBow, 5);
    // The opposed long edge is the second of its parallel bundle, so it bows
    // one step deeper on top of the sideways separation it already has.
    expect(back.parallelIndex).toBe(1);
    expect(back.via![2]).toBeCloseTo(
      (back.from[2] + back.to[2]) / 2 + expectedBow + CONNECTOR_VIA_BOW_PARALLEL_STEP,
      5
    );
  });

  // Review finding: the lane slice moved a grouped intermediate node to
  // z = 0.12 and the original fixed 0.08 bow then landed *inside* its body —
  // the tier and bow calculations undoing each other. The bow now clears what the
  // crossed tiers actually hold.
  it("bows past an intermediate node a group lane moved into the bow's path", () => {
    const laned = base({
      nodes: [
        { id: "a", label: "A", role: "service" },
        { id: "b", label: "B", role: "service", group: "g1" },
        { id: "c", label: "C", role: "service" }
      ],
      edges: [
        { id: "ab", from: "a", to: "b", kind: "sync" },
        { id: "bc", from: "b", to: "c", kind: "sync" },
        { id: "ac", from: "a", to: "c", kind: "sync" }
      ],
      groups: [{ id: "g1", label: "G1" }]
    });
    const composed = composeDiagram(laned, undefined);
    const middle = entity(composed, "node:b")!;
    const skip = connector(composed, "edge:ac")!;

    expect(middle.transform.position[2]).toBeCloseTo(DIAGRAM_GROUP_LANE_Z, 5);
    // The apex crosses b's tier above its front face, not inside its body.
    expect(skip.via![2]).toBeCloseTo(
      DIAGRAM_GROUP_LANE_Z + CONNECTOR_VIA_NODE_HALF_DEPTH + CONNECTOR_VIA_CLEARANCE,
      5
    );

    // A hidden node is not drawn, so it demands no clearance and the bow
    // relaxes to its floor.
    const hidden = composeDiagram(laned, human([{ id: "b", visible: false }]));
    expect(connector(hidden, "edge:ac")!.via![2]).toBeCloseTo(CONNECTOR_VIA_BOW_BASE, 5);
  });

  // Review finding: the parallel stagger had no cap, so a schema-valid bundle
  // of 126 skip edges pushed an apex ~2.6 m out — and the client sweeps vias
  // into its fit bounds, so the whole diagram shrank around one degenerate
  // bundle. The stagger now compresses like the sideways fan-out: distinct
  // bows, bounded spread.
  it("compresses a degenerate parallel bundle's bow stagger instead of escaping", () => {
    const composed = composeDiagram(base({
      nodes: [
        { id: "a", label: "A", role: "service" },
        { id: "b", label: "B", role: "service" },
        { id: "c", label: "C", role: "service" }
      ],
      edges: [
        { id: "ab", from: "a", to: "b", kind: "sync" },
        { id: "bc", from: "b", to: "c", kind: "sync" },
        ...Array.from({ length: 126 }, (_, index) => ({
          id: `s${index}`,
          from: "a",
          to: "c",
          kind: "sync"
        }))
      ]
    }), undefined);

    const viaHeights = composed.connectors.flatMap((candidate) =>
      candidate.via ? [candidate.via[2]] : []
    );
    expect(viaHeights).toHaveLength(126);
    expect(Math.max(...viaHeights)).toBeCloseTo(
      CONNECTOR_VIA_BOW_BASE + CONNECTOR_VIA_BOW_PARALLEL_MAX,
      5
    );
    // Compression, not collapse: every edge keeps a bow of its own.
    expect(new Set(viaHeights).size).toBe(126);
  });

  // The bow is a heuristic, not a router: a deep group's front row would
  // demand a ~0.7 m bow, and past the cap the edge draws through what it
  // cannot clear — what every edge did before the bow existed — rather than
  // ballooning the fit bounds the client derives from the apex.
  it("clamps the bow at its maximum however deep the intermediate tier stands", () => {
    const members = Array.from({ length: 62 }, (_, index) => ({
      id: `m${index}`,
      label: `M${index}`,
      role: "service",
      group: "big"
    }));
    const composed = composeDiagram(base({
      nodes: [
        { id: "a", label: "A", role: "service" },
        ...members,
        { id: "c", label: "C", role: "service" }
      ],
      edges: [
        { id: "in", from: "a", to: "m0", kind: "sync" },
        { id: "out", from: "m0", to: "c", kind: "sync" },
        { id: "skip", from: "a", to: "c", kind: "sync" }
      ],
      groups: [{ id: "big", label: "Big" }]
    }), undefined);

    expect(connector(composed, "edge:skip")!.via![2]).toBeCloseTo(CONNECTOR_VIA_BOW_MAX, 5);
  });

  // A platter that moved without its nodes was the pre-existing rough edge
  // Dragging a group used to slide the backdrop out from under
  // the components standing on it.
  it("carries a moved group's members with it, and leaves individually placed ones alone", () => {
    const laidOut = composeDiagram(grouped(), undefined);
    const platterPosition = entity(laidOut, "group:core")!.transform.position;
    const apiPosition = entity(laidOut, "node:api")!.transform.position;

    const moved = composeDiagram(grouped(), human([
      {
        id: "core",
        transform: { position: [platterPosition[0] + 0.5, platterPosition[1] - 0.2, platterPosition[2]] }
      },
      { id: "worker", transform: { position: [1, 1, 1] } }
    ]));

    const carried = entity(moved, "node:api")!.transform.position;
    expect(carried[0]).toBeCloseTo(apiPosition[0] + 0.5);
    expect(carried[1]).toBeCloseTo(apiPosition[1] - 0.2);
    expect(carried[2]).toBeCloseTo(apiPosition[2]);
    // The member moved, but the human adjusted the *group* — the badge belongs
    // on the entry that exists, not on everything it displaced.
    expect(entity(moved, "node:api")!.humanEdited).toBe(false);
    // An explicit placement is the more specific instruction, so it wins over
    // the group it happens to sit in.
    expect(entity(moved, "node:worker")!.transform.position).toEqual([1, 1, 1]);
    // Edges follow what they are attached to.
    expect(connector(moved, "edge:in")!.to).toEqual(entity(moved, "node:api")!.transform.position);
  });

  it("composes a collapsed group as one stand-in its edges point at", () => {
    const expanded = composeDiagram(grouped(), undefined);
    const collapsed = composeDiagram(grouped(), human([{ id: "core", collapsed: true }]));

    expect(entity(collapsed, "node:api")).toBeUndefined();
    expect(entity(collapsed, "node:worker")).toBeUndefined();

    const standIn = entity(collapsed, "group:core")!;
    expect(standIn.geometry.kind).toBe("box");
    expect(standIn.label).toBe("Core");
    // Collapsing changes what is drawn, never where the group is.
    expect(standIn.transform.position).toEqual(entity(expanded, "group:core")!.transform.position);
    // Nor does it re-lay-out the diagram around it: layout stays a pure
    // function of the base document.
    expect(entity(collapsed, "node:gw")!.transform.position)
      .toEqual(entity(expanded, "node:gw")!.transform.position);
    expect(entity(collapsed, "node:db")!.transform.position)
      .toEqual(entity(expanded, "node:db")!.transform.position);

    // Edges that crossed the boundary now terminate on the stand-in...
    expect(connector(collapsed, "edge:in")!.toId).toBe("group:core");
    expect(connector(collapsed, "edge:in")!.to).toEqual(standIn.transform.position);
    expect(connector(collapsed, "edge:out")!.fromId).toBe("group:core");
    // ...and the one that was internal to the group is not drawn at all: it
    // would loop from the stand-in back onto itself.
    expect(connector(collapsed, "edge:internal")).toBeUndefined();
  });

  it("separates edges that became parallel by collapsing a group", () => {
    const document = grouped({
      edges: [
        { id: "in", from: "gw", to: "api", kind: "sync" },
        { id: "also", from: "gw", to: "worker", kind: "sync" }
      ]
    });
    const collapsed = composeDiagram(document, human([{ id: "core", collapsed: true }]));

    const first = connector(collapsed, "edge:in")!;
    const second = connector(collapsed, "edge:also")!;
    expect([first.toId, second.toId]).toEqual(["group:core", "group:core"]);
    // Two members talking to the same outside node draw one segment each,
    // rather than two arrows down the same line. Both edges run the same
    // direction here, so the separation is measured at the same endpoint.
    expect(Math.hypot(
      first.to[0] - second.to[0],
      first.to[1] - second.to[1],
      first.to[2] - second.to[2]
    )).toBeCloseTo(PARALLEL_EDGE_SEPARATION);
  });

  // The backend decides how far apart parallel edges sit; the client decides
  // how fat an arrowhead is. At 0.01 m separation against a 0.011 m cone
  // radius, the commonest parallel pair drew interpenetrating cones — so the
  // relationship is pinned across the repo boundary the same way the Swift
  // structure tests pin client layout.
  it.skipIf(!clientRendererPresent)("keeps the separation at least 2.5 times the client arrowhead radius", async () => {
    const builderSource = await readFile(CLIENT_CONNECTORS_PATH, "utf8");
    const match = builderSource.match(/connectorArrowRadius:\s*Float\s*=\s*([0-9.]+)/);
    expect(match).not.toBeNull();
    const arrowRadius = Number(match![1]);
    expect(Number.isFinite(arrowRadius)).toBe(true);
    expect(arrowRadius).toBeGreaterThan(0);
    expect(PARALLEL_EDGE_SEPARATION).toBeGreaterThanOrEqual(arrowRadius * 2.5);
  });

  // The composed document deliberately does not carry a node's role; the
  // client's label badge recovers it from the treatment's baseColor. That
  // makes the colour a contract — unique per role backend-side, mirrored
  // exactly by the Swift `nodeRoleByBaseColor` map — pinned across the repo
  // boundary the same way the arrowhead radius above is.
  it.skipIf(!clientRendererPresent)("keeps the client badge colour map in lockstep with the treatment palette", async () => {
    const builderSource = await readFile(CLIENT_ROLE_BADGES_PATH, "utf8");
    const region = builderSource.match(
      /nodeRoleByBaseColor:\s*\[String:\s*String\]\s*=\s*\[([\s\S]*?)\n\s*\]/
    );
    expect(region).not.toBeNull();
    const swiftPairs = new Map<string, string>();
    for (const pair of region![1]!.matchAll(/"(#[0-9A-Fa-f]{6})":\s*"([a-z0-9_]+)"/g)) {
      swiftPairs.set(pair[1]!.toUpperCase(), pair[2]!);
    }

    const composed = composeDiagram(base({
      nodes: [...SUPPORTED_DIAGRAM_ROLES].map((role, index) => (
        { id: `node-${index}`, label: role, role }
      )),
      edges: []
    }), undefined);
    const backendPairs = new Map<string, string>();
    SUPPORTED_DIAGRAM_ROLES.forEach((role, index) => {
      backendPairs.set(
        entity(composed, `node:node-${index}`)!.material.baseColor!.toUpperCase(),
        role
      );
    });

    expect(backendPairs.size).toBe(SUPPORTED_DIAGRAM_ROLES.length);
    expect(Object.fromEntries([...swiftPairs.entries()].sort()))
      .toEqual(Object.fromEntries([...backendPairs.entries()].sort()));
  });

  // Compose emits `stack` for every datastore, and an unknown geometry kind
  // renders *nothing* client-side (unknown roles warn; unknown kinds
  // disappear), so the renderer's stack support is pinned before the re-map
  // can reach it.
  it.skipIf(!clientRendererPresent)("keeps the client renderer able to draw the stack kind datastores compose to", async () => {
    const builderSource = await readFile(CLIENT_BUILDER_PATH, "utf8");
    expect(builderSource).toContain('case "stack":');
    expect(builderSource).toContain("func stackTotalHeight");
  });

  it("keeps a collapsed group's member overrides for when it expands again", () => {
    const overrides = human([
      { id: "core", collapsed: true },
      { id: "api", transform: { position: [0.4, 0.2, -0.1] }, locked: true }
    ]);
    expect(entity(composeDiagram(grouped(), overrides), "node:api")).toBeUndefined();

    const expanded = composeDiagram(grouped(), human(
      overrides.overrides.filter((override) => override.id !== "core")
    ));
    expect(entity(expanded, "node:api")).toMatchObject({
      transform: { position: [0.4, 0.2, -0.1] },
      locked: true,
      humanEdited: true
    });
  });

  it("reports a hidden member suppressed by collapse so the client can restore it", () => {
    const collapsed = composeDiagram(grouped(), human([
      { id: "core", collapsed: true },
      { id: "api", visible: false }
    ]));

    expect(entity(collapsed, "node:api")).toBeUndefined();
    expect(collapsed.suppressedHiddenEntities).toEqual([
      { id: "api", label: "API", isGroup: false }
    ]);
  });

  it("resolves a flow to its connectors in the order the flow names them", () => {
    const composed = composeDiagram(grouped({
      schemaVersion: 2,
      flows: [{ id: "request", label: "Request", edges: ["out", "in"] }]
    }), undefined);

    expect(composed.flows).toEqual([
      {
        id: "flow:request",
        label: "Request",
        provenance: { flowId: "request" },
        // The flow's own order, not the document's edge order.
        connectorIds: ["edge:out", "edge:in"]
      }
    ]);
  });

  it("composes no flows for a document that declares none", () => {
    expect(composeDiagram(base(), undefined).flows).toEqual([]);
  });

  // Collapsing drops the edges internal to a group, so a flow that walked
  // through one has fewer hops to light. The remaining hops still make a
  // sequence, so the flow survives rather than disappearing from the picker.
  it("drops the steps a collapsed group removed and keeps the rest of the flow", () => {
    const document = grouped({
      schemaVersion: 2,
      flows: [{ id: "request", label: "Request", edges: ["in", "internal", "out"] }]
    });

    expect(composeDiagram(document, undefined).flows[0]!.connectorIds)
      .toEqual(["edge:in", "edge:internal", "edge:out"]);
    expect(composeDiagram(document, human([{ id: "core", collapsed: true }])).flows[0]!.connectorIds)
      .toEqual(["edge:in", "edge:out"]);
  });

  it("omits a flow with nothing left to light", () => {
    const composed = composeDiagram(grouped({
      schemaVersion: 2,
      flows: [{ id: "inside", label: "Inside the group", edges: ["internal"] }]
    }), human([{ id: "core", collapsed: true }]));

    expect(composed.flows).toEqual([]);
  });

  it("produces stable versions that change with composed state", () => {
    const first = composeDiagram(base(), undefined);
    expect(composedDiagramVersion(first)).toBe(composedDiagramVersion(composeDiagram(base(), undefined)));

    const moved = composeDiagram(base(), human([{ id: "api", transform: { position: [1, 0, 0] } }]));
    expect(composedDiagramVersion(moved)).not.toBe(composedDiagramVersion(first));
  });

  // Schema v3: descriptions pass through untouched so the selection card can
  // answer "why does this exist?" without a second read.
  it("passes descriptions through to entities, connectors, and the document", () => {
    const composed = composeDiagram(
      grouped({
        schemaVersion: 3,
        description: "Order lifecycle end to end.",
        nodes: [
          { id: "gw", label: "Gateway", role: "gateway" },
          {
            id: "api",
            label: "API",
            description: "Owns order state.",
            role: "service",
            group: "core"
          },
          { id: "worker", label: "Worker", role: "function", group: "core" },
          { id: "db", label: "DB", role: "datastore" }
        ],
        edges: [
          { id: "in", from: "gw", to: "api", description: "REST ingress.", kind: "sync" },
          { id: "internal", from: "api", to: "worker", kind: "async" },
          { id: "out", from: "worker", to: "db", kind: "read_write" }
        ],
        groups: [{ id: "core", label: "Core", description: "The core domain." }]
      }),
      undefined
    );
    expect(composed.description).toBe("Order lifecycle end to end.");
    expect(entity(composed, "node:api")?.description).toBe("Owns order state.");
    expect(entity(composed, "node:worker")?.description).toBeUndefined();
    expect(entity(composed, "group:core")?.description).toBe("The core domain.");
    expect(connector(composed, "edge:in")?.description).toBe("REST ingress.");
    expect(connector(composed, "edge:internal")?.description).toBeUndefined();
  });

  it("keeps a collapsed group's description on its stand-in", () => {
    const composed = composeDiagram(
      grouped({
        schemaVersion: 3,
        groups: [{ id: "core", label: "Core", description: "The core domain." }]
      }),
      human([{ id: "core", collapsed: true }])
    );
    const standIn = entity(composed, "group:core");
    expect(standIn?.geometry.kind).toBe("box");
    expect(standIn?.description).toBe("The core domain.");
  });

  it("composes a document without descriptions identically to before the field existed", () => {
    const composed = composeDiagram(base(), undefined);
    expect("description" in composed).toBe(false);
    expect(composed.entities.every((candidate) => !("description" in candidate))).toBe(true);
    expect(composed.connectors.every((candidate) => !("description" in candidate))).toBe(true);
  });
});

// The report of an adjustment the agent's own edit orphaned.
// Compose has always skipped an unresolvable override silently — these are the
// rules for saying so without ever calling a live adjustment stale.
describe("composeDiagram stale overrides", () => {
  it("reports an override the diagram no longer declares, with what it carried", () => {
    const composed = composeDiagram(
      base(),
      human([
        { id: "api", transform: { position: [1, 0, 0] } },
        { id: "orders", transform: { position: [2, 0, 0] }, locked: true }
      ])
    );

    expect(composed.staleOverrides).toEqual([
      { id: "orders", moved: true, locked: true }
    ]);
  });

  it("reports an orphaned group entry, collapse flag and all", () => {
    const composed = composeDiagram(base(), human([{ id: "core", collapsed: true, visible: false }]));

    expect(composed.staleOverrides).toEqual([
      { id: "core", moved: false, visible: false, collapsed: true }
    ]);
  });

  // The distinction the whole feature rests on: "not rendered right now" is a
  // view state the human chose, while "not in the document" is the agent having
  // moved out from under them. Only the second is stale.
  it("does not call a hidden node or a collapsed group's member stale", () => {
    const composed = composeDiagram(
      grouped(),
      human([
        { id: "core", collapsed: true },
        { id: "api", transform: { position: [1, 0, 0] } },
        { id: "db", visible: false }
      ])
    );

    expect(composed.entities.some((candidate) => candidate.id === "node:api")).toBe(false);
    expect(composed.staleOverrides).toEqual([]);
  });

  it("is empty with no override layer at all", () => {
    expect(composeDiagram(base(), undefined).staleOverrides).toEqual([]);
    expect(composeDiagram(base(), human([])).staleOverrides).toEqual([]);
  });

  // Reporting an entry must not delete it: an id the agent brings back picks the
  // human's placement up again, which is what makes regeneration non-destructive.
  it("keeps a stale entry composable, so a returning id gets its placement back", () => {
    const overrides = human([{ id: "orders", transform: { position: [0.5, 0, 0] } }]);
    expect(composeDiagram(base(), overrides).staleOverrides).toHaveLength(1);

    const readded = base({
      nodes: [
        { id: "api", label: "API", role: "service" },
        { id: "db", label: "DB", role: "datastore" },
        { id: "orders", label: "Orders", role: "service" }
      ]
    });
    const composed = composeDiagram(readded, overrides);

    expect(composed.staleOverrides).toEqual([]);
    expect(entity(composed, "node:orders")?.transform.position).toEqual([0.5, 0, 0]);
  });

  it("preserves override-file order so the list is stable between reads", () => {
    const composed = composeDiagram(
      base(),
      human([{ id: "zeta", locked: true }, { id: "alpha", visible: false }])
    );

    expect(composed.staleOverrides.map((override) => override.id)).toEqual(["zeta", "alpha"]);
  });
});
