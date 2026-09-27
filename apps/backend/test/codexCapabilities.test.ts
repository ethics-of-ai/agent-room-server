import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import { capabilitiesFromModelList } from "../src/runner/codex/capabilities";

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
});
