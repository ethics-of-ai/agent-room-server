import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import {
  cursorCapabilities,
  cursorCatalogFromModels,
  fallbackCursorCatalog,
  type CursorModelCatalog
} from "../src/runner/cursor/capabilities";
import {
  cursorAgentStartPosture,
  cursorCommandAudit,
  cursorHostEnv,
  cursorModelSelection,
  cursorPosture,
  effectiveCursorSettings,
  loadsCursorWorkspaceSettings
} from "../src/runner/cursor/settings";

const config = (overrides: Partial<ServiceConfig> = {}): ServiceConfig =>
  ({
    runnerKind: "cursor",
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

/** A live-shaped catalog: one model per depth parameter, one with speed only, one with nothing. */
const liveCatalog = (): CursorModelCatalog => {
  const catalog = cursorCatalogFromModels([
    { id: "default", displayName: "Auto", parameters: [], variants: [{ isDefault: true, params: [] }] },
    {
      id: "composer-2.5",
      displayName: "Composer 2.5",
      parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      variants: [{ isDefault: true, params: [{ id: "fast", value: "true" }] }]
    },
    {
      id: "claude-opus-5",
      displayName: "Claude Opus 5",
      parameters: [
        { id: "effort", values: [{ value: "low" }, { value: "high" }, { value: "max" }] },
        { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        { id: "context", values: [{ value: "300k" }, { value: "1m" }] },
        { id: "thinking", values: [{ value: "true" }] }
      ],
      variants: [{
        isDefault: true,
        params: [{ id: "effort", value: "high" }, { id: "fast", value: "false" }, { id: "context", value: "1m" }]
      }]
    },
    {
      id: "gpt-5.3-codex",
      displayName: "Codex 5.3",
      parameters: [{ id: "reasoning", values: [{ value: "low" }, { value: "extra-high" }] }],
      variants: [{ isDefault: true, params: [{ id: "reasoning", value: "low" }] }]
    }
  ]);
  if (!catalog) throw new Error("fixture catalog did not parse");
  return catalog;
};

describe("Cursor effective settings", () => {
  it("defaults sandbox on, auto-review off, and workspace settings on", () => {
    const settings = effectiveCursorSettings(config(), undefined);
    expect(settings.sandbox).toBe(true);
    expect(settings.autoReview).toBe(false);
    expect(settings.loadWorkspaceSettings).toBe(true);
    // With nothing configured the catalog's own default model is selected and
    // no depth or speed is named, so the model runs its own default variant.
    expect(settings.modelId).toBe("default");
    expect(settings.reasoningEffort).toBeUndefined();
    expect(settings.serviceTier).toBeUndefined();
  });

  it("honors a turn's model over the operator's configured default", () => {
    const configured = effectiveCursorSettings(config({ cursorModel: "composer-2.5" }), undefined);
    expect(configured.modelId).toBe("composer-2.5");
    const turned = effectiveCursorSettings(config({ cursorModel: "composer-2.5" }), { model: "claude-opus-5" });
    expect(turned.modelId).toBe("claude-opus-5");
  });

  it("records where a turn's effort and speed came from", () => {
    const fromConfig = effectiveCursorSettings(
      config({ cursorReasoningEffort: "high", cursorServiceTier: "fast" }),
      undefined
    );
    expect(fromConfig.reasoningEffort).toEqual({ value: "high", source: "config" });
    expect(fromConfig.serviceTier).toEqual({ value: "fast", source: "config" });

    const fromTurn = effectiveCursorSettings(
      config({ cursorReasoningEffort: "high", cursorServiceTier: "fast" }),
      { reasoningEffort: "low", serviceTier: "standard" }
    );
    expect(fromTurn.reasoningEffort).toEqual({ value: "low", source: "turn" });
    expect(fromTurn.serviceTier).toEqual({ value: "standard", source: "turn" });
  });

  it("carries operator posture overrides", () => {
    const settings = effectiveCursorSettings(
      config({ cursorSandbox: false, cursorAutoReview: true, cursorLoadWorkspaceSettings: false }),
      undefined
    );
    expect(settings.sandbox).toBe(false);
    expect(settings.autoReview).toBe(true);
    expect(settings.loadWorkspaceSettings).toBe(false);
    expect(loadsCursorWorkspaceSettings(config({ cursorLoadWorkspaceSettings: false }))).toBe(false);
  });
});

describe("Cursor model selection", () => {
  it("sends the depth value on whichever parameter the model declares", () => {
    const catalog = liveCatalog();
    expect(
      cursorModelSelection(catalog, effectiveCursorSettings(config(), { model: "claude-opus-5", reasoningEffort: "max" }, catalog))
    ).toEqual({ id: "claude-opus-5", params: [{ id: "effort", value: "max" }] });
    expect(
      cursorModelSelection(
        catalog,
        effectiveCursorSettings(config(), { model: "gpt-5.3-codex", reasoningEffort: "extra-high" }, catalog)
      )
    ).toEqual({ id: "gpt-5.3-codex", params: [{ id: "reasoning", value: "extra-high" }] });
  });

  it("sends speed as the boolean fast parameter, both ways", () => {
    const catalog = liveCatalog();
    expect(
      cursorModelSelection(catalog, effectiveCursorSettings(config(), { model: "composer-2.5", serviceTier: "standard" }, catalog))
    ).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(
      cursorModelSelection(
        catalog,
        effectiveCursorSettings(config(), { model: "claude-opus-5", reasoningEffort: "low", serviceTier: "fast" }, catalog)
      )
    ).toEqual({ id: "claude-opus-5", params: [{ id: "effort", value: "low" }, { id: "fast", value: "true" }] });
  });

  it("sends no params when nothing is selected, so the model runs its default variant", () => {
    const catalog = liveCatalog();
    expect(cursorModelSelection(catalog, effectiveCursorSettings(config(), { model: "claude-opus-5" }, catalog))).toEqual({
      id: "claude-opus-5"
    });
  });

  it("refuses a turn's selection the model does not offer", () => {
    const catalog = liveCatalog();
    expect(() =>
      cursorModelSelection(catalog, effectiveCursorSettings(config(), { model: "composer-2.5", reasoningEffort: "high" }, catalog))
    ).toThrow('Cursor model "composer-2.5" does not offer the reasoning effort "high"');
    expect(() =>
      cursorModelSelection(catalog, effectiveCursorSettings(config(), { model: "gpt-5.3-codex", serviceTier: "fast" }, catalog))
    ).toThrow('Cursor model "gpt-5.3-codex" does not offer the speed "fast"');
    // A value outside the model's own list is refused even on a model with depth.
    expect(() =>
      cursorModelSelection(catalog, effectiveCursorSettings(config(), { model: "claude-opus-5", reasoningEffort: "extra-high" }, catalog))
    ).toThrow(/does not offer the reasoning effort/);
    // A model the catalog has never heard of offers nothing.
    expect(() =>
      cursorModelSelection(catalog, effectiveCursorSettings(config(), { model: "mystery-1", reasoningEffort: "high" }, catalog))
    ).toThrow(/mystery-1/);
  });

  it("applies the operator's default only to a model that offers it", () => {
    const catalog = liveCatalog();
    const serviceConfig = config({ cursorReasoningEffort: "high", cursorServiceTier: "fast" });
    // Claude Opus 5 offers both.
    expect(cursorModelSelection(catalog, effectiveCursorSettings(serviceConfig, { model: "claude-opus-5" }, catalog))).toEqual({
      id: "claude-opus-5",
      params: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }]
    });
    // Composer offers speed but no depth: the effort default is skipped, not refused.
    expect(cursorModelSelection(catalog, effectiveCursorSettings(serviceConfig, { model: "composer-2.5" }, catalog))).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }]
    });
    // Auto offers neither, and the operator's default model must still run.
    expect(cursorModelSelection(catalog, effectiveCursorSettings(serviceConfig, undefined, catalog))).toEqual({ id: "default" });
    // The configured effort names a value this model's own list lacks.
    expect(
      cursorModelSelection(catalog, effectiveCursorSettings(config({ cursorReasoningEffort: "max" }), { model: "gpt-5.3-codex" }, catalog))
    ).toEqual({ id: "gpt-5.3-codex" });
  });

  it("maps against the fallback catalog until a live one arrives", () => {
    expect(
      cursorModelSelection(
        fallbackCursorCatalog,
        effectiveCursorSettings(config(), { model: "gpt-5.6-sol", reasoningEffort: "xhigh", serviceTier: "standard" })
      )
    ).toEqual({ id: "gpt-5.6-sol", params: [{ id: "reasoning", value: "xhigh" }, { id: "fast", value: "false" }] });
  });
});

describe("Cursor capability descriptor", () => {
  it("projects the catalog's parameters and defaults onto the shared shape", () => {
    const capabilities = cursorCapabilities(liveCatalog(), config());
    const opus = capabilities.settings.models.find((model) => model.id === "claude-opus-5");
    expect(opus).toMatchObject({
      label: "Claude Opus 5",
      reasoningEfforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
        { id: "max", label: "Max" }
      ],
      defaultReasoningEffort: "high",
      defaultServiceTier: "standard",
      contextWindowTokens: 1_000_000
    });
    expect(opus?.serviceTiers.map((tier) => tier.id)).toEqual(["standard", "fast"]);
    const composer = capabilities.settings.models.find((model) => model.id === "composer-2.5");
    expect(composer).toMatchObject({ reasoningEfforts: [], defaultServiceTier: "fast" });
    const auto = capabilities.settings.models.find((model) => model.id === "default");
    expect(auto).toMatchObject({ isDefault: true, reasoningEfforts: [], serviceTiers: [] });
    expect(auto?.contextWindowTokens).toBeUndefined();
    expect(capabilities.settings.defaultSettings).toEqual({ model: "default" });
  });

  it("ignores malformed default context values", () => {
    const catalog = cursorCatalogFromModels([{
      id: "model-with-bad-context",
      parameters: [{ id: "context", values: [{ value: "lots" }] }],
      variants: [{ isDefault: true, params: [{ id: "context", value: "lots" }] }]
    }]);
    if (!catalog) throw new Error("fixture catalog did not parse");

    expect(cursorCapabilities(catalog, config()).settings.models[0]?.contextWindowTokens).toBeUndefined();
  });

  it("makes the configured model the default and appends one the catalog lacks", () => {
    const configured = cursorCapabilities(liveCatalog(), config({ cursorModel: "claude-opus-5" }));
    expect(configured.settings.defaultSettings).toEqual({ model: "claude-opus-5", reasoningEffort: "high", serviceTier: "standard" });
    expect(configured.settings.models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["claude-opus-5"]);

    const unknown = cursorCapabilities(liveCatalog(), config({ cursorModel: "mystery-1" }));
    expect(unknown.settings.models.at(-1)).toEqual({
      id: "mystery-1",
      label: "mystery-1",
      isDefault: true,
      reasoningEfforts: [],
      serviceTiers: []
    });
  });

  it("returns no catalog for an unusable reply rather than an empty live one", () => {
    expect(cursorCatalogFromModels([])).toBeUndefined();
    expect(cursorCatalogFromModels([{ displayName: "no id" }])).toBeUndefined();
    expect(cursorCatalogFromModels("nonsense")).toBeUndefined();
  });
});

describe("Cursor agent-start posture", () => {
  it("always disallows askQuestion and registers the question tool only when enabled", () => {
    const settings = effectiveCursorSettings(config(), undefined);
    const model = cursorModelSelection(fallbackCursorCatalog, settings);
    const on = cursorAgentStartPosture(config(), settings, model);
    expect(on.model).toEqual({ id: "default" });
    expect(on.disallowedTools).toEqual(["askQuestion"]);
    expect(on.questionTool).toBe(true);
    expect(on.settingSources).toEqual(["project"]);

    const off = cursorAgentStartPosture(config({ clarifyingQuestionsEnabled: false }), settings, model);
    expect(off.questionTool).toBe(false);
    // Belt-and-braces: the built-in tool stays disallowed even with the channel off.
    expect(off.disallowedTools).toEqual(["askQuestion"]);
  });

  it("forces settingSources empty when workspace settings are off", () => {
    const serviceConfig = config({ cursorLoadWorkspaceSettings: false });
    const settings = effectiveCursorSettings(serviceConfig, undefined);
    const model = cursorModelSelection(fallbackCursorCatalog, settings);
    expect(cursorAgentStartPosture(serviceConfig, settings, model).settingSources).toEqual([]);
  });

  it("labels the sandbox posture for RunnerMetadata", () => {
    expect(cursorPosture(effectiveCursorSettings(config(), undefined))).toEqual({ label: "sandbox", value: "sandboxed" });
    expect(cursorPosture(effectiveCursorSettings(config({ cursorSandbox: false }), undefined))).toEqual({
      label: "sandbox",
      value: "unsandboxed"
    });
  });
});

describe("Cursor host environment", () => {
  it("scrubs AUTH_TOKEN and sets CURSOR_API_KEY only when configured", () => {
    const original = process.env.AUTH_TOKEN;
    process.env.AUTH_TOKEN = "transport-secret";
    try {
      const withoutKey = cursorHostEnv(config());
      expect(withoutKey.AUTH_TOKEN).toBeUndefined();
      expect(withoutKey.CURSOR_API_KEY).toBeUndefined();

      const withKey = cursorHostEnv(config({ cursorApiKey: "cursor-key", cursorBackendUrl: "https://backend.example" }));
      expect(withKey.AUTH_TOKEN).toBeUndefined();
      expect(withKey.CURSOR_API_KEY).toBe("cursor-key");
      expect(withKey.CURSOR_BACKEND_URL).toBe("https://backend.example");
    } finally {
      if (original === undefined) delete process.env.AUTH_TOKEN;
      else process.env.AUTH_TOKEN = original;
    }
  });

  it("audits the host runtime and never a credential or workspace path", () => {
    const audit = cursorCommandAudit();
    expect(audit.argsCount).toBe(1);
    expect(JSON.stringify(audit)).not.toContain("cursor-key");
    expect(JSON.stringify(audit)).not.toContain("/tmp/workspaces");
  });
});
