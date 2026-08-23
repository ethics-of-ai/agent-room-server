import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import { codingAgentTurnSettingsSchema } from "../src/domain/schemas";
import { capabilitiesFromSupportedModels, fallbackClaudeCodeCapabilities } from "../src/runner/claudeCode/capabilities";
import {
  claudeCodeChildEnv,
  claudeCodeEffort,
  claudeCodeQueryOptions,
  effectiveClaudeCodeSettings
} from "../src/runner/claudeCode/settings";
import { DIAGRAM_PROMPT_INSTRUCTION } from "../src/scene/diagram/prompt";

const config = (overrides: Partial<ServiceConfig> = {}): ServiceConfig => ({
  runnerKind: "claude_code",
  host: "0.0.0.0",
  port: 8787,
  workspaceRoot: "/tmp/workspaces",
  stateDir: "/tmp/state",
  requireAuth: false,
  gitCommandTimeoutMs: 30_000,
  codexArgs: [],
  ...overrides
});

describe("claude code settings", () => {
  it("maps AgentRoom reasoning efforts onto SDK effort levels", () => {
    expect(claudeCodeEffort(undefined)).toBeUndefined();
    expect(claudeCodeEffort("none")).toBe("low");
    expect(claudeCodeEffort("minimal")).toBe("low");
    expect(claudeCodeEffort("low")).toBe("low");
    expect(claudeCodeEffort("medium")).toBe("medium");
    expect(claudeCodeEffort("high")).toBe("high");
    expect(claudeCodeEffort("xhigh")).toBe("xhigh");
    expect(() => claudeCodeEffort("ultra")).toThrow(
      'Claude Code does not offer the reasoning effort "ultra"'
    );
  });

  it("refuses an open turn effort outside Claude Code's vocabulary", () => {
    const parsed = codingAgentTurnSettingsSchema.parse({ reasoningEffort: "ultra" });

    expect(() => effectiveClaudeCodeSettings(config(), parsed)).toThrow(
      'Claude Code does not offer the reasoning effort "ultra"'
    );
  });

  it("prefers turn settings over config defaults", () => {
    const settings = effectiveClaudeCodeSettings(
      config({ claudeCodeModel: "claude-fable-5", claudeCodeReasoningEffort: "high" }),
      { model: "claude-sonnet-4-6", reasoningEffort: "minimal" }
    );

    expect(settings).toEqual({ model: "claude-sonnet-4-6", effort: "low" });
  });

  it("scrubs provider credentials from the child environment by default", () => {
    const previousValues = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN
    };
    process.env.ANTHROPIC_API_KEY = "secret-api-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "secret-auth-token";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "secret-oauth-token";
    try {
      const scrubbed = claudeCodeChildEnv(config());
      expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
      expect(scrubbed.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(scrubbed.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(scrubbed.PATH).toBe(process.env.PATH);

      const inherited = claudeCodeChildEnv(config({ claudeCodeInheritProviderAuth: true }));
      expect(inherited.ANTHROPIC_API_KEY).toBe("secret-api-key");
      expect(inherited.CLAUDE_CODE_OAUTH_TOKEN).toBe("secret-oauth-token");
    } finally {
      for (const [name, value] of Object.entries(previousValues)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it("scrubs AgentRoom's own bearer token from the child environment in both auth postures", () => {
    // AUTH_TOKEN is AgentRoom's transport secret, not a provider credential, so
    // the inherit-provider-auth opt-in must not carry it into a CLI that runs
    // shell tools under bypassPermissions. Mirrors the terminal PTY scrub.
    const previousValues = { AUTH_TOKEN: process.env.AUTH_TOKEN };
    process.env.AUTH_TOKEN = "agentroom-not-a-real-bearer";
    try {
      expect(claudeCodeChildEnv(config()).AUTH_TOKEN).toBeUndefined();
      expect(claudeCodeChildEnv(config({ claudeCodeInheritProviderAuth: true })).AUTH_TOKEN).toBeUndefined();
    } finally {
      for (const [name, value] of Object.entries(previousValues)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it("builds bypassPermissions query options that load workspace skills by default", () => {
    // No claudeCodeLoadWorkspaceSkills override, so this exercises the runner's
    // documented default (the `?? true` fallback), not a hardcoded input.
    const options = claudeCodeQueryOptions(
      config({ claudeCodeExecutable: "/usr/local/bin/claude" }),
      "/tmp/workspaces/demo",
      { model: "claude-fable-5", effort: "high" }
    );

    expect(options).toMatchObject({
      cwd: "/tmp/workspaces/demo",
      includePartialMessages: true,
      settingSources: ["project"],
      skills: "all",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: DIAGRAM_PROMPT_INSTRUCTION
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: "claude-fable-5",
      effort: "high",
      pathToClaudeCodeExecutable: "/usr/local/bin/claude"
    });
  });

  it("keeps the configured executable on the isolated capability-discovery probe", () => {
    // Discovery is what populates the client model picker, and the spawned CLI
    // owns that catalog: without pathToClaudeCodeExecutable the SDK falls back to
    // the CLI it bundles, whose pinned version can advertise a stale model list.
    const options = claudeCodeQueryOptions(
      config({ claudeCodeExecutable: "/usr/local/bin/claude" }),
      "/tmp/backend-cwd",
      {},
      { forceIsolation: true }
    );

    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBeUndefined();
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("omits the diagram contract when the scene engine is disabled", () => {
    const options = claudeCodeQueryOptions(
      config({ sceneEngineEnabled: false }),
      "/tmp/workspaces/demo",
      {}
    );

    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("falls back to full SDK settings isolation when workspace skills are disabled", () => {
    const options = claudeCodeQueryOptions(
      config({ claudeCodeLoadWorkspaceSkills: false }),
      "/tmp/workspaces/demo",
      {}
    );

    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBeUndefined();
  });

  it("forces isolation for stricter permission modes even when workspace skills are enabled", () => {
    // A workspace's project settings (permissions.allow, hooks) must not be able
    // to widen a stricter configured mode, so settings loading is gated to
    // bypassPermissions regardless of the load-workspace-skills flag.
    const options = claudeCodeQueryOptions(
      config({ claudeCodePermissionMode: "acceptEdits", claudeCodeLoadWorkspaceSkills: true }),
      "/tmp/workspaces/demo",
      {}
    );

    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBeUndefined();
  });

  it("forces isolation for the discovery probe even at the default posture", () => {
    // Capability discovery runs in the backend cwd, never a registered
    // workspace, so it must never load or execute that directory's project
    // settings just to read the model list.
    const options = claudeCodeQueryOptions(
      config({ claudeCodeLoadWorkspaceSkills: true }),
      "/tmp/backend-cwd",
      {},
      { forceIsolation: true }
    );

    expect(options.settingSources).toEqual([]);
    expect(options.skills).toBeUndefined();
  });

  it("does not dangerously skip permissions for stricter configured modes", () => {
    const options = claudeCodeQueryOptions(
      config({ claudeCodePermissionMode: "acceptEdits" }),
      "/tmp/workspaces/demo",
      {}
    );

    expect(options.permissionMode).toBe("acceptEdits");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
  });
});

describe("claude code capabilities", () => {
  it("returns the hardcoded fallback catalog when discovery is unavailable", () => {
    const capabilities = fallbackClaudeCodeCapabilities(config({ claudeCodeModel: "claude-sonnet-5" }));

    expect(capabilities.runnerKind).toBe("claude_code");
    expect(capabilities.settings.models.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5"
    ]);
    expect(capabilities.settings.models.find((model) => model.isDefault)?.id).toBe("claude-sonnet-5");
    expect(capabilities.settings.models[0].serviceTiers).toEqual([]);
    expect(capabilities.settings.defaultSettings).toEqual({
      model: "claude-sonnet-5",
      reasoningEffort: "high"
    });
  });

  it("advertises no effort levels for a fallback model that does not accept them", () => {
    const capabilities = fallbackClaudeCodeCapabilities(config({ claudeCodeModel: "claude-haiku-4-5" }));
    const haiku = capabilities.settings.models.find((model) => model.id === "claude-haiku-4-5");

    // Haiku takes no effort level; advertising one would both break the client
    // picker and send an unsupported effortLevel to the SDK.
    expect(haiku?.reasoningEfforts).toEqual([]);
    expect(haiku?.defaultReasoningEffort).toBeUndefined();
    expect(capabilities.settings.defaultSettings).toEqual({ model: "claude-haiku-4-5" });
  });

  it("maps SDK supportedModels output into the AgentRoom capabilities shape", () => {
    const capabilities = capabilitiesFromSupportedModels(
      [
        {
          value: "claude-fable-5",
          displayName: "Fable 5",
          description: "Most intelligent model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"]
        },
        {
          value: "claude-haiku-4-5",
          displayName: "Haiku 4.5",
          description: "Fastest model",
          supportsEffort: false
        }
      ],
      config()
    );

    expect(capabilities).toEqual({
      runnerKind: "claude_code",
      settings: {
        models: [
          {
            id: "claude-fable-5",
            label: "Fable 5",
            description: "Most intelligent model",
            isDefault: true,
            reasoningEfforts: [
              { id: "low", label: "Low", description: "Minimal thinking, fastest responses" },
              { id: "medium", label: "Medium", description: "Moderate thinking" },
              { id: "high", label: "High", description: "Deep reasoning" },
              { id: "xhigh", label: "Xhigh", description: "Deeper than high on supported models" }
            ],
            defaultReasoningEffort: "high",
            serviceTiers: []
          },
          {
            id: "claude-haiku-4-5",
            label: "Haiku 4.5",
            description: "Fastest model",
            isDefault: false,
            reasoningEfforts: [],
            serviceTiers: []
          }
        ],
        defaultSettings: {
          model: "claude-fable-5",
          reasoningEffort: "high"
        }
      }
    });
  });

  it("falls back to the catalog when discovery returns no models", () => {
    const capabilities = capabilitiesFromSupportedModels([], config());
    expect(capabilities.settings.models.length).toBeGreaterThan(0);
    expect(capabilities.settings.models[0].id).toBe("claude-opus-5");
  });

  it("keeps default reasoning efforts inside the model's discovered effort list", () => {
    const capabilities = capabilitiesFromSupportedModels(
      [
        {
          value: "claude-limited",
          displayName: "Limited",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium"]
        }
      ],
      config()
    );

    expect(capabilities.settings.models[0].defaultReasoningEffort).toBe("medium");
    expect(capabilities.settings.defaultSettings).toEqual({
      model: "claude-limited",
      reasoningEffort: "medium"
    });
  });

  it("omits the default reasoning effort when the default model exposes none", () => {
    const capabilities = capabilitiesFromSupportedModels(
      [{ value: "claude-basic", displayName: "Basic", supportsEffort: false }],
      config()
    );

    expect(capabilities.settings.defaultSettings).toEqual({ model: "claude-basic" });
  });

  // Discovery and turn validation must agree on what a model id may look like:
  // a client can only send back an id capability discovery advertised, so any id
  // the CLI exposes has to survive codingAgentTurnSettingsSchema. The CLI's
  // context-window variants carry square brackets, which the allowlist once
  // rejected — sessions using them failed with "Invalid agent session payload"
  // while unsuffixed aliases worked.
  it("accepts every discovered model id as turn settings", () => {
    const discovered = [
      { value: "default", displayName: "Default (recommended)" },
      { value: "opus[1m]", displayName: "Opus (1M context)" },
      { value: "claude-fable-5[1m]", displayName: "Fable" },
      { value: "sonnet", displayName: "Sonnet" },
      { value: "sonnet[1m]", displayName: "Sonnet (1M context)" },
      { value: "haiku", displayName: "Haiku" }
    ];
    const capabilities = capabilitiesFromSupportedModels(discovered, config());

    for (const model of capabilities.settings.models) {
      expect(
        codingAgentTurnSettingsSchema.safeParse({ model: model.id }).success,
        `model id ${model.id} must be valid turn settings`
      ).toBe(true);
    }
  });

  it("still rejects model ids outside the allowlist", () => {
    // The allowlist is defense in depth around a value forwarded to a runner;
    // widening it for brackets must not turn it into "anything goes".
    for (const model of ["opus 1m", "opus;rm -rf /", "opus$(id)", "opus`id`", "opus|tee", ""]) {
      expect(
        codingAgentTurnSettingsSchema.safeParse({ model }).success,
        `model id ${JSON.stringify(model)} must be rejected`
      ).toBe(false);
    }
  });
});
