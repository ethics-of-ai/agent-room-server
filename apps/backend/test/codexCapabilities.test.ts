import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import { capabilitiesFromModelList, fallbackCapabilities } from "../src/runner/codex/capabilities";

const efforts = (...ids: string[]) => ids.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));

describe("Codex model list mapping", () => {
  it("offers the effort levels Codex names, including ones newer than the shared enum", () => {
    // Codex 0.158 reports `max` and `ultra` beside the older levels.
    const capabilities = capabilitiesFromModelList(
      {
        data: [
          {
            model: "gpt-6-astra",
            displayName: "GPT-6-Astra",
            isDefault: true,
            supportedReasoningEfforts: efforts("low", "xhigh", "max", "ultra", "not an id"),
            defaultReasoningEffort: "max"
          }
        ]
      },
      {} as ServiceConfig
    );

    const model = capabilities.settings.models[0];
    expect(model.reasoningEfforts.map((effort) => effort.id)).toEqual(["low", "xhigh", "max", "ultra"]);
    expect(model.defaultReasoningEffort).toBe("max");
    expect(capabilities.settings.defaultSettings).toMatchObject({ model: "gpt-6-astra", reasoningEffort: "max" });
  });

  it("falls back to the model catalog's Codex list through the same mapping", () => {
    const capabilities = fallbackCapabilities({} as ServiceConfig);
    const [first] = capabilities.settings.models;

    expect(first).toMatchObject({ id: "gpt-6-astra", isDefault: true, defaultReasoningEffort: "medium", defaultServiceTier: "standard" });
    expect(first.reasoningEfforts.map((effort) => effort.id)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(first.serviceTiers.map((tier) => tier.id)).toEqual(["standard", "fast"]);
    expect(capabilities.settings.defaultSettings).toEqual({ model: "gpt-6-astra", reasoningEffort: "medium", serviceTier: "standard" });
  });

  it("keeps an operator's Codex model as the fallback default", () => {
    const capabilities = fallbackCapabilities({ codexModel: "gpt-6-sol", codexReasoningEffort: "high" } as ServiceConfig);

    expect(capabilities.settings.defaultSettings).toMatchObject({ model: "gpt-6-sol", reasoningEffort: "high" });
  });
});
