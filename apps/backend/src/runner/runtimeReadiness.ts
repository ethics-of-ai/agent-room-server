import type { AgentRunnerKind, CodingAgentCapabilities } from "../domain/models";
import type { AgentRunner } from "./AgentRunner";

/**
 * Backend runtime readiness, as defined by docs/engineering/RUNNERS.md.
 *
 * Readiness has **two authorities**, and the phase exists because collapsing
 * them lets a runner read "ready" in a client while the backend cannot spawn it:
 *
 * - *Backend runtime readiness* — can the backend spawn the child, complete the
 *   handshake, and discover capabilities? Only a running backend can answer it,
 *   and only the adapter can answer it, which is what this file records.
 * - *Mac bootstrap readiness* — is the local prerequisite satisfied (an
 *   installed executable, a `claude login` credential)? That one must work with
 *   the backend **stopped**, so it is answered on the Mac from a bundled
 *   bootstrap descriptor and never from here.
 *
 * **The probe is the discovery the backend already performs.** `getCapabilities`
 * spawns the child, handshakes, and reads the model list, so a discovery that
 * came back without an `error` *is* the proof of runtime readiness; adding a
 * second probe method would mean a second child spawn to learn what the first
 * already established. Nothing here initiates a discovery of its own: readiness
 * is observed as a by-product of a capabilities read, which is what keeps the
 * plan's residual question 2 answered — **N registered runners must never mean N
 * probe children at startup**, and `GET /api/runners` must stay a cheap read a
 * client can poll.
 *
 * The consequence is deliberate: a runner nothing has asked about reports
 * `ready: undefined` rather than `false`. "Not probed" is not "not ready", and
 * reporting the second would be the same lie in the opposite direction.
 *
 * Turn outcomes are deliberately **not** an input. A turn fails for reasons that
 * have nothing to do with whether the runner can start — a rejected prompt, a
 * cancelled turn, a workspace error — so folding them in would make `ready` a
 * lagging judgment of unrelated things. One probe, one meaning.
 */
export class RunnerRuntimeReadiness {
  private readonly observed = new Map<string, boolean>();

  /**
   * What the last discovery proved, or `undefined` when none has run in this
   * process. In-memory and per process by construction: a restarted backend has
   * spawned nothing yet, and claiming otherwise is exactly the failure this
   * separation exists to prevent.
   */
  isReady(runnerKind: string): boolean | undefined {
    return this.observed.get(runnerKind);
  }

  /**
   * Run the adapter's own capability discovery and record what it proved.
   *
   * The adapters return a bounded `error` string rather than throwing when the
   * child cannot start, so that field is the readiness answer. A throw from a
   * future adapter is recorded as unavailable and rethrown — the caller's error
   * handling is not this class's business, but an unobserved failure would leave
   * a stale `ready: true` behind.
   */
  async discoverCapabilities(
    runnerKind: AgentRunnerKind,
    runner: AgentRunner
  ): Promise<CodingAgentCapabilities> {
    try {
      const capabilities = await runner.getCapabilities();
      this.observed.set(runnerKind, capabilities.error === undefined);
      return capabilities;
    } catch (error) {
      this.observed.set(runnerKind, false);
      throw error;
    }
  }
}
