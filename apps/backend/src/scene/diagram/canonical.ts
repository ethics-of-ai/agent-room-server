// Shared canonical helpers for solution-diagram documents.
//
// Two pure-compute surfaces hand a client `.diagram.json` *text* to write
// verbatim through the bounded workspace PUT — the Mermaid import bridge and
// the diagram edit route — and both must produce the same bytes for the same
// document, or a converted-then-edited file would churn on serialization
// alone. So the field order, indentation, and trailing newline live here, in
// exactly one place, alongside the id sanitizer that turns free text into the
// diagram id grammar (`^[a-z0-9][a-z0-9_-]{0,63}$`) for ids and filename
// slugs alike.

import type {
  DiagramDocument,
  DiagramEdge,
  DiagramFlow,
  DiagramGroup,
  DiagramNode
} from "./schemas";

export const MAX_DIAGRAM_ID_LENGTH = 64;

// Lowercase, replace anything outside the id charset with `-`, squeeze runs,
// and trim edge separators — deterministically, so the same text always yields
// the same id or slug.
export function sanitizeDiagramIdText(raw: string): string {
  let cleaned = "";
  for (const ch of raw.toLowerCase()) {
    cleaned += /[a-z0-9_-]/.test(ch) ? ch : "-";
  }
  cleaned = cleaned.replace(/-{2,}/g, "-");
  cleaned = cleaned.replace(/^[-_]+/, "").replace(/[-_]+$/, "");
  cleaned = cleaned.slice(0, MAX_DIAGRAM_ID_LENGTH).replace(/[-_]+$/, "");
  return cleaned;
}

// The filename stem a route offers clients for a written `.diagram.json`,
// derived with the id sanitizer so filename rules live in one place.
export function diagramSlug(name: string, fallback: string): string {
  const slug = sanitizeDiagramIdText(name);
  return slug.length > 0 ? slug : fallback;
}

// Allocate an unused id from a base candidate with the deterministic `-2`,
// `-3`… collision ladder, respecting the id length cap. The caller owns the
// `used` set (node and group ids share one namespace; edge ids have their
// own).
export function allocateDiagramId(base: string, used: ReadonlySet<string>): string {
  let candidate = base;
  for (let ordinal = 2; used.has(candidate); ordinal += 1) {
    const suffix = `-${ordinal}`;
    candidate = `${base.slice(0, MAX_DIAGRAM_ID_LENGTH - suffix.length).replace(/[-_]+$/, "")}${suffix}`;
  }
  return candidate;
}

// Canonical serialization: fixed field order (the standing contract's example
// order), two-space indent, trailing newline. `JSON.stringify` preserves
// insertion order, so rebuilding each object is what pins the order for
// documents that arrived with fields shuffled.
export function serializeDiagramDocument(document: DiagramDocument): string {
  return `${JSON.stringify(canonicalDiagramDocument(document), null, 2)}\n`;
}

function canonicalDiagramDocument(document: DiagramDocument): DiagramDocument {
  const canonical: DiagramDocument = {
    schemaVersion: document.schemaVersion,
    kind: document.kind,
    name: document.name,
    // `description` sits directly after the human-text field it annotates —
    // here and on every item below — matching the zod shape order.
    ...(document.description !== undefined ? { description: document.description } : {}),
    nodes: document.nodes.map(canonicalNode),
    edges: document.edges.map(canonicalEdge),
    groups: document.groups.map(canonicalGroup)
  };
  // An absent and an empty `flows` mean the same thing; canonical form omits
  // the key so the two cannot produce different bytes.
  if (document.flows !== undefined && document.flows.length > 0) {
    canonical.flows = document.flows.map(canonicalFlow);
  }
  return canonical;
}

function canonicalNode(node: DiagramNode): DiagramNode {
  const canonical: DiagramNode = {
    id: node.id,
    label: node.label,
    ...(node.description !== undefined ? { description: node.description } : {}),
    role: node.role
  };
  if (node.group !== undefined) {
    canonical.group = node.group;
  }
  return canonical;
}

// Field order matches the zod schema *shape* order (label before kind),
// because the import route has always served `diagramDocumentSchema`'s parsed
// output and zod emits shape order — an already-imported file must not churn
// when re-serialized here.
function canonicalEdge(edge: DiagramEdge): DiagramEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    ...(edge.label !== undefined ? { label: edge.label } : {}),
    ...(edge.description !== undefined ? { description: edge.description } : {}),
    kind: edge.kind
  };
}

function canonicalGroup(group: DiagramGroup): DiagramGroup {
  return {
    id: group.id,
    label: group.label,
    ...(group.description !== undefined ? { description: group.description } : {})
  };
}

function canonicalFlow(flow: DiagramFlow): DiagramFlow {
  return { id: flow.id, label: flow.label, edges: [...flow.edges] };
}
