import type { FastifyInstance } from "fastify";
import type { ServiceConfig } from "../domain/models";
import { publicRunnerDescriptors } from "../runner/registry";
import type { RunnerRuntimeReadiness } from "../runner/runtimeReadiness";

/**
 * `GET /api/runners` is the safe/public runner descriptor projection described
 * by docs/engineering/RUNNERS.md.
 *
 * It exists so a client stops deciding *which runners exist* from a compiled-in
 * enum. Both apps used to render their runner pickers from a closed Swift
 * `AgentRunnerKind`, which meant a runner the backend registered was invisible
 * until the apps shipped again — the leak this route retires. A client now
 * hydrates from here and falls back to its own bundled floor while offline.
 *
 * **Additive and ungated, for the same reason `GET /api/config` is.** It reports
 * the operator's posture, never their credentials: a runner's id, its display
 * name, and the three availability states the registry resolves. The descriptor
 * fields that decide backend behavior (`promptDelivery`, `turnDiffSource`,
 * `workspaceSkills`, `restoreStrategy`) are deliberately not projected — no
 * client acts on them — and tier-3 bootstrap material is not in a descriptor at
 * all, so `configured` can say *that* the operator supplied what a runner needs
 * without saying what it is. See docs/safety/TRUST_AND_SAFETY.md.
 *
 * The fourth state, `ready`, comes from a different authority: what the
 * adapter's own capability discovery proved at runtime. This handler reads that
 * observation and **never triggers one** — the route stays a cheap read a client
 * can poll, and a runner nothing has probed simply carries no `ready` field.
 * Asking for a runner's capabilities is the probe.
 */
export async function registerRunnerRoutes(
  app: FastifyInstance,
  deps: { config: ServiceConfig; readiness: RunnerRuntimeReadiness }
): Promise<void> {
  app.get("/api/runners", async () => ({
    runners: publicRunnerDescriptors(deps.config, (runnerKind) => deps.readiness.isReady(runnerKind))
  }));
}
