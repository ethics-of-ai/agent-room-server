import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentSessionError } from "../agent/agentSessionTypes";
import type { ToolAppCallService } from "../agent/toolAppCalls";

/** The largest `arguments` object a view may send, serialized. */
export const MAX_TOOL_APP_CALL_ARGUMENT_BYTES = 64 * 1024;

const paramsSchema = z.object({
  sessionId: z.string().trim().min(1),
  artifactId: z.string().trim().min(1).max(512)
});

// An MCP tool name as SEP-1865 views send it, without the CLI's `mcp__` prefix.
const payloadSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  arguments: z.record(z.string(), z.unknown()).default({})
});

/**
 * `POST /api/agent-sessions/:sessionId/artifacts/:artifactId/tool-calls`: one
 * `tools/call` from an MCP tool view. Mutating, so the global bearer check
 * applies. The client asks the person before it sends one.
 */
export async function registerToolAppCallRoutes(app: FastifyInstance, calls: ToolAppCallService): Promise<void> {
  app.post("/api/agent-sessions/:sessionId/artifacts/:artifactId/tool-calls", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const parsed = payloadSchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: "Invalid tool call payload" });
    }
    if (Buffer.byteLength(JSON.stringify(parsed.data.arguments), "utf8") > MAX_TOOL_APP_CALL_ARGUMENT_BYTES) {
      return reply.code(413).send({ error: "Tool call arguments are too large" });
    }
    try {
      const result = await calls.call({ ...params.data, ...parsed.data });
      return { result };
    } catch (error) {
      if (error instanceof AgentSessionError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
