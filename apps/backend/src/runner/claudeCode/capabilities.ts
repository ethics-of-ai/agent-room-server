import type {
  CodingAgentCapabilities,
  CodingAgentModelOption,
  CodingAgentReasoningEffort,
  CodingAgentSettingValue,
  ServiceConfig
} from "../../domain/models";
import { arrayValue, booleanValue, labelFromIdentifier, objectValue, stringValue } from "../shared/jsonValues";

const claudeCodeEffortValues: CodingAgentSettingValue[] = [
  { id: "low", label: "Low", description: "Minimal thinking, fastest responses" },
  { id: "medium", label: "Medium", description: "Moderate thinking" },
  { id: "high", label: "High", description: "Deep reasoning" },
  { id: "xhigh", label: "Xhigh", description: "Deeper than high on supported models" }
];

const supportedClaudeCodeEfforts = new Set(claudeCodeEffortValues.map((value) => value.id));

// Offline fallback only: the primary path is live discovery through the SDK
// supportedModels() control request, which reflects whatever `claude` CLI the
// runner spawns. Keep this list aligned with current Claude model aliases when
// it drifts. Haiku carries no effort list because it does not accept an effort
// level; advertising one would send an unsupported effortLevel to the SDK.
const fallbackClaudeCodeModels: CodingAgentModelOption[] = [
  fallbackModel("claude-opus-5", "Opus 5", "Best for everyday, complex tasks"),
  fallbackModel("claude-fable-5", "Fable 5", "Most capable for the hardest, longest-running tasks"),
  fallbackModel("claude-sonnet-5", "Sonnet 5", "Efficient for routine tasks"),
  fallbackModel("claude-haiku-4-5", "Haiku 4.5", "Fastest for quick answers", [])
];

export function fallbackClaudeCodeCapabilities(config: ServiceConfig): CodingAgentCapabilities {
  const models = fallbackClaudeCodeModels.map((model) => ({
    ...model,
    isDefault: model.id === (config.claudeCodeModel ?? fallbackClaudeCodeModels[0].id)
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
  const discoveredEfforts = arrayValue(object.supportedEffortLevels)
    .flatMap((effort) => {
      const effortId = stringValue(effort);
      return effortId && supportedClaudeCodeEfforts.has(effortId) ? [effortId] : [];
    })
    .map((effortId) => claudeCodeEffortValues.find((candidate) => candidate.id === effortId) ?? {
      id: effortId,
      label: labelFromIdentifier(effortId)
    });
  const reasoningEfforts = discoveredEfforts.length > 0
    ? discoveredEfforts
    : supportsEffort
      ? claudeCodeEffortValues
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
  description: string,
  reasoningEfforts: CodingAgentSettingValue[] = claudeCodeEffortValues
): CodingAgentModelOption {
  const defaultReasoningEffort = supportedDefaultEffort(reasoningEfforts);
  return {
    id,
    label,
    description,
    isDefault: false,
    reasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    serviceTiers: []
  };
}
