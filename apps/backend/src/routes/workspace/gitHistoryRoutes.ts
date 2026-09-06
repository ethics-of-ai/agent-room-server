import { realpath, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { gitCommitFileQuerySchema, gitCommitQuerySchema, gitHistoryQuerySchema } from "../../domain/gitHistory";
import { workspaceParamsSchema } from "../../domain/workspaceSchemas";
import { WorkspaceGitServiceError } from "../../workspace/git/errors";
import { authorizedForRead } from "../readAuthorization";
import { replyWorkspaceError, type WorkspaceRouteDeps } from "./deps";

export async function registerWorkspaceGitHistoryRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): Promise<void> {
  const reader = deps.registry.git.historyReader;
  async function directory(workspaceId: string): Promise<string> {
    const workspace = await deps.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) throw new WorkspaceGitServiceError("Workspace was not found.", 404);
    try {
      const path = await realpath(workspace.path);
      if (!(await stat(path)).isDirectory()) throw new Error("Not a directory");
      return path;
    } catch { throw new WorkspaceGitServiceError("Workspace directory was not found.", 404); }
  }

  app.get("/api/workspaces/:workspaceId/git/history", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) return reply.code(401).send({ error: "Unauthorized" });
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = gitHistoryQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Git history query" });
    try {
      return await reader.history(await directory(params.data.workspaceId), params.data.workspaceId, query.data);
    } catch (error) { return replyWorkspaceError(reply, error); }
  });

  app.get("/api/workspaces/:workspaceId/git/commit", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) return reply.code(401).send({ error: "Unauthorized" });
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = gitCommitQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Git commit query" });
    try {
      return await reader.detail(await directory(params.data.workspaceId), params.data.workspaceId, query.data.commit);
    } catch (error) { return replyWorkspaceError(reply, error); }
  });

  app.get("/api/workspaces/:workspaceId/git/commit-file", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) return reply.code(401).send({ error: "Unauthorized" });
    const params = workspaceParamsSchema.safeParse(request.params);
    const query = gitCommitFileQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) return reply.code(400).send({ error: "Invalid Git commit file query" });
    try {
      return await reader.diff(await directory(params.data.workspaceId), params.data.workspaceId, query.data.commit, query.data.path);
    } catch (error) { return replyWorkspaceError(reply, error); }
  });
}
