import { z } from "zod";
import type { CodingAgentSettingsDescriptor, CodingAgentSettingValue } from "../../domain/models";
import {
  codingAgentModelIdSchema,
  codingAgentReasoningEffortIdSchema
} from "../../domain/settingValueSchemas";
import {
  MAX_PERMISSION_OPTION_ID_LENGTH,
  MAX_PERMISSION_OPTION_KIND_LENGTH,
  MAX_PERMISSION_OPTION_NAME_LENGTH,
  MAX_PERMISSION_OPTIONS
} from "../shared/PendingPermissionRequests";

/**
 * The Agent Client Protocol (ACP) stable v1 messages this adapter consumes.
 *
 * Every one is zod-validated on receipt. That is not because the peer is
 * expected to lie — it is because the peer is an **operator-supplied binary**,
 * which is precisely the input class `AGENTS.md` requires be validated with zod.
 * Shape validation is not trust (the executable allowlist in `admission.ts` is
 * the trust decision); it is what keeps a malformed or hostile frame from
 * reaching the canonical mapper as an unchecked shape.
 *
 * The schemas are deliberately **lenient about fields we do not read** and
 * strict about the ones we do: an agent that adds a field must keep working, so
 * unknown keys pass through rather than failing a frame. What must never pass is
 * a field we act on arriving as something other than what we act on it as.
 *
 * Conformance reference: the SDK's published `schema/schema.json` for v1
 * (`@agentclientprotocol/sdk`). The dependency itself is deliberately not taken
 * — see the Phase 0b findings in
 * docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md.
 */

/** The protocol version this adapter speaks. v2 is still draft and is not used. */
export const ACP_PROTOCOL_VERSION = 1;

/** How many session config selectors one response may carry before the rest are dropped. */
const MAX_CONFIG_OPTIONS = 32;
/** How many values one selector may offer. The reference agent's longest is 7. */
const MAX_CONFIG_OPTION_VALUES = 64;

const textContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string()
  })
  .passthrough();

/** Any content block; only the text variant carries something we render. */
const contentBlockSchema = z.union([textContentSchema, z.object({ type: z.string() }).passthrough()]);

function textOf(content: unknown): string | undefined {
  const parsed = textContentSchema.safeParse(content);
  return parsed.success ? parsed.data.text : undefined;
}

/**
 * Agent capabilities from `initialize`.
 *
 * The two restore capabilities are advertised with **different shapes**, which
 * the Phase 0b spike confirmed against the reference agent: `loadSession` is a
 * boolean, while `sessionCapabilities.resume` is an object (`{}`) whose mere
 * presence is the claim. A `=== true` check would therefore silently reject an
 * agent that supports the *preferred* restore path, so both are read as
 * presence/truthiness.
 */
export const agentCapabilitiesSchema = z
  .object({
    loadSession: z.unknown().optional(),
    promptCapabilities: z
      .object({
        image: z.unknown().optional(),
        embeddedContext: z.unknown().optional()
      })
      .passthrough()
      .optional(),
    sessionCapabilities: z
      .object({
        resume: z.unknown().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export const initializeResponseSchema = z
  .object({
    protocolVersion: z.number().int(),
    agentCapabilities: agentCapabilitiesSchema.optional(),
    authMethods: z.array(z.object({ id: z.string() }).passthrough()).optional()
  })
  .passthrough();

export type AcpInitializeResponse = z.infer<typeof initializeResponseSchema>;

export type AcpAgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;

/**
 * Whether this agent takes image content blocks in a prompt.
 *
 * ACP v1 defines this field as a boolean. Keep the surrounding schema lenient so
 * one malformed optional capability does not invalidate the whole initialize
 * response, but accept support only from the exact value `true`: a truthy string
 * or object is not a valid advertisement and must fail in the conservative
 * direction.
 */
export function agentSupportsPromptImages(capabilities: AcpAgentCapabilities | undefined): boolean {
  return capabilities?.promptCapabilities?.image === true;
}

/**
 * A prompt content block. ACP carries an image inline as base64 with an explicit
 * mime type — there is no local-file source — which is why the total decoded
 * bytes one prompt may carry is a transport bound rather than a detail.
 */
export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

/**
 * One entry of the `configOptions` list a v1 `session/new`, `session/load`, or
 * `session/set_config_option` response carries: a named selector plus its
 * current state.
 *
 * Only the `select` variant is read. ACP also defines a `boolean` toggle, but
 * `CodingAgentCapabilities` has no shape for one — its settings are lists of
 * `{ id, label, description }` a client renders as a picker — and inventing a
 * two-value picker for it would be a projection the agent did not advertise.
 * An unread variant simply does not map, which is the same rule an unmapped
 * `session/update` follows.
 */
export const sessionConfigOptionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().nullish(),
    /**
     * The spec's own words: categories are "UX only" and "MUST NOT be required
     * for correctness", and a client "MUST handle missing or unknown categories
     * gracefully". So this is read leniently — an unknown or absent category is
     * an option this adapter has no reading for, never a malformed frame.
     */
    category: z.string().nullish(),
    type: z.string().optional(),
    currentValue: z.string().optional(),
    options: z
      .array(
        z
          .object({
            value: z.string().min(1),
            name: z.string().optional(),
            description: z.string().nullish()
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

export type AcpSessionConfigOption = z.infer<typeof sessionConfigOptionSchema>;

/**
 * A `configOptions` list, bounded and drop-invalid.
 *
 * `catch` on each entry mirrors the schema's own
 * `x-deserialize-skip-invalid-items`: one malformed selector must not cost the
 * others, because the others include the model list.
 */
const boundedSessionConfigOptionsSchema = z
  .array(sessionConfigOptionSchema.catch(() => ({ id: "", type: "" }) as AcpSessionConfigOption))
  .max(MAX_CONFIG_OPTIONS);

const sessionConfigOptionsSchema = boundedSessionConfigOptionsSchema
  .optional()
  // And the list as a whole degrades to *absent* rather than throwing. These
  // selectors are discovery, not the session: an agent carrying more of them
  // than the cap, or sending the field as something other than a list, must
  // cost its model picker and nothing else — failing `session/new` over it
  // would deny a working agent a session for a cosmetic reason.
  .catch(undefined);

export const newSessionResponseSchema = z
  .object({
    sessionId: z.string().min(1),
    configOptions: sessionConfigOptionsSchema
  })
  .passthrough();

/** `session/load` and `session/resume` report the restored session's selectors too. */
export const restoredSessionResponseSchema = z
  .object({
    configOptions: sessionConfigOptionsSchema
  })
  .passthrough();

/** `session/set_config_option` answers with the whole refreshed list. */
export const setConfigOptionResponseSchema = z
  .object({
    // Unlike discovery on session creation, this field is the acknowledgement
    // of an explicit operator selection. ACP requires the complete refreshed
    // state here, so absence or a wrong-typed/over-cap list must fail the turn
    // instead of being mistaken for success.
    configOptions: boundedSessionConfigOptionsSchema
  })
  .passthrough();

const configOptionUpdateSchema = z
  .object({
    sessionUpdate: z.literal("config_option_update"),
    // An agent-initiated update is also a complete state replacement. Keep the
    // prior live state if that replacement is malformed rather than partially
    // applying an untrusted notification.
    configOptions: boundedSessionConfigOptionsSchema
  })
  .passthrough();

/**
 * `stopReason` is an open vocabulary in v1. It is read only to distinguish a
 * cancellation from a completion, so an unknown value is treated as a normal
 * end rather than failing the turn.
 */
export const promptResponseSchema = z
  .object({
    stopReason: z.string().optional()
  })
  .passthrough();

const toolCallStatusSchema = z.string();

const sessionUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  z
    .object({
      sessionUpdate: z.literal("agent_message_chunk"),
      messageId: z.string().optional(),
      content: contentBlockSchema.optional()
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal("agent_thought_chunk"),
      messageId: z.string().optional(),
      content: contentBlockSchema.optional()
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal("tool_call"),
      toolCallId: z.string().min(1),
      status: toolCallStatusSchema.optional(),
      kind: z.string().optional(),
      title: z.string().optional(),
      rawInput: z.unknown().optional()
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal("tool_call_update"),
      toolCallId: z.string().min(1),
      status: toolCallStatusSchema.optional(),
      title: z.string().optional(),
      rawOutput: z.unknown().optional()
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal("plan"),
      entries: z
        .array(
          z
            .object({
              content: z.string().optional(),
              status: z.string().optional()
            })
            .passthrough()
        )
        .optional()
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal("usage_update"),
      used: z.number().optional(),
      size: z.number().optional()
    })
    .passthrough()
]);

/**
 * A `session/update` notification whose `sessionUpdate` this adapter has a
 * canonical reading for. Anything else — `available_commands_update`,
 * `session_info_update`, a kind a newer agent invents — parses as `undefined`
 * and produces **no** event, which is the boundary's documented way for an
 * adapter to keep something out of the canonical stream without the mapper
 * knowing why.
 */
export const sessionNotificationSchema = z
  .object({
    sessionId: z.string().optional(),
    update: z.unknown()
  })
  .passthrough();

export type AcpSessionUpdate = z.infer<typeof sessionUpdateSchema>;

export function parseSessionUpdate(update: unknown): AcpSessionUpdate | undefined {
  const parsed = sessionUpdateSchema.safeParse(update);
  return parsed.success ? parsed.data : undefined;
}

/** Read an agent-initiated complete config-state replacement. */
export function parseConfigOptionUpdate(
  update: unknown
): readonly AcpSessionConfigOption[] | undefined {
  const parsed = configOptionUpdateSchema.safeParse(update);
  return parsed.success ? parsed.data.configOptions : undefined;
}

export function updateText(update: { content?: unknown }): string | undefined {
  return textOf(update.content);
}

/**
 * The two ACP config-option categories that map safely onto AgentRoom's
 * per-turn coding-agent settings, and the categories deliberately excluded.
 *
 * `mode` is **excluded on safety grounds, not for lack of a shape.** It is the
 * agent's own sandbox/approval posture — the reference agent offers `read-only`,
 * `agent`, and `agent-full-access`, the last described as "edit files outside
 * this workspace and run commands with network access". AgentRoom's turn
 * settings are chosen per turn by any client holding the bearer token, while
 * every other runner trust posture (the Codex sandbox mode and network pin, the
 * Claude Code permission mode, this adapter's own `permissionPolicy`) is a
 * tier-2 managed setting a paired client can only change behind
 * `REMOTE_SETTINGS_ADMIN`. Projecting `mode` into the model picker would
 * therefore be a sandbox-widening control on the composer, reachable without
 * that gate — an escalation, not a feature. An operator who wants a different
 * mode configures the agent itself, which is where that decision already lives.
 *
 * `collaboration_mode` (the reference agent's `default`/`plan`) is excluded for
 * the plainer reason: it is not a trust posture, but it is not a model setting
 * either, and cramming it into `serviceTiers` is exactly the flattening the
 * boundary plan forbids.
 *
 * `model_config` is also not synonymous with a service tier. ACP defines the
 * category as a UX hint that may describe context size, speed/quality, or more
 * than one independent control. Projecting the first such selector as "Speed"
 * would mislabel a compliant agent and hide the rest, so it stays unmapped until
 * the public contract can preserve generic config options.
 */
const MODEL_CATEGORY = "model";
const REASONING_CATEGORY = "thought_level";

/** Which AgentRoom turn-setting field a selector drives, and its live value. */
export interface AcpSettingControl {
  readonly configId: string;
  currentValue?: string;
}

export interface AcpSessionSettings {
  readonly descriptor: CodingAgentSettingsDescriptor;
  readonly model?: AcpSettingControl;
  readonly reasoningEffort?: AcpSettingControl;
  readonly serviceTier?: AcpSettingControl;
}

export const EMPTY_ACP_SESSION_SETTINGS: AcpSessionSettings = {
  descriptor: { models: [], defaultSettings: {} }
};

function selectFor(
  options: readonly AcpSessionConfigOption[] | undefined,
  category: string
): AcpSessionConfigOption | undefined {
  return options?.find((option) => option.type === "select" && option.category === category && option.id.length > 0);
}

/**
 * Values a selector offers, dropped to the ones AgentRoom can carry back.
 *
 * A value id that fails the shape a turn setting is validated against is
 * skipped rather than listed: offering a choice `POST /turns` would then refuse
 * is the "looks like a valid edit, fails at the write" trap in a new place.
 */
function valuesOf(
  option: AcpSessionConfigOption | undefined,
  idSchema: z.ZodType<string>
): CodingAgentSettingValue[] {
  const values: CodingAgentSettingValue[] = [];
  for (const value of (option?.options ?? []).slice(0, MAX_CONFIG_OPTION_VALUES)) {
    const parsed = idSchema.safeParse(value.value);
    // ACP option values are opaque protocol tokens. A schema that trims one
    // cannot safely advertise the normalized token: sending it back would ask
    // the agent for a value it never offered. Drop any non-round-tripping value.
    if (!parsed.success || parsed.data !== value.value) continue;
    values.push({
      id: parsed.data,
      label: value.name && value.name.length > 0 ? value.name : parsed.data,
      ...(value.description ? { description: value.description } : {})
    });
  }
  return values;
}

function selectedValue(
  values: readonly CodingAgentSettingValue[],
  currentValue: string | undefined
): string | undefined {
  return currentValue !== undefined && values.some((value) => value.id === currentValue)
    ? currentValue
    : undefined;
}

function controlFor(
  option: AcpSessionConfigOption | undefined,
  currentValue: string | undefined
): AcpSettingControl | undefined {
  return option ? { configId: option.id, ...(currentValue ? { currentValue } : {}) } : undefined;
}

/**
 * Map a v1 `configOptions` list onto `CodingAgentCapabilities`.
 *
 * ACP v1 has no model-list method, but it does have this — a generic session
 * configuration selector whose `category` hints at what each one means. The
 * `model` and `thought_level` categories map without interpretation; generic
 * `model_config` does not, because the category alone cannot distinguish speed
 * from context size or several independent model controls. The descriptor is
 * read from the `session/new` response the handshake already receives, which is
 * why discovery still spawns nothing extra.
 *
 * The reasoning-effort list is **session-scoped in ACP** — one selector for the
 * session, not one per model — so the same list is attached to every model
 * rather than pretending each model has its own. It is dropped when the agent
 * offers no model selector at all, because
 * `CodingAgentModelOption` is the only place the contract can hang them and a
 * list nothing carries is a list no client can render.
 */
export function readSessionSettings(
  configOptions: readonly AcpSessionConfigOption[] | undefined
): AcpSessionSettings {
  const modelSelect = selectFor(configOptions, MODEL_CATEGORY);
  const reasoningSelect = selectFor(configOptions, REASONING_CATEGORY);

  const models = valuesOf(modelSelect, codingAgentModelIdSchema);
  if (models.length === 0) return EMPTY_ACP_SESSION_SETTINGS;

  const reasoningEfforts = valuesOf(reasoningSelect, codingAgentReasoningEffortIdSchema);
  const defaultModel = selectedValue(models, modelSelect?.currentValue);
  const defaultReasoningEffort = selectedValue(reasoningEfforts, reasoningSelect?.currentValue);

  return {
    descriptor: {
      models: models.map((model) => ({
        ...model,
        isDefault: model.id === defaultModel,
        reasoningEfforts,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        serviceTiers: []
      })),
      defaultSettings: {
        ...(defaultModel ? { model: defaultModel } : {}),
        ...(defaultReasoningEffort ? { reasoningEffort: defaultReasoningEffort } : {})
      }
    },
    ...(controlFor(modelSelect, defaultModel) ? { model: controlFor(modelSelect, defaultModel) } : {}),
    ...(reasoningEfforts.length > 0 && controlFor(reasoningSelect, defaultReasoningEffort)
      ? { reasoningEffort: controlFor(reasoningSelect, defaultReasoningEffort) }
      : {})
  };
}

/**
 * A permission option offered by the agent. `kind` is what the conservative
 * responder selects on: only an option the agent itself supplied is ever
 * chosen, and `allow_always` is never invented.
 */
export const permissionOptionSchema = z
  .object({
    optionId: z.string().min(1).max(MAX_PERMISSION_OPTION_ID_LENGTH),
    kind: z.string().max(MAX_PERMISSION_OPTION_KIND_LENGTH).optional(),
    name: z.string().max(MAX_PERMISSION_OPTION_NAME_LENGTH).optional()
  })
  .passthrough();

const permissionOptionsSchema = z
  .array(permissionOptionSchema)
  .max(MAX_PERMISSION_OPTIONS)
  .superRefine((options, context) => {
    const seen = new Set<string>();
    options.forEach((option, index) => {
      if (seen.has(option.optionId)) {
        context.addIssue({
          code: "custom",
          message: "permission option ids must be unique",
          path: [index, "optionId"]
        });
      }
      seen.add(option.optionId);
    });
  });

export const permissionRequestSchema = z
  .object({
    sessionId: z.string().optional(),
    options: permissionOptionsSchema.default([]),
    toolCall: z.object({ title: z.string().optional() }).passthrough().optional()
  })
  .passthrough();

export type AcpPermissionOption = z.infer<typeof permissionOptionSchema>;

/**
 * The conservative default from the Phase 0 spike, kept for production: select
 * a rejection option the agent offered, else cancel.
 *
 * It never invents `allow_always`, and it never selects an allow option — an
 * unattended auto-allow posture is a separate, gated tier-2 trust setting, not
 * a fallback that happens when no rejection option is present.
 */
export function conservativePermissionOutcome(
  options: readonly AcpPermissionOption[]
): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
  const rejection = options.find((option) => option.kind === "reject_once")
    ?? options.find((option) => option.kind === "reject_always");
  return rejection ? { outcome: "selected", optionId: rejection.optionId } : { outcome: "cancelled" };
}
