import type {
  CodingAgentCapabilities,
  CodingAgentModelOption,
  CodingAgentTurnSettings,
  ServiceConfig
} from "../../domain/models";
import { currentModelCatalog } from "../modelCatalog";
import { DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_PROVIDER } from "./settings";

/**
 * DeepSeek Harness's model catalog, read from `modelCatalog.json`.
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
function deepseekModels(): CodingAgentModelOption[] {
  return currentModelCatalog().runners.deepseek.models.map((entry) => model(entry.id, entry.label, entry.description));
}

export function deepseekCapabilities(config: ServiceConfig, error?: string): CodingAgentCapabilities {
  // An operator-configured model this build does not ship is still the default:
  // the catalog is a convenience, and coercing their choice to a listed id would
  // silently run a different model than `/api/config` reports. Without one, the
  // default is the constant a turn falls back to rather than the file's first
  // entry, so the reported default and the model a turn runs cannot drift apart.
  const defaultModelId = config.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL;
  const listed = deepseekModels();
  const models = listed.some((candidate) => candidate.id === defaultModelId)
    ? listed
    : [...listed, model(defaultModelId, defaultModelId)];
  const resolved = models.map((candidate) => ({ ...candidate, isDefault: candidate.id === defaultModelId }));
  return {
    runnerKind: "deepseek",
    modelSelectionScope: "session",
    sessionNotice: "Stopping a turn or restarting the backend ends this thread's ability to continue. Its transcript stays available. Start a new thread to continue working or choose a different model.",
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
