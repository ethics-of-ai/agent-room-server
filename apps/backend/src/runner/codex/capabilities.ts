import type {
  CodingAgentCapabilities,
  CodingAgentModelOption,
  CodingAgentReasoningEffort,
  CodingAgentSettingValue,
  ServiceConfig
} from "../../domain/models";
import {
  arrayValue,
  booleanValue,
  labelFromIdentifier,
  objectValue,
  positiveIntegerValue,
  stringValue
} from "../shared/jsonValues";
import { codexDisplayServiceTier } from "./settings";

const standardSpeedTier: CodingAgentSettingValue = {
  id: "standard",
  label: "Standard",
  description: "Standard Codex speed"
};

export function fallbackCapabilities(config: ServiceConfig): CodingAgentCapabilities {
  const serviceTier = codexDisplayServiceTier(config.codexServiceTier);
  return {
    runnerKind: "codex",
    settings: {
      models: [],
      defaultSettings: {
        ...(config.codexModel ? { model: config.codexModel } : {}),
        ...(config.codexReasoningEffort ? { reasoningEffort: config.codexReasoningEffort } : {}),
        ...(serviceTier ? { serviceTier } : {})
      }
    }
  };
}

export function capabilitiesFromModelList(response: unknown, config: ServiceConfig): CodingAgentCapabilities {
  const data = arrayValue(objectValue(response)?.data);
  const models = data.flatMap((value) => {
    const model = modelOptionFromValue(value);
    return model ? [model] : [];
  });
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const selectedModel = config.codexModel
    ? models.find((model) => model.id === config.codexModel) ?? defaultModel
    : defaultModel;
  const model = config.codexModel ?? selectedModel?.id;
  const reasoningEffort = config.codexReasoningEffort ?? selectedModel?.defaultReasoningEffort;
  const serviceTier = codexDisplayServiceTier(config.codexServiceTier) ?? selectedModel?.defaultServiceTier;
  return {
    runnerKind: "codex",
    settings: {
      models,
      defaultSettings: {
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(serviceTier ? { serviceTier } : {})
      }
    }
  };
}

function modelOptionFromValue(value: unknown): CodingAgentModelOption | undefined {
  const object = objectValue(value);
  if (!object || booleanValue(object.hidden)) return undefined;

  const id = stringValue(object.model) ?? stringValue(object.id);
  if (!id) return undefined;

  const reasoningEfforts = arrayValue(object.supportedReasoningEfforts).flatMap((effort) => {
    const mapped = reasoningEffortValueFromValue(effort);
    return mapped ? [mapped] : [];
  });
  const discoveredServiceTiers = uniqueSettingValues([
    ...arrayValue(object.serviceTiers).flatMap((tier) => {
      const mapped = serviceTierValueFromValue(tier);
      return mapped ? [mapped] : [];
    }),
    ...arrayValue(object.additionalSpeedTiers).flatMap((tier) => {
      const mapped = serviceTierValueFromValue(tier);
      return mapped ? [mapped] : [];
    })
  ]);
  const serviceTiers = codexSpeedTiers(discoveredServiceTiers);
  const defaultReasoningEffort = reasoningEffortValue(object.defaultReasoningEffort);
  const defaultServiceTier = standardSpeedTier.id;
  const contextWindowTokens = contextWindowTokensFromValue(object);

  return {
    id,
    label: stringValue(object.displayName) ?? id,
    ...(stringValue(object.description) ? { description: stringValue(object.description) } : {}),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    isDefault: booleanValue(object.isDefault) ?? false,
    reasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    serviceTiers,
    ...(defaultServiceTier ? { defaultServiceTier } : {})
  };
}

function contextWindowTokensFromValue(object: Record<string, unknown>): number | undefined {
  return positiveIntegerValueFromFields(object, [
    "contextWindowTokens",
    "context_window_tokens",
    "contextWindow",
    "context_window",
    "contextLength",
    "context_length",
    "maxContextTokens",
    "max_context_tokens",
    "maxInputTokens",
    "max_input_tokens",
    "inputTokenLimit",
    "input_token_limit"
  ]);
}

function positiveIntegerValueFromFields(object: Record<string, unknown>, fields: string[]): number | undefined {
  for (const field of fields) {
    const value = positiveIntegerValue(object[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function reasoningEffortValueFromValue(value: unknown): CodingAgentSettingValue | undefined {
  const object = objectValue(value);
  const id = reasoningEffortValue(object?.reasoningEffort);
  if (!id) return undefined;
  return {
    id,
    label: labelFromIdentifier(id),
    ...(stringValue(object?.description) ? { description: stringValue(object?.description) } : {})
  };
}

function serviceTierValueFromValue(value: unknown): CodingAgentSettingValue | undefined {
  const object = objectValue(value);
  const id = stringValue(object?.id) ?? stringValue(value);
  if (!id) return undefined;
  return {
    id,
    label: stringValue(object?.name) ?? labelFromIdentifier(id),
    ...(stringValue(object?.description) ? { description: stringValue(object?.description) } : {})
  };
}

function codexSpeedTiers(values: CodingAgentSettingValue[]): CodingAgentSettingValue[] {
  const fast = fastSpeedTier(values);
  return fast ? [standardSpeedTier, fast] : [standardSpeedTier];
}

function fastSpeedTier(values: CodingAgentSettingValue[]): CodingAgentSettingValue | undefined {
  const value = values.find((candidate) =>
    codexDisplayServiceTier(candidate.id) === "fast" ||
    candidate.label.trim().toLowerCase() === "fast"
  );
  if (!value) return undefined;
  return {
    id: "fast",
    label: "Fast",
    ...(value.description ? { description: value.description } : {})
  };
}

function uniqueSettingValues(values: CodingAgentSettingValue[]): CodingAgentSettingValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

function reasoningEffortValue(value: unknown): CodingAgentReasoningEffort | undefined {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return undefined;
}
