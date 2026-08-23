import type { FastifyInstance } from "fastify";
import type { EventBus } from "../events/EventBus";
import type { AuditLogStore } from "../state/AuditLogStore";
import { z } from "zod";
import type { AgentSessionService } from "../agent/AgentSessionService";

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional()
});

// `/api/config` lives in `configRoutes.ts`: the read and the managed-settings
// PATCH are one contract and belong together.
export async function registerStatusRoutes(
  app: FastifyInstance,
  deps: { agentSessions: AgentSessionService; eventBus: EventBus; auditLogStore: AuditLogStore }
): Promise<void> {
  // Artifact deltas (up to 64 KB each) are excluded from the polled status
  // snapshot; clients reconstruct artifact state from the artifacts read route.
  // /api/logs below stays unfiltered as the diagnostics view of the buffer.
  app.get("/api/status", async () =>
    deps.agentSessions.getStatusSnapshot(deps.eventBus.getRecentEvents(200, { excludeTypes: ["coding_artifact_delta"] })));
  app.get("/api/logs", async () => ({ events: deps.eventBus.getRecentEvents(200) }));
  app.get("/api/audit", async (request, reply) => {
    const parsed = auditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid audit query" });
    }
    return { events: deps.auditLogStore.getRecent(parsed.data.limit) };
  });
}
