import type { FastifyInstance } from "fastify";
import { publishWorkspaceRegistered, publishWorkspaceRemoved } from "../../events/workspaceEvents";
import type { RegisterLocalWorkspaceInput } from "../../workspace/LocalWorkspaceRegistry";
import { replyWorkspaceError, type WorkspaceRouteDeps } from "./deps";
import { registerWorkspacePayloadSchema, workspaceParamsSchema } from "../../domain/workspaceSchemas";

/**
 * Registration is metadata-only: it records an existing absolute directory
 * under `STATE_DIR` and never writes inside the selected folder, and
 * unregistering forgets that metadata without touching the folder either.
 * Unregistering refuses an open child's workspace and a parent workspace with
 * open children; Close is the only way to remove a child (decision 9).
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
      publishWorkspaceRegistered(deps.eventBus, result.workspace, result.created);
      return reply.code(result.created ? 201 : 200).send({ workspace: result.workspace });
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  app.delete("/api/workspaces/:workspaceId", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    try {
      const remove = () => deps.registry.unregister(workspaceId);
      const result = await (deps.children ? deps.children.guardWorkspaceRemoval(workspaceId, remove) : remove());
      // Release the unregistered workspace's cached file index (and detach any
      // in-flight build) so the explorer holds no state for a forgotten workspace.
      deps.explorer.invalidateFileIndex(workspaceId);
      publishWorkspaceRemoved(deps.eventBus, result.workspace);
      return reply.code(204).send();
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });
}
