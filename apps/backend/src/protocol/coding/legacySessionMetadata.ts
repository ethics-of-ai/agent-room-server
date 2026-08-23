import type { ClaudeCodeSessionMetadata, CodexSessionMetadata, RunnerSessionMetadata } from "../../domain/models";

/**
 * The session-block half of the pre-canonical compatibility shim (see
 * `legacyMetadata.ts` for the event-payload half). `AgentSession.runner` is
 * what the backend records; these are its per-runner projections, kept on the
 * session DTO while the advertised coding-event contract floor is below 2.
 *
 * Like its sibling, this is the one place allowed to name a runner: it is a
 * projection, not a decision.
 */
export function legacySessionMetadata(
  runnerKind: string,
  runner: RunnerSessionMetadata
): { codex?: CodexSessionMetadata; claudeCode?: ClaudeCodeSessionMetadata } {
  if (runnerKind === "codex") {
    return {
      codex: {
        threadId: runner.nativeSessionId,
        model: runner.model,
        cwd: runner.cwd,
        approvalPolicy: runner.posture?.label === "approvalPolicy" ? runner.posture.value : undefined,
        sandbox: runner.sandbox
      }
    };
  }
  if (runnerKind === "claude_code") {
    return {
      claudeCode: {
        sessionId: runner.nativeSessionId,
        model: runner.model,
        cwd: runner.cwd,
        permissionMode: runner.posture?.label === "permissionMode" ? runner.posture.value : undefined
      }
    };
  }
  return {};
}
