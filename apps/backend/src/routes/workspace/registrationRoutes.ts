import type { FastifyInstance } from "fastify";
import type { RegisterLocalWorkspaceInput } from "../../workspace/LocalWorkspaceRegistry";
import { replyWorkspaceError, type WorkspaceRouteDeps } from "./deps";
import { registerWorkspacePayloadSchema, workspaceParamsSchema } from "../../domain/workspaceSchemas";

/**
 * Registration is metadata-only: it records an existing absolute directory
 * under `STATE_DIR` and never writes inside the selected folder, and
 * unregistering forgets that metadata without touching the folder either.
 */
export async function registerWorkspaceRegistrationRoutes(
  app: FastifyInstance,
  deps: WorkspaceRouteDeps
): Promise<void> {
  app.get("/api/workspaces", async () => deps.registry.list());

  app.post("/api/workspaces", async (request, reply) => {
    const parsed = registerWorkspacePayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace payload" });
    }

    try {
      const input: RegisterLocalWorkspaceInput = parsed.data;
      const result = await deps.registry.register(input);
      deps.eventBus.publish("workspace_registered", {
        workspaceId: result.workspace.id,
        path: result.workspace.path,
        kind: result.workspace.kind,
        created: result.created
      });
      return reply.code(result.created ? 201 : 200).send({ workspace: result.workspace });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  app.delete("/api/workspaces/:workspaceId", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    try {
      const result = await deps.registry.unregister(workspaceId);
      // Release the unregistered workspace's cached file index (and detach any
      // in-flight build) so the explorer holds no state for a forgotten workspace.
      deps.explorer.invalidateFileIndex(workspaceId);
      deps.eventBus.publish("workspace_removed", {
        workspaceId: result.workspace.id,
        path: result.workspace.path,
        kind: result.workspace.kind
      });
      return reply.code(204).send();
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });
}
