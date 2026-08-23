import { describe, expect, it } from "vitest";
import type { AgentRunner, AgentRunnerEvent } from "../src/runner/AgentRunner";
import type { CodingAgentCapabilities } from "../src/domain/models";
import { RunnerRuntimeReadiness } from "../src/runner/runtimeReadiness";

/**
 * The backend half of Phase 6's split readiness
 * (docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md): what the adapter's own
 * capability discovery proved, observed rather than probed for.
 */
describe("runner runtime readiness", () => {
  it("knows nothing about a runner until a discovery runs", () => {
    expect(new RunnerRuntimeReadiness().isReady("codex")).toBeUndefined();
  });

  it("reads a bounded discovery error as unavailable", async () => {
    const readiness = new RunnerRuntimeReadiness();

    await readiness.discoverCapabilities("codex", stubRunner({ error: "Codex runner requires CODEX_EXECUTABLE" }));

    expect(readiness.isReady("codex")).toBe(false);
  });

  it("lets a later discovery correct an earlier one", async () => {
    // The operator installs the CLI and asks again; readiness is the latest
    // answer, not the first one. A sticky `false` would outlive the fix, and a
    // sticky `true` would outlive an executable that has been moved away.
    const readiness = new RunnerRuntimeReadiness();

    await readiness.discoverCapabilities("codex", stubRunner({ error: "no executable" }));
    await readiness.discoverCapabilities("codex", stubRunner());

    expect(readiness.isReady("codex")).toBe(true);
  });

  it("records a thrown discovery as unavailable and lets the error through", async () => {
    // Both current adapters report failure as a bounded `error` string, but the
    // recording must not depend on that convention: an adapter that throws would
    // otherwise leave a stale `ready: true` behind it.
    const readiness = new RunnerRuntimeReadiness();
    await readiness.discoverCapabilities("claude_code", stubRunner());

    await expect(
      readiness.discoverCapabilities("claude_code", stubRunner({ throws: new Error("handshake failed") }))
    ).rejects.toThrow("handshake failed");
    expect(readiness.isReady("claude_code")).toBe(false);
  });
});

function stubRunner(options: { error?: string; throws?: Error } = {}): AgentRunner {
  return {
    async getCapabilities(): Promise<CodingAgentCapabilities> {
      if (options.throws) throw options.throws;
      return {
        runnerKind: "codex",
        settings: { models: [], defaultSettings: {} },
        ...(options.error ? { error: options.error } : {})
      };
    },
    validateInputParts(): void {},
    async *run(): AsyncIterable<AgentRunnerEvent> {
      throw new Error("not used");
    },
    async cancel(): Promise<void> {}
  };
}
