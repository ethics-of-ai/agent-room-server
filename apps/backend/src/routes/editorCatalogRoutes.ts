import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import { EditorCatalogError, type EditorCatalogManager } from "../editor/EditorCatalogStore";
import type { EventBus } from "../events/EventBus";
import type { EditorCatalogChangedPayload } from "../events/eventTypes";
import { authorizedForRead } from "./readAuthorization";

const assetQuerySchema = z.object({
  path: z.string().min(1)
});

// Phase C: backend-served editor language catalog. App/global DATA (TextMate
// grammars/themes/configs + the Oniguruma WASM), NOT workspace files — these
// routes never touch a registered workspace or the workspace file API. The GET
// reads expose project-independent catalog data; like other reads that leak
// content, they require the bearer token when AUTH_TOKEN is configured.
//
// Phase C.5: the catalog directory is operator-managed and reloadable
// (`EditorCatalogManager`). `POST /reload` re-reads it and broadcasts
// `editor_catalog_changed` (so paired visionOS clients auto-rehydrate). It is a
// mutating method, so the global preHandler (server.ts) already bearer-gates it
// when AUTH_TOKEN is configured — no per-handler read check needed.
export async function registerEditorCatalogRoutes(
  app: FastifyInstance,
  catalog: EditorCatalogManager,
  config: ServiceConfig,
  eventBus: EventBus
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
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // Operator-facing status for the macOS catalog pane. A read; bearer-gated like
  // the other GETs. Returns no asset content, only the live source + version.
  app.get("/api/editor/catalog/status", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const manifest = catalog.getManifest();
    return {
      enabled: config.languageCatalogEnabled !== false,
      source: catalog.source(),
      version: manifest?.version ?? null,
      languageCount: manifest?.grammars.length ?? 0
    };
  });

  // Re-read the operator override dir (then the bundled fallback) and swap in the
  // new snapshot. Mutating → bearer-gated by the global preHandler. Broadcasts the
  // change only when the aggregate version actually moved, so idempotent reloads
  // don't churn connected editors.
  app.post("/api/editor/catalog/reload", async (_request, _reply) => {
    const result = await catalog.reload();
    if (result.changed && result.version) {
      eventBus.publish<EditorCatalogChangedPayload>("editor_catalog_changed", {
        version: result.version,
        languageCount: catalog.getManifest()?.grammars.length ?? 0
      });
    }
    return {
      reloaded: true,
      source: result.source,
      version: result.version,
      changed: result.changed
    };
  });
}
