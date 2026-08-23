import type { FastifyInstance } from "fastify";
import type { ServiceConfig } from "../domain/models";
import { releaseCompatibility } from "../releaseInfo";

export async function registerHealthRoutes(app: FastifyInstance, config: ServiceConfig): Promise<void> {
  app.get("/health", async () => ({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    runnerKind: config.runnerKind,
    mode: "agent-bridge",
    release: releaseCompatibility
  }));
}
