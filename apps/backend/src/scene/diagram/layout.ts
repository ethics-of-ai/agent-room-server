import type { DiagramDocument, DiagramNode } from "./schemas";

// Canonical v1 layout constants (meters). The renderer uniformly scales the
// completed root to fit its volume; layout itself never depends on client
// bounds or time/randomness.
export const DIAGRAM_NODE_PITCH_X = 0.18;
export const DIAGRAM_ROW_PITCH_Z = 0.15;
export const DIAGRAM_TIER_PITCH_Y = 0.28;
export const DIAGRAM_PLATTER_MARGIN = 0.04;
export const DIAGRAM_MAX_NODES_PER_ROW = 8;
// Each group's z lane. Without it every ungrouped node sits at z = 0
// and a group only leaves the plane when a row overflows, so a typical diagram
// is a flat poster standing in a 3D container. Groups alternate ± this offset
// by document order — deterministic, like everything else here — which
// separates them in depth and gives the room presentation something to walk
// around; ungrouped atoms stay at z = 0. The magnitude is a headset judgement
// the plan flags for tuning: large enough to read as a distinct lane past the
// deepest palette shape (a service box spans ±0.06 in z), small enough that a
// front lane's billboarded captions do not occlude a back lane's nodes from a
// seated viewpoint.
export const DIAGRAM_GROUP_LANE_Z = 0.12;

const NODE_FOOTPRINT_X = 0.12;
const NODE_FOOTPRINT_Z = 0.12;
const ATOM_GAP_X = 0.1;
const PLATTER_Y_OFFSET = -0.06;

export type DiagramPoint = [number, number, number];

export interface DiagramNodePlacement {
  id: string;
  groupId?: string;
  position: DiagramPoint;
  tier: number;
}

export interface DiagramGroupPlacement {
  id: string;
  position: DiagramPoint;
  width: number;
  depth: number;
  tier: number;
}

export interface DiagramLayout {
  nodes: DiagramNodePlacement[];
  groups: DiagramGroupPlacement[];
}

interface LayoutAtom {
  key: string;
  documentOrder: number;
  groupId?: string;
  nodes: DiagramNode[];
  width: number;
  depth: number;
}

interface AtomEdge {
  from: number;
  to: number;
}

// Deterministic Sugiyama-lite layout. Groups are condensed into atomic graph
// vertices; ungrouped nodes are singleton vertices. A document-order DFS drops
// cycle back edges, tiers are longest paths from sources, and a downward
// barycenter sweep seeds each tier's order before a fixed up/down refinement
// pass uncrosses what a single sweep cannot see — each stage kept only if it
// leaves no more crossings than the best ordering so far. Human overrides are
// intentionally absent: compose applies them after this pure base-document
// layout.
export function layoutDiagram(document: DiagramDocument): DiagramLayout {
  const { atoms, atomIndexByNodeId } = buildAtoms(document);
  const graphEdges = buildAtomEdges(document, atomIndexByNodeId);
  const keptEdges = dropCycleBackEdges(atoms.length, graphEdges);
  const tiers = longestPathTiers(atoms.length, keptEdges);
  const atomsByTier = orderAtomsByTier(atoms, tiers, keptEdges);

  const nodePlacements = new Map<string, DiagramNodePlacement>();
  const groupPlacements = new Map<string, DiagramGroupPlacement>();
  const placedNodeX = new Map<string, number>();
  const nodeDocumentOrder = new Map(document.nodes.map((node, index) => [node.id, index]));

  for (const [tier, atomIndexes] of atomsByTier.entries()) {
    const totalWidth = atomIndexes.reduce((sum, atomIndex) => sum + atoms[atomIndex]!.width, 0)
      + Math.max(0, atomIndexes.length - 1) * ATOM_GAP_X;
    let cursorX = -totalWidth / 2;

    for (const atomIndex of atomIndexes) {
      const atom = atoms[atomIndex]!;
      const centerX = cursorX + atom.width / 2;
      const tierY = -tier * DIAGRAM_TIER_PITCH_Y;
      // A group atom's documentOrder is its index in document.groups, so the
      // lane assignment survives regeneration as long as the group order does.
      const laneZ = atom.groupId ? groupLaneZ(atom.documentOrder) : 0;
      const orderedNodes = orderNodesWithinAtom(atom.nodes, document, placedNodeX, nodeDocumentOrder);

      if (atom.groupId) {
        groupPlacements.set(atom.groupId, {
          id: atom.groupId,
          position: [cleanMetric(centerX), cleanMetric(tierY + PLATTER_Y_OFFSET), cleanMetric(laneZ)],
          width: atom.width,
          depth: atom.depth,
          tier
        });
      }

      const rowCount = Math.max(1, Math.ceil(orderedNodes.length / DIAGRAM_MAX_NODES_PER_ROW));
      for (const [nodeOrder, node] of orderedNodes.entries()) {
        const row = Math.floor(nodeOrder / DIAGRAM_MAX_NODES_PER_ROW);
        const rowStart = row * DIAGRAM_MAX_NODES_PER_ROW;
        const columnsInRow = Math.min(
          DIAGRAM_MAX_NODES_PER_ROW,
          orderedNodes.length - rowStart
        );
        const column = nodeOrder - rowStart;
        const localX = (column - (columnsInRow - 1) / 2) * DIAGRAM_NODE_PITCH_X;
        const localZ = (row - (rowCount - 1) / 2) * DIAGRAM_ROW_PITCH_Z;
        const placement: DiagramNodePlacement = {
          id: node.id,
          ...(node.group ? { groupId: node.group } : {}),
          position: [cleanMetric(centerX + localX), cleanMetric(tierY), cleanMetric(laneZ + localZ)],
          tier
        };
        nodePlacements.set(node.id, placement);
        placedNodeX.set(node.id, placement.position[0]);
      }

      cursorX += atom.width + ATOM_GAP_X;
    }
  }

  return {
    nodes: document.nodes.map((node) => nodePlacements.get(node.id)!),
    groups: document.groups.map((group) => groupPlacements.get(group.id)!)
  };
}

function buildAtoms(document: DiagramDocument): {
  atoms: LayoutAtom[];
  atomIndexByNodeId: Map<string, number>;
} {
  const nodesByGroup = new Map<string, DiagramNode[]>();
  for (const group of document.groups) nodesByGroup.set(group.id, []);
  for (const node of document.nodes) {
    if (node.group) nodesByGroup.get(node.group)!.push(node);
  }

  const atoms: LayoutAtom[] = document.groups.map((group, index) => {
    const nodes = nodesByGroup.get(group.id) ?? [];
    const size = platterSize(nodes.length);
    return {
      key: `group:${group.id}`,
      documentOrder: index,
      groupId: group.id,
      nodes,
      ...size
    };
  });

  for (const [nodeIndex, node] of document.nodes.entries()) {
    if (node.group) continue;
    atoms.push({
      key: `node:${node.id}`,
      documentOrder: document.groups.length + nodeIndex,
      nodes: [node],
      width: NODE_FOOTPRINT_X,
      depth: NODE_FOOTPRINT_Z
    });
  }

  const atomIndexByNodeId = new Map<string, number>();
  for (const [atomIndex, atom] of atoms.entries()) {
    for (const node of atom.nodes) atomIndexByNodeId.set(node.id, atomIndex);
  }
  return { atoms, atomIndexByNodeId };
}

// Alternating ± lanes: the first group comes toward the viewer, the second
// recedes, and so on. Groups two apart share a lane, which is fine — tiers
// already separate them in x/y, and two lanes are what depth legibility needs;
// a staircase of ever-deeper lanes would walk long documents out of the
// container instead.
function groupLaneZ(groupIndex: number): number {
  return (groupIndex % 2 === 0 ? 1 : -1) * DIAGRAM_GROUP_LANE_Z;
}

function platterSize(nodeCount: number): { width: number; depth: number } {
  const columns = Math.max(1, Math.min(nodeCount, DIAGRAM_MAX_NODES_PER_ROW));
  const rows = Math.max(1, Math.ceil(nodeCount / DIAGRAM_MAX_NODES_PER_ROW));
  return {
    width: cleanMetric(NODE_FOOTPRINT_X
      + (columns - 1) * DIAGRAM_NODE_PITCH_X
      + DIAGRAM_PLATTER_MARGIN * 2),
    depth: cleanMetric(NODE_FOOTPRINT_Z
      + (rows - 1) * DIAGRAM_ROW_PITCH_Z
      + DIAGRAM_PLATTER_MARGIN * 2)
  };
}

function buildAtomEdges(document: DiagramDocument, atomIndexByNodeId: Map<string, number>): AtomEdge[] {
  const edges: AtomEdge[] = [];
  const seen = new Set<string>();
  for (const edge of document.edges) {
    const from = atomIndexByNodeId.get(edge.from)!;
    const to = atomIndexByNodeId.get(edge.to)!;
    if (from === to) continue;
    const key = `${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  return edges;
}

function dropCycleBackEdges(atomCount: number, edges: AtomEdge[]): AtomEdge[] {
  const adjacency = Array.from({ length: atomCount }, () => [] as number[]);
  for (const [edgeIndex, edge] of edges.entries()) adjacency[edge.from]!.push(edgeIndex);
  const state = Array<number>(atomCount).fill(0);
  const kept = Array<boolean>(edges.length).fill(false);

  const visit = (atomIndex: number): void => {
    state[atomIndex] = 1;
    for (const edgeIndex of adjacency[atomIndex]!) {
      const edge = edges[edgeIndex]!;
      if (state[edge.to] === 1) continue;
      kept[edgeIndex] = true;
      if (state[edge.to] === 0) visit(edge.to);
    }
    state[atomIndex] = 2;
  };

  for (let atomIndex = 0; atomIndex < atomCount; atomIndex += 1) {
    if (state[atomIndex] === 0) visit(atomIndex);
  }
  return edges.filter((_, index) => kept[index]);
}

function longestPathTiers(atomCount: number, edges: AtomEdge[]): number[] {
  const outgoing = Array.from({ length: atomCount }, () => [] as number[]);
  const indegree = Array<number>(atomCount).fill(0);
  for (const edge of edges) {
    outgoing[edge.from]!.push(edge.to);
    indegree[edge.to] += 1;
  }

  const tiers = Array<number>(atomCount).fill(0);
  const ready: number[] = [];
  for (let index = 0; index < atomCount; index += 1) {
    if (indegree[index] === 0) ready.push(index);
  }

  while (ready.length > 0) {
    ready.sort((left, right) => left - right);
    const current = ready.shift()!;
    for (const target of outgoing[current]!) {
      tiers[target] = Math.max(tiers[target]!, tiers[current]! + 1);
      indegree[target] -= 1;
      if (indegree[target] === 0) ready.push(target);
    }
  }
  return tiers;
}

function orderAtomsByTier(atoms: LayoutAtom[], tiers: number[], edges: AtomEdge[]): number[][] {
  const maxTier = tiers.length === 0 ? -1 : Math.max(...tiers);
  const result = Array.from({ length: maxTier + 1 }, () => [] as number[]);
  const rank = new Map<number, number>();
  const incoming = Array.from({ length: atoms.length }, () => [] as number[]);
  const outgoing = Array.from({ length: atoms.length }, () => [] as number[]);
  for (const edge of edges) {
    incoming[edge.to]!.push(edge.from);
    outgoing[edge.from]!.push(edge.to);
  }

  const tieBreak = (left: number, right: number): number => {
    const documentOrder = atoms[left]!.documentOrder - atoms[right]!.documentOrder;
    return documentOrder !== 0 ? documentOrder : atoms[left]!.key.localeCompare(atoms[right]!.key);
  };

  // Seeding pass — the original single downward sweep: each tier ordered by
  // the barycenter of its already-ranked parents, atoms with none sorting
  // after the ranked ones in document order.
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const atomIndexes = atoms
      .map((_, index) => index)
      .filter((index) => tiers[index] === tier);
    atomIndexes.sort((left, right) => {
      const leftBarycenter = barycenter(incoming[left]!, rank);
      const rightBarycenter = barycenter(incoming[right]!, rank);
      const barycenterOrder = compareBarycenters(leftBarycenter, rightBarycenter);
      if (barycenterOrder !== 0) return barycenterOrder;
      return tieBreak(left, right);
    });
    result[tier] = atomIndexes;
    atomIndexes.forEach((atomIndex, index) => rank.set(atomIndex, index));
  }

  // Refinement — a fixed schedule (one upward sweep by children, one downward
  // sweep by parents), so determinism holds. The seeding pass cannot see below
  // the tier it is ordering, so a source tier laid out in document order keeps
  // crossings the tiers under it then have to live with; the upward sweep is
  // what lets structure below reorder it.
  //
  // Unlike the seeding pass, an atom with no ranked neighbour on the sweep's
  // side keeps its current slot instead of sorting to the end: the sweep
  // refines an order that already exists, and "no information" must not move
  // an atom — sorting sources last in the final downward sweep would undo
  // exactly what the upward sweep fixed.
  const refineTier = (tier: number, neighbours: number[][]): void => {
    const current = result[tier]!;
    if (current.length < 2) return;
    const position = new Map(current.map((atomIndex, index) => [atomIndex, index]));
    const sortValue = (atomIndex: number): number => {
      const value = barycenter(neighbours[atomIndex]!, rank);
      return Number.isFinite(value) ? value : position.get(atomIndex)!;
    };
    const sorted = [...current].sort((left, right) => {
      const order = sortValue(left) - sortValue(right);
      return order !== 0 ? order : tieBreak(left, right);
    });
    result[tier] = sorted;
    sorted.forEach((atomIndex, index) => rank.set(atomIndex, index));
  };

  // Barycenter refinement is not monotone: a sweep can also *introduce* a
  // crossing, because a rank in one tier is compared against a rank in
  // another as if the two scales lined up. So each stage is a candidate, not
  // an answer: the ordering that leaves the fewest crossings wins, and ties
  // keep the earliest candidate so a document whose crossings the sweeps
  // cannot improve keeps its seeded layout instead of re-flowing for nothing.
  const snapshot = (): number[][] => result.map((tierAtoms) => [...tierAtoms]);
  const candidates = [snapshot()];
  for (let tier = maxTier - 1; tier >= 0; tier -= 1) refineTier(tier, outgoing);
  candidates.push(snapshot());
  for (let tier = 1; tier <= maxTier; tier += 1) refineTier(tier, incoming);
  candidates.push(snapshot());

  let best = candidates[0]!;
  let bestCrossings = orderingCrossings(best, atoms, tiers, edges);
  for (const candidate of candidates.slice(1)) {
    const candidateCrossings = orderingCrossings(candidate, atoms, tiers, edges);
    if (candidateCrossings < bestCrossings) {
      best = candidate;
      bestCrossings = candidateCrossings;
    }
  }
  return best;
}

// The centre x each atom would be placed at under an ordering, mirroring the
// placement loop exactly, so the crossing count judges candidates by the
// geometry that will actually be drawn rather than by raw ranks (whose scales
// differ between tiers of different widths).
function atomCenterXs(ordering: number[][], atoms: LayoutAtom[]): Map<number, number> {
  const centers = new Map<number, number>();
  for (const atomIndexes of ordering) {
    const totalWidth = atomIndexes.reduce((sum, atomIndex) => sum + atoms[atomIndex]!.width, 0)
      + Math.max(0, atomIndexes.length - 1) * ATOM_GAP_X;
    let cursorX = -totalWidth / 2;
    for (const atomIndex of atomIndexes) {
      centers.set(atomIndex, cursorX + atoms[atomIndex]!.width / 2);
      cursorX += atoms[atomIndex]!.width + ATOM_GAP_X;
    }
  }
  return centers;
}

// Proper intersections between the straight atom-centre segments an ordering
// implies, excluding pairs that share an endpoint. Pure and deterministic —
// this is the acceptance metric for the refinement sweeps, cheap at the
// schema's caps (at most 128 edges).
function orderingCrossings(
  ordering: number[][],
  atoms: LayoutAtom[],
  tiers: number[],
  edges: AtomEdge[]
): number {
  const centerX = atomCenterXs(ordering, atoms);
  const orient = (
    px: number, py: number,
    qx: number, qy: number,
    rx: number, ry: number
  ): number => {
    const value = (qx - px) * (ry - py) - (qy - py) * (rx - px);
    return Math.abs(value) < 1e-9 ? 0 : Math.sign(value);
  };
  let count = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i]!;
      const b = edges[j]!;
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      const ax = centerX.get(a.from)!, ay = tiers[a.from]!;
      const bx = centerX.get(a.to)!, by = tiers[a.to]!;
      const cx = centerX.get(b.from)!, cy = tiers[b.from]!;
      const dx = centerX.get(b.to)!, dy = tiers[b.to]!;
      const o1 = orient(ax, ay, bx, by, cx, cy);
      const o2 = orient(ax, ay, bx, by, dx, dy);
      const o3 = orient(cx, cy, dx, dy, ax, ay);
      const o4 = orient(cx, cy, dx, dy, bx, by);
      if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4) count += 1;
    }
  }
  return count;
}

function orderNodesWithinAtom(
  nodes: DiagramNode[],
  document: DiagramDocument,
  placedNodeX: Map<string, number>,
  documentOrder: Map<string, number>
): DiagramNode[] {
  const incomingX = new Map<string, number[]>();
  for (const edge of document.edges) {
    const sourceX = placedNodeX.get(edge.from);
    if (sourceX === undefined) continue;
    const values = incomingX.get(edge.to) ?? [];
    values.push(sourceX);
    incomingX.set(edge.to, values);
  }
  return [...nodes].sort((left, right) => {
    const leftBarycenter = averageOrInfinity(incomingX.get(left.id));
    const rightBarycenter = averageOrInfinity(incomingX.get(right.id));
    const barycenterOrder = compareBarycenters(leftBarycenter, rightBarycenter);
    if (barycenterOrder !== 0) return barycenterOrder;
    const order = documentOrder.get(left.id)! - documentOrder.get(right.id)!;
    return order !== 0 ? order : left.id.localeCompare(right.id);
  });
}

function barycenter(parents: number[], rank: Map<number, number>): number {
  const values = parents.flatMap((parent) => {
    const value = rank.get(parent);
    return value === undefined ? [] : [value];
  });
  return averageOrInfinity(values);
}

function averageOrInfinity(values: number[] | undefined): number {
  if (!values || values.length === 0) return Number.POSITIVE_INFINITY;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareBarycenters(left: number, right: number): number {
  if (left === right) return 0;
  if (!Number.isFinite(left)) return 1;
  if (!Number.isFinite(right)) return -1;
  return left - right;
}

// Rounds a computed metre value to micrometres and normalizes -0, so composed
// documents stay clean and byte-stable across recomputes (the composed version
// is a hash of them). Exported for the connector offsets in `diagram/compose.ts`,
// which are computed the same way and land in the same document.
export function cleanMetric(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
