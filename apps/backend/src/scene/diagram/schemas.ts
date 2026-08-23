import { z } from "zod";
import { spatialSceneTransformOverrideSchema } from "../geometry/schemas";

// Semantic solution-diagram source contracts. Unlike geometry-first
// `.scene.json` files, a diagram contains no render coordinates: the backend
// lays it out deterministically and then applies the separate human override
// layer. The role/kind vocabulary is intentionally open in the schema for
// forward compatibility; compose maps unknown values to a bounded fallback and
// reports warnings.

// The version an agent should author against today. Version 2 added `flows`;
// version 3 added optional `description` fields (claimed here per the
// cross-plan coordination with the domain-profiles plan, whose `domain` field
// takes the next bump).
export const DIAGRAM_SCHEMA_VERSION = 3;
// Older documents still render. Diagram files are committed and travel between
// machines, so a version this engine predates must not turn into an error card
// just because it cannot use the newest field — the same forward-compatibility
// reasoning that keeps the role/kind vocabulary open. The bump is what makes
// the version an honest capability marker: a document may only carry `flows`
// once it declares 2, and `description` fields once it declares 3.
export const DIAGRAM_MIN_SCHEMA_VERSION = 1;
export const DIAGRAM_FLOWS_SCHEMA_VERSION = 2;
export const DIAGRAM_DESCRIPTIONS_SCHEMA_VERSION = 3;
export const MAX_DIAGRAM_NODES = 64;
export const MAX_DIAGRAM_EDGES = 128;
export const MAX_DIAGRAM_GROUPS = 16;
export const MAX_DIAGRAM_FLOWS = 16;
// A flow is a sequence a person watches step through, not a full traversal of
// the graph: 32 hops is already a long sequence to follow one hop at a time.
export const MAX_DIAGRAM_FLOW_STEPS = 32;
export const MAX_DIAGRAM_OVERRIDES = MAX_DIAGRAM_NODES + MAX_DIAGRAM_GROUPS;

export const DIAGRAM_BASE_SUFFIX = ".diagram.json";
export const DIAGRAM_HUMAN_SUFFIX = ".diagram.human.json";

export const diagramIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, {
  message: "Ids must match ^[a-z0-9][a-z0-9_-]{0,63}$"
});

export const diagramLabelSchema = z.string().trim().min(1).max(120);
const labelSchema = diagramLabelSchema;
const vocabularyValueSchema = diagramIdSchema;

// The v3 field that turns a diagram from a picture into a design document: a
// bounded explanation of *why* a component exists or what an edge carries,
// anchored to the thing it explains. Optional everywhere; absent means none,
// so an empty string is rejected rather than being a second spelling of
// absence.
export const diagramDescriptionSchema = z.string().trim().min(1).max(500);
const descriptionSchema = diagramDescriptionSchema;

export const diagramNodeSchema = z
  .object({
    id: diagramIdSchema,
    label: labelSchema,
    description: descriptionSchema.optional(),
    role: vocabularyValueSchema,
    group: diagramIdSchema.optional()
  })
  .strict();

export const diagramEdgeSchema = z
  .object({
    id: diagramIdSchema,
    from: diagramIdSchema,
    to: diagramIdSchema,
    label: labelSchema.optional(),
    description: descriptionSchema.optional(),
    kind: vocabularyValueSchema
  })
  .strict();

export const diagramGroupSchema = z
  .object({
    id: diagramIdSchema,
    label: labelSchema,
    description: descriptionSchema.optional()
  })
  .strict();

// A named, ordered walk over existing edges — the path a request, an order, or
// a message actually takes through the design. Flows carry no geometry: the
// renderer lights the edges the flow names, in the order it names them.
//
// Flow ids are deliberately *not* required to be disjoint from node and group
// ids. That rule exists because human overrides key on bare node/group ids, and
// a flow is never overridden — it is not placed. Requiring disjointness would
// reject the natural naming (a `checkout` flow through a `checkout` service)
// for no benefit.
export const diagramFlowSchema = z
  .object({
    id: diagramIdSchema,
    label: labelSchema,
    // Edge ids in traversal order. A repeated id is legal: a flow may cross the
    // same edge twice, and each occurrence is its own step.
    edges: z.array(diagramIdSchema).min(1).max(MAX_DIAGRAM_FLOW_STEPS)
  })
  .strict();

export const diagramDocumentSchema = z
  .object({
    schemaVersion: z
      .number()
      .int()
      .min(DIAGRAM_MIN_SCHEMA_VERSION)
      .max(DIAGRAM_SCHEMA_VERSION),
    kind: z.literal("solution"),
    name: labelSchema,
    description: descriptionSchema.optional(),
    nodes: z.array(diagramNodeSchema).max(MAX_DIAGRAM_NODES),
    edges: z.array(diagramEdgeSchema).max(MAX_DIAGRAM_EDGES),
    groups: z.array(diagramGroupSchema).max(MAX_DIAGRAM_GROUPS),
    flows: z.array(diagramFlowSchema).max(MAX_DIAGRAM_FLOWS).optional()
  })
  .strict()
  .superRefine((document, context) => {
    addDuplicateIssues(document.nodes, "nodes", context);
    addDuplicateIssues(document.edges, "edges", context);
    addDuplicateIssues(document.groups, "groups", context);
    addDuplicateIssues(document.flows ?? [], "flows", context);

    const nodeIds = new Set(document.nodes.map((node) => node.id));
    const groupIds = new Set(document.groups.map((group) => group.id));
    const edgeIds = new Set(document.edges.map((edge) => edge.id));

    if (document.flows && document.schemaVersion < DIAGRAM_FLOWS_SCHEMA_VERSION) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"flows" requires schemaVersion ${DIAGRAM_FLOWS_SCHEMA_VERSION}`,
        path: ["flows"]
      });
    }

    // Like `flows` at 2: the version is only an honest capability marker if a
    // document cannot carry the field while declaring less.
    if (document.schemaVersion < DIAGRAM_DESCRIPTIONS_SCHEMA_VERSION) {
      if (document.description !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"description" requires schemaVersion ${DIAGRAM_DESCRIPTIONS_SCHEMA_VERSION}`,
          path: ["description"]
        });
      }
      for (const [collection, items] of [
        ["nodes", document.nodes],
        ["edges", document.edges],
        ["groups", document.groups]
      ] as const) {
        for (const [index, item] of items.entries()) {
          if (item.description !== undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              message: `"description" requires schemaVersion ${DIAGRAM_DESCRIPTIONS_SCHEMA_VERSION}`,
              path: [collection, index, "description"]
            });
          }
        }
      }
    }

    for (const [flowIndex, flow] of (document.flows ?? []).entries()) {
      for (const [stepIndex, edgeId] of flow.edges.entries()) {
        if (!edgeIds.has(edgeId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown edge id "${edgeId}"`,
            path: ["flows", flowIndex, "edges", stepIndex]
          });
        }
      }
    }

    for (const [index, node] of document.nodes.entries()) {
      if (node.group && !groupIds.has(node.group)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown group id "${node.group}"`,
          path: ["nodes", index, "group"]
        });
      }
      // Human overrides use bare semantic ids, so a node and group may not
      // share one: that would make an override target ambiguous.
      if (groupIds.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Node id "${node.id}" conflicts with a group id`,
          path: ["nodes", index, "id"]
        });
      }
    }

    for (const [index, edge] of document.edges.entries()) {
      if (edge.from === edge.to) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Edge endpoints must be different",
          path: ["edges", index]
        });
      }
      if (!nodeIds.has(edge.from)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown source node id "${edge.from}"`,
          path: ["edges", index, "from"]
        });
      }
      if (!nodeIds.has(edge.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown target node id "${edge.to}"`,
          path: ["edges", index, "to"]
        });
      }
    }
  });

export const diagramTransformOverrideSchema = spatialSceneTransformOverrideSchema.strict();

export const diagramHumanOverrideSchema = z
  .object({
    id: diagramIdSchema,
    transform: diagramTransformOverrideSchema.optional(),
    visible: z.boolean().optional(),
    locked: z.boolean().optional(),
    // Group ids only: a collapsed group composes to a single stand-in entity
    // instead of its member nodes. Meaningless on a node id, where compose
    // ignores it rather than failing the document — the schema stays strict
    // about structure, not about which entry a flag is useful on.
    collapsed: z.boolean().optional()
  })
  .strict();

// The override layer versions independently of the base document: it describes
// the human's placement, not the design, and nothing about `flows` changed its
// shape. Slice 3 set the same precedent by adding `collapsed` without a bump.
export const DIAGRAM_HUMAN_SCHEMA_VERSION = 1;

export const diagramHumanDocumentSchema = z
  .object({
    schemaVersion: z.literal(DIAGRAM_HUMAN_SCHEMA_VERSION),
    baseline: z.string().max(128).optional(),
    overrides: z.array(diagramHumanOverrideSchema).max(MAX_DIAGRAM_OVERRIDES)
  })
  .strict()
  .superRefine((document, context) => {
    addDuplicateIssues(document.overrides, "overrides", context);
  });

export type DiagramNode = z.infer<typeof diagramNodeSchema>;
export type DiagramEdge = z.infer<typeof diagramEdgeSchema>;
export type DiagramGroup = z.infer<typeof diagramGroupSchema>;
export type DiagramFlow = z.infer<typeof diagramFlowSchema>;
export type DiagramDocument = z.infer<typeof diagramDocumentSchema>;
export type DiagramTransformOverride = z.infer<typeof diagramTransformOverrideSchema>;
export type DiagramHumanOverride = z.infer<typeof diagramHumanOverrideSchema>;
export type DiagramHumanDocument = z.infer<typeof diagramHumanDocumentSchema>;

export function isDiagramHumanPath(path: string): boolean {
  return path.endsWith(DIAGRAM_HUMAN_SUFFIX);
}

export function isDiagramBasePath(path: string): boolean {
  return path.endsWith(DIAGRAM_BASE_SUFFIX) && !isDiagramHumanPath(path);
}

export function diagramHumanPathForBasePath(basePath: string): string {
  return `${basePath.slice(0, -DIAGRAM_BASE_SUFFIX.length)}${DIAGRAM_HUMAN_SUFFIX}`;
}

export function diagramBasePathForHumanPath(humanPath: string): string {
  return `${humanPath.slice(0, -DIAGRAM_HUMAN_SUFFIX.length)}${DIAGRAM_BASE_SUFFIX}`;
}

function addDuplicateIssues<T extends { id: string }>(
  items: T[],
  collection: DiagramIdCollection,
  context: z.RefinementCtx
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate ${singular(collection)} id "${item.id}"`,
        path: [collection, index, "id"]
      });
    }
    seen.add(item.id);
  }
}

function singular(collection: DiagramIdCollection): string {
  return collection === "overrides" ? "override" : collection.slice(0, -1);
}

type DiagramIdCollection = "nodes" | "edges" | "groups" | "flows" | "overrides";
