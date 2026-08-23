import { z } from "zod";

/**
 * The value vocabularies a managed setting can hold, in a module whose only
 * import is zod.
 *
 * They moved out of `domain/schemas.ts` for the same reason
 * `domain/runnerDefaults.ts` did: since Phase 3 the runner registry is *upstream*
 * of `domain/schemas.ts` (which imports `agentRunnerKindSchema` from it), and
 * since Phase 5 each `RunnerDescriptor` declares its own managed settings —
 * including the schema each one validates against. Reaching back into
 * `domain/schemas.ts` for those schemas would close the loop
 * (`schemas` → `registry` → `schemas`) and leave initialization order deciding
 * whether a documented trust vocabulary is `undefined` at module load. A leaf
 * cannot participate in a cycle.
 *
 * `domain/schemas.ts` re-exports every name here, so no import site changed.
 */

/**
 * The reasoning-effort vocabulary of the two runners AgentRoom *ships*, and the
 * one a managed setting (`codexReasoningEffort`, `claudeCodeReasoningEffort`) is
 * bounded to. It stays closed precisely because `/api/config` reports it as that
 * setting's `options`, and a client must not be offered a value the runner it
 * belongs to would reject.
 */
export const codingAgentReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);

/**
 * The reasoning effort a *turn* may select, which is deliberately **not** the
 * closed enum above.
 *
 * A registered runner advertises its own effort vocabulary through
 * `GET /api/coding-agent/capabilities`, and clients render that list — the whole
 * point of the capability descriptor. A configured ACP adapter proves the enum
 * was too narrow: the reference agent offers `max` and `ultra` beside the four
 * shared values, and either filtering them out (hiding a real capability) or
 * listing them under a schema that then refuses them (an edit that looks valid
 * and fails at the write) is dishonest. So a turn's effort is bounded by *shape*
 * like `model` and `serviceTier` already are, and the vocabulary is the
 * advertising runner's. As with those two, a value the runner does not know is
 * refused by the runner rather than by this schema; it is never passed through a
 * shell.
 */
export const codingAgentReasoningEffortIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const codexApprovalPolicySchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);

export const codexSandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);

export const claudeCodePermissionModeSchema = z.enum(["default", "acceptEdits", "dontAsk", "bypassPermissions"]);

/**
 * Square brackets are part of real model identifiers, not punctuation we can
 * drop: the Claude Code CLI advertises context-window variants as `opus[1m]`,
 * `sonnet[1m]`, and `claude-fable-5[1m]`, and clients send back exactly the id
 * capability discovery gave them. The allowlist stays an allowlist — it is
 * defense in depth, not shell escaping, because the value is only ever passed as
 * an argv element (Claude Code SDK options) or a JSON-RPC field (Codex), never
 * through a shell.
 */
export const codingAgentModelIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:\[\]-]+$/);

export const codingAgentServiceTierIdSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/);

/**
 * DeepSeek Harness's provider route (`initialize.provider`) — the registered
 * adapter every SDK-created agent runs on.
 *
 * Bounded by shape rather than by an enum, and deliberately so: the runtime
 * mounts `dsh-llm-deepseek` for an unowned `deepseek-official` route and
 * otherwise resolves whatever adapter its own composition registered, so the
 * vocabulary belongs to the operator's profile. An enum here would report
 * `options` on `/api/config` that the runtime never agreed to, which is the
 * "an edit that looks valid and fails at the write" failure
 * `codingAgentReasoningEffortIdSchema` above already names.
 */
export const deepseekProviderSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/);

/**
 * DeepSeek Harness's own approval posture, passed to the child as
 * `DSH_PERMISSION_MODE`.
 *
 * Same reasoning as the provider above, and it matters more here because this is
 * a **trust** setting: the values a harness accepts are its approval plugin's,
 * and a stale enum would either hide a posture the operator's build supports or
 * advertise one it rejects. AgentRoom bounds the shape, passes the value
 * through, and does not pretend to own the vocabulary — the posture this runner
 * actually enforces is the composed profile's. See
 * docs/safety/TRUST_AND_SAFETY.md.
 */
export const deepseekPermissionModeSchema = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);
