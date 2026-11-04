import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import { EditorCatalogError, type EditorCatalogStore } from "../editor/EditorCatalogStore";
import { authorizedForRead } from "./readAuthorization";

const assetQuerySchema = z.object({
  path: z.string().min(1)
});

// Backend-served editor language catalog. App/global DATA (TextMate
// grammars/themes/configs + the Oniguruma WASM), NOT workspace files — these
// routes never touch a registered workspace or the workspace file API. The GET
// reads expose project-independent catalog data; like other reads that leak
// content, they require the bearer token when AUTH_TOKEN is configured.
export async function registerEditorCatalogRoutes(
  app: FastifyInstance,
  catalog: EditorCatalogStore,
  config: ServiceConfig
): Promise<void> {
  app.get("/api/editor/catalog", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const manifest = catalog.getManifest();
    if (!manifest) {
      return reply.code(404).send({ error: "Editor language catalog is not available" });
    }
    return { catalog: manifest };
  });

  app.get("/api/editor/catalog/asset", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    if (!catalog.hasManifest()) {
      return reply.code(404).send({ error: "Editor language catalog is not available" });
    }
    const parsed = assetQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid catalog asset path" });
    }
    try {
      const asset = await catalog.readAsset(parsed.data.path);
      if (!asset) return reply.code(404).send({ error: "Catalog asset was not found" });
      return reply
        .header("Content-Type", asset.contentType)
        .header("Cache-Control", "no-store")
        .send(asset.data);
    } catch (error) {
      if (error instanceof EditorCatalogError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });
}
