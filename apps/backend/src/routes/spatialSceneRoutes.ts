import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import { diagramSlug, serializeDiagramDocument } from "../scene/diagram/canonical";
import { applyDiagramEdits, diagramEditOpsSchema } from "../scene/diagram/editOps";
import {
  MAX_MERMAID_SOURCE_BYTES,
  convertMermaidToDiagram,
  mermaidDiagramSlug
} from "../scene/diagram/mermaidImport";
import { SpatialSceneError, type SpatialSceneService } from "../scene/SpatialSceneService";
import { WorkspaceExplorerError, maxWriteBytes } from "../workspace/WorkspaceExplorer";
import { authorizedForRead } from "./readAuthorization";

const sceneParamsSchema = z.object({
  workspaceId: z.string().min(1)
});

const sceneQuerySchema = z.object({
  path: z.string().trim().min(1).max(1024)
});

const mermaidImportPayloadSchema = z
  .object({
    source: z.string().refine((value) => value.trim().length > 0, {
      message: "source must not be blank"
    }),
    name: z.string().trim().min(1).max(120).optional()
  })
  .strict();

const diagramEditPayloadSchema = z
  .object({
    // The current base document text, verbatim from the bounded file-preview
    // read (which also carries the PUT's `modifiedAt` lock token; the composed
    // read returns only base metadata, not text). Absent means "start from an
    // empty document" — the New Diagram path.
    baseContent: z.string().optional(),
    // Only for a document created from nothing; renames of an existing
    // document go through the setName op, so the two paths cannot disagree.
    name: z.string().trim().min(1).max(120).optional(),
    ops: diagramEditOpsSchema
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.baseContent !== undefined && payload.name !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name applies only when creating; use the setName op to rename",
        path: ["name"]
      });
    }
  });

// Spatial render engine. The GET composes either a geometry-first scene
// (`*.scene.json`) or a semantic solution diagram (`*.diagram.json`) with its
// sibling human override on read, returning the composed document plus the
// optimistic-lock tokens for the client's next override write. Diagram schema
// failures are a bounded `{ errors }` document in a successful snapshot so the
// renderer can surface and feed them back to the agent. It exposes workspace
// file content, so like the file-preview read it requires the bearer token when
// AUTH_TOKEN is configured. There is no scene-specific write route: overrides
// go through the existing bounded
// `PUT /api/workspaces/:workspaceId/file`.
export async function registerSpatialSceneRoutes(
  app: FastifyInstance,
  deps: { scenes: SpatialSceneService; config: ServiceConfig }
): Promise<void> {
  app.get("/api/workspaces/:workspaceId/spatial-scene", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const params = sceneParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid workspace id" });
    }
    const query = sceneQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid spatial render path" });
    }
    try {
      return await deps.scenes.getScene(params.data.workspaceId, query.data.path);
    } catch (error) {
      if (error instanceof SpatialSceneError || error instanceof WorkspaceExplorerError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // The Mermaid import bridge: pure, deterministic compute — no filesystem, no
  // workspace, no mermaid.js execution. It returns the canonical
  // `.diagram.json` *text* (fixed field order, two-space indent) rather than a
  // document object, so a client writes the bytes verbatim through the
  // existing bounded `PUT /api/workspaces/:workspaceId/file` and re-importing
  // an unchanged sketch stays byte-identical; `slug` keeps the filename rule
  // backend-owned. Unconvertible source is a 422 rather than the compose GET's
  // 200-error-document, because a convert call has no render surface for an
  // error state. As a mutating POST the global preHandler already enforces the
  // bearer token, so this handler does not opt into authorizedForRead.
  app.post("/api/spatial-scene/mermaid-import", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null | undefined;
    const rawSource = body === null || body === undefined ? undefined : body["source"];
    if (typeof rawSource === "string" && Buffer.byteLength(rawSource, "utf8") > MAX_MERMAID_SOURCE_BYTES) {
      return reply.code(413).send({ error: "Mermaid source is too large" });
    }
    const payload = mermaidImportPayloadSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.code(400).send({ error: "Invalid mermaid import payload" });
    }
    const result = convertMermaidToDiagram(payload.data.source, {
      ...(payload.data.name === undefined ? {} : { name: payload.data.name })
    });
    if (!result.ok) {
      // `errors` is the structured contract; `error` folds the first issue in
      // so a client that only surfaces the repo-wide `{ error }` string still
      // shows something actionable.
      const first = result.errors[0];
      const detail =
        first === undefined
          ? ""
          : `: ${first.line === undefined ? "" : `line ${first.line}: `}${first.message}`;
      const more = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : "";
      return reply.code(422).send({
        error: `Mermaid source could not be converted${detail}${more}`,
        errors: result.errors
      });
    }
    return {
      content: serializeDiagramDocument(result.document),
      name: result.document.name,
      slug: mermaidDiagramSlug(result.document.name),
      warnings: result.warnings
    };
  });

  // The semantic edit route is the import bridge's sibling,
  // with the identical posture — pure, deterministic compute that converts a
  // base document plus a bounded op list into new canonical `.diagram.json`
  // *text*, which the client writes itself through the existing bounded
  // `PUT /api/workspaces/:workspaceId/file` with the `base.modifiedAt`
  // optimistic-lock token the composed read returns. Nothing here touches a
  // workspace, so a mid-edit agent regeneration surfaces as the PUT's 409, not
  // as a lost update. Inapplicable ops are a 422 (no render surface for an
  // error state), never a partial apply. As a mutating POST the global
  // preHandler already enforces the bearer token.
  app.post("/api/spatial-scene/diagram-edit", async (request, reply) => {
    const body = request.body as Record<string, unknown> | null | undefined;
    const rawBase = body === null || body === undefined ? undefined : body["baseContent"];
    if (typeof rawBase === "string" && Buffer.byteLength(rawBase, "utf8") > maxWriteBytes) {
      return reply.code(413).send({ error: "Base document is too large" });
    }
    const payload = diagramEditPayloadSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.code(400).send({ error: "Invalid diagram edit payload" });
    }
    const result = applyDiagramEdits({
      ...(payload.data.baseContent === undefined ? {} : { baseContent: payload.data.baseContent }),
      ...(payload.data.name === undefined ? {} : { name: payload.data.name }),
      ops: payload.data.ops
    });
    if (!result.ok) {
      // `errors` is the structured contract; `error` folds the first issue in
      // so a client that only surfaces the repo-wide `{ error }` string still
      // shows something actionable. Op indexes are 1-based in the display
      // string (people count ops from one) and 0-based in the array (clients
      // index their own request).
      const first = result.errors[0];
      const location =
        first === undefined
          ? ""
          : first.opIndex !== undefined
            ? `op ${first.opIndex + 1}: `
            : first.path !== undefined
              ? `${first.path}: `
              : "";
      const detail = first === undefined ? "" : `: ${location}${first.message}`;
      const more = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : "";
      return reply.code(422).send({
        error: `Diagram edit could not be applied${detail}${more}`,
        errors: result.errors
      });
    }
    return {
      content: serializeDiagramDocument(result.document),
      name: result.document.name,
      slug: diagramSlug(result.document.name, "diagram"),
      warnings: result.warnings,
      created: result.created
    };
  });
}
