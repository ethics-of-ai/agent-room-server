import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunnerEvent, AgentRunnerInputPart } from "../src/runner/AgentRunner";
import { AgentRunnerInputError } from "../src/runner/AgentRunner";
import { AcpRunner } from "../src/runner/acp/AcpRunner";
import { DEFAULT_ACP_LIMITS } from "../src/runner/acp/AcpStdioClient";
import { admitExecutable, buildAcpChildEnv, isGrantableEnvName } from "../src/runner/acp/admission";
import { acpRunnerDescriptor, acpSettingsKeyPrefix, readAcpAdapterConfigs, type AcpAdapterConfig } from "../src/runner/acp/config";
import {
  agentSupportsPromptImages,
  newSessionResponseSchema,
  permissionRequestSchema,
  readSessionSettings
} from "../src/runner/acp/protocol";
import {
  codingAgentReasoningEffortSchema,
  codingAgentTurnSettingsSchema
} from "../src/domain/schemas";
import {
  MAX_PERMISSION_OPTION_ID_LENGTH,
  MAX_PERMISSION_OPTIONS
} from "../src/runner/shared/PendingPermissionRequests";
import {
  agentRunnerKindSchema,
  managedSettingScope,
  registerExternalRunnerDescriptors,
  registeredRunnerKinds,
  runnerAvailability
} from "../src/runner/registry";
import {
  managedSettingDefaults,
  managedSettingEnvNames,
  managedSettingKeys,
  managedSettingPaths,
  managedSettingTiers,
  managedSettingsPatchSchema,
  rebuildManagedSettings
} from "../src/config/settingsStore";
import type { ServiceConfig } from "../src/domain/models";
import { writeSyntheticAgent, type SyntheticAgentMode } from "./support/syntheticAcpAgent";

const serviceConfig = (overrides: Partial<ServiceConfig> = {}): ServiceConfig =>
  ({
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: "/tmp/workspaces",
    stateDir: "/tmp/state",
    editorCatalogDir: "/tmp/catalog-assets",
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  }) as ServiceConfig;

const adapterConfig = (command: string, overrides: Partial<AcpAdapterConfig> = {}): AcpAdapterConfig => ({
  id: "acp_synthetic",
  displayName: "Synthetic Agent",
  command,
  args: [],
  envGrants: [],
  permissionPolicyKey: "acpSyntheticPermissionPolicy",
  ...overrides
});

const runners: AcpRunner[] = [];
function track(runner: AcpRunner): AcpRunner {
  runners.push(runner);
  return runner;
}

async function collect(iterable: AsyncIterable<AgentRunnerEvent>): Promise<AgentRunnerEvent[]> {
  const events: AgentRunnerEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function agentFor(mode: SyntheticAgentMode, flags: string[] = []) {
  const agent = writeSyntheticAgent();
  return {
    ...agent,
    adapter: adapterConfig(agent.command, { args: [mode, ...flags] })
  };
}

const image = (path: string): AgentRunnerInputPart => ({
  type: "localImage",
  path,
  contentType: "image/png"
});

const assistantText = (events: AgentRunnerEvent[]): string =>
  events
    .filter((event): event is AgentRunnerEvent & { type: "agent_update" } => event.type === "agent_update")
    .map((event) => event.message)
    .join("");

/**
 * Consume a run in the background.
 *
 * A permission turn cannot be collected to completion first: the agent is
 * waiting on the answer this test has to send, so the events have to be
 * readable while the run is still open.
 */
function stream(iterable: AsyncIterable<AgentRunnerEvent>): {
  events: AgentRunnerEvent[];
  done: Promise<void>;
} {
  const events: AgentRunnerEvent[] = [];
  const done = (async () => {
    for await (const event of iterable) events.push(event);
  })();
  return { events, done };
}

const canonicalOf = (events: AgentRunnerEvent[], kind: string): Record<string, unknown> | undefined =>
  events
    .filter((event): event is AgentRunnerEvent & { type: "agent_activity" } => event.type === "agent_activity")
    .map((event) => event.activity.canonical as Record<string, unknown> | undefined)
    .find((canonical) => canonical?.kind === kind);

async function waitForCanonical(
  events: AgentRunnerEvent[],
  kind: string,
  timeoutMs = 10_000
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  for (;;) {
    const canonical = canonicalOf(events, kind);
    if (canonical) return canonical;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const canonicalKinds = (events: AgentRunnerEvent[]): string[] =>
  events
    .filter((event): event is AgentRunnerEvent & { type: "agent_activity" } => event.type === "agent_activity")
    .map((event) => event.activity.canonical?.kind ?? "none");

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.dispose();
  registerExternalRunnerDescriptors([]);
  // The settings table derives from the registry, so leaving it built over a
  // de-registered adapter would leak that adapter's keys into the next test.
  rebuildManagedSettings();
  delete process.env.ACP_ADAPTERS_ENABLED;
  delete process.env.ACP_ADAPTERS;
});

describe("ACP process admission", () => {
  it("refuses a relative path, because a turn's cwd is a registered workspace", () => {
    // A relative command would let the repository being worked on decide which
    // binary runs.
    expect(admitExecutable("bin/agent")).toMatchObject({ ok: false });
  });

  it("refuses a path that does not exist", () => {
    expect(admitExecutable("/definitely/not/here/agent")).toMatchObject({ ok: false });
  });

  it("refuses a symlink rather than following it", () => {
    // The operator allowlisted a program; a symlink's target can be repointed
    // afterwards without the allowlist changing.
    const agent = writeSyntheticAgent();
    const link = join(agent.dir, "link-to-agent");
    symlinkSync(agent.command, link);
    expect(admitExecutable(link)).toMatchObject({ ok: false, reason: expect.stringContaining("symlink") });
  });

  it("refuses a directory and a non-executable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-admit-"));
    const nested = join(dir, "nested");
    mkdirSync(nested);
    const plain = join(dir, "plain.txt");
    writeFileSync(plain, "not a program", "utf8");

    expect(admitExecutable(nested)).toMatchObject({ ok: false });
    expect(admitExecutable(plain)).toMatchObject({ ok: false });
  });

  it("admits an executable regular file and reports the resolved path", () => {
    const agent = writeSyntheticAgent();
    expect(admitExecutable(agent.command)).toMatchObject({ ok: true });
  });
});

describe("ACP child environment", () => {
  it("is an allowlist rather than an inheritance", () => {
    // The strictest difference from the built-in runners, and deliberate: an
    // arbitrary allowlisted binary has no claim on the operator's whole
    // developer environment the way codex and claude do.
    const env = buildAcpChildEnv([], { PATH: "/usr/bin", HOME: "/Users/x", AWS_SECRET_ACCESS_KEY: "sk-live" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/x");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("passes an explicitly granted name through", () => {
    const env = buildAcpChildEnv(["GEMINI_API_KEY"], { PATH: "/usr/bin", GEMINI_API_KEY: "k" });
    expect(env.GEMINI_API_KEY).toBe("k");
  });

  it("never grants AUTH_TOKEN, however it is asked for", () => {
    // AgentRoom's transport secret reaches no child the backend spawns.
    expect(isGrantableEnvName("AUTH_TOKEN")).toBe(false);
    const env = buildAcpChildEnv(["AUTH_TOKEN"], { PATH: "/usr/bin", AUTH_TOKEN: "secret" });
    expect(env.AUTH_TOKEN).toBeUndefined();
  });

  it("omits a granted name that is unset rather than inventing one", () => {
    expect(buildAcpChildEnv(["GEMINI_API_KEY"], { PATH: "/usr/bin" }).GEMINI_API_KEY).toBeUndefined();
  });
});

describe("ACP adapter configuration", () => {
  it("is off by default, so nothing can be spawned without the flag", () => {
    process.env.ACP_ADAPTERS = JSON.stringify([
      { id: "acp_x", displayName: "X", command: "/bin/echo" }
    ]);
    expect(readAcpAdapterConfigs()).toEqual([]);
  });

  it("drops a malformed list whole rather than applying part of it", () => {
    process.env.ACP_ADAPTERS_ENABLED = "true";
    expect(readAcpAdapterConfigs("{not json")).toEqual([]);
  });

  it("refuses an id outside the acp_ namespace", () => {
    // The namespace is what keeps an operator from shadowing a built-in id and
    // keeps the derived settings prefix from colliding with codex/claudeCode.
    process.env.ACP_ADAPTERS_ENABLED = "true";
    expect(
      readAcpAdapterConfigs(JSON.stringify([{ id: "codex", displayName: "X", command: "/bin/echo" }]))
    ).toEqual([]);
  });

  it("refuses a definition that asks for AUTH_TOKEN, dropping the whole list", () => {
    process.env.ACP_ADAPTERS_ENABLED = "true";
    expect(
      readAcpAdapterConfigs(
        JSON.stringify([{ id: "acp_x", displayName: "X", command: "/bin/echo", envGrants: ["AUTH_TOKEN"] }])
      )
    ).toEqual([]);
  });

  it("accepts a well-formed definition and derives its settings key", () => {
    process.env.ACP_ADAPTERS_ENABLED = "true";
    const [config] = readAcpAdapterConfigs(
      JSON.stringify([{ id: "acp_gemini", displayName: "Gemini", command: "/bin/echo", args: ["--acp"] }])
    );
    expect(config).toMatchObject({ id: "acp_gemini", displayName: "Gemini", args: ["--acp"] });
    expect(acpSettingsKeyPrefix("acp_gemini")).toBe("acpGemini");
    expect(config.permissionPolicyKey).toBe("acpGeminiPermissionPolicy");
  });

  it("drops definitions whose ids derive the same managed-setting key", () => {
    process.env.ACP_ADAPTERS_ENABLED = "true";
    expect(
      readAcpAdapterConfigs(
        JSON.stringify([
          { id: "acp_foo", displayName: "Foo", command: "/bin/echo" },
          { id: "acp_foo_", displayName: "Foo trailing", command: "/bin/echo" }
        ])
      )
    ).toEqual([]);
  });
});

describe("external runner registration", () => {
  it("keeps the built-in admission list closed while admitting a configured adapter", () => {
    // The rollout gate is about *bundled* ids reaching an older Mac's settings
    // file. An operator-configured adapter is a different thing, so admitting
    // one must never grow the tuple of ids this build ships.
    registerExternalRunnerDescriptors([acpRunnerDescriptor(adapterConfig("/bin/echo", { id: "acp_x" }))]);
    expect([...registeredRunnerKinds]).toEqual(["codex", "claude_code", "deepseek", "cursor"]);
    expect(agentRunnerKindSchema.safeParse("acp_x").success).toBe(true);
    expect(agentRunnerKindSchema.safeParse("acp_unregistered").success).toBe(false);
  });

  it("refuses an external id that collides with a built-in runner", () => {
    expect(() =>
      registerExternalRunnerDescriptors([
        { ...acpRunnerDescriptor(adapterConfig("/bin/echo")), id: "codex" }
      ])
    ).toThrow(/collides/);
  });

  it("refuses distinct ids that derive an identical settings prefix", () => {
    expect(() =>
      registerExternalRunnerDescriptors([
        acpRunnerDescriptor(adapterConfig("/bin/echo", { id: "acp_foo" })),
        acpRunnerDescriptor(adapterConfig("/bin/echo", { id: "acp_foo_" }))
      ])
    ).toThrow(/settings prefix/i);
    expect(agentRunnerKindSchema.safeParse("acp_foo").success).toBe(false);
    expect(agentRunnerKindSchema.safeParse("acp_foo_").success).toBe(false);
  });

  it("addresses a configured adapter's settings under its own namespace", () => {
    registerExternalRunnerDescriptors([acpRunnerDescriptor(adapterConfig("/bin/echo", { id: "acp_gemini" }))]);
    expect(managedSettingScope("acpGeminiPermissionPolicy")).toEqual({
      scope: "runner",
      runnerKind: "acp_gemini",
      field: "permissionPolicy"
    });
  });

  it("reaches the settings layer once the table is rebuilt", () => {
    // Regression: the managed setting table was assembled at *import* time while
    // external adapters are admitted at *startup* time, so a configured
    // adapter's settings — including the tier-2 setting that decides its
    // permission posture — silently reached neither the schema, the metadata,
    // the patch schema, nor environment resolution.
    registerExternalRunnerDescriptors([acpRunnerDescriptor(adapterConfig("/bin/echo", { id: "acp_gemini" }))]);
    rebuildManagedSettings();

    expect(managedSettingKeys).toContain("acpGeminiPermissionPolicy");
    expect(managedSettingPaths).toContain("runners.acp_gemini.permissionPolicy");
    expect(managedSettingTiers.acpGeminiPermissionPolicy).toBe(2);
    expect(managedSettingEnvNames.acpGeminiPermissionPolicy).toBe("ACP_GEMINI_PERMISSION_POLICY");
    expect(managedSettingDefaults.acpGeminiPermissionPolicy).toBe("reject");

    // Both addresses patch, like every other managed setting.
    expect(managedSettingsPatchSchema.safeParse({ "runners.acp_gemini.permissionPolicy": "auto_allow" }).success)
      .toBe(true);
    expect(managedSettingsPatchSchema.safeParse({ acpGeminiPermissionPolicy: "reject" }).success).toBe(true);
    expect(managedSettingsPatchSchema.safeParse({ acpGeminiPermissionPolicy: "sudo" }).success).toBe(false);
  });

  it("drops a de-registered adapter's settings again on rebuild", () => {
    registerExternalRunnerDescriptors([acpRunnerDescriptor(adapterConfig("/bin/echo", { id: "acp_gemini" }))]);
    rebuildManagedSettings();
    registerExternalRunnerDescriptors([]);
    rebuildManagedSettings();
    expect(managedSettingKeys).not.toContain("acpGeminiPermissionPolicy");
  });

  it("reports configured from whether the allowlisted binary is spawnable", () => {
    const agent = writeSyntheticAgent();
    registerExternalRunnerDescriptors([acpRunnerDescriptor(adapterConfig(agent.command, { id: "acp_ok" }))]);
    expect(runnerAvailability("acp_ok", serviceConfig()).configured).toBe(true);

    registerExternalRunnerDescriptors([
      acpRunnerDescriptor(adapterConfig("/nope/missing", { id: "acp_missing" }))
    ]);
    expect(runnerAvailability("acp_missing", serviceConfig()).configured).toBe(false);
  });
});

/**
 * See docs/engineering/RUNNERS.md.
 *
 * ACP v1 has no model-*list* method, which is why the descriptor used to be
 * empty — but `session/new` carries `configOptions`, whose `model` and
 * `thought_level` categories map without interpretation. `model_config` remains
 * generic (context size, speed/quality, or several controls), while `mode` must
 * **not** cross at all: it is the agent's sandbox posture, and a turn setting is
 * chosen by any client holding the bearer token.
 */
describe("ACP session config discovery", () => {
  it("maps model and effort selectors without flattening generic model config", async () => {
    const { adapter } = agentFor("config_options");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const capabilities = await runner.getCapabilities();

    expect(capabilities.error).toBeUndefined();
    // The unrepresentable id is dropped rather than listed: offering a value the
    // turn schema would refuse is an edit that looks valid and fails at the write.
    expect(capabilities.settings.models.map((model) => model.id)).toEqual(["m-fast", "m-deep"]);
    expect(capabilities.settings.models[0]).toMatchObject({
      id: "m-fast",
      label: "Fast",
      description: "Quick",
      isDefault: true,
      defaultReasoningEffort: "low"
    });
    expect(capabilities.settings.models[1]?.isDefault).toBe(false);
    // Session-scoped in ACP, so the same list hangs off every model rather than
    // pretending each model has its own.
    for (const model of capabilities.settings.models) {
      expect(model.reasoningEfforts.map((effort) => effort.id)).toEqual(["low", "high", "ultra"]);
      expect(model.serviceTiers).toEqual([]);
    }
    expect(capabilities.settings.defaultSettings).toEqual({
      model: "m-fast",
      reasoningEffort: "low"
    });
    expect(JSON.stringify(capabilities)).not.toContain("fast-mode");
  });

  it("carries an effort vocabulary the built-in runners do not have", async () => {
    const { adapter } = agentFor("config_options");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const capabilities = await runner.getCapabilities();

    // `ultra` is outside `CodingAgentReasoningEffort`, the closed vocabulary of
    // the Codex and Claude Code managed settings. It survives because a turn's effort is
    // the advertising runner's vocabulary, bounded by shape rather than by enum.
    expect(capabilities.settings.models[0]?.reasoningEfforts.map((effort) => effort.id)).toContain("ultra");
    expect(codingAgentTurnSettingsSchema.safeParse({ reasoningEffort: "ultra" }).success).toBe(true);
    // Those managed settings stay closed, because
    // `/api/config` reports that vocabulary as their `options`.
    expect(codingAgentReasoningEffortSchema.safeParse("ultra").success).toBe(false);
  });

  it("never projects the agent's sandbox posture into a turn setting", async () => {
    const { adapter } = agentFor("config_options_mode_only");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const capabilities = await runner.getCapabilities();

    // The agent offers exactly one selector — `agent-full-access`, which is
    // "edit files outside this workspace and run commands with network access".
    // Every other runner trust posture is a tier-2 managed setting behind
    // REMOTE_SETTINGS_ADMIN; a turn setting has no such gate, so this must not
    // become a control on the composer.
    expect(capabilities.settings.models).toEqual([]);
    expect(capabilities.settings.defaultSettings).toEqual({});
    expect(JSON.stringify(capabilities)).not.toContain("agent-full-access");
  });

  it("reads a restored session's own current values rather than assuming them", () => {
    // `session/resume` reports the selectors too; a conversation that came back
    // after a reap may not be set to what it started with.
    const restored = readSessionSettings([
      { id: "model", category: "model", type: "select", currentValue: "m-deep",
        options: [{ value: "m-fast" }, { value: "m-deep" }] }
    ]);
    expect(restored.model).toMatchObject({ configId: "model", currentValue: "m-deep" });
    expect(restored.descriptor.models.find((model) => model.isDefault)?.id).toBe("m-deep");
  });

  it("drops option values that cannot round-trip through the turn schema", () => {
    const settings = readSessionSettings([
      { id: "model", category: "model", type: "select", currentValue: " m-spaced ",
        options: [{ value: " m-spaced " }, { value: "m-valid" }] }
    ]);

    // Trimming the first id and sending it back would select a token the agent
    // never offered, so it must not appear in the descriptor at all.
    expect(settings.descriptor.models.map((model) => model.id)).toEqual(["m-valid"]);
    expect(settings.descriptor.defaultSettings).toEqual({});
    expect(settings.model?.currentValue).toBeUndefined();
  });

  it("keeps the session when the selector list itself is unusable", () => {
    // A model picker is discovery; the session is the thing that matters. An
    // over-cap or wrong-typed list must cost the picker and nothing else.
    const overCap = Array.from({ length: 40 }, (_, index) => ({ id: `x${index}`, type: "select" }));
    for (const configOptions of [overCap, "not-a-list", 7]) {
      const parsed = newSessionResponseSchema.safeParse({ sessionId: "s-1", configOptions });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.sessionId).toBe("s-1");
      expect(parsed.success && readSessionSettings(parsed.data.configOptions).descriptor.models).toEqual([]);
    }
  });

  it("maps nothing from a boolean selector or an unknown category", () => {
    const settings = readSessionSettings([
      { id: "verbose", category: "model_config", type: "boolean", value: false },
      { id: "context", category: "model_config", type: "select", currentValue: "200k",
        options: [{ value: "200k" }, { value: "1m" }] },
      { id: "collab", category: "collaboration_mode", type: "select", currentValue: "plan",
        options: [{ value: "plan" }] },
      { id: "model", category: "model", type: "select", currentValue: "m",
        options: [{ value: "m" }] }
    ]);
    // A model list, and neither generic model config nor the off-spec category
    // flattened into the tier or effort lists beside it.
    expect(settings.descriptor.models).toHaveLength(1);
    expect(settings.descriptor.models[0]?.serviceTiers).toEqual([]);
    expect(settings.descriptor.models[0]?.reasoningEfforts).toEqual([]);
    expect(settings.serviceTier).toBeUndefined();
  });
});

describe("ACP session config application", () => {
  it("sets only what changed, before the prompt arrives", async () => {
    const { adapter, workspace } = agentFor("config_options");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({
        runId: "run-cfg",
        sessionId: "session-cfg",
        workspacePath: workspace,
        prompt: "hi",
        settings: { model: "m-deep", reasoningEffort: "high" }
      })
    );

    const text = assistantText(events);
    expect(text).toContain('"model":"m-deep"');
    expect(text).toContain('"reasoning_effort":"high"');
    expect(text).toContain("sets:model=m-deep,reasoning_effort=high");
    expect(text).not.toContain("fast-mode=off");
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
  });

  it("tracks an agent-initiated config update while the session is idle", async () => {
    const { adapter, workspace } = agentFor("config_options", ["config_update_idle"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));

    await collect(
      runner.run({ runId: "run-before-update", sessionId: "session-update", workspacePath: workspace, prompt: "one" })
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    const events = await collect(
      runner.run({
        runId: "run-after-update",
        sessionId: "session-update",
        workspacePath: workspace,
        prompt: "two",
        // The agent moved itself from m-fast to m-deep while idle. A stale local
        // record would think this is already selected and skip the setter.
        settings: { model: "m-fast" }
      })
    );

    expect(assistantText(events)).toContain("sets:model=m-fast");
    expect(assistantText(events)).toContain('"model":"m-fast"');
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
  });

  it("fails when a config setter omits the required refreshed state", async () => {
    const { adapter, workspace } = agentFor("config_options", ["set_config_missing_state"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({
        runId: "run-missing-state",
        sessionId: "session-missing-state",
        workspacePath: workspace,
        prompt: "hi",
        settings: { model: "m-deep" }
      })
    );

    expect(events.some((event) => event.type === "run_failed")).toBe(true);
    expect(events.some((event) => event.type === "run_succeeded")).toBe(false);
    expect(assistantText(events)).toBe("");
  });

  it("fails when the refreshed state does not confirm the selection", async () => {
    const { adapter, workspace } = agentFor("config_options", ["set_config_ignored"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({
        runId: "run-ignored-set",
        sessionId: "session-ignored-set",
        workspacePath: workspace,
        prompt: "hi",
        settings: { model: "m-deep" }
      })
    );

    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toContain('did not apply the model "m-deep"');
    expect(assistantText(events)).toBe("");
  });

  it("refuses generic model config through the service-tier field", async () => {
    const { adapter, workspace } = agentFor("config_options");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({
        runId: "run-generic-config",
        sessionId: "session-generic-config",
        workspacePath: workspace,
        prompt: "hi",
        settings: { serviceTier: "on" }
      })
    );

    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toContain("does not offer a serviceTier selection");
  });

  it("refuses a value the agent never offered instead of forwarding it", async () => {
    const { adapter, workspace } = agentFor("config_options");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({
        runId: "run-bad",
        sessionId: "session-bad",
        workspacePath: workspace,
        prompt: "hi",
        settings: { model: "m-nonexistent" }
      })
    );

    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toContain('does not offer the model "m-nonexistent"');
  });

  it("refuses a selection an agent offering no selector cannot honor", async () => {
    const { adapter, workspace } = agentFor("basic");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({
        runId: "run-none",
        sessionId: "session-none",
        workspacePath: workspace,
        prompt: "hi",
        settings: { model: "m-fast" }
      })
    );

    // Silently dropping it would run the turn on a model the operator did not
    // choose and report success.
    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toContain("does not offer a model selection");
  });

  it("runs a turn that selects nothing without touching the session config", async () => {
    const { adapter, workspace } = agentFor("config_options");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-plain", sessionId: "session-plain", workspacePath: workspace, prompt: "hi" })
    );

    expect(assistantText(events)).toContain("sets:]");
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
  });
});

describe("AcpRunner turns", () => {
  it("maps the ACP update vocabulary onto canonical activities", async () => {
    const { adapter, workspace } = agentFor("basic");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-1", sessionId: "session-1", workspacePath: workspace, prompt: "hi" })
    );

    expect(assistantText(events)).toBe("Hello world");
    // session_started first — it is what fills the session's runner-agnostic
    // metadata block — then reasoning, the tool pair, and the plan. Nothing at
    // all for the update the adapter has no canonical reading of.
    expect(canonicalKinds(events)).toEqual([
      "session_started",
      "reasoning",
      "tool_started",
      "tool_output",
      "tool_completed",
      "plan_updated"
    ]);

    const toolOutput = events.find(
      (event): event is AgentRunnerEvent & { type: "agent_activity" } =>
        event.type === "agent_activity" && event.activity.canonical?.kind === "tool_output"
    );
    expect(toolOutput?.activity.canonical).toMatchObject({
      kind: "tool_output",
      toolId: "t1",
      delta: '{"exit_code":0}'
    });
    expect(toolOutput?.activity.content).toMatchObject({ rawOutput: { exit_code: 0 } });

    const started = events.find(
      (event): event is AgentRunnerEvent & { type: "agent_activity" } =>
        event.type === "agent_activity" && event.activity.canonical?.kind === "session_started"
    );
    expect(started?.activity.runner).toMatchObject({
      nativeSessionId: "synthetic-session-1",
      cwd: workspace,
      posture: { label: "permissionPolicy", value: "reject" }
    });
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);

    const usage = events.find((event) => event.type === "token_usage_updated");
    expect(usage).toMatchObject({ contextWindowUsedTokens: 1234, modelContextWindowTokens: 200000 });

    const audits = events.filter((event) => event.type === "runner_audit");
    expect(audits).toHaveLength(2);
  });

  it("correlates a tool call's start and completion by one stable id", async () => {
    const { adapter, workspace } = agentFor("basic");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-2", sessionId: "session-2", workspacePath: workspace, prompt: "hi" })
    );
    const toolIds = events
      .filter((event): event is AgentRunnerEvent & { type: "agent_activity" } => event.type === "agent_activity")
      .map((event) => event.activity.canonical)
      .filter((canonical) => canonical?.kind === "tool_started" || canonical?.kind === "tool_completed")
      .map((canonical) => (canonical as { toolId?: string }).toolId);
    expect(toolIds).toEqual(["t1", "t1"]);
  });

  it("refuses an agent that advertises no restore capability", async () => {
    // A runner AgentRoom reaps and resumes must be restorable, or a reap
    // silently begins a fresh conversation under the same session id.
    const { adapter, workspace } = agentFor("no_restore");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-3", sessionId: "session-3", workspacePath: workspace, prompt: "hi" })
    );
    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toMatch(/restore capability/);
  });

  it("reports an unrestorable agent as not ready during capability discovery", async () => {
    const { adapter } = agentFor("no_restore");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const capabilities = await runner.getCapabilities();
    expect(capabilities.error).toMatch(/restore capability/);
  });

  it("records a valid refusal as a failed completed audit", async () => {
    const { adapter, workspace } = agentFor("refusal");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-refusal", sessionId: "session-refusal", workspacePath: workspace, prompt: "hi" })
    );
    expect(events.some((event) => event.type === "run_failed")).toBe(true);
    expect(
      events.find((event) => event.type === "runner_audit" && event.audit.phase === "completed")
    ).toMatchObject({ audit: { status: "failed" } });
  });

  it("fails a malformed prompt response instead of treating it as completion", async () => {
    const { adapter, workspace } = agentFor("malformed_prompt");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-malformed", sessionId: "session-malformed", workspacePath: workspace, prompt: "hi" })
    );
    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toMatch(/invalid session\/prompt response/i);
    expect(events.some((event) => event.type === "run_succeeded")).toBe(false);
  });

  it("preserves a UTF-8 scalar split across stdout chunks", async () => {
    const { adapter, workspace } = agentFor("split_utf8");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-utf8", sessionId: "session-utf8", workspacePath: workspace, prompt: "hi" })
    );
    expect(assistantText(events)).toBe("Hello 🌍");
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
  });

  it("refuses image attachments once the agent has said it takes none", async () => {
    // Unknown is not "no": the advertisement is read at a handshake, and the
    // capability probe is the cheapest thing that establishes it.
    const { adapter } = agentFor("basic");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    await runner.getCapabilities();
    expect(() => runner.validateInputParts([image("/tmp/a.png")])).toThrow(AgentRunnerInputError);
  });

  it("accepts image support only from the exact ACP boolean", () => {
    expect(agentSupportsPromptImages({ promptCapabilities: { image: true } })).toBe(true);
    expect(agentSupportsPromptImages({ promptCapabilities: { image: false } })).toBe(false);
    expect(agentSupportsPromptImages({ promptCapabilities: { image: "false" } })).toBe(false);
    expect(agentSupportsPromptImages({ promptCapabilities: { image: {} } })).toBe(false);
  });

  it("refuses an attachment with no content type, which ACP has no way to send", async () => {
    const { adapter } = agentFor("basic", ["images"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    await runner.getCapabilities();
    expect(() => runner.validateInputParts([{ type: "localImage", path: "/tmp/a.png" }]))
      .toThrow(/content type/i);
  });

  it("sends image attachments as content blocks to an agent that advertises them", async () => {
    const { adapter, workspace } = agentFor("basic", ["images"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const path = join(workspace, "shot.png");
    writeFileSync(path, Buffer.from([1, 2, 3, 4, 5]));

    const events = await collect(
      runner.run({
        runId: "run-image",
        sessionId: "session-image",
        workspacePath: workspace,
        prompt: "hi",
        inputParts: [image(path)]
      })
    );

    // The agent reports what actually arrived: the text block, then the image
    // inlined as base64 with its mime type.
    expect(assistantText(events)).toContain("PROMPT[text,image:image/png:5]");
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
    expect(() => runner.validateInputParts([image(path)])).not.toThrow();
  });

  it("fails the turn explicitly when the first attachment arrives before any handshake", async () => {
    // The unknown window. Nothing has spawned this agent, so the turn is
    // admitted and the handshake it performs is what refuses — never a silent
    // drop, and never a refusal that turns out to have been about AgentRoom.
    const { adapter, workspace } = agentFor("basic");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    expect(() => runner.validateInputParts([image("/tmp/a.png")])).not.toThrow();

    const events = await collect(
      runner.run({
        runId: "run-image-unknown",
        sessionId: "session-image-unknown",
        workspacePath: workspace,
        prompt: "hi",
        inputParts: [image("/tmp/a.png")]
      })
    );
    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toMatch(/does not support image attachments/);
    expect(
      events.find((event) => event.type === "runner_audit" && event.audit.phase === "completed")
    ).toMatchObject({ audit: { status: "failed" } });
    // Converged: that handshake recorded the answer, so the next attempt never
    // reaches a turn.
    expect(() => runner.validateInputParts([image("/tmp/a.png")])).toThrow(AgentRunnerInputError);
  });

  it("bounds the image bytes one prompt may carry", async () => {
    // The per-attachment upload cap bounds a file; this bounds the frame, which
    // is the thing an arbitrary child actually receives.
    const { adapter, workspace } = agentFor("basic", ["images"]);
    const runner = track(
      new AcpRunner(serviceConfig(), adapter, { ...DEFAULT_ACP_LIMITS, maxPromptImageBytes: 4 })
    );
    const path = join(workspace, "big.png");
    writeFileSync(path, Buffer.alloc(16));

    const events = await collect(
      runner.run({
        runId: "run-image-cap",
        sessionId: "session-image-cap",
        workspacePath: workspace,
        prompt: "hi",
        inputParts: [image(path)]
      })
    );
    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toMatch(/at most 4 bytes/);
  });

  it("uses the capability negotiated by each persistent child", async () => {
    const { adapter, workspace } = agentFor("basic", ["images_by_cwd"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const imagesOffWorkspace = join(workspace, "images-off");
    const imagesOnWorkspace = join(workspace, "images-on");
    mkdirSync(imagesOffWorkspace);
    mkdirSync(imagesOnWorkspace);
    const path = join(workspace, "shot.png");
    writeFileSync(path, Buffer.from([1, 2, 3, 4, 5]));

    await collect(runner.run({
      runId: "run-images-off-prime",
      sessionId: "session-images-off",
      workspacePath: imagesOffWorkspace,
      prompt: "prime"
    }));
    await collect(runner.run({
      runId: "run-images-on-prime",
      sessionId: "session-images-on",
      workspacePath: imagesOnWorkspace,
      prompt: "prime"
    }));

    // Mixed process-wide observations cannot answer for a particular retained
    // child, so synchronous preflight defers to that child's own negotiation.
    expect(() => runner.validateInputParts([image(path)])).not.toThrow();

    const refused = await collect(runner.run({
      runId: "run-images-off-attachment",
      sessionId: "session-images-off",
      workspacePath: imagesOffWorkspace,
      prompt: "hi",
      inputParts: [image(path)]
    }));
    expect(refused.find((event) => event.type === "run_failed")).toMatchObject({
      error: expect.stringMatching(/does not support image attachments/)
    });
    expect(refused.some((event) => event.type === "run_succeeded")).toBe(false);

    const accepted = await collect(runner.run({
      runId: "run-images-on-attachment",
      sessionId: "session-images-on",
      workspacePath: imagesOnWorkspace,
      prompt: "hi",
      inputParts: [image(path)]
    }));
    expect(assistantText(accepted)).toContain("PROMPT[text,image:image/png:5]");
    expect(accepted.some((event) => event.type === "run_succeeded")).toBe(true);
  });

  it("answers a permission request conservatively by default, and says the policy did", async () => {
    // The spike's declared response, kept for production: select a rejection
    // option the agent offered, and never invent an allow.
    const { adapter, workspace } = agentFor("permission");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-4", sessionId: "session-4", workspacePath: workspace, prompt: "hi" })
    );
    expect(assistantText(events)).toContain('"optionId":"reject-1"');
    expect(assistantText(events)).not.toContain("allow-1");

    // The request is announced even when nobody is asked: "the agent wanted to
    // run this and was refused" is the operator's posture taking effect, and
    // the transcript is where they see it.
    const requested = canonicalOf(events, "permission_requested");
    expect(requested).toMatchObject({
      request: { title: "Run rm -rf" }
    });
    // A stored posture decides this request immediately, so there is no pending
    // route for the client and the event must not advertise one.
    expect(requested).not.toHaveProperty("requestId");
    expect(requested).not.toHaveProperty("options");
    expect(canonicalOf(events, "permission_resolved")).toMatchObject({
      status: "selected",
      optionId: "reject-1",
      decidedBy: "policy"
    });
  });

  it("selects an allow option only under the gated auto_allow posture", async () => {
    const { adapter, workspace } = agentFor("permission");
    const config = serviceConfig({
      settingsValues: { acpSyntheticPermissionPolicy: "auto_allow" }
    } as Partial<ServiceConfig>);
    const runner = track(new AcpRunner(config, adapter));
    const events = await collect(
      runner.run({ runId: "run-5", sessionId: "session-5", workspacePath: workspace, prompt: "hi" })
    );
    expect(assistantText(events)).toContain('"optionId":"allow-1"');
    // Unattended: still the policy's decision, not a person's, and the resolved
    // event has to say so — "allowed" reads very differently otherwise.
    expect(canonicalOf(events, "permission_resolved")).toMatchObject({
      optionId: "allow-1",
      decidedBy: "policy"
    });
    const requested = canonicalOf(events, "permission_requested");
    expect(requested).not.toHaveProperty("requestId");
    expect(requested).not.toHaveProperty("options");
  });

  it("bounds and de-duplicates the permission vocabulary before it can be advertised", () => {
    const option = (optionId: string) => ({ optionId, kind: "allow_once", name: "Allow" });
    expect(permissionRequestSchema.safeParse({
      options: Array.from({ length: MAX_PERMISSION_OPTIONS }, (_, index) => option(`option-${index}`))
    }).success).toBe(true);
    expect(permissionRequestSchema.safeParse({
      options: Array.from({ length: MAX_PERMISSION_OPTIONS + 1 }, (_, index) => option(`option-${index}`))
    }).success).toBe(false);
    expect(permissionRequestSchema.safeParse({
      options: [option("x".repeat(MAX_PERMISSION_OPTION_ID_LENGTH + 1))]
    }).success).toBe(false);
    expect(permissionRequestSchema.safeParse({
      options: [option("duplicate"), option("duplicate")]
    }).success).toBe(false);
  });

  it("holds a request open for a human under the ask posture", async () => {
    const { adapter, workspace } = agentFor("permission");
    const config = serviceConfig({
      settingsValues: { acpSyntheticPermissionPolicy: "ask" }
    } as Partial<ServiceConfig>);
    const runner = track(new AcpRunner(config, adapter));
    const { events, done } = stream(
      runner.run({ runId: "run-ask", sessionId: "session-ask", workspacePath: workspace, prompt: "hi" })
    );

    const requested = await waitForCanonical(events, "permission_requested");
    const requestId = requested.requestId as string;
    // Nothing is decided while the request is open: the agent is waiting on us.
    expect(canonicalOf(events, "permission_resolved")).toBeUndefined();

    // An option the agent did not offer is refused rather than forwarded, and
    // an id it never issued reaches nothing.
    expect(runner.answerPermissionRequest({ sessionId: "session-ask", requestId, optionId: "allow_always" }))
      .toBe("unknown_option");
    expect(runner.answerPermissionRequest({
      sessionId: "session-ask",
      requestId: "permission-not-mine",
      optionId: "allow-1"
    })).toBe("unknown_request");
    expect(runner.answerPermissionRequest({ sessionId: "session-ask", requestId, optionId: "allow-1" }))
      .toBe("answered");

    await done;
    expect(assistantText(events)).toContain('"optionId":"allow-1"');
    expect(canonicalOf(events, "permission_resolved")).toMatchObject({
      requestId,
      status: "selected",
      optionId: "allow-1",
      decidedBy: "human"
    });
  });

  it("falls back to the conservative answer when nobody answers in time", async () => {
    const { adapter, workspace } = agentFor("permission");
    const config = serviceConfig({
      settingsValues: { acpSyntheticPermissionPolicy: "ask" }
    } as Partial<ServiceConfig>);
    const runner = track(
      new AcpRunner(config, adapter, { ...DEFAULT_ACP_LIMITS, permissionTimeoutMs: 150 })
    );
    const events = await collect(
      runner.run({ runId: "run-wait", sessionId: "session-wait", workspacePath: workspace, prompt: "hi" })
    );

    // A turn that blocks forever on an absent operator is a worse failure than
    // a refusal — and the resolved event says the clock decided, not a person.
    expect(assistantText(events)).toContain('"optionId":"reject-1"');
    expect(canonicalOf(events, "permission_resolved")).toMatchObject({
      optionId: "reject-1",
      decidedBy: "timeout"
    });
  });

  it("does not wait or advertise an answer route when the agent offers no options", async () => {
    const { adapter, workspace } = agentFor("permission_empty");
    const config = serviceConfig({
      settingsValues: { acpSyntheticPermissionPolicy: "ask" }
    } as Partial<ServiceConfig>);
    const runner = track(
      new AcpRunner(config, adapter, { ...DEFAULT_ACP_LIMITS, permissionTimeoutMs: 30 })
    );
    const events = await collect(
      runner.run({ runId: "run-empty", sessionId: "session-empty", workspacePath: workspace, prompt: "hi" })
    );

    const requested = canonicalOf(events, "permission_requested");
    expect(requested).not.toHaveProperty("requestId");
    expect(requested).not.toHaveProperty("options");
    expect(canonicalOf(events, "permission_resolved")).toMatchObject({
      status: "cancelled",
      decidedBy: "policy"
    });
  });

  it("releases an outstanding request when its session is closed", async () => {
    // Outstanding requests are per-session state and go with it. Without the
    // release, this run would sit on the default five-minute wait.
    const { adapter, workspace } = agentFor("permission");
    const config = serviceConfig({
      settingsValues: { acpSyntheticPermissionPolicy: "ask" }
    } as Partial<ServiceConfig>);
    const runner = track(new AcpRunner(config, adapter));
    const { events, done } = stream(
      runner.run({ runId: "run-closed", sessionId: "session-closed", workspacePath: workspace, prompt: "hi" })
    );

    await waitForCanonical(events, "permission_requested");
    const closedAt = Date.now();
    await runner.closeSession("session-closed");
    await done;

    expect(Date.now() - closedAt).toBeLessThan(5_000);
    expect(events.some((event) => event.type === "run_failed")).toBe(true);
  });

  it("refuses a client capability it never advertised", async () => {
    // fs/terminal are declined at initialize; a call is a conformance breach and
    // must not become a read path into the operator's filesystem.
    const { adapter, workspace } = agentFor("fs_violation");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const events = await collect(
      runner.run({ runId: "run-6", sessionId: "session-6", workspacePath: workspace, prompt: "hi" })
    );
    expect(assistantText(events)).toContain("Method not available");
    expect(assistantText(events)).not.toContain("root:");
  });

  it("settles a cancelled turn through the protocol", async () => {
    const { adapter, workspace } = agentFor("never_answers");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    const iterator = runner.run({
      runId: "run-7",
      sessionId: "session-7",
      workspacePath: workspace,
      prompt: "hi"
    });
    const pending = collect(iterator);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await runner.cancel("run-7");
    const events = await pending;
    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toMatch(/cancelled/i);
  });

  it("resumes a conversation whose child is gone without replaying it", async () => {
    // The reap/crash path: the agent exits after the first turn, so the second
    // must restore. `session/resume` continues without replay.
    const { adapter, workspace } = agentFor("basic", ["die"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    await collect(runner.run({ runId: "run-8a", sessionId: "session-8", workspacePath: workspace, prompt: "one" }));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const events = await collect(
      runner.run({ runId: "run-8b", sessionId: "session-8", workspacePath: workspace, prompt: "two" })
    );
    // The marker is what distinguishes a resumed conversation from a quietly
    // restarted one; both would otherwise produce identical output.
    expect(assistantText(events)).toBe("RESTORED:resume Hello world");
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
  });

  it("resumes a seeded session id on the first spawn of the process", async () => {
    // The durable-session hydration path: no child has existed for this
    // session in this process, and the first turn must still restore.
    const { adapter, workspace } = agentFor("basic");
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    runner.rememberResumableId({
      sessionId: "session-seeded",
      nativeSessionId: "acp-session-from-disk",
      interrupted: false
    });

    const events = await collect(
      runner.run({ runId: "run-seeded", sessionId: "session-seeded", workspacePath: workspace, prompt: "two" })
    );
    expect(assistantText(events)).toBe("RESTORED:resume Hello world");
    expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
  });

  it("consumes a session/load replay without duplicating the transcript", async () => {
    // An agent with only `loadSession` replays history through session/update.
    // AgentRoom already holds that transcript, so the replay must emit nothing.
    const { adapter, workspace } = agentFor("load_replay", ["die"]);
    const runner = track(new AcpRunner(serviceConfig(), adapter));
    await collect(runner.run({ runId: "run-9a", sessionId: "session-9", workspacePath: workspace, prompt: "one" }));
    await new Promise((resolve) => setTimeout(resolve, 250));

    const events = await collect(
      runner.run({ runId: "run-9b", sessionId: "session-9", workspacePath: workspace, prompt: "two" })
    );
    // Restored through load — and the replayed message and tool call the agent
    // pushed during it reached no event.
    expect(assistantText(events)).toBe("RESTORED:load Hello world");
    expect(assistantText(events)).not.toContain("REPLAYED");
    // The replayed tool call reached no event either: only this turn's own.
    expect(canonicalKinds(events)).toEqual([
      "session_started",
      "reasoning",
      "tool_started",
      "tool_output",
      "tool_completed",
      "plan_updated"
    ]);
  });

  it("kills an agent that breaches the frame limit", async () => {
    const { adapter, workspace } = agentFor("oversized_frame");
    const runner = track(new AcpRunner(serviceConfig(), adapter, { ...DEFAULT_ACP_LIMITS, turnTimeoutMs: 8_000 }));
    const events = await collect(
      runner.run({ runId: "run-10", sessionId: "session-10", workspacePath: workspace, prompt: "hi" })
    );
    const failure = events.find(
      (event): event is AgentRunnerEvent & { type: "run_failed" } => event.type === "run_failed"
    );
    expect(failure?.error).toMatch(/maximum frame size/);
  });
});
