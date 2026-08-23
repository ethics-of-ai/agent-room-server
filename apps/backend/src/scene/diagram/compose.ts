import { sha256Hex } from "../../util/hash";
import type {
  SpatialSceneGeometry,
  SpatialSceneMaterial,
  SpatialSceneTransform
} from "../geometry/schemas";
import {
  cleanMetric,
  layoutDiagram,
  type DiagramGroupPlacement,
  type DiagramPoint
} from "./layout";
import type {
  DiagramDocument,
  DiagramFlow,
  DiagramHumanDocument,
  DiagramHumanOverride,
  DiagramNode
} from "./schemas";

export const SUPPORTED_DIAGRAM_ROLES = [
  "service",
  "datastore",
  "queue",
  "cache",
  "external",
  "actor",
  "gateway",
  "function",
  "load_balancer",
  "cdn",
  "auth",
  "scheduler",
  "blob_storage",
  "ml_model",
  "stream"
] as const;

// The composed treatment splits between the two sides: the backend owns which
// kinds are first-class (no unknown-kind warning) and each kind's arrowhead
// pairing; the client owns colour and line style (`connectorColorHex` and the
// dash mapping in `SpatialSceneEntityBuilder`). The visual grammar the client
// renders: solid = a call or data relationship (`sync`, `read_write`,
// `replicates`), dashed = message passing (`async`, `event`). The prompt's
// legend sentence names both halves, so update it with any change here.
export const SUPPORTED_DIAGRAM_EDGE_KINDS = [
  "sync",
  "async",
  "read_write",
  "event",
  "replicates"
] as const;
export type SupportedDiagramRole = typeof SUPPORTED_DIAGRAM_ROLES[number];
export type SupportedDiagramEdgeKind = typeof SUPPORTED_DIAGRAM_EDGE_KINDS[number];

export interface DiagramEntityProvenance {
  nodeId?: string;
  groupId?: string;
}

export interface ComposedDiagramEntity {
  id: string;
  label: string;
  /**
   * The source node's or group's own `description` (schema v3), passed through
   * untouched so the selection card can show why a component exists without a
   * second read. Absent when the source declares none, so older documents
   * compose byte-identically.
   */
  description?: string;
  provenance: DiagramEntityProvenance;
  geometry: SpatialSceneGeometry;
  material: SpatialSceneMaterial;
  transform: SpatialSceneTransform;
  visible: boolean;
  locked: boolean;
  humanEdited: boolean;
}

export interface DiagramConnector {
  id: string;
  provenance: { edgeId: string };
  fromId: string;
  toId: string;
  from: DiagramPoint;
  to: DiagramPoint;
  kind: SupportedDiagramEdgeKind;
  label?: string;
  /** The source edge's own `description` (schema v3), like an entity's. */
  description?: string;
  arrowheads: "to" | "both";
  /**
   * Position among the edges sharing this connector's unordered endpoint
   * pair, in composed order. Present only past the first (index > 0), so a
   * document without parallel edges composes byte-identically to before the
   * field existed. The client staggers each parallel edge's midpoint label
   * along its shaft with this, so two opposed edges do not print their
   * captions on top of each other.
   */
  parallelIndex?: number;
  /**
   * Waypoint bowing a long edge out of the tier plane (Phase 4). Layout has
   * no dummy vertices, so an edge spanning two or more tiers draws a straight
   * line through the tiers between — a chain A→B→C plus the skip edge A→C
   * skewers B outright when barycenter centres all three. Present only on
   * such edges: the drawn midpoint pushed toward the viewer (+z) far enough
   * that the polyline clears the front-most drawn node or stand-in on every
   * tier it crosses (clamped at a fixed maximum — the bow is a heuristic,
   * not a router), plus a capped stagger for the connector's position in its
   * parallel bundle. Deterministic, so a
   * document without multi-tier edges composes byte-identically. Additive on
   * the composed contract like `parallelIndex`: a client that ignores it
   * draws the straight shaft it drew before, which is exactly the previous
   * behavior.
   */
  via?: DiagramPoint;
}

// A hidden node that is deliberately absent from `entities` because its group
// is collapsed. This is restore-list metadata, never renderable geometry: the
// client needs the source id and current label to let the human undo
// `visible: false` while the group remains closed.
export interface DiagramSuppressedHiddenEntity {
  id: string;
  label: string;
  isGroup: false;
}

// An override entry whose id matches no node and no group in the base document
// — the human adjusted something the agent has since renamed or removed.
//
// Compose has always skipped these silently, and deliberately does not delete
// them: an id that comes back picks its placement up again, which is what makes
// a regenerated diagram keep the human's work. The cost of that rule is that a
// rename orphans an adjustment with nothing to show for it, and the standing
// contract warns the agent about exactly this. This is the report of it: bounded
// semantic metadata, never renderable geometry, so a client can tell the human
// which adjustments no longer land and let them adopt the new layout instead.
//
// It carries the entry's own fields rather than display text: the client already
// builds its own labels, and the override layer's vocabulary is the honest
// description of what would be dropped.
export interface DiagramStaleOverride {
  id: string;
  /** The entry carries a placement — the field a "Reset placement" would clear. */
  moved: boolean;
  visible?: boolean;
  locked?: boolean;
  collapsed?: boolean;
}

// A named path through the diagram, resolved to the connectors that actually
// got drawn. The renderer lights `connectorIds` in order; it does not know
// about edge ids, and it never has to reconcile a step with a connector that
// is not in the document.
export interface ComposedDiagramFlow {
  id: string;
  label: string;
  provenance: { flowId: string };
  connectorIds: string[];
}

export interface ComposedDiagramDocument {
  schemaVersion: typeof COMPOSED_DIAGRAM_SCHEMA_VERSION;
  kind: "solution";
  name: string;
  /** The source document's own `description` (schema v3). */
  description?: string;
  entities: ComposedDiagramEntity[];
  suppressedHiddenEntities: DiagramSuppressedHiddenEntity[];
  staleOverrides: DiagramStaleOverride[];
  connectors: DiagramConnector[];
  flows: ComposedDiagramFlow[];
  warnings: string[];
}

// The composed render document is its own contract, versioned alongside the
// source it is compiled from: both gained flows at 2 and descriptions at 3. A
// source document that still declares an older version composes to the same
// shape with an empty `flows` and no descriptions, so the renderer never
// branches on a source version.
export const COMPOSED_DIAGRAM_SCHEMA_VERSION = 3;

export interface DiagramValidationIssue {
  path: string;
  message: string;
}

export interface DiagramValidationErrorDocument {
  errors: DiagramValidationIssue[];
}

export type DiagramRenderDocument = ComposedDiagramDocument | DiagramValidationErrorDocument;

export function composeDiagram(
  base: DiagramDocument,
  human: DiagramHumanDocument | undefined
): ComposedDiagramDocument {
  const layout = layoutDiagram(base);
  const overridesById = new Map<string, DiagramHumanOverride>();
  for (const override of human?.overrides ?? []) overridesById.set(override.id, override);

  const warnings: string[] = [];
  const nodesById = new Map(base.nodes.map((node) => [node.id, node]));
  const nodeEntities = new Map<string, ComposedDiagramEntity>();

  // A group is one thing, and both of the ways the human can say so are decided
  // here — before any entity is built, because a node's composed placement
  // depends on its group's override.
  //
  // Neither reaches layout: layout stays a pure function of the base document
  // (the v1 layout spec's rule), so collapsing or moving a group never
  // reshuffles the rest of the diagram. Everything else stays exactly where the
  // human last saw it, which is what makes the state change predictable rather
  // than a surprise re-flow (WWDC23 10072 t=950).
  const { collapsedGroupIds, groupOffsets } = resolveGroupState(layout.groups, overridesById);
  // Member nodes normally become ordinary hidden render entities when a person
  // sets `visible: false`. A collapsed group intentionally omits every member
  // from `entities`, which would otherwise make a pre-existing hidden member
  // disappear from the ornament's restore list. Keep only the small semantic
  // record that list needs; it stays bounded by the 64-node diagram cap and is
  // not a second render path.
  const suppressedHiddenEntities: DiagramSuppressedHiddenEntity[] = base.nodes.flatMap((node) => (
    node.group && collapsedGroupIds.has(node.group) && overridesById.get(node.id)?.visible === false
      ? [{ id: node.id, label: node.label, isGroup: false }]
      : []
  ));

  for (const placement of layout.nodes) {
    const node = nodesById.get(placement.id)!;
    // A collapsed group's members are not in the composed document at all:
    // the group's stand-in entity is what represents them, and their edges are
    // re-pointed at it below. Their override entries are untouched, so
    // expanding restores every placement, lock, and hide they carried.
    if (node.group && collapsedGroupIds.has(node.group)) continue;

    const treatment = nodeTreatment(node, warnings);
    const override = overridesById.get(node.id);
    // A moved group carries the nodes standing on it. A node the human placed
    // individually keeps its own absolute position instead — `mergeTransform`
    // prefers the node's own override — because an explicit placement is the
    // more specific instruction of the two.
    const groupOffset = node.group ? groupOffsets.get(node.group) : undefined;
    const entity: ComposedDiagramEntity = {
      id: `node:${node.id}`,
      label: node.label,
      ...(node.description !== undefined ? { description: node.description } : {}),
      provenance: {
        nodeId: node.id,
        ...(node.group ? { groupId: node.group } : {})
      },
      geometry: treatment.geometry,
      material: treatment.material,
      transform: mergeTransform(
        {
          position: groupOffset ? offsetPoint(placement.position, groupOffset) : placement.position,
          ...(treatment.rotationEulerDegrees
            ? { rotationEulerDegrees: treatment.rotationEulerDegrees }
            : {})
        },
        override
      ),
      visible: override?.visible ?? true,
      locked: override?.locked ?? false,
      humanEdited: override !== undefined
    };
    nodeEntities.set(node.id, entity);
  }

  const groupsById = new Map(base.groups.map((group) => [group.id, group]));
  const groupEntities = new Map<string, ComposedDiagramEntity>();
  for (const placement of layout.groups) {
    const group = groupsById.get(placement.id)!;
    const override = overridesById.get(group.id);
    const collapsed = collapsedGroupIds.has(group.id);
    // The description rides the platter and the collapsed stand-in alike:
    // collapsed, the stand-in is what represents the group, and the "what is
    // this?" question it answers is the same either way.
    groupEntities.set(group.id, {
      id: `group:${group.id}`,
      label: group.label,
      ...(group.description !== undefined ? { description: group.description } : {}),
      provenance: { groupId: group.id },
      geometry: collapsed
        ? { ...COLLAPSED_GROUP_GEOMETRY }
        : {
          kind: "plane",
          width: placement.width,
          depth: placement.depth,
          cornerRadius: 0.04
        },
      material: collapsed ? { ...COLLAPSED_GROUP_MATERIAL } : { ...GROUP_PLATTER_MATERIAL },
      // The stand-in keeps the platter's own layout position, so collapsing
      // changes what is drawn and never where the group is.
      transform: mergeTransform({ position: placement.position }, override),
      visible: override?.visible ?? true,
      locked: override?.locked ?? false,
      humanEdited: override !== undefined
    });
  }

  // Which entity an edge endpoint actually lands on: the node itself, or the
  // stand-in for the collapsed group it belongs to.
  const endpointEntities = new Map<string, ComposedDiagramEntity>();
  for (const node of base.nodes) {
    const collapsedGroupId = node.group && collapsedGroupIds.has(node.group) ? node.group : undefined;
    const entity = collapsedGroupId ? groupEntities.get(collapsedGroupId) : nodeEntities.get(node.id);
    if (entity) endpointEntities.set(node.id, entity);
  }

  // Whether an edge draws at all, shared by the bundle pre-count and the
  // connector loop below so the two can never disagree about bundle size.
  const drawableEndpoints = (edge: { from: string; to: string }) => {
    const fromEntity = endpointEntities.get(edge.from)!;
    const toEntity = endpointEntities.get(edge.to)!;
    // Both endpoints inside one collapsed group: the edge is internal to what
    // the stand-in now represents, and drawing it would loop an arrow from a
    // block back onto itself.
    if (fromEntity.id === toEntity.id) return undefined;
    if (!fromEntity.visible || !toEntity.visible) return undefined;
    return { fromEntity, toEntity };
  };

  // Pre-count each unordered pair's drawable bundle so the offsets below can
  // spread symmetrically about the shared segment. Walking one-sided from the
  // first edge — the original rule — marched the third edge of a bundle far
  // enough (2 × 0.03 m) that its centreline missed a small endpoint entirely
  // (the actor sphere's radius is 0.05 m), leaving the arrowhead floating
  // beside the node it points at.
  const parallelBundleSizes = new Map<string, number>();
  for (const edge of base.edges) {
    const endpoints = drawableEndpoints(edge);
    if (!endpoints) continue;
    const pairKey = unorderedPairKey(endpoints.fromEntity.id, endpoints.toEntity.id);
    parallelBundleSizes.set(pairKey, (parallelBundleSizes.get(pairKey) ?? 0) + 1);
  }

  // Which tier an edge endpoint stands on. A collapsed group's stand-in needs
  // no case of its own: it keeps the platter's layout position, and a member
  // node's tier is by construction its group atom's tier. The via bow below
  // keys on the *structural* span between these, not on drawn positions: a
  // human override that drags two tiers level should not flatten the bow that
  // keeps the edge out of the tiers between.
  const tierByNodeId = new Map(layout.nodes.map((placement) => [placement.id, placement.tier]));
  const endpointTier = (nodeId: string): number => tierByNodeId.get(nodeId)!;

  // The front face the via bow has to clear on each tier: the largest drawn z
  // over the tier's visible node entities and collapsed stand-ins, plus the
  // conservative palette half-depth. A hidden entity is not drawn and demands
  // no clearance. Platter geometry is deliberately not measured — an expanded
  // group's backdrop was always crossed by straight edges — but its member
  // nodes count individually, which is how a deep group's front row drives a
  // bow up to the cap.
  const tierFrontZ = new Map<number, number>();
  const noteTierFront = (
    tier: number | undefined,
    entity: ComposedDiagramEntity | undefined
  ): void => {
    if (tier === undefined || !entity?.visible) return;
    const front = entity.transform.position[2] + CONNECTOR_VIA_NODE_HALF_DEPTH;
    const existing = tierFrontZ.get(tier);
    if (existing === undefined || front > existing) tierFrontZ.set(tier, front);
  };
  for (const node of base.nodes) {
    if (node.group && collapsedGroupIds.has(node.group)) continue;
    noteTierFront(tierByNodeId.get(node.id), nodeEntities.get(node.id));
  }
  for (const placement of layout.groups) {
    if (collapsedGroupIds.has(placement.id)) {
      noteTierFront(placement.tier, groupEntities.get(placement.id));
    }
  }

  const parallelEdgeCounts = new Map<string, number>();
  const connectors: DiagramConnector[] = [];
  // Which edges actually became connectors, so a flow can be resolved to what
  // is on screen rather than to what the source document declared.
  const connectorIdByEdgeId = new Map<string, string>();
  for (const edge of base.edges) {
    const endpoints = drawableEndpoints(edge);
    if (!endpoints) continue;
    const { fromEntity, toEntity } = endpoints;

    // Edges sharing a pair of endpoints share a segment, so the bundle is
    // fanned out around it. The key is the *unordered* pair: A to B and
    // B to A occupy the same line in space, so a directed key would hand both
    // offset zero and draw them exactly on top of each other: overlapping
    // shafts, overlapping midpoint labels, and an arrowhead at each end that
    // reads as one read_write edge rather than two opposed ones.
    //
    // It keys on the *endpoint entities*, not the edge's own node ids, so
    // collapsing a group separates the edges that just became parallel: two
    // members talking to the same outside node draw one segment each rather
    // than two arrows down the same line.
    const pairKey = unorderedPairKey(fromEntity.id, toEntity.id);
    const parallelIndex = parallelEdgeCounts.get(pairKey) ?? 0;
    parallelEdgeCounts.set(pairKey, parallelIndex + 1);
    // The perpendicular is taken from a canonical orientation of the shared
    // segment (smaller entity id first — the same canonicalization the pair
    // key uses), never from the edge's own direction: an opposed edge's
    // perpendicular points the other way, and symmetric distances applied
    // along flipped perpendiculars would land both edges on one side.
    const [canonicalFrom, canonicalTo] = fromEntity.id < toEntity.id
      ? [fromEntity, toEntity]
      : [toEntity, fromEntity];
    const offset = parallelOffset(
      canonicalFrom.transform.position,
      canonicalTo.transform.position,
      parallelIndex,
      parallelBundleSizes.get(pairKey)!
    );
    const kind = edgeTreatment(edge.kind, edge.id, warnings);
    const from = offsetPoint(fromEntity.transform.position, offset);
    const to = offsetPoint(toEntity.transform.position, offset);
    const via = viaWaypoint(
      from,
      to,
      endpointTier(edge.from),
      endpointTier(edge.to),
      tierFrontZ,
      parallelIndex,
      parallelBundleSizes.get(pairKey)!
    );
    connectorIdByEdgeId.set(edge.id, `edge:${edge.id}`);
    connectors.push({
      id: `edge:${edge.id}`,
      provenance: { edgeId: edge.id },
      fromId: fromEntity.id,
      toId: toEntity.id,
      from,
      to,
      ...(via ? { via } : {}),
      kind,
      ...(edge.label ? { label: edge.label } : {}),
      ...(edge.description !== undefined ? { description: edge.description } : {}),
      arrowheads: kind === "read_write" ? "both" : "to",
      ...(parallelIndex > 0 ? { parallelIndex } : {})
    });
  }

  return {
    schemaVersion: COMPOSED_DIAGRAM_SCHEMA_VERSION,
    kind: "solution",
    name: base.name,
    ...(base.description !== undefined ? { description: base.description } : {}),
    entities: [...nodeEntities.values(), ...groupEntities.values()],
    suppressedHiddenEntities,
    staleOverrides: collectStaleOverrides(base, human),
    connectors,
    flows: composeFlows(base.flows ?? [], connectorIdByEdgeId),
    warnings
  };
}

// Resolves each flow to the connectors that survived compose, in the order the
// flow names them.
//
// A step can vanish for reasons that are the human's doing rather than the
// document's: collapsing a group drops the edges internal to it, and hiding
// either endpoint drops the edge as well. Those steps are dropped from the
// flow rather than warned about — a warning that fires every time someone
// collapses a group would bury the vocabulary warnings the channel is for —
// and a flow left with nothing to light is omitted entirely, because a flow
// the renderer cannot animate is not one a person should be offered.
function composeFlows(
  flows: DiagramFlow[],
  connectorIdByEdgeId: Map<string, string>
): ComposedDiagramFlow[] {
  return flows.flatMap((flow) => {
    const connectorIds = flow.edges.flatMap((edgeId) => {
      const connectorId = connectorIdByEdgeId.get(edgeId);
      return connectorId ? [connectorId] : [];
    });
    if (connectorIds.length === 0) return [];
    return [{
      id: `flow:${flow.id}`,
      label: flow.label,
      provenance: { flowId: flow.id },
      connectorIds
    }];
  });
}

// The override entries that no longer land on anything, in file order.
//
// Deliberately computed from the base document's own ids rather than from the
// composed entities: a member omitted because its group is collapsed, and a node
// the human hid, both still exist in the design. Only an id the base does not
// declare at all is orphaned, so collapsing a group never makes the human's work
// look lost.
//
// Bounded by the source schema, which caps the override layer at one entry per
// node plus one per group.
function collectStaleOverrides(
  base: DiagramDocument,
  human: DiagramHumanDocument | undefined
): DiagramStaleOverride[] {
  if (!human || human.overrides.length === 0) return [];
  const declaredIds = new Set<string>([
    ...base.nodes.map((node) => node.id),
    ...base.groups.map((group) => group.id)
  ]);
  return human.overrides
    .filter((override) => !declaredIds.has(override.id))
    .map((override) => ({
      id: override.id,
      moved: override.transform !== undefined,
      ...(override.visible !== undefined ? { visible: override.visible } : {}),
      ...(override.locked !== undefined ? { locked: override.locked } : {}),
      ...(override.collapsed !== undefined ? { collapsed: override.collapsed } : {})
    }));
}

const GROUP_PLATTER_MATERIAL: SpatialSceneMaterial = {
  baseColor: "#8892A0",
  opacity: 0.18,
  roughness: 0.7
};

// A collapsed group stands in for its members, so it is drawn as a solid
// object rather than the flat, nearly transparent backdrop a platter is:
// occlusion and material density are the cues a viewer reads structure from
// (WWDC23 10078 t=222), and a stand-in that still looked like a backdrop would
// not read as holding anything. It is deliberately a little chunkier than a
// service node without becoming a different class of object — collapsing says
// "this group behaves as one component", not "this group became a room".
const COLLAPSED_GROUP_GEOMETRY: SpatialSceneGeometry = {
  kind: "box",
  size: [0.14, 0.1, 0.14],
  cornerRadius: 0.02
};

const COLLAPSED_GROUP_MATERIAL: SpatialSceneMaterial = {
  baseColor: "#8892A0",
  opacity: 0.5,
  roughness: 0.6
};

// Which groups are collapsed, and how far each moved group displaces what
// stands on it. The offset is measured against the group's own layout
// position, so it composes the same way whether the group is collapsed or
// expanded — the stand-in and the platter share one base position.
function resolveGroupState(
  groups: DiagramGroupPlacement[],
  overridesById: Map<string, DiagramHumanOverride>
): { collapsedGroupIds: Set<string>; groupOffsets: Map<string, DiagramPoint> } {
  const collapsedGroupIds = new Set<string>();
  const groupOffsets = new Map<string, DiagramPoint>();
  for (const placement of groups) {
    const override = overridesById.get(placement.id);
    if (override?.collapsed) collapsedGroupIds.add(placement.id);
    const moved = override?.transform?.position;
    if (!moved) continue;
    groupOffsets.set(placement.id, [
      cleanMetric(moved[0] - placement.position[0]),
      cleanMetric(moved[1] - placement.position[1]),
      cleanMetric(moved[2] - placement.position[2])
    ]);
  }
  return { collapsedGroupIds, groupOffsets };
}

export function composedDiagramVersion(document: DiagramRenderDocument): string {
  return sha256Hex(JSON.stringify(document));
}

function nodeTreatment(
  node: DiagramNode,
  warnings: string[]
): {
  geometry: SpatialSceneGeometry;
  material: SpatialSceneMaterial;
  rotationEulerDegrees?: [number, number, number];
} {
  switch (node.role) {
    case "service":
      return {
        geometry: { kind: "box", size: [0.12, 0.08, 0.12], cornerRadius: 0.02 },
        material: { baseColor: "#4A7FD4", roughness: 0.5 }
      };
    case "datastore":
      // The stacked-disk silhouette everyone reads as a database (Phase 5
      // slice 2). Same radius and the same 0.09 m total height as the plain
      // cylinder it replaces (3 × 0.024 + 2 × 0.009), so layout spacing, fit
      // bounds, and connector insets are untouched by the re-map.
      return {
        geometry: { kind: "stack", count: 3, radius: 0.055, height: 0.024, gap: 0.009 },
        material: { baseColor: "#3FA08A", roughness: 0.5 }
      };
    case "queue":
      return {
        geometry: { kind: "cylinder", radius: 0.04, height: 0.14 },
        material: { baseColor: "#D98E3B", roughness: 0.55 },
        rotationEulerDegrees: [0, 0, 90]
      };
    case "cache":
      return {
        geometry: { kind: "cylinder", radius: 0.055, height: 0.045 },
        material: { baseColor: "#C9A227", roughness: 0.5 }
      };
    case "external":
      return {
        geometry: { kind: "box", size: [0.12, 0.08, 0.12], cornerRadius: 0.02 },
        material: { baseColor: "#9AA1AA", opacity: 0.55, roughness: 0.6 }
      };
    case "actor":
      return {
        geometry: { kind: "sphere", radius: 0.05 },
        material: { baseColor: "#8A6FC9", roughness: 0.45 }
      };
    case "gateway":
      return {
        geometry: { kind: "box", size: [0.09, 0.09, 0.09], cornerRadius: 0.01 },
        material: { baseColor: "#3F9FB8", roughness: 0.45 },
        rotationEulerDegrees: [0, 45, 0]
      };
    case "function":
      return {
        geometry: { kind: "cone", radius: 0.05, height: 0.08 },
        material: { baseColor: "#C9C13F", roughness: 0.5 }
      };
    // The Phase 5 slice 1 additions: the roles agents reach for that used to
    // render as the gray warning box. Every treatment stays inside the two
    // composed-geometry envelopes the connector heuristics assume: no shape's
    // z half-extent exceeds CONNECTOR_VIA_NODE_HALF_DEPTH (0.07), and no
    // horizontal half-extent drops below PARALLEL_BUNDLE_MAX_HALF_WIDTH
    // (0.04), so the via bow still clears every tier and a fanned bundle's
    // outer connector still passes through the smallest shape. Each role's
    // baseColor is unique across the palette — the client recovers the role
    // from it for the label badge, pinned by a cross-repo test.
    case "load_balancer":
      // A wide, flat slab lying across the flow — traffic spreads over it.
      return {
        geometry: { kind: "box", size: [0.14, 0.04, 0.1], cornerRadius: 0.015 },
        material: { baseColor: "#D4704A", roughness: 0.5 }
      };
    case "cdn":
      // A translucent globe: the edge copy of your content, worldwide and
      // slightly outside the system the opaque shapes make up.
      return {
        geometry: { kind: "sphere", radius: 0.05 },
        material: { baseColor: "#5FC3D6", opacity: 0.6, roughness: 0.4 }
      };
    case "auth":
      // A tall rounded pillar — the bollard requests pass on the way in.
      return {
        geometry: { kind: "box", size: [0.08, 0.12, 0.08], cornerRadius: 0.03 },
        material: { baseColor: "#C2568C", roughness: 0.5 }
      };
    case "scheduler":
      // A diamond standing on its point: a tick mark, balanced until it
      // fires. Rotated about z, so its z half-extent stays the box's own.
      return {
        geometry: { kind: "box", size: [0.08, 0.08, 0.08], cornerRadius: 0.01 },
        material: { baseColor: "#5E5FC0", roughness: 0.45 },
        rotationEulerDegrees: [0, 0, 45]
      };
    case "blob_storage":
      // A wide, squat drum — bulk capacity rather than the datastore's
      // structured stack. Its 0.07 radius is the palette's deepest z
      // half-extent, tied with the collapsed-group stand-in.
      return {
        geometry: { kind: "cylinder", radius: 0.07, height: 0.07 },
        material: { baseColor: "#8C6D4F", roughness: 0.6 }
      };
    case "ml_model":
      // An inverted cone: a funnel distilling data into predictions.
      return {
        geometry: { kind: "cone", radius: 0.06, height: 0.1 },
        material: { baseColor: "#7B4FC9", roughness: 0.5 },
        rotationEulerDegrees: [180, 0, 0]
      };
    case "stream":
      // The queue's continuous cousin: a longer, thinner horizontal pipe in
      // its own colour, so the two message carriers read as siblings without
      // reading as the same thing.
      return {
        geometry: { kind: "cylinder", radius: 0.045, height: 0.18 },
        material: { baseColor: "#B8434E", roughness: 0.55 },
        rotationEulerDegrees: [0, 0, 90]
      };
    default:
      warnings.push(`Unknown role "${node.role}" on node "${node.id}"; rendered as generic`);
      return {
        geometry: { kind: "box", size: [0.1, 0.08, 0.1], cornerRadius: 0.01 },
        material: { baseColor: "#8E8E93", roughness: 0.6 }
      };
  }
}

function edgeTreatment(kind: string, edgeId: string, warnings: string[]): SupportedDiagramEdgeKind {
  if ((SUPPORTED_DIAGRAM_EDGE_KINDS as readonly string[]).includes(kind)) {
    return kind as SupportedDiagramEdgeKind;
  }
  warnings.push(`Unknown edge kind "${kind}" on edge "${edgeId}"; rendered as sync`);
  return "sync";
}

function mergeTransform(
  base: SpatialSceneTransform,
  override: DiagramHumanOverride | undefined
): SpatialSceneTransform {
  const rotation = override?.transform?.rotationEulerDegrees ?? base.rotationEulerDegrees;
  const scale = override?.transform?.scale ?? base.scale;
  return {
    position: override?.transform?.position ?? base.position,
    ...(rotation ? { rotationEulerDegrees: rotation } : {}),
    ...(scale ? { scale } : {})
  };
}

// Must clear the client's arrowhead cone radius (0.011 m in
// `SpatialSceneEntityBuilder.connectorArrowRadius`) with room to spare — at
// 0.01 m the commonest parallel pair, two opposed edges between the same two
// nodes, drew interpenetrating cones. The ≥ 2.5× relationship is pinned by a
// test that reads the client constant, so the two values cannot drift apart
// silently again.
export const PARALLEL_EDGE_SEPARATION = 0.03;

// The bundle's spread is capped so the outermost connector's centreline still
// passes through the smallest palette shape at both ends (the queue
// cylinder's 0.04 m radius is the tightest perpendicular extent). Past a
// three-edge bundle the spacing compresses instead of the bundle escaping its
// nodes: an arrow attached to nothing is a worse failure than two close
// cones, and a 4+-edge bundle between one pair is already degenerate design.
export const PARALLEL_BUNDLE_MAX_HALF_WIDTH = 0.04;

// Spreads a bundle of edges symmetrically about the segment they share, along
// a direction perpendicular to that segment. `from`/`to` are the pair's
// canonical orientation, not the edge's own, so every edge of the bundle fans
// out in one shared frame.
//
// Offsetting along a fixed axis — the original rule, and the one the v1 layout
// spec wrote down — is degenerate whenever the segment itself runs along that
// axis: it slides the duplicate along its own line and separates nothing. That
// is not a corner case here. Layout puts one tier's nodes at a single y and
// spreads them along x, so every intra-tier edge runs along x, and two services
// in one group calling each other is the commonest bidirectional pair a
// solution diagram has.
//
// The perpendicular is taken in the horizontal plane, so separated edges stay
// level with each other. A purely vertical segment has no horizontal
// perpendicular; it keeps the x axis, which already separates it precisely
// because it does not run along x.
function parallelOffset(
  from: DiagramPoint,
  to: DiagramPoint,
  index: number,
  bundleSize: number
): DiagramPoint {
  if (bundleSize < 2) return [0, 0, 0];
  const directionX = to[0] - from[0];
  const directionZ = to[2] - from[2];
  const horizontalLength = Math.hypot(directionZ, directionX);
  const [unitX, unitZ] = horizontalLength > 1e-9
    ? [directionZ / horizontalLength, -directionX / horizontalLength]
    : [1, 0];
  const halfWidth = Math.min(
    ((bundleSize - 1) / 2) * PARALLEL_EDGE_SEPARATION,
    PARALLEL_BUNDLE_MAX_HALF_WIDTH
  );
  const distance = index * ((2 * halfWidth) / (bundleSize - 1)) - halfWidth;
  return [cleanMetric(unitX * distance), 0, cleanMetric(unitZ * distance)];
}

// The z half-extent the bow assumes for anything standing on an intermediate
// tier. Conservative over the whole palette — the deepest current treatments
// are the blob_storage drum and the collapsed-group stand-in (0.07 m each,
// with the gateway box rotated 45° at ~0.064 m) — and a constant rather than
// per-entity rotated bounds, which keeps the bow a bounded heuristic instead
// of a collision router. A new role treatment must stay within it.
export const CONNECTOR_VIA_NODE_HALF_DEPTH = 0.07;

// Air between an intermediate node's front face and the polyline crossing its
// tier.
export const CONNECTOR_VIA_CLEARANCE = 0.01;

// The floor for every bow, and the whole bow when the tiers an edge crosses
// hold nothing deeper than the plane: the palette half-depth plus clearance
// (0.07 + 0.01), stated as one literal so the composed value is float-clean.
export const CONNECTOR_VIA_BOW_BASE = 0.08;

// The most a bow may reach however deep the intermediate tiers stand — a
// 62-member group's front row would otherwise demand ~0.7 m and more at long
// spans. The bow is a depth heuristic, not a router: past the cap the edge
// draws through what it cannot clear, exactly what every edge did before the
// bow existed, rather than ballooning the fit bounds the client derives from
// the apex.
export const CONNECTOR_VIA_BOW_MAX = 0.4;

// Parallel long edges take distinct bows so their apexes do not share a point
// in space the way their endpoints already do not share a line. The stagger
// compresses past a four-edge bundle instead of growing without bound — the
// schema admits 128 edges, and an uncapped stagger let a degenerate bundle
// push an apex metres out — the same rule as the sideways bundle fan-out's
// half-width cap.
export const CONNECTOR_VIA_BOW_PARALLEL_STEP = 0.02;
export const CONNECTOR_VIA_BOW_PARALLEL_MAX = 0.06;

// The waypoint a multi-tier edge bows through: the drawn midpoint pushed +z
// (toward the viewer in the volume), far enough that the polyline clears the
// front-most thing drawn on every tier it crosses. Emitted only for a span of
// two or more tiers, so a document whose edges all connect adjacent tiers
// composes byte-identically to before the field existed. Computed from the
// drawn endpoints and the intermediate tiers' drawn occupancy — both already
// carrying human overrides — so the bow rides with moved nodes on the next
// composed read; the *span* stays the base document's structural tier
// distance.
function viaWaypoint(
  from: DiagramPoint,
  to: DiagramPoint,
  fromTier: number,
  toTier: number,
  tierFrontZ: Map<number, number>,
  parallelIndex: number,
  bundleSize: number
): DiagramPoint | undefined {
  if (Math.abs(toTier - fromTier) < 2) return undefined;

  // The polyline's z at fraction f of the edge is the chord's z there plus
  // the bow scaled by closeness to the apex, w(f) = 2·min(f, 1 − f). Each
  // occupied tier the edge crosses demands the bow that lifts its crossing
  // past that tier's front face; the deepest demand wins. A fixed +z push
  // could not do this: the group lanes put nodes at z = 0.12, inside the
  // reach of any constant small enough to read as an arc.
  let bow = CONNECTOR_VIA_BOW_BASE;
  const lower = Math.min(fromTier, toTier);
  const upper = Math.max(fromTier, toTier);
  for (let tier = lower + 1; tier < upper; tier += 1) {
    const front = tierFrontZ.get(tier);
    if (front === undefined) continue;
    const fraction = (tier - fromTier) / (toTier - fromTier);
    const weight = 2 * Math.min(fraction, 1 - fraction);
    if (weight <= 0) continue;
    const chordZ = from[2] + fraction * (to[2] - from[2]);
    bow = Math.max(bow, (front + CONNECTOR_VIA_CLEARANCE - chordZ) / weight);
  }
  bow = Math.min(bow, CONNECTOR_VIA_BOW_MAX);

  const step = bundleSize > 1
    ? Math.min(CONNECTOR_VIA_BOW_PARALLEL_STEP, CONNECTOR_VIA_BOW_PARALLEL_MAX / (bundleSize - 1))
    : 0;
  const apex = bow + parallelIndex * step;
  return [
    cleanMetric((from[0] + to[0]) / 2),
    cleanMetric((from[1] + to[1]) / 2),
    cleanMetric((from[2] + to[2]) / 2 + apex)
  ];
}

function offsetPoint(point: DiagramPoint, offset: DiagramPoint): DiagramPoint {
  return [
    cleanMetric(point[0] + offset[0]),
    cleanMetric(point[1] + offset[1]),
    cleanMetric(point[2] + offset[2])
  ];
}

// Direction-independent identity for the segment two nodes share, so the
// parallel-edge counter treats an edge and its reverse as neighbours on one
// line. The id regex does not admit NUL, so it separates the ids unambiguously;
// keep it escaped so the TypeScript source remains an ordinary text file.
function unorderedPairKey(from: string, to: string): string {
  const [first, second] = from < to ? [from, to] : [to, from];
  return `${first}\u0000${second}`;
}
