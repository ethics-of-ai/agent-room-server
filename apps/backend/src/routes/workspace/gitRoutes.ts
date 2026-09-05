import type { FastifyInstance, FastifyReply } from "fastify";
import type { LocalWorkspaceGitOperationResult } from "../../domain/models";
import { WorkspaceGitService, type WorkspaceGitPathsInput } from "../../workspace/WorkspaceGitService";
import { replyWorkspaceError, type WorkspaceRouteDeps } from "./deps";
import {
  createBranchPayloadSchema,
  gitCommitPayloadSchema,
  gitDiscardPayloadSchema,
  gitPathsPayloadSchema,
  gitPushPayloadSchema,
  switchBranchPayloadSchema,
  workspaceParamsSchema
} from "../../domain/workspaceSchemas";

// A pull, discard, or branch creation can add, remove, or rewrite tracked
// files, so the cached file index behind quick-open and search is dropped for
// exactly those operations.
const invalidatesFileIndex = new Set(["pull", "discard", "create_branch"]);

/**
 * The fixed Git surface: the clean-branch switch plus the eight mutating
 * operations. All are mutating POSTs, so the global preHandler requires the
 * bearer token when `AUTH_TOKEN` is configured; none opts into
 * `authorizedForRead`. Each runs one fixed argv through `WorkspaceGitService`
 * (no shell, no caller-supplied flags), publishes a sanitized
 * `workspace_git_operation` event, and returns the refreshed workspace plus Git
 * status so a client re-renders from one response.
 * See `docs/safety/TRUST_AND_SAFETY.md` (Git operations).
 */
export async function registerWorkspaceGitRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): Promise<void> {
  const gitService = new WorkspaceGitService(deps.registry);

  const runGitOperation = async (reply: FastifyReply, run: () => Promise<LocalWorkspaceGitOperationResult>) => {
    try {
      const result = await run();
      if (invalidatesFileIndex.has(result.operation)) {
        deps.explorer.invalidateFileIndex(result.workspaceId);
      }
      // Sanitized: identifiers, the operation, and counts only. Never file
      // content, never a path list, and never a remote URL (which can carry
      // credentials in its userinfo).
      deps.eventBus.publish("workspace_git_operation", {
        workspaceId: result.workspaceId,
        workspacePath: result.workspace.path,
        operation: result.operation,
        ...(result.branch ? { branch: result.branch } : {}),
        ...(result.previousBranch ? { previousBranch: result.previousBranch } : {}),
        ...(result.commit ? { commit: result.commit } : {}),
        ...(result.remote ? { remote: result.remote } : {}),
        fileCount: result.paths?.length ?? 0,
        changedFileCount: result.status.counts.total
      });
      if (result.operation === "create_branch" && result.branch) {
        deps.eventBus.publish("workspace_branch_changed", {
          workspaceId: result.workspaceId,
          path: result.workspace.path,
          previousBranch: result.previousBranch,
          branch: result.branch
        });
      }
      return result;
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  };

  const gitPathsPayload = (body: unknown): WorkspaceGitPathsInput | undefined => {
    const parsed = gitPathsPayloadSchema.safeParse(body ?? {});
    return parsed.success ? parsed.data : undefined;
  };

  app.post("/api/workspaces/:workspaceId/git/branch", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = switchBranchPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace Git branch payload" });
    }

    try {
      const result = await deps.registry.checkoutBranch(workspaceId, parsed.data.branch);
      if (result.changed) {
        // A checkout can add, remove, or rename tracked files wholesale.
        deps.explorer.invalidateFileIndex(workspaceId);
        deps.eventBus.publish("workspace_branch_changed", {
          workspaceId: result.workspace.id,
          path: result.workspace.path,
          previousBranch: result.previousBranch,
          branch: result.branch
        });
      }
      return {
        workspace: result.workspace,
        previousBranch: result.previousBranch,
        branch: result.branch,
        changed: result.changed
      };
    } catch (error) {
      return replyWorkspaceError(reply, error);
    }
  });

  app.post("/api/workspaces/:workspaceId/git/stage", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const payload = gitPathsPayload(request.body);
    if (!payload) return reply.code(400).send({ error: "Invalid workspace Git stage payload" });
    return runGitOperation(reply, () => gitService.stage(workspaceId, payload));
  });

  app.post("/api/workspaces/:workspaceId/git/unstage", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const payload = gitPathsPayload(request.body);
    if (!payload) return reply.code(400).send({ error: "Invalid workspace Git unstage payload" });
    return runGitOperation(reply, () => gitService.unstage(workspaceId, payload));
  });

  app.post("/api/workspaces/:workspaceId/git/discard", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = gitDiscardPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace Git discard payload" });
    }
    return runGitOperation(reply, () => gitService.discard(workspaceId, parsed.data));
  });

  app.post("/api/workspaces/:workspaceId/git/commit", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = gitCommitPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace Git commit payload" });
    }
    return runGitOperation(reply, () => gitService.commit(workspaceId, parsed.data));
  });

  app.post("/api/workspaces/:workspaceId/git/fetch", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    return runGitOperation(reply, () => gitService.fetch(workspaceId));
  });

  app.post("/api/workspaces/:workspaceId/git/pull", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    return runGitOperation(reply, () => gitService.pull(workspaceId));
  });

  app.post("/api/workspaces/:workspaceId/git/push", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = gitPushPayloadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace Git push payload" });
    }
    return runGitOperation(reply, () => gitService.push(workspaceId, parsed.data ?? {}));
  });

  app.post("/api/workspaces/:workspaceId/git/branch/create", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = createBranchPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace Git branch payload" });
    }
    return runGitOperation(reply, () => gitService.createBranch(workspaceId, parsed.data));
  });
}
