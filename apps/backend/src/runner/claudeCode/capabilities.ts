import type {
  CodingAgentCapabilities,
  CodingAgentModelOption,
  CodingAgentReasoningEffort,
  CodingAgentSettingValue,
  ServiceConfig
} from "../../domain/models";
import { currentModelCatalog } from "../modelCatalog";
import { arrayValue, booleanValue, objectValue, stringValue } from "../shared/jsonValues";

function claudeCodeEffortValues(): CodingAgentSettingValue[] {
  return currentModelCatalog().runners.claude_code.reasoningEfforts;
}

// Offline fallback only: the primary path is live discovery through the SDK
// supportedModels() control request, which reflects whatever `claude` CLI the
// runner spawns. The list lives in the model catalog; keep it aligned with
// current Claude model aliases when it drifts. A model with an empty effort
// list (Haiku) does not accept an effort level; advertising one would send an
// unsupported effortLevel to the SDK.
function fallbackClaudeCodeModels(): CodingAgentModelOption[] {
  const vocabulary = claudeCodeEffortValues();
  return currentModelCatalog().runners.claude_code.fallbackModels.map((model) => {
    const efforts = model.reasoningEfforts === undefined ? undefined : new Set<string>(model.reasoningEfforts);
    return fallbackModel(
      model.id,
      model.label,
      model.description,
      efforts ? vocabulary.filter((effort) => efforts.has(effort.id)) : vocabulary
    );
  });
}

export function fallbackClaudeCodeCapabilities(config: ServiceConfig): CodingAgentCapabilities {
  const fallback = fallbackClaudeCodeModels();
  const models = fallback.map((model) => ({
    ...model,
    isDefault: model.id === (config.claudeCodeModel ?? fallback[0].id)
  }));
  return {
    runnerKind: "claude_code",
    settings: {
      models,
      defaultSettings: defaultClaudeCodeSettings(config, models)
    }
  };
}

export function capabilitiesFromSupportedModels(response: unknown, config: ServiceConfig): CodingAgentCapabilities {
  const models = arrayValue(response).flatMap((value) => {
    const model = modelOptionFromValue(value);
    return model ? [model] : [];
  });
  if (models.length === 0) {
    return fallbackClaudeCodeCapabilities(config);
  }
  const defaultModelId = config.claudeCodeModel ?? models[0].id;
  const resolved = models.map((model) => ({ ...model, isDefault: model.id === defaultModelId }));
  return {
    runnerKind: "claude_code",
    settings: {
      models: resolved,
      defaultSettings: defaultClaudeCodeSettings(config, resolved)
    }
  };
}

function defaultClaudeCodeSettings(
  config: ServiceConfig,
  models: CodingAgentModelOption[]
): { model?: string; reasoningEffort?: CodingAgentReasoningEffort } {
  const model = config.claudeCodeModel ?? models.find((candidate) => candidate.isDefault)?.id ?? models[0]?.id;
  const modelOption = models.find((candidate) => candidate.id === model) ?? models[0];
  const reasoningEffort = supportedDefaultEffort(
    modelOption?.reasoningEfforts ?? [],
    config.claudeCodeReasoningEffort
  );
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

// Defaults must come from the model's own effort list: advertising "high" for
// a model that only supports lower efforts breaks client pickers and sends an
// unsupported effortLevel to the SDK.
function supportedDefaultEffort(
  efforts: CodingAgentSettingValue[],
  preferred?: CodingAgentReasoningEffort
): CodingAgentReasoningEffort | undefined {
  if (efforts.length === 0) return undefined;
  const candidate = preferred ?? "high";
  if (efforts.some((effort) => effort.id === candidate)) return candidate;
  return efforts[efforts.length - 1].id as CodingAgentReasoningEffort;
}

function modelOptionFromValue(value: unknown): CodingAgentModelOption | undefined {
  const object = objectValue(value);
  const id = stringValue(object?.value) ?? stringValue(object?.id);
  if (!object || !id) return undefined;

  const supportsEffort = booleanValue(object.supportsEffort) ?? false;
  const vocabulary = claudeCodeEffortValues();
  const discoveredEfforts = arrayValue(object.supportedEffortLevels).flatMap((effort) => {
    const known = vocabulary.find((candidate) => candidate.id === stringValue(effort));
    return known ? [known] : [];
  });
  const reasoningEfforts = discoveredEfforts.length > 0
    ? discoveredEfforts
    : supportsEffort
      ? vocabulary
      : [];

  const defaultReasoningEffort = supportedDefaultEffort(reasoningEfforts);
  return {
    id,
    label: stringValue(object.displayName) ?? id,
    ...(stringValue(object.description) ? { description: stringValue(object.description) } : {}),
    isDefault: false,
    reasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    serviceTiers: []
  };
}

function fallbackModel(
  id: string,
  label: string,
  description: string | undefined,
  reasoningEfforts: CodingAgentSettingValue[]
): CodingAgentModelOption {
  const defaultReasoningEffort = supportedDefaultEffort(reasoningEfforts);
  return {
    id,
    label,
    ...(description ? { description } : {}),
    isDefault: false,
    reasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    serviceTiers: []
  };
}
