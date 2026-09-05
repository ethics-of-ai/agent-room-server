import type {
  CodingAgentCapabilities,
  CodingAgentModelOption,
  CodingAgentSettingValue,
  ServiceConfig
} from "../../domain/models";
import { arrayValue, booleanValue, objectValue, stringValue } from "../shared/jsonValues";

/**
 * Cursor's model catalog, in the shape the adapter needs and the client-facing
 * capability descriptor is projected from.
 *
 * The primary path is the live `models/list` the host answers from
 * `Cursor.models.list()` (docs/engineering/CURSOR_SDK_RUNNER.md).
 * Each model's depth parameter is `effort` (Anthropic, Grok, Gemini) or
 * `reasoning` (OpenAI, Kimi, GLM), and its speed parameter is `fast` (fact 5).
 * The capability descriptor flattens both onto `reasoningEfforts` and
 * `serviceTiers`, but the adapter also needs the parameter *name* to send a
 * selection back as `ModelSelection.params`, and `CodingAgentModelOption` has no
 * field for that. So the catalog keeps the name, and the descriptor is derived.
 *
 * `thinking` and `context` are not selectable AgentRoom turn settings. The
 * default variant's `context` value is still projected as context-window
 * capacity when it is a bounded token quantity, so clients can render the
 * selected model accurately. A model that declares neither depth nor speed
 * carries nothing rather than borrowed values. The variant a model marks
 * `isDefault` supplies its default selection.
 */
export type CursorDepthParameter = "effort" | "reasoning";

export interface CursorCatalogModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  /** Token capacity from the model's default `context` variant. */
  readonly contextWindowTokens?: number;
  /** The depth parameter, when the model declares one. */
  readonly depth?: {
    readonly parameter: CursorDepthParameter;
    readonly values: readonly string[];
    /** From the `isDefault` variant; absent when that variant names none. */
    readonly defaultValue?: string;
  };
  /** Present when the model declares `fast`; whether the default variant is fast. */
  readonly speed?: { readonly defaultFast: boolean };
  /** The catalog's own default model, before the operator's configured one. */
  readonly isDefault: boolean;
}

export interface CursorModelCatalog {
  readonly models: readonly CursorCatalogModel[];
  /** `live` from `models/list`; `fallback` is the static list below. */
  readonly source: "live" | "fallback";
}

/** The model a turn runs when nothing names one: Cursor's own selection. */
export const DEFAULT_CURSOR_MODEL = "default";

/**
 * The offline fallback, seeded from the catalog recorded on 2026-08-26 against
 * `@cursor/sdk@1.0.28`. Deliberately small and open: what a client sees when the
 * live read fails, and what the adapter maps parameters against until a live
 * list arrives. The model id stays an open bounded string
 * (`codingAgentModelIdSchema`), so an operator-configured model this list has
 * never heard of is still the default rather than coerced to a listed id.
 */
export const fallbackCursorCatalog: CursorModelCatalog = {
  source: "fallback",
  models: [
    { id: DEFAULT_CURSOR_MODEL, label: "Auto", description: "Cursor picks the model", isDefault: true },
    {
      id: "composer-2.5",
      label: "Composer 2.5",
      description: "Cursor's own coding model",
      speed: { defaultFast: true },
      isDefault: false
    },
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      contextWindowTokens: 1_000_000,
      depth: { parameter: "effort", values: ["low", "medium", "high", "xhigh", "max"], defaultValue: "high" },
      speed: { defaultFast: false },
      isDefault: false
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      contextWindowTokens: 1_000_000,
      depth: { parameter: "effort", values: ["low", "medium", "high", "xhigh", "max"], defaultValue: "high" },
      isDefault: false
    },
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      contextWindowTokens: 1_000_000,
      depth: {
        parameter: "reasoning",
        values: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultValue: "medium"
      },
      speed: { defaultFast: false },
      isDefault: false
    },
    {
      id: "gpt-5.3-codex",
      label: "Codex 5.3",
      depth: { parameter: "reasoning", values: ["low", "medium", "high", "extra-high"], defaultValue: "high" },
      speed: { defaultFast: true },
      isDefault: false
    }
  ]
};

/**
 * Parse the raw `Cursor.models.list()` reply into a catalog. Returns `undefined`
 * when the reply carries no usable model, so the caller can keep whatever
 * catalog it already had rather than replacing a live list with an empty one.
 */
export function cursorCatalogFromModels(response: unknown): CursorModelCatalog | undefined {
  const models = arrayValue(response).flatMap((value) => {
    const model = catalogModelFromValue(value);
    return model ? [model] : [];
  });
  if (models.length === 0) return undefined;
  return { source: "live", models };
}

/**
 * The model a turn runs when neither the turn nor the operator names one: the
 * operator's managed `runners.cursor.model`, else the catalog's own default.
 */
export function defaultCursorModelId(catalog: CursorModelCatalog, config: ServiceConfig): string {
  return (
    configuredCursorModel(config) ??
    catalog.models.find((model) => model.isDefault)?.id ??
    catalog.models[0]?.id ??
    DEFAULT_CURSOR_MODEL
  );
}

/** The managed `runners.cursor.model`, when the operator set one. */
export function configuredCursorModel(config: ServiceConfig): string | undefined {
  return config.cursorModel;
}

/**
 * Project a catalog into the client-facing capability descriptor. Whichever
 * depth parameter a model declares becomes `reasoningEfforts`, and `fast`
 * becomes `serviceTiers` (`true` → fast, `false` → standard). An
 * operator-configured model the catalog has never heard of is appended so it is
 * still selectable, with empty lists because nothing is known about it.
 */
export function cursorCapabilities(
  catalog: CursorModelCatalog,
  config: ServiceConfig,
  error?: string
): CodingAgentCapabilities {
  const configured = configuredCursorModel(config);
  const models =
    configured && !catalog.models.some((model) => model.id === configured)
      ? [...catalog.models, { id: configured, label: configured, isDefault: false }]
      : catalog.models;
  const defaultModelId = defaultCursorModelId(catalog, config);
  const options = models.map((model) => modelOption(model, model.id === defaultModelId));
  const defaultOption = options.find((option) => option.isDefault);
  return {
    runnerKind: "cursor",
    settings: {
      models: options,
      defaultSettings: {
        model: defaultModelId,
        ...(defaultOption?.defaultReasoningEffort ? { reasoningEffort: defaultOption.defaultReasoningEffort } : {}),
        ...(defaultOption?.defaultServiceTier ? { serviceTier: defaultOption.defaultServiceTier } : {})
      }
    },
    ...(error ? { error } : {})
  };
}

/** The fallback catalog's descriptor, with the bounded error a failed probe reports. */
export function fallbackCursorCapabilities(config: ServiceConfig, error?: string): CodingAgentCapabilities {
  return cursorCapabilities(fallbackCursorCatalog, config, error);
}

/** The live reply's descriptor, or the fallback's when the reply is unusable. */
export function cursorCapabilitiesFromModels(response: unknown, config: ServiceConfig): CodingAgentCapabilities {
  return cursorCapabilities(cursorCatalogFromModels(response) ?? fallbackCursorCatalog, config);
}

function modelOption(model: CursorCatalogModel, isDefault: boolean): CodingAgentModelOption {
  const reasoningEfforts: CodingAgentSettingValue[] = (model.depth?.values ?? []).map((id) => ({
    id,
    label: labelFor(id)
  }));
  const serviceTiers: CodingAgentSettingValue[] = model.speed ? speedTiers() : [];
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
    isDefault,
    reasoningEfforts,
    ...(model.depth?.defaultValue ? { defaultReasoningEffort: model.depth.defaultValue } : {}),
    serviceTiers,
    ...(model.speed ? { defaultServiceTier: model.speed.defaultFast ? "fast" : "standard" } : {})
  };
}

function catalogModelFromValue(value: unknown): CursorCatalogModel | undefined {
  const object = objectValue(value);
  const id = stringValue(object?.id);
  if (!object || !id) return undefined;

  const parameters = arrayValue(object.parameters).flatMap((parameter) => {
    const parameterObject = objectValue(parameter);
    const parameterId = stringValue(parameterObject?.id);
    return parameterId ? [{ id: parameterId, values: arrayValue(parameterObject?.values) }] : [];
  });
  const depthParameter = parameters.find((parameter) => parameter.id === "effort" || parameter.id === "reasoning");
  const speedParameter = parameters.find((parameter) => parameter.id === "fast");

  const defaultVariant = arrayValue(object.variants)
    .map((variant) => objectValue(variant))
    .find((variant) => booleanValue(variant?.isDefault) === true);
  const defaultParams = new Map(
    arrayValue(defaultVariant?.params).flatMap((param) => {
      const paramObject = objectValue(param);
      const paramId = stringValue(paramObject?.id);
      const paramValue = stringValue(paramObject?.value);
      return paramId && paramValue ? [[paramId, paramValue] as const] : [];
    })
  );

  const depthValues = (depthParameter?.values ?? []).flatMap((entry) => {
    const effortId = stringValue(objectValue(entry)?.value) ?? stringValue(entry);
    return effortId ? [effortId] : [];
  });
  const defaultDepth = depthParameter ? defaultParams.get(depthParameter.id) : undefined;
  const contextWindowTokens = contextWindowTokensFromValue(defaultParams.get("context"));
  const description = stringValue(object.description);

  return {
    id,
    label: stringValue(object.displayName) ?? id,
    ...(description ? { description } : {}),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(depthParameter && depthValues.length > 0
      ? {
          depth: {
            parameter: depthParameter.id as CursorDepthParameter,
            values: depthValues,
            ...(defaultDepth && depthValues.includes(defaultDepth) ? { defaultValue: defaultDepth } : {})
          }
        }
      : {}),
    ...(speedParameter ? { speed: { defaultFast: defaultParams.get("fast") === "true" } } : {}),
    // The live list marks no model as the catalog default; `default` is
    // Cursor's own Auto selection, so it takes that role when present.
    isDefault: id === DEFAULT_CURSOR_MODEL
  };
}

function contextWindowTokensFromValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000;
  const tokens = amount * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function speedTiers(): CodingAgentSettingValue[] {
  return [
    { id: "standard", label: "Standard", description: "Standard speed" },
    { id: "fast", label: "Fast", description: "Cursor's fast mode, increased usage" }
  ];
}

function labelFor(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
