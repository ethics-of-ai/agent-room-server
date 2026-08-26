import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { getServiceConfig } from "../src/config/serviceConfig";
import type { AgentRunner, AgentRunnerEvent } from "../src/runner/AgentRunner";
import type { AgentRunnerKind, CodingAgentCapabilities } from "../src/domain/models";
import { registeredRunnerKinds } from "../src/runner/registry";

// Cleared per test so a developer `.env` (loaded once at import time by
// config/env.ts) cannot decide the outcome.
const ENV_NAMES = [
  "RUNNER_KIND",
  "CODEX_EXECUTABLE",
  "CLAUDE_CODE_EXECUTABLE",
  "AGENTROOM_HOME",
  "WORKSPACE_ROOT",
  "STATE_DIR",
  "EDITOR_CATALOG_DIR",
  "AUTH_TOKEN"
];

/**
 * `GET /api/runners` is Phase 4's answer to "which runners exist?" — the
 * question both clients used to answer from a compiled-in Swift enum. What it
 * must *not* answer is how a runner is bootstrapped or how the backend behaves
 * because of it. See docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md.
 */
describe("GET /api/runners", () => {
  it("serves one safe descriptor per registered runner, in registration order", async () => {
    await withEnv(async () => {
      await withServer(async (app) => {
        const response = await app.inject({ method: "GET", url: "/api/runners" });

        expect(response.statusCode).toBe(200);
        expect(response.json().runners.map((runner: { runnerKind: string }) => runner.runnerKind))
          .toEqual([...registeredRunnerKinds]);
        expect(response.json().runners).toEqual([
          { runnerKind: "codex", displayName: "Codex", registered: true, configured: false, enabled: true },
          { runnerKind: "claude_code", displayName: "Claude Code", registered: true, configured: true, enabled: true },
          { runnerKind: "deepseek", displayName: "DeepSeek Harness", registered: true, configured: false, enabled: true },
          { runnerKind: "cursor", displayName: "Cursor", registered: true, configured: true, enabled: true }
        ]);
      });
    });
  });

  it("reports configured separately from registered", async () => {
    await withEnv(async () => {
      // Codex is registered whether or not the operator supplied an executable,
      // and only the second makes it usable. Collapsing the two is what produces
      // a runner that reads ready in the UI and cannot start.
      process.env.CODEX_EXECUTABLE = "/usr/local/bin/codex";
      await withServer(async (app) => {
        const runners = (await app.inject({ method: "GET", url: "/api/runners" })).json().runners;
        expect(runners.find((runner: { runnerKind: string }) => runner.runnerKind === "codex"))
          .toMatchObject({ registered: true, configured: true });
      });
    });
  });

  it("projects no policy field, no bootstrap value, and no secret", async () => {
    await withEnv(async () => {
      process.env.CODEX_EXECUTABLE = "/usr/local/bin/codex";
      process.env.CLAUDE_CODE_EXECUTABLE = "/opt/homebrew/bin/claude";
      process.env.AUTH_TOKEN = "agentroom-secret";
      await withServer(async (app) => {
        const response = await app.inject({ method: "GET", url: "/api/runners" });
        const body = response.body;

        for (const runner of response.json().runners) {
          // An exact key set, not a spot check: a descriptor field added later
          // reaches this route by default, so the assertion has to be the
          // allowlist. `promptDelivery`, `turnDiffSource`, `workspaceSkills`,
          // and `restoreStrategy` decide backend behavior and are nobody's
          // business on the wire.
          expect(Object.keys(runner).sort())
            .toEqual(["configured", "displayName", "enabled", "registered", "runnerKind"]);
        }
        expect(body).not.toContain("/usr/local/bin/codex");
        expect(body).not.toContain("/opt/homebrew/bin/claude");
        expect(body).not.toContain("agentroom-secret");
        expect(body).not.toContain("CODEX_EXECUTABLE");
      });
    });
  });

  /**
   * Phase 6 splits readiness into two authorities. This route reports the
   * backend's half — what the adapter's own capability discovery proved — and
   * the whole point is that it *reports* it rather than establishing it: a probe
   * per registered runner on a pollable read is the startup cost the plan's
   * residual question 2 forbids.
   */
  describe("runtime readiness", () => {
    it("reports no readiness, and spawns no probe, until something asks a runner", async () => {
      await withEnv(async () => {
        const codex = new ProbeCountingRunner("codex");
        const claudeCode = new ProbeCountingRunner("claude_code");
        await withServer(async (app) => {
          await app.inject({ method: "GET", url: "/api/runners" });
          const runners = (await app.inject({ method: "GET", url: "/api/runners" })).json().runners;

          // Building the server and reading this route twice must cost nothing:
          // N registered runners must never mean N discovery children.
          expect(codex.probes).toBe(0);
          expect(claudeCode.probes).toBe(0);
          for (const runner of runners) {
            // Absent, not `false`. "Nothing has asked" and "cannot start" are
            // different answers, and reporting the second for the first is the
            // "ready in the UI, unusable by the backend" failure inverted.
            expect(runner).not.toHaveProperty("ready");
          }
        }, { codex, claude_code: claudeCode });
      });
    });

    it("reports what a capability read proved, for that runner alone", async () => {
      await withEnv(async () => {
        const codex = new ProbeCountingRunner("codex");
        const claudeCode = new ProbeCountingRunner("claude_code");
        await withServer(async (app) => {
          await app.inject({ method: "GET", url: "/api/coding-agent/capabilities?runnerKind=codex" });
          const runners = (await app.inject({ method: "GET", url: "/api/runners" })).json().runners;

          expect(codex.probes).toBe(1);
          expect(claudeCode.probes).toBe(0);
          expect(runnerNamed(runners, "codex")).toMatchObject({ ready: true });
          // A runner is not made ready by its neighbour being probed.
          expect(runnerNamed(runners, "claude_code")).not.toHaveProperty("ready");
        }, { codex, claude_code: claudeCode });
      });
    });

    it("separates a runner that cannot start from one that is merely unconfigured", async () => {
      await withEnv(async () => {
        // The adapters report a failed handshake as a bounded `error` on the
        // capabilities they return rather than by throwing, so that field is the
        // readiness answer.
        const codex = new ProbeCountingRunner("codex", "Codex runner requires CODEX_EXECUTABLE");
        await withServer(async (app) => {
          await app.inject({ method: "GET", url: "/api/coding-agent/capabilities?runnerKind=codex" });
          const codexRunner = runnerNamed((await app.inject({ method: "GET", url: "/api/runners" })).json().runners, "codex");

          expect(codexRunner).toMatchObject({ registered: true, configured: false, ready: false });
          // Still four separate states: an unreadable runtime probe does not
          // rewrite what the operator did or did not supply.
          expect(Object.keys(codexRunner).sort())
            .toEqual(["configured", "displayName", "enabled", "ready", "registered", "runnerKind"]);
        }, { codex });
      });
    });

    it("carries no diagnostic text from the child that failed", async () => {
      await withEnv(async () => {
        const codex = new ProbeCountingRunner("codex", "spawn /Users/me/.secret-tools/codex ENOENT");
        await withServer(async (app) => {
          await app.inject({ method: "GET", url: "/api/coding-agent/capabilities?runnerKind=codex" });
          const body = (await app.inject({ method: "GET", url: "/api/runners" })).body;

          // The discovery error is a child's own text and reaches the bounded
          // `error` on the capabilities read. This route stays a posture
          // projection: a state, never a message.
          expect(body).not.toContain(".secret-tools");
          expect(body).not.toContain("ENOENT");
        }, { codex });
      });
    });
  });

  it("is readable without a bearer token, like GET /api/config", async () => {
    await withEnv(async () => {
      process.env.AUTH_TOKEN = "agentroom-secret";
      await withServer(async (app) => {
        // The global preHandler gates mutating methods only, and this read is
        // the operator's posture rather than their credentials — the same
        // reasoning that keeps `GET /api/config` ungated. A client that cannot
        // read which runners exist cannot render a picker at all.
        expect((await app.inject({ method: "GET", url: "/api/runners" })).statusCode).toBe(200);
      });
    });
  });
});

function runnerNamed(runners: { runnerKind: string }[], runnerKind: string): Record<string, unknown> {
  const runner = runners.find((candidate) => candidate.runnerKind === runnerKind);
  expect(runner, `expected ${runnerKind} in the catalog`).toBeDefined();
  return runner as unknown as Record<string, unknown>;
}

/** An adapter that answers discovery instantly and counts being asked. */
class ProbeCountingRunner implements AgentRunner {
  probes = 0;

  constructor(
    private readonly runnerKind: AgentRunnerKind,
    private readonly error?: string
  ) {}

  async getCapabilities(): Promise<CodingAgentCapabilities> {
    this.probes += 1;
    return {
      runnerKind: this.runnerKind,
      settings: { models: [], defaultSettings: {} },
      ...(this.error ? { error: this.error } : {})
    };
  }

  validateInputParts(): void {}

  async *run(): AsyncIterable<AgentRunnerEvent> {
    throw new Error("not used");
  }

  async cancel(): Promise<void> {}
}

async function withServer(
  run: (app: FastifyInstance) => Promise<void>,
  runners?: Partial<Record<AgentRunnerKind, AgentRunner>>
): Promise<void> {
  const { app } = await buildServer({ config: getServiceConfig(), ...(runners ? { runners } : {}) });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

async function withEnv(run: () => Promise<void>): Promise<void> {
  const previous = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  process.env.AGENTROOM_HOME = await mkdtemp(join(tmpdir(), "agentroom-home-"));
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
