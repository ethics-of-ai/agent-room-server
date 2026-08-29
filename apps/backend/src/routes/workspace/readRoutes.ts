import type { FastifyInstance } from "fastify";
import { workspaceSkillsAvailable } from "../../runner/registry";
import { authorizedForRead } from "../readAuthorization";
import { replyWorkspaceError, type WorkspaceRouteDeps } from "./deps";
import {
  fileIndexQuerySchema,
  filePreviewQuerySchema,
  gitFileBaselineQuerySchema,
  searchQuerySchema,
  skillsQuerySchema,
  treeQuerySchema,
  workspaceParamsSchema
} from "../../domain/workspaceSchemas";

/**
 * The bounded, read-only workspace surface. Every route here exposes project
 * structure or file content, so each takes the bearer token through
 * `authorizedForRead` — the global preHandler gates mutating methods only —
 * and none emits an event or an audit entry.
 */
export async function registerWorkspaceReadRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): Promise<void> {
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
      return replyWorkspaceError(reply, error);
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
      return replyWorkspaceError(reply, error);
    }
  });

  // Bounded, read-only workspace file index backing quick-open and the composer's
  // `@` mention picker.
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
      return replyWorkspaceError(reply, error);
    }
  });

  // Bounded, read-only literal-substring content search over the same index.
  // Every bound reports partial results with `truncated` rather than running long.
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
      return replyWorkspaceError(reply, error);
    }
  });

  // Bounded, read-only skills discovery for the clients' composer slash picker.
  // The listing never loads anything — it only mirrors what a session of that
  // runner kind would natively load from the workspace.
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
      return replyWorkspaceError(reply, error);
    }
  });

  app.get("/api/workspaces/:workspaceId/git/status", async (request, reply) => {
    if (!authorizedForRead(request.headers.authorization, deps.config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { workspaceId } = workspaceParamsSchema.parse(request.params);
    try {
      return await deps.registry.gitStatus(workspaceId);
    } catch (error) {
      return replyWorkspaceError(reply, error);
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
      return replyWorkspaceError(reply, error);
    }
  });
}
