// Phase 6 slice 1 of the spatial-solution-diagrams plan: the semantic edit-ops
// engine behind `POST /api/spatial-scene/diagram-edit`.
//
// This is what lets a client author *structure* — nodes, edges, labels, roles,
// groups — instead of only the placement its override layer already owns. It
// follows the Mermaid import bridge's shape exactly: pure, deterministic
// compute (no filesystem, no caller input compiled into a RegExp), producing a
// schema-valid document the route serializes canonically and the client writes
// itself through the bounded workspace PUT. The route converts and this module
// applies; neither ever writes.
//
// Two rules are load-bearing:
//
// - **Humans edit labels; the backend derives ids.** A changed id orphans
//   every human override keyed on it (the `staleOverrides` problem), so there
//   is deliberately no rename-id op. `addNode`/`addGroup` derive ids from
//   labels with the shared sanitizer and a deterministic collision ladder, and
//   the created ids are reported so the client can co-write a placement
//   override without parsing the document.
// - **Never a silent partial apply.** Ops apply sequentially and the first
//   inapplicable one fails the whole request with its op index; later ops in
//   the same request would otherwise cascade misleading errors off a state the
//   caller never saw. Deleting a node or edge is the one place an op has
//   knock-on effects (incident edges, flow steps), and each of those is a
//   bounded warning, never silence — the same discipline as the import's lossy
//   conversions.

import { z } from "zod";
import { allocateDiagramId, sanitizeDiagramIdText } from "./canonical";
import {
  DIAGRAM_SCHEMA_VERSION,
  MAX_DIAGRAM_EDGES,
  MAX_DIAGRAM_GROUPS,
  MAX_DIAGRAM_NODES,
  diagramDescriptionSchema,
  diagramDocumentSchema,
  diagramIdSchema,
  diagramLabelSchema,
  type DiagramDocument
} from "./schemas";

// A client interaction produces a handful of ops (a palette drop is two, a
// card edit is one); 32 bounds a batch without inviting document-sized ones.
export const MAX_DIAGRAM_EDIT_OPS = 32;

const MAX_REPORTED_ERRORS = 20;
const MAX_REPORTED_WARNINGS = 50;

export const DEFAULT_NEW_DIAGRAM_NAME = "New diagram";

// Role and kind values share the schema's open-vocabulary stance: any
// id-grammar value is accepted, the engine palette renders the closed set
// specially, and compose warns on the rest. The route does not need updating
// when the palette grows.
const roleSchema = diagramIdSchema;
const kindSchema = diagramIdSchema;

export const diagramEditOpSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("addNode"),
      label: diagramLabelSchema,
      role: roleSchema,
      groupId: diagramIdSchema.optional()
    })
    .strict(),
  z
    .object({
      op: z.literal("addEdge"),
      fromId: diagramIdSchema,
      toId: diagramIdSchema,
      kind: kindSchema.optional(),
      label: diagramLabelSchema.optional()
    })
    .strict(),
  z.object({ op: z.literal("setNodeLabel"), nodeId: diagramIdSchema, label: diagramLabelSchema }).strict(),
  z.object({ op: z.literal("setNodeRole"), nodeId: diagramIdSchema, role: roleSchema }).strict(),
  z.object({ op: z.literal("setEdgeKind"), edgeId: diagramIdSchema, kind: kindSchema }).strict(),
  // `label: null` clears an edge label; node labels are identity-bearing (ids
  // derive from them) and cannot be cleared, only replaced.
  z
    .object({ op: z.literal("setEdgeLabel"), edgeId: diagramIdSchema, label: diagramLabelSchema.nullable() })
    .strict(),
  z.object({ op: z.literal("deleteNode"), nodeId: diagramIdSchema }).strict(),
  z.object({ op: z.literal("deleteEdge"), edgeId: diagramIdSchema }).strict(),
  z.object({ op: z.literal("addGroup"), label: diagramLabelSchema }).strict(),
  z
    .object({
      op: z.literal("setNodeGroup"),
      nodeId: diagramIdSchema,
      groupId: diagramIdSchema.nullable()
    })
    .strict(),
  z.object({ op: z.literal("deleteGroup"), groupId: diagramIdSchema }).strict(),
  z.object({ op: z.literal("setName"), name: diagramLabelSchema }).strict(),
  // The v3 description ops. `description: null` clears, like a cleared edge
  // label; descriptions are annotations rather than identity, so every one of
  // them is clearable.
  z
    .object({
      op: z.literal("setNodeDescription"),
      nodeId: diagramIdSchema,
      description: diagramDescriptionSchema.nullable()
    })
    .strict(),
  z
    .object({
      op: z.literal("setEdgeDescription"),
      edgeId: diagramIdSchema,
      description: diagramDescriptionSchema.nullable()
    })
    .strict(),
  z
    .object({
      op: z.literal("setGroupDescription"),
      groupId: diagramIdSchema,
      description: diagramDescriptionSchema.nullable()
    })
    .strict(),
  z.object({ op: z.literal("setDescription"), description: diagramDescriptionSchema.nullable() }).strict()
]);

export const diagramEditOpsSchema = z
  .array(diagramEditOpSchema)
  .min(1)
  .max(MAX_DIAGRAM_EDIT_OPS);

export type DiagramEditOp = z.infer<typeof diagramEditOpSchema>;

export interface DiagramEditIssue {
  // Which op failed or warned; absent for base-document problems, where `path`
  // locates the issue instead.
  opIndex?: number;
  path?: string;
  message: string;
}

export interface DiagramEditCreated {
  opIndex: number;
  type: "node" | "edge" | "group";
  id: string;
}

export type DiagramEditResult =
  | {
      ok: true;
      document: DiagramDocument;
      warnings: DiagramEditIssue[];
      created: DiagramEditCreated[];
    }
  | { ok: false; errors: DiagramEditIssue[] };

export function applyDiagramEdits(input: {
  baseContent?: string;
  name?: string;
  ops: DiagramEditOp[];
}): DiagramEditResult {
  const base = resolveBaseDocument(input);
  if (!base.ok) {
    return base;
  }
  // The working copy always carries the current schema version: an older
  // document upgrades on its first human edit (v3 is what an author should
  // produce today, and absent `flows`/`description` keeps the document valid
  // either way).
  const document = structuredClone(base.document);
  document.schemaVersion = DIAGRAM_SCHEMA_VERSION;

  const warnings: DiagramEditIssue[] = [];
  const created: DiagramEditCreated[] = [];

  for (const [opIndex, op] of input.ops.entries()) {
    const error = applyOp(document, op, opIndex, warnings, created);
    if (error !== null) {
      return { ok: false, errors: [{ opIndex, message: error }] };
    }
  }

  const parsed = diagramDocumentSchema.safeParse(document);
  if (!parsed.success) {
    // Not an input problem: every op checked its own applicability, so an
    // invalid result means this module's invariant broke. Throwing routes the
    // blame to a 500 instead of telling the client its edit was at fault.
    const issue = parsed.error.issues[0];
    throw new Error(
      `diagram-edit produced an invalid document: ${issue?.message ?? "unknown issue"}`
    );
  }

  return { ok: true, document: parsed.data, warnings: boundWarnings(warnings), created };
}

// --- base document ----------------------------------------------------------

type BaseResolution = { ok: true; document: DiagramDocument } | { ok: false; errors: DiagramEditIssue[] };

function resolveBaseDocument(input: { baseContent?: string; name?: string }): BaseResolution {
  if (input.baseContent === undefined) {
    return {
      ok: true,
      document: {
        schemaVersion: DIAGRAM_SCHEMA_VERSION,
        kind: "solution",
        name: input.name ?? DEFAULT_NEW_DIAGRAM_NAME,
        nodes: [],
        edges: [],
        groups: []
      }
    };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(input.baseContent);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown parse error";
    return { ok: false, errors: [{ message: `Base document is not valid JSON: ${detail}` }] };
  }
  const parsed = diagramDocumentSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, MAX_REPORTED_ERRORS).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    };
  }
  return { ok: true, document: parsed.data };
}

// --- op application ---------------------------------------------------------

// Applies one op in place. Returns an error message when the op is
// inapplicable, else null.
function applyOp(
  document: DiagramDocument,
  op: DiagramEditOp,
  opIndex: number,
  warnings: DiagramEditIssue[],
  created: DiagramEditCreated[]
): string | null {
  switch (op.op) {
    case "addNode": {
      if (document.nodes.length >= MAX_DIAGRAM_NODES) {
        return `Adding a node would exceed the maximum of ${MAX_DIAGRAM_NODES} nodes`;
      }
      if (op.groupId !== undefined && !hasGroup(document, op.groupId)) {
        return `Unknown group id "${op.groupId}"`;
      }
      const id = allocateNodeOrGroupId(document, op.label, "node");
      document.nodes.push({
        id,
        label: op.label,
        role: op.role,
        ...(op.groupId === undefined ? {} : { group: op.groupId })
      });
      created.push({ opIndex, type: "node", id });
      return null;
    }
    case "addEdge": {
      if (document.edges.length >= MAX_DIAGRAM_EDGES) {
        return `Adding an edge would exceed the maximum of ${MAX_DIAGRAM_EDGES} edges`;
      }
      for (const endpoint of [op.fromId, op.toId]) {
        if (!hasNode(document, endpoint)) {
          return `Unknown node id "${endpoint}"`;
        }
      }
      if (op.fromId === op.toId) {
        return "Edge endpoints must be different";
      }
      const id = allocateEdgeId(document);
      document.edges.push({
        id,
        from: op.fromId,
        to: op.toId,
        ...(op.label === undefined ? {} : { label: op.label }),
        kind: op.kind ?? "sync"
      });
      created.push({ opIndex, type: "edge", id });
      return null;
    }
    case "setNodeLabel": {
      const node = findNode(document, op.nodeId);
      if (node === undefined) {
        return `Unknown node id "${op.nodeId}"`;
      }
      node.label = op.label;
      return null;
    }
    case "setNodeRole": {
      const node = findNode(document, op.nodeId);
      if (node === undefined) {
        return `Unknown node id "${op.nodeId}"`;
      }
      node.role = op.role;
      return null;
    }
    case "setEdgeKind": {
      const edge = findEdge(document, op.edgeId);
      if (edge === undefined) {
        return `Unknown edge id "${op.edgeId}"`;
      }
      edge.kind = op.kind;
      return null;
    }
    case "setEdgeLabel": {
      const edge = findEdge(document, op.edgeId);
      if (edge === undefined) {
        return `Unknown edge id "${op.edgeId}"`;
      }
      if (op.label === null) {
        delete edge.label;
      } else {
        edge.label = op.label;
      }
      return null;
    }
    case "deleteNode": {
      if (!hasNode(document, op.nodeId)) {
        return `Unknown node id "${op.nodeId}"`;
      }
      document.nodes = document.nodes.filter((node) => node.id !== op.nodeId);
      const droppedEdges = document.edges.filter(
        (edge) => edge.from === op.nodeId || edge.to === op.nodeId
      );
      document.edges = document.edges.filter(
        (edge) => edge.from !== op.nodeId && edge.to !== op.nodeId
      );
      for (const edge of droppedEdges) {
        warnings.push({
          opIndex,
          message: `Edge "${edge.id}" from "${edge.from}" to "${edge.to}" dropped with node "${op.nodeId}"`
        });
        removeEdgeFromFlows(document, edge.id, opIndex, warnings);
      }
      return null;
    }
    case "deleteEdge": {
      if (!hasEdge(document, op.edgeId)) {
        return `Unknown edge id "${op.edgeId}"`;
      }
      document.edges = document.edges.filter((edge) => edge.id !== op.edgeId);
      removeEdgeFromFlows(document, op.edgeId, opIndex, warnings);
      return null;
    }
    case "addGroup": {
      if (document.groups.length >= MAX_DIAGRAM_GROUPS) {
        return `Adding a group would exceed the maximum of ${MAX_DIAGRAM_GROUPS} groups`;
      }
      const id = allocateNodeOrGroupId(document, op.label, "group");
      document.groups.push({ id, label: op.label });
      created.push({ opIndex, type: "group", id });
      return null;
    }
    case "setNodeGroup": {
      const node = findNode(document, op.nodeId);
      if (node === undefined) {
        return `Unknown node id "${op.nodeId}"`;
      }
      if (op.groupId === null) {
        delete node.group;
        return null;
      }
      if (!hasGroup(document, op.groupId)) {
        return `Unknown group id "${op.groupId}"`;
      }
      node.group = op.groupId;
      return null;
    }
    case "deleteGroup": {
      if (!hasGroup(document, op.groupId)) {
        return `Unknown group id "${op.groupId}"`;
      }
      document.groups = document.groups.filter((group) => group.id !== op.groupId);
      let ungrouped = 0;
      for (const node of document.nodes) {
        if (node.group === op.groupId) {
          delete node.group;
          ungrouped += 1;
        }
      }
      if (ungrouped > 0) {
        warnings.push({
          opIndex,
          message: `${ungrouped} member node(s) of group "${op.groupId}" ungrouped`
        });
      }
      return null;
    }
    case "setName": {
      document.name = op.name;
      return null;
    }
    case "setNodeDescription": {
      const node = findNode(document, op.nodeId);
      if (node === undefined) {
        return `Unknown node id "${op.nodeId}"`;
      }
      if (op.description === null) {
        delete node.description;
      } else {
        node.description = op.description;
      }
      return null;
    }
    case "setEdgeDescription": {
      const edge = findEdge(document, op.edgeId);
      if (edge === undefined) {
        return `Unknown edge id "${op.edgeId}"`;
      }
      if (op.description === null) {
        delete edge.description;
      } else {
        edge.description = op.description;
      }
      return null;
    }
    case "setGroupDescription": {
      const group = document.groups.find((candidate) => candidate.id === op.groupId);
      if (group === undefined) {
        return `Unknown group id "${op.groupId}"`;
      }
      if (op.description === null) {
        delete group.description;
      } else {
        group.description = op.description;
      }
      return null;
    }
    case "setDescription": {
      if (op.description === null) {
        delete document.description;
      } else {
        document.description = op.description;
      }
      return null;
    }
  }
}

// A flow may only reference declared edges (schema rule), so deleting an edge
// must trim it. A repeated edge id is multiple steps and they all go; a flow
// left with nothing is removed entirely, because a flow with no steps fails
// the schema and a client should learn the path is gone rather than compose a
// broken document.
function removeEdgeFromFlows(
  document: DiagramDocument,
  edgeId: string,
  opIndex: number,
  warnings: DiagramEditIssue[]
): void {
  if (document.flows === undefined) {
    return;
  }
  const keptFlows = [];
  for (const flow of document.flows) {
    const keptSteps = flow.edges.filter((step) => step !== edgeId);
    const droppedSteps = flow.edges.length - keptSteps.length;
    if (droppedSteps === 0) {
      keptFlows.push(flow);
      continue;
    }
    if (keptSteps.length === 0) {
      warnings.push({
        opIndex,
        message: `Flow "${flow.id}" removed; deleting edge "${edgeId}" left it with no steps`
      });
      continue;
    }
    warnings.push({
      opIndex,
      message: `Flow "${flow.id}" dropped ${droppedSteps} step(s) that referenced deleted edge "${edgeId}"`
    });
    keptFlows.push({ ...flow, edges: keptSteps });
  }
  if (keptFlows.length === 0) {
    delete document.flows;
  } else {
    document.flows = keptFlows;
  }
}

// --- id allocation ----------------------------------------------------------

// Node and group ids share one namespace (human overrides key on bare ids), so
// both allocate against the union. Derived from the label, like the import
// derives from the Mermaid id, with the same ladder.
function allocateNodeOrGroupId(
  document: DiagramDocument,
  label: string,
  fallback: "node" | "group"
): string {
  const used = new Set<string>([
    ...document.nodes.map((node) => node.id),
    ...document.groups.map((group) => group.id)
  ]);
  const base = sanitizeDiagramIdText(label) || fallback;
  return allocateDiagramId(base, used);
}

// Edge ids follow the import's `e1`…`eN` shape: the smallest unused ordinal,
// which is deterministic and may refill a gap a delete left — safe, because a
// deleted edge id is scrubbed from flows above and nothing else references
// edge ids.
function allocateEdgeId(document: DiagramDocument): string {
  const used = new Set(document.edges.map((edge) => edge.id));
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = `e${ordinal}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

// --- helpers ----------------------------------------------------------------

function findNode(document: DiagramDocument, nodeId: string) {
  return document.nodes.find((node) => node.id === nodeId);
}

function findEdge(document: DiagramDocument, edgeId: string) {
  return document.edges.find((edge) => edge.id === edgeId);
}

function hasNode(document: DiagramDocument, nodeId: string): boolean {
  return findNode(document, nodeId) !== undefined;
}

function hasEdge(document: DiagramDocument, edgeId: string): boolean {
  return findEdge(document, edgeId) !== undefined;
}

function hasGroup(document: DiagramDocument, groupId: string): boolean {
  return document.groups.some((group) => group.id === groupId);
}

function boundWarnings(warnings: DiagramEditIssue[]): DiagramEditIssue[] {
  if (warnings.length <= MAX_REPORTED_WARNINGS) {
    return warnings;
  }
  return [
    ...warnings.slice(0, MAX_REPORTED_WARNINGS),
    { message: `…and ${warnings.length - MAX_REPORTED_WARNINGS} more warnings` }
  ];
}
