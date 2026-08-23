import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import { buildHarnessProfile } from "../harness/harnessProfile";
import { VisionOSHarness, VisionOSHarnessError } from "../harness/visionosHarness";
import type { LocalWorkspaceRegistry } from "../workspace/LocalWorkspaceRegistry";

const harnessActionContextSchema = z.object({
  workspaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1),
  turnId: z.string().trim().min(1)
});

const xcodebuildPayloadSchema = harnessActionContextSchema.extend({
  action: z.enum(["build", "test"]).default("build"),
  onlyTesting: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9_./:-]+$/u).optional()
});

export async function registerHarnessRoutes(
  app: FastifyInstance,
  config: ServiceConfig,
  deps: {
    registry: LocalWorkspaceRegistry;
    eventBus: EventBus;
    resolveSessionRunnerKind: (sessionId: string) => string | undefined;
  }
): Promise<void> {
  const visionOSHarness = new VisionOSHarness(deps.registry, deps.eventBus, {
    resolveRunnerKind: deps.resolveSessionRunnerKind,
    defaultRunnerKind: config.runnerKind
  });
  app.get("/api/harness", async () => buildHarnessProfile(config));
  app.post("/api/harness/visionos/xcodegen", async (request, reply) => {
    const parsed = harnessActionContextSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid visionOS harness payload" });
    }
    try {
      return await visionOSHarness.runXcodegen(parsed.data);
    } catch (error) {
      if (error instanceof VisionOSHarnessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/api/harness/visionos/xcodebuild", async (request, reply) => {
    const parsed = xcodebuildPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid visionOS xcodebuild payload" });
    }
    try {
      return await visionOSHarness.runXcodebuild(parsed.data);
    } catch (error) {
      if (error instanceof VisionOSHarnessError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
