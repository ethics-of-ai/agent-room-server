import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  MAX_PERMISSION_OPTION_ID_LENGTH,
  MAX_PERMISSION_REQUEST_ID_LENGTH
} from "../runner/shared/PendingPermissionRequests";
import { AgentAttachmentError, AgentAttachmentStore, maxAgentAttachmentBytes } from "../agent/AgentAttachmentStore";
import { AgentSessionError, AgentSessionService } from "../agent/AgentSessionService";
import { agentRunnerKindSchema, agentTurnContextSchema, codingAgentTurnSettingsSchema } from "../domain/schemas";
import type { ServiceConfig } from "../domain/models";
import { authorizedForRead } from "./readAuthorization";

const createSessionPayloadSchema = z.object({
  workspaceId: z.string().trim().min(1),
  runnerKind: agentRunnerKindSchema.optional(),
  gitBranch: z.string().trim().min(1).max(240).optional(),
  settings: codingAgentTurnSettingsSchema.optional(),
  title: z.string().trim().min(1).optional()
});

const sessionParamsSchema = z.object({
  sessionId: z.string().trim().min(1)
});

const permissionParamsSchema = z.object({
  sessionId: z.string().trim().min(1),
  requestId: z.string().trim().min(1).max(MAX_PERMISSION_REQUEST_ID_LENGTH)
});

// An option id the *agent* minted, so the bound matches what the canonical
// mapper clamps an option to rather than being a guess about agent id shapes.
const answerPermissionPayloadSchema = z.object({
  // Opaque agent id: preserve leading/trailing whitespace exactly rather than
  // changing the value between the advertised option and the pending store.
  optionId: z.string().min(1).max(MAX_PERMISSION_OPTION_ID_LENGTH)
});

const startTurnPayloadSchema = z.object({
  message: z.string().trim().min(1),
  context: agentTurnContextSchema.optional(),
  settings: codingAgentTurnSettingsSchema.optional()
});

export async function registerAgentSessionRoutes(
  app: FastifyInstance,
  agentSessions: AgentSessionService,
  attachments: AgentAttachmentStore,
  config: ServiceConfig
): Promise<void> {
  app.get("/api/agent-sessions", async () => ({ sessions: agentSessions.listSessions() }));

  app.get("/api/agent-sessions/:sessionId", async (request, reply) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const session = agentSessions.getSession(sessionId);
    if (!session) return reply.code(404).send({ error: "Agent session was not found" });
    return { session };
  });

  app.get("/api/agent-sessions/:sessionId/messages", async (request, reply) => {
    // Session transcripts expose user/assistant content, so they require the
    // bearer token when AUTH_TOKEN is configured, like workspace reads.
    if (!authorizedForRead(request.headers.authorization, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const messages = agentSessions.listSessionMessages(sessionId);
    if (!messages) return reply.code(404).send({ error: "Agent session was not found" });
    return { messages };
  });

  app.get("/api/agent-sessions/:sessionId/artifacts", async (request, reply) => {
    // Artifacts carry model-authored content; gate the read behind bearer auth
    // when AUTH_TOKEN is configured, consistent with messages and workspace reads.
    if (!authorizedForRead(request.headers.authorization, config)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const artifacts = agentSessions.listSessionArtifacts(sessionId);
    if (!artifacts) return reply.code(404).send({ error: "Agent session was not found" });
    return { artifacts };
  });

  app.delete("/api/agent-sessions/:sessionId", async (request, reply) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    try {
      await agentSessions.deleteSession(sessionId);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof AgentSessionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/agent-sessions", async (request, reply) => {
    const parsed = createSessionPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid agent session payload" });
    }

    try {
      const session = await agentSessions.createSession(parsed.data);
      return reply.code(201).send({ session });
    } catch (error) {
      if (error instanceof AgentSessionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/agent-sessions/:sessionId/turns", async (request, reply) => {
    const startedAtMs = Date.now();
    const { sessionId } = sessionParamsSchema.parse(request.params);
    const parsed = startTurnPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid agent turn payload" });
    }

    try {
      const turn = await agentSessions.startTurn({
        sessionId,
        message: parsed.data.message,
        context: parsed.data.context,
        settings: parsed.data.settings
      });
      request.log.info({
        sessionId,
        turnId: turn.id,
        acceptDurationMs: Date.now() - startedAtMs,
        contextPathCount: parsed.data.context?.paths?.length ?? 0,
        attachmentCount: parsed.data.context?.attachments?.length ?? 0
      }, "Agent turn HTTP request accepted");
      return reply.code(202).send({ turn });
    } catch (error) {
      if (error instanceof AgentSessionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof AgentAttachmentError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/agent-sessions/:sessionId/attachments", async (request, reply) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    try {
      const file = await request.file({
        limits: {
          files: 1,
          fileSize: maxAgentAttachmentBytes
        }
      });
      if (!file) {
        return reply.code(400).send({ error: "Attachment file is required" });
      }
      const attachment = await attachments.storeImage({
        sessionId,
        sourceName: file.filename,
        contentType: file.mimetype,
        data: await file.toBuffer()
      });
      return reply.code(201).send({ attachment });
    } catch (error) {
      if (error instanceof AgentAttachmentError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof Error && error.message.toLowerCase().includes("file too large")) {
        return reply.code(413).send({ error: "Attachment file is too large" });
      }
      throw error;
    }
  });

  // Answer a permission request a runner raised mid-turn. Deliberately not a
  // "run this" endpoint by another name: it selects one of the options the
  // agent itself offered for one outstanding request, and can express nothing
  // else. Mutating, so the global preHandler requires the bearer token when
  // AUTH_TOKEN is configured.
  app.post("/api/agent-sessions/:sessionId/permissions/:requestId", async (request, reply) => {
    const { sessionId, requestId } = permissionParamsSchema.parse(request.params);
    const parsed = answerPermissionPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid permission answer payload" });
    }
    try {
      const session = agentSessions.answerPermissionRequest({
        sessionId,
        requestId,
        optionId: parsed.data.optionId
      });
      return { session };
    } catch (error) {
      if (error instanceof AgentSessionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/agent-sessions/:sessionId/cancel", async (request, reply) => {
    const { sessionId } = sessionParamsSchema.parse(request.params);
    try {
      const session = await agentSessions.cancelTurn(sessionId);
      return { session };
    } catch (error) {
      if (error instanceof AgentSessionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
