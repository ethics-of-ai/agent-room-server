import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeCodeRunner } from "../src/runner/claudeCode/ClaudeCodeRunner";
import { claudeCodeLoginCheck } from "../src/runner/claudeCode/discovery";
import type { ClaudeCodeQuery, ClaudeCodeQueryFunction } from "../src/runner/claudeCode/sdk";
import type { ServiceConfig } from "../src/domain/models";

/// Capability discovery reads the CLI's signed-in account next to the model
/// list, so readiness can say "not signed in" before a turn fails on it. The
/// signed-in and signed-out shapes below are what SDK 0.3.172 returned against
/// Claude Code 2.1.261; the API-key and provider cases follow its
/// `AccountInfo` type.

const config = async (): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-claude-login-"));
  return {
    runnerKind: "claude_code",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: []
  };
};

function discoveryHarness(accounts: unknown[]): { loadQuery: () => Promise<ClaudeCodeQueryFunction>; spawned: () => number } {
  let spawned = 0;
  const queryFunction: ClaudeCodeQueryFunction = () => {
    const account = accounts[Math.min(spawned, accounts.length - 1)];
    spawned += 1;
    const query: ClaudeCodeQuery = {
      async *[Symbol.asyncIterator]() {},
      interrupt: async () => undefined,
      supportedModels: async () => [],
      accountInfo: async () => account
    };
    return query;
  };
  return { loadQuery: async () => queryFunction, spawned: () => spawned };
}

describe("Claude Code login check", () => {
  it("reads a signed-out CLI as unavailable", () => {
    expect(claudeCodeLoginCheck({ tokenSource: "none", apiProvider: "firstParty" })).toMatchObject({
      id: "claude_login",
      status: "unavailable"
    });
  });

  it("reads a subscription token or an API key as signed in", () => {
    // Claude Code 2.1.261 signed in with `claude auth login` omits
    // tokenSource entirely; only a signed-out CLI names "none".
    expect(claudeCodeLoginCheck({
      email: "a@b.c",
      organization: "Org",
      subscriptionType: "Claude Max",
      apiProvider: "firstParty"
    })).toMatchObject({ status: "ready" });
    expect(claudeCodeLoginCheck({ tokenSource: "claude.ai", apiProvider: "firstParty", email: "a@b.c" }))
      .toMatchObject({ status: "ready" });
    expect(claudeCodeLoginCheck({ tokenSource: "none", apiKeySource: "user" })).toMatchObject({ status: "ready" });
  });

  it("leaves providers that authenticate outside claude login alone", () => {
    expect(claudeCodeLoginCheck({ apiProvider: "bedrock" })).toMatchObject({ status: "ready" });
  });

  it("carries no account identity in the check", () => {
    const check = claudeCodeLoginCheck({ tokenSource: "claude.ai", email: "person@example.com", organization: "Org" });
    expect(JSON.stringify(check)).not.toContain("person@example.com");
    expect(JSON.stringify(check)).not.toContain("Org");
  });

  it("reports not checked when the SDK cannot answer", async () => {
    const harness = discoveryHarness([]);
    const loadQuery = async (): Promise<ClaudeCodeQueryFunction> => {
      const fn = await harness.loadQuery();
      return (params) => ({ ...fn(params), accountInfo: undefined });
    };
    const runner = new ClaudeCodeRunner(await config(), { loadQuery });
    const capabilities = await runner.getCapabilities();
    expect(capabilities.error).toBeUndefined();
    expect(capabilities.checks).toEqual([expect.objectContaining({ id: "claude_login", status: "not_checked" })]);
    await runner.dispose();
  });

  it("asks again after a signed-out answer, then caches the signed-in one", async () => {
    const harness = discoveryHarness([
      { tokenSource: "none", apiProvider: "firstParty" },
      { email: "a@b.c", subscriptionType: "Claude Max", apiProvider: "firstParty" }
    ]);
    const runner = new ClaudeCodeRunner(await config(), { loadQuery: harness.loadQuery });

    const signedOut = await runner.getCapabilities();
    expect(signedOut.checks?.[0]?.status).toBe("unavailable");
    // Readiness is still decided by `error`: the runtime answered, only the
    // account is missing.
    expect(signedOut.error).toBeUndefined();

    const signedIn = await runner.getCapabilities();
    expect(signedIn.checks?.[0]?.status).toBe("ready");
    await runner.getCapabilities();
    expect(harness.spawned()).toBe(2);

    await runner.dispose();
  });

  it("reads again on refresh, so a sign-out shows before the cache expires", async () => {
    const harness = discoveryHarness([
      { email: "a@b.c", subscriptionType: "Claude Max", apiProvider: "firstParty" },
      { tokenSource: "none", apiProvider: "firstParty" }
    ]);
    const runner = new ClaudeCodeRunner(await config(), { loadQuery: harness.loadQuery });

    expect((await runner.getCapabilities()).checks?.[0]?.status).toBe("ready");
    expect((await runner.getCapabilities()).checks?.[0]?.status).toBe("ready");
    expect(harness.spawned()).toBe(1);

    const refreshed = await runner.getCapabilities({ refresh: true });
    expect(refreshed.checks?.[0]?.status).toBe("unavailable");
    expect(harness.spawned()).toBe(2);

    await runner.dispose();
  });
});
