import type {
  CodingAgentCapabilities,
  CodingAgentModelOption,
  CodingAgentTurnSettings,
  ServiceConfig
} from "../../domain/models";
import { DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_PROVIDER } from "./settings";

/**
 * DeepSeek Harness's model catalog.
 *
 * This list is static because the SDK wire has no `model/list`
 * analog — `provider` and `model` are `initialize` parameters, and which models
 * a route serves is the composed profile's business. So the catalog is a
 * starting point and the model id stays an open bounded string
 * (`codingAgentModelIdSchema`), which is what lets an operator run a model this
 * build has never heard of by setting `DEEPSEEK_MODEL` or the managed
 * `runners.deepseek.model`.
 *
 * Readiness is still proved rather than assumed: `getCapabilities()` spawns the
 * runtime, completes the handshake, and checks the server identity, so the
 * capabilities read remains the runtime-readiness probe (`runner/runtimeReadiness.ts`)
 * exactly as it is for the other registered runners.
 *
 * `serviceTiers` is empty — DeepSeek Harness has no speed-tier analog, the same
 * as Claude Code. Reasoning effort is likewise absent: the runtime exposes no
 * per-request effort lever on this wire, and advertising a control that does
 * nothing is worse than omitting it.
 */
const deepseekModels: CodingAgentModelOption[] = [
  // First entry is the fallback an unconfigured turn runs, so the id this
  // reports as `defaultSettings.model` and the id a turn actually uses are one
  // constant rather than two that have to agree.
  model(DEFAULT_DEEPSEEK_MODEL, "DeepSeek V4 Flash", "Fast, for routine work"),
  model("deepseek-v4-pro", "DeepSeek V4 Pro", "Most capable, for harder tasks")
];

export function deepseekCapabilities(config: ServiceConfig, error?: string): CodingAgentCapabilities {
  const configured = config.deepseekModel;
  // An operator-configured model this build does not ship is still the default:
  // the catalog is a convenience, and coercing their choice to a listed id would
  // silently run a different model than `/api/config` reports.
  const models = configured && !deepseekModels.some((candidate) => candidate.id === configured)
    ? [...deepseekModels, model(configured, configured)]
    : deepseekModels;
  const defaultModelId = configured ?? models[0].id;
  const resolved = models.map((candidate) => ({ ...candidate, isDefault: candidate.id === defaultModelId }));
  return {
    runnerKind: "deepseek",
    settings: {
      models: resolved,
      defaultSettings: defaultSettings(defaultModelId)
    },
    ...(error ? { error } : {})
  };
}

/** The provider route the capabilities read reports it would hand `initialize`. */
export function configuredDeepSeekProvider(config: ServiceConfig): string {
  return config.deepseekProvider ?? DEFAULT_DEEPSEEK_PROVIDER;
}

function defaultSettings(modelId: string): CodingAgentTurnSettings {
  return { model: modelId };
}

function model(id: string, label: string, description?: string): CodingAgentModelOption {
  return {
    id,
    label,
    ...(description ? { description } : {}),
    isDefault: false,
    reasoningEfforts: [],
    serviceTiers: []
  };
}
