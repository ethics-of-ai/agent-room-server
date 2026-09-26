import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentRunnerKind } from "../domain/models";
import { agentRunnerKindSchema } from "../domain/schemas";
import type { AgentRunner } from "../runner/AgentRunner";
import type { RunnerRuntimeReadiness } from "../runner/runtimeReadiness";

const capabilitiesQuerySchema = z.object({
  runnerKind: agentRunnerKindSchema.optional()
});

export interface CodingAgentRoutesInput {
  runners: Partial<Record<AgentRunnerKind, AgentRunner>>;
  defaultRunnerKind: AgentRunnerKind;
  /**
   * Discovery runs through the readiness observer rather than straight at the
   * adapter, because this route *is* the backend's runtime readiness probe
   * Spawning the child, handshaking, and reading the model list is
   * exactly the question `GET /api/runners` reports the answer to. Recording it
   * here is what keeps that route free of probes of its own.
   */
  readiness: RunnerRuntimeReadiness;
}

export async function registerCodingAgentRoutes(app: FastifyInstance, input: CodingAgentRoutesInput): Promise<void> {
  app.post("/api/coding-agent/connection-test", async (request, reply) => {
    const parsed = capabilitiesQuerySchema.strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Expected only an optional runnerKind" });
    const runnerKind = parsed.data.runnerKind ?? input.defaultRunnerKind;
    const runner = input.runners[runnerKind];
    const testConnection = runner?.testConnection?.bind(runner);
    if (!testConnection) return reply.code(400).send({ error: "This runner does not support connection tests" });
    const test = await input.readiness.testConnection(runnerKind, testConnection);
    if (test.running) return reply.code(409).send({ error: "A connection test is already running" });
    return test.result;
  });
  app.get("/api/coding-agent/capabilities", async (request, reply) => {
    const parsed = capabilitiesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid capabilities query" });
    }
    const runnerKind = parsed.data.runnerKind ?? input.defaultRunnerKind;
    const runner = input.runners[runnerKind];
    if (!runner) {
      return reply.code(400).send({ error: `Runner kind ${runnerKind} is not configured` });
    }
    return input.readiness.discoverCapabilities(runnerKind, runner);
  });
}
