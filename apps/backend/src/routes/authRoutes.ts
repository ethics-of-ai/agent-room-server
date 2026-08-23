import type { FastifyInstance } from "fastify";
import type { ServiceConfig } from "../domain/models";

export async function registerAuthRoutes(app: FastifyInstance, config: ServiceConfig): Promise<void> {
  app.get("/api/auth/check", async (request, reply) => {
    if (!config.requireAuth) {
      return { authRequired: false, authenticated: true };
    }

    if (request.headers.authorization !== `Bearer ${config.authToken}`) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    return { authRequired: true, authenticated: true };
  });
}
