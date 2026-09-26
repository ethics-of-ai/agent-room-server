import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import { RepositorySketchService } from "../sketch/RepositorySketchService";
import { SketchServiceError } from "../sketch/sketchErrors";
import { WorkspaceExplorerError } from "../workspace/WorkspaceExplorer";
import { SKETCH_MAX_BATCH_BYTES, SKETCH_MAX_BATCH_OPERATIONS, sketchRequestIdSchema } from "../sketch/core";
import { authorizedForRead } from "./readAuthorization";

const edit = z.object({
  requestId: sketchRequestIdSchema,
  baseRevision: z.number().int().nonnegative(),
  fileVersion: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().trim().min(1).max(120).optional()
}).strict();
const commit = edit.extend({ operations: z.array(z.unknown()).min(1).max(SKETCH_MAX_BATCH_OPERATIONS) });
const pathInput = z.object({ path: z.string().min(1).max(4096) }).strict();
const creation = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const workspaceParams = z.object({ workspaceId: z.string().min(1) });

export async function registerRepositorySketchRoutes(app: FastifyInstance, deps: {
  sketches: RepositorySketchService; config: ServiceConfig;
}): Promise<void> {
  // Scoped plugin keeps validation/error handling local to these routes.
  await app.register(async (routes) => {
    routes.addHook("preHandler", async (request, reply) => {
      if (!authorizedForRead(request.headers.authorization, deps.config)) return reply.code(401).send({ error: "Unauthorized" });
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid repository sketch request" });
      if (error instanceof SketchServiceError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, ...error.details });
      if (error instanceof WorkspaceExplorerError) return reply.code(error.statusCode).send({ error: error.message, code: "invalid_path" });
      if ((error as { statusCode?: number }).statusCode === 413) return reply.code(413).send({ error: "Sketch request is too large" });
      return reply.code(503).send({ error: "Sketch storage is unavailable; retry the same request after recovery", code: "storage_unavailable" });
    });
    const workspaceBase = "/api/workspaces/:workspaceId/sketch";
    routes.post(workspaceBase, async (request, reply) => {
      const { workspaceId } = workspaceParams.parse(request.params);
      const { name } = creation.parse(request.body);
      return reply.code(201).send({ sketch: await deps.sketches.create(workspaceId, name) });
    });
    routes.get(workspaceBase, async (request) => {
      const { workspaceId } = workspaceParams.parse(request.params);
      return { sketch: await deps.sketches.read(workspaceId, pathInput.parse(request.query).path) };
    });
    routes.post(workspaceBase + "/reset-history", async (request) => {
      const { workspaceId } = workspaceParams.parse(request.params);
      const { path } = pathInput.parse(request.query);
      const { fileVersion } = edit.pick({ fileVersion: true }).parse(request.body);
      return { sketch: await deps.sketches.resetHistory(workspaceId, path, fileVersion) };
    });
    for (const kind of ["commit", "undo", "redo"] as const) {
      const schema = kind === "commit" ? commit : edit;
      const suffix = kind === "commit" ? "commits" : kind;
      routes.post(workspaceBase + "/" + suffix, { bodyLimit: SKETCH_MAX_BATCH_BYTES + 4096 }, async (request) => {
        const { workspaceId } = workspaceParams.parse(request.params);
        const { path } = pathInput.parse(request.query);
        checkBatch(request.body);
        return deps.sketches.edit(workspaceId, path, kind, schema.parse(request.body));
      });
    }
  });
}
function checkBatch(body: unknown): void {
  const operations = body && typeof body === "object" ? (body as { operations?: unknown }).operations : undefined;
  if (operations && Buffer.byteLength(JSON.stringify(operations)) > SKETCH_MAX_BATCH_BYTES) {
    throw new SketchServiceError("Sketch batch exceeds 256 KiB", 413, "batch_too_large");
  }
}
