import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentSessionError } from "../agent/agentSessionTypes";
import type { ChildThreadService } from "../children/ChildThreadService";
import { CHILD_THREAD_LIMITS } from "../domain/childThreads";
import type { ServiceConfig } from "../domain/models";
import { agentRunnerKindSchema, codingAgentTurnSettingsSchema } from "../domain/schemas";
import { authorizedForRead } from "./readAuthorization";
import { sendRefusal } from "./refusals";
import { replyWorkspaceError } from "./workspace/deps";

const sessionParams = z.object({ sessionId: z.string().trim().min(1) });
const listQuery = z.object({ include: z.literal("closed").optional() });
const createChild = z.object({
  title: z.string().trim().min(1).max(CHILD_THREAD_LIMITS.title),
  task: z.string().trim().min(1).refine((task) => Buffer.byteLength(task, "utf8") <= CHILD_THREAD_LIMITS.taskBytes, {
    message: "Task exceeds 16 KiB"
  }),
  runnerKind: agentRunnerKindSchema.optional(),
  // Strict inside too, so a posture key in `settings` refuses rather than vanishing.
  settings: codingAgentTurnSettingsSchema.strict().optional()
}).strict();

/**
 * Child threads of one parent session. Create, Land, Update and Close are
 * mutations, so the global preHandler requires the bearer token when
 * `AUTH_TOKEN` is set. The list carries child titles and last messages, so it
 * is a session-content read and checks the token itself. Refusals send
 * `{ error, code }`. Land, Update and Close are person actions; no agent tool
 * calls these routes or the service methods behind them.
 */
export async function registerChildThreadRoutes(app: FastifyInstance, deps: {
  children: ChildThreadService; config: ServiceConfig;
}): Promise<void> {
  await app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "Invalid child thread request", code: "invalid_request" });
      if (error instanceof AgentSessionError) return sendRefusal(reply, error);
      return replyWorkspaceError(reply, error);
    });

    routes.post("/api/agent-sessions/:sessionId/children", async (request, reply) => {
      const { sessionId } = sessionParams.parse(request.params);
      const input = createChild.parse(request.body);
      // A person tapping New child is the answer; no offer card is asked.
      const created = await deps.children.create(sessionId, { ...input, initiation: "button" });
      return reply.code(201).send(created);
    });

    routes.get("/api/agent-sessions/:sessionId/children", async (request, reply) => {
      if (!authorizedForRead(request.headers.authorization, deps.config)) return reply.code(401).send({ error: "Unauthorized" });
      const { sessionId } = sessionParams.parse(request.params);
      const { include } = listQuery.parse(request.query ?? {});
      return deps.children.list(sessionId, { includeClosed: include === "closed" });
    });

    routes.post("/api/agent-sessions/:sessionId/land", async (request) => {
      const { sessionId } = sessionParams.parse(request.params);
      return deps.children.land(sessionId);
    });

    routes.post("/api/agent-sessions/:sessionId/update-from-parent", async (request) => {
      const { sessionId } = sessionParams.parse(request.params);
      return deps.children.update(sessionId);
    });

    routes.post("/api/agent-sessions/:sessionId/close", async (request) => {
      const { sessionId } = sessionParams.parse(request.params);
      return deps.children.closeChild(sessionId);
    });
  });
}
