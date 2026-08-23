import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import {
  LocalWorkspaceRegistry,
  LocalWorkspaceRegistryError,
  type RegisterLocalWorkspaceInput
} from "../workspace/LocalWorkspaceRegistry";
import {
  WorkspaceExplorer,
  WorkspaceExplorerError,
  maxFileIndexResults,
  maxSearchMatches,
  maxWriteBytes
} from "../workspace/WorkspaceExplorer";
import {
  WorkspaceGitService,
  WorkspaceGitServiceError,
  type WorkspaceGitPathsInput
} from "../workspace/WorkspaceGitService";
import { maxCommitMessageChars } from "../workspace/LocalWorkspaceGit";
import { agentRunnerKindSchema } from "../domain/schemas";
import { workspaceSkillsAvailable } from "../runner/registry";
import { authorizedForRead } from "./readAuthorization";
import type { LocalWorkspaceGitOperationResult } from "../domain/models";

const registerWorkspacePayloadSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  kind: z.enum(["managed_throwaway", "user_selected"]).optional()
});

const workspaceParamsSchema = z.object({
  workspaceId: z.string().trim().min(1)
});

const treeQuerySchema = z.object({
  path: z.string().optional(),
  depth: z.coerce.number().int().min(0).max(4).optional()
});

const filePreviewQuerySchema = z.object({
  path: z.string().trim().min(1),
  // Optional override that lets an editor load a file up to the write cap. The read
  // path otherwise truncates at the 24 KB browse-preview default, which forces any
  // larger file read-only in the client. Bounded to the same `maxWriteBytes` the
  // write route enforces, so a load can never request more than a save can persist.
  maxBytes: z.coerce.number().int().min(1).max(maxWriteBytes).optional()
});

const gitFileBaselineQuerySchema = z.object({
  path: z.string().trim().min(1),
  // Same cap contract as `filePreviewQuerySchema`; the default is the full write
  // cap because a baseline is only useful whole for diffing editable files.
  maxBytes: z.coerce.number().int().min(1).max(maxWriteBytes).optional()
});

const maxSearchQueryChars = 200;

// Query-string booleans arrive as text; `z.coerce.boolean()` would read "false"
// as true (any non-empty string is truthy), so accept only explicit tokens.
const booleanFlagSchema = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const fileIndexQuerySchema = z.object({
  query: z.string().trim().max(maxSearchQueryChars).optional(),
  limit: z.coerce.number().int().min(1).max(maxFileIndexResults).optional()
});

const searchQuerySchema = z.object({
  // Literal substring only — no regex in v1 (a caller-supplied pattern would be
  // an in-process ReDoS vector). See docs/safety/TRUST_AND_SAFETY.md.
  query: z.string().trim().min(1).max(maxSearchQueryChars),
  matchCase: booleanFlagSchema.optional(),
  wholeWord: booleanFlagSchema.optional(),
  include: z.string().trim().max(maxSearchQueryChars).optional(),
  // `limit` bounds total matches returned, not files scanned.
  limit: z.coerce.number().int().min(1).max(maxSearchMatches).optional()
});

const skillsQuerySchema = z.object({
  // Registry-derived, so a registered runner is accepted here without editing
  // this route (docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md, Phase 3).
  runnerKind: agentRunnerKindSchema.optional()
});

const branchNameSchema = z.string().trim().min(1).max(240);

const switchBranchPayloadSchema = z.object({
  branch: branchNameSchema
});

const createBranchPayloadSchema = z.object({
  branch: branchNameSchema
});

// Path lists are bounded so one request cannot ask the backend to fork git over
// an unbounded argv; `all` is the supported way to act on a whole dirty tree.
const gitPathsPayloadSchema = z.object({
  paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(500).optional(),
  all: z.boolean().optional()
});

const gitDiscardPayloadSchema = z.object({
  // Discard is irreversible, so it has no `all`: a client names every path it
  // means to destroy.
  paths: z.array(z.string().trim().min(1).max(1024)).min(1).max(500)
});

const gitCommitPayloadSchema = z.object({
  message: z.string().trim().min(1).max(maxCommitMessageChars),
  stageAll: z.boolean().optional()
});

const gitPushPayloadSchema = z
  .object({
    setUpstream: z.boolean().optional()
  })
  .optional();

const writeFilePayloadSchema = z.object({
  path: z.string().trim().min(1).max(1024),
  // Cap the UTF-8 byte length, not the JS string length: `.max()` would count
  // UTF-16 code units, letting multibyte content land ~3x over the documented cap.
  content: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= maxWriteBytes, {
    message: "Workspace file content exceeds the maximum size"
  }),
  baseModifiedAt: z.string().trim().min(1).optional()
});

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  registry: LocalWorkspaceRegistry,
  deps: { eventBus: EventBus; config: ServiceConfig; explorer: WorkspaceExplorer }
): Promise<void> {
  app.get("/api/workspaces", async () => registry.list());

  app.get("/api/workspaces/:workspaceId/tree", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = treeQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace tree query" });
    }
    try {
      return await deps.explorer.tree(workspaceId, parsed.data);
    } catch (error) {
      if (error instanceof WorkspaceExplorerError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/workspaces/:workspaceId/file-preview", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = filePreviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace file preview query" });
    }
    try {
      return await deps.explorer.filePreview(workspaceId, parsed.data);
    } catch (error) {
      if (error instanceof WorkspaceExplorerError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // Bounded, read-only workspace file index backing quick-open and the composer's
  // `@` mention picker. Bearer-authed like the other structure-exposing reads;
  // emits no events or audit entries.
  app.get("/api/workspaces/:workspaceId/files", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = fileIndexQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace file index query" });
    }
    try {
      return await deps.explorer.listFiles(workspaceId, parsed.data);
    } catch (error) {
      if (error instanceof WorkspaceExplorerError || error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // Bounded, read-only literal-substring content search over the same index.
  // Bearer-authed, no events, no audit. Every bound reports partial results with
  // `truncated` rather than running long.
  app.get("/api/workspaces/:workspaceId/search", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace search query" });
    }
    try {
      return await deps.explorer.searchFiles(workspaceId, parsed.data);
    } catch (error) {
      if (error instanceof WorkspaceExplorerError || error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // Bounded, read-only skills discovery for the clients' composer slash picker.
  // Bearer-authed like the other structure-exposing reads; emits no events or
  // audit entries. The listing never loads anything — it only mirrors what a
  // session of that runner kind would natively load from the workspace.
  app.get("/api/workspaces/:workspaceId/skills", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = skillsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace skills query" });
    }
    const runnerKind = parsed.data.runnerKind ?? deps.config.runnerKind;
    // Whether a session of this kind would actually load these skills is the
    // registry's answer: `native` always does, `gated` defers to the adapter's
    // own trust rule. Report unavailable with an empty list rather than
    // advertising invocations an isolated session would ignore. The scan still
    // runs first so an unknown workspace 404s consistently in both states.
    const available = workspaceSkillsAvailable(runnerKind, deps.config);
    try {
      const skills = await deps.explorer.listSkills(workspaceId, runnerKind);
      return { workspaceId, runnerKind, available, skills: available ? skills : [] };
    } catch (error) {
      if (error instanceof WorkspaceExplorerError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // Bounded write seam (mutating PUT): the global preHandler gates this with bearer
  // auth when AUTH_TOKEN is set, so it does NOT opt into `authorizedForRead`.
  app.put("/api/workspaces/:workspaceId/file", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = writeFilePayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace file write payload" });
    }
    try {
      const result = await deps.explorer.writeTextFile(workspaceId, parsed.data);
      // A create adds a path the cached file index has not seen; drop it so
      // quick-open and search observe the new file immediately.
      if (result.created) deps.explorer.invalidateFileIndex(workspaceId);
      deps.eventBus.publish("workspace_file_written", {
        workspaceId,
        workspacePath: result.workspacePath,
        path: result.preview.path,
        sizeBytes: result.preview.sizeBytes,
        created: result.created
      });
      return reply.code(result.created ? 201 : 200).send(result.preview);
    } catch (error) {
      if (error instanceof WorkspaceExplorerError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/workspaces/:workspaceId/git/status", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    try {
      return await registry.gitStatus(workspaceId);
    } catch (error) {
      if (error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/workspaces/:workspaceId/git/file-base", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = gitFileBaselineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace Git file baseline query" });
    }
    try {
      return await deps.explorer.gitFileBaseline(workspaceId, parsed.data);
    } catch (error) {
      if (error instanceof WorkspaceExplorerError || error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/workspaces", async (request, reply) => {
    const parsed = registerWorkspacePayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace payload" });
    }

    try {
      const input: RegisterLocalWorkspaceInput = parsed.data;
      const result = await registry.register(input);
      deps.eventBus.publish("workspace_registered", {
        workspaceId: result.workspace.id,
        path: result.workspace.path,
        kind: result.workspace.kind,
        created: result.created
      });
      return reply.code(result.created ? 201 : 200).send({ workspace: result.workspace });
    } catch (error) {
      if (error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/workspaces/:workspaceId/git/branch", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    const parsed = switchBranchPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid workspace Git branch payload" });
    }

    try {
      const result = await registry.checkoutBranch(workspaceId, parsed.data.branch);
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
      if (error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  // --- Fixed mutating Git operations -----------------------------------------
  // All are mutating POSTs, so the global preHandler requires the bearer token
  // when AUTH_TOKEN is configured; none opts into `authorizedForRead`. Each runs
  // one fixed argv through `WorkspaceGitService` (no shell, no caller-supplied
  // flags), publishes a sanitized `workspace_git_operation` event, and returns
  // the refreshed workspace plus Git status so a client re-renders from one
  // response. See docs/safety/TRUST_AND_SAFETY.md.
  const gitService = new WorkspaceGitService(registry);

  // A pull, discard, or branch creation can add, remove, or rewrite tracked
  // files, so the cached file index behind quick-open and search is dropped for
  // exactly those operations.
  const invalidatesFileIndex = new Set(["pull", "discard", "create_branch"]);

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
      if (error instanceof WorkspaceGitServiceError || error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  };

  const gitPathsPayload = (body: unknown): WorkspaceGitPathsInput | undefined => {
    const parsed = gitPathsPayloadSchema.safeParse(body ?? {});
    return parsed.success ? parsed.data : undefined;
  };

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

  app.delete("/api/workspaces/:workspaceId", async (request, reply) => {
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    try {
      const result = await registry.unregister(workspaceId);
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
      if (error instanceof LocalWorkspaceRegistryError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
