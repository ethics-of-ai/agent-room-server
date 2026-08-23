import { z } from "zod";
import type { ServiceConfig } from "../../domain/models";
import type { RunnerDescriptor } from "../registry";
import { booleanEnv, optionalEnv } from "../../config/env";
import { logger } from "../../logging/logger";
import { admitExecutable, isGrantableEnvName } from "./admission";

/**
 * Tier-3 configuration for external ACP adapters.
 *
 * All of it is **environment-only**, and that is a safety property rather than
 * an implementation convenience. An executable path is "run this binary", which
 * is remote code execution by configuration — so it may never be a managed
 * setting, may never appear in `GET /api/config`, and may never arrive from
 * `/api/runners` or the offline runner catalog. The same holds for the
 * environment names an adapter is granted: naming a variable is choosing what a
 * child gets to read.
 *
 * The channel is **off by default**, in the spirit of `TERMINAL_ENABLED`: with
 * `ACP_ADAPTERS_ENABLED` unset, no definition is parsed, no runner is
 * registered, and nothing can be spawned.
 */

/**
 * External ids live in their own `acp_` namespace. Two things follow, both
 * deliberate: an operator cannot shadow a current or future built-in id, and the
 * derived settings prefix cannot collide with `codex`/`claudeCode`, so the
 * registry's "no prefix shadows another" invariant holds by construction rather
 * than by luck.
 */
const ACP_RUNNER_ID = /^acp_[a-z][a-z0-9_]{0,30}$/;

const adapterDefinitionSchema = z
  .object({
    id: z.string().regex(ACP_RUNNER_ID, "id must match acp_[a-z][a-z0-9_]*"),
    displayName: z.string().min(1).max(60),
    /** Absolute path to the agent executable. Admitted before it is ever spawned. */
    command: z.string().min(1),
    /** Fixed arguments. The backend assembles argv; there is no shell and no caller fragment. */
    args: z.array(z.string().max(200)).max(32).default([]),
    /**
     * Environment names this adapter may receive beyond the base allowlist —
     * the opt-in credential grants. `AUTH_TOKEN` is refused here as it is
     * everywhere else.
     */
    envGrants: z.array(z.string()).max(32).default([])
  })
  .strict();

export type AcpAdapterDefinition = z.infer<typeof adapterDefinitionSchema>;

const adapterListSchema = z.array(adapterDefinitionSchema).max(8);

export interface AcpAdapterConfig extends AcpAdapterDefinition {
  /** The flat version-1 key of this adapter's permission-policy setting. */
  readonly permissionPolicyKey: string;
}

/** Whether the external-adapter channel is enabled at all. */
export function acpAdaptersEnabled(): boolean {
  return booleanEnv("ACP_ADAPTERS_ENABLED", false);
}

/**
 * Parse `ACP_ADAPTERS`, a JSON array of adapter definitions.
 *
 * A malformed list is dropped **whole** with one bounded warning, never applied
 * in part — the same rule the managed settings file follows, and for the same
 * reason: a half-applied set of adapters is a worse answer than none, because
 * the operator cannot tell which half is live.
 */
export function readAcpAdapterConfigs(raw = optionalEnv("ACP_ADAPTERS")): AcpAdapterConfig[] {
  if (!acpAdaptersEnabled() || !raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("ACP_ADAPTERS is not valid JSON; no external adapters registered");
    return [];
  }
  const result = adapterListSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { issues: result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
      "ACP_ADAPTERS failed validation; no external adapters registered"
    );
    return [];
  }
  const seen = new Set<string>();
  const settingsPrefixes = new Map<string, string>();
  const configs: AcpAdapterConfig[] = [];
  for (const definition of result.data) {
    if (seen.has(definition.id)) {
      logger.warn({ id: definition.id }, "Duplicate ACP adapter id; no external adapters registered");
      return [];
    }
    const rejectedGrant = definition.envGrants.find((name) => !isGrantableEnvName(name));
    if (rejectedGrant) {
      logger.warn(
        { id: definition.id, envGrant: rejectedGrant },
        "ACP adapter requests an env grant that is never granted; no external adapters registered"
      );
      return [];
    }
    const settingsPrefix = acpSettingsKeyPrefix(definition.id);
    for (const [otherPrefix, otherId] of settingsPrefixes) {
      if (settingsPrefix === otherPrefix
        || settingsPrefix.startsWith(otherPrefix)
        || otherPrefix.startsWith(settingsPrefix)) {
        logger.warn(
          { id: definition.id, otherId },
          "ACP adapter settings prefixes collide; no external adapters registered"
        );
        return [];
      }
    }
    seen.add(definition.id);
    settingsPrefixes.set(settingsPrefix, definition.id);
    configs.push({ ...definition, permissionPolicyKey: permissionPolicySettingKey(definition.id) });
  }
  return configs;
}

/** `acp_gemini` → `acpGemini`, the descriptor's version-1 settings prefix. */
export function acpSettingsKeyPrefix(id: string): string {
  return id
    .split("_")
    .map((part, index) => (index === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`))
    .join("");
}

/** `acp_gemini` → `ACP_GEMINI_PERMISSION_POLICY`, the env var that locks the key. */
function permissionPolicyEnvName(id: string): string {
  return `${id.toUpperCase()}_PERMISSION_POLICY`;
}

function permissionPolicySettingKey(id: string): string {
  return `${acpSettingsKeyPrefix(id)}PermissionPolicy`;
}

/**
 * An adapter's permission posture. All three are **tier 2** for the reason
 * `terminalEnabled` is: each decides what an agent is allowed to do on the
 * operator's Mac, so a paired client can only set one behind the Mac's
 * `REMOTE_SETTINGS_ADMIN` switch.
 *
 * - `reject` — the default and the documented conservative response: a
 *   permission request selects a rejection option the agent offered, or
 *   cancels. Nothing waits, and nobody is asked.
 * - `ask` — hold the request open for the person driving the session
 *   (`POST /api/agent-sessions/:id/permissions/:requestId`), bounded by
 *   `permissionTimeoutMs`, after which the conservative response above is what
 *   the agent gets. Opt-in rather than implied by a connected client, because a
 *   posture that changed with who happened to be listening would be no posture
 *   at all — and because every turn under the default would otherwise stall for
 *   the timeout before refusing.
 * - `auto_allow` — the unattended posture: select an allow option the agent
 *   supplied for that request, without asking anyone, even while a client is
 *   connected. It never invents or persists an implicit `allow_always`.
 *
 * In every posture the answer is an option the *agent* offered for that
 * request; none of them can express one it did not.
 */
export const acpPermissionPolicySchema = z.enum(["reject", "ask", "auto_allow"]);

export type AcpPermissionPolicy = z.infer<typeof acpPermissionPolicySchema>;

export function acpPermissionPolicy(config: ServiceConfig, adapter: AcpAdapterConfig): AcpPermissionPolicy {
  const value = config.settingsValues?.[adapter.permissionPolicyKey];
  const parsed = acpPermissionPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : "reject";
}

/**
 * The registry row for one configured adapter.
 *
 * The policy answers are conservative on purpose, and each is a real decision:
 *
 * - `promptDelivery: "turn"` — ACP v1 has no stable system-prompt surface an
 *   adapter could install a standing instruction into, so the contract rides
 *   each turn.
 * - `turnDiffSource: "settle_time_git"` — v1 reports file changes as tool-call
 *   content rather than a turn diff, and deriving one from that would risk
 *   double-reporting against the settle-time tracker. The Git delta is the
 *   honest source.
 * - `workspaceSkills: { mode: "none" }` — AgentRoom cannot assert what an
 *   arbitrary agent loads from a workspace, and advertising skills a session may
 *   ignore is exactly what the `available: false` rule exists to prevent.
 * - `restoreStrategy: "native_resume"` — the handshake *enforces* this: an agent
 *   advertising neither `session/resume` nor `loadSession` is refused at
 *   initialize, so no unrestorable session ever exists to be idle-reaped.
 */
export function acpRunnerDescriptor(adapter: AcpAdapterConfig): RunnerDescriptor {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    promptDelivery: "turn",
    turnDiffSource: "settle_time_git",
    workspaceSkills: { mode: "none" },
    skillSourceDirs: [],
    skillInvocationPrefix: "/",
    settingsKeyPrefix: acpSettingsKeyPrefix(adapter.id),
    settings: [
      {
        field: "permissionPolicy",
        schema: acpPermissionPolicySchema.optional(),
        tier: 2,
        env: permissionPolicyEnvName(adapter.id),
        valueKind: "string",
        defaultValue: "reject"
      }
    ],
    restoreStrategy: "native_resume",
    // Configured means the operator's allowlisted binary is actually spawnable.
    // This spawns nothing: it is the same statement `configured` makes for
    // Codex's executable, and runtime readiness stays the separate authority.
    isConfigured: () => admitExecutable(adapter.command).ok
  };
}
