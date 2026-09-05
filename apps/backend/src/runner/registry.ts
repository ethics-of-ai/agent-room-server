import { z } from "zod";
import type { ServiceConfig } from "../domain/models";
import type { ManagedSettingDefinition } from "../domain/managedSettings";
import {
  defaultClaudeCodeLoadWorkspaceSkills,
  defaultClaudeCodePermissionMode,
  defaultCursorAutoReview,
  defaultCursorLoadWorkspaceSettings,
  defaultCursorSandbox
} from "../domain/runnerDefaults";
import {
  claudeCodePermissionModeSchema,
  codexApprovalPolicySchema,
  codexSandboxModeSchema,
  codingAgentModelIdSchema,
  codingAgentReasoningEffortSchema,
  codingAgentServiceTierIdSchema,
  cursorReasoningEffortSchema,
  cursorServiceTierSchema,
  deepseekPermissionModeSchema,
  deepseekProviderSchema
} from "../domain/settingValueSchemas";
import type { RunnerRestoreStrategy } from "./shared/PersistentRunnerSessionHost";
import { loadsWorkspaceSettings } from "./claudeCode/settings";
import { loadsCursorWorkspaceSettings } from "./cursor/settings";
import { DEEPSEEK_QUESTION_PROMPT_INSTRUCTION } from "./deepseek/promptQuestions";

/**
 * Central declaration for runner-specific behavior.
 *
 * Presentation may name a runner. Behavioral decisions outside `runner/` must
 * use a descriptor field instead of branching on runner identity.
 *
 * Generalize the **dispatch**, never the **payload**. A descriptor field replaces a
 * conditional; it must not flatten what a runner's native protocol or trust
 * posture actually says. That is why `workspaceSkills` names only *that* a gate
 * exists while the adapter keeps *what the gate is*, and why there is
 * deliberately no universal permission enum here — Codex's sandbox/network pin
 * and Claude Code's `settingSources` gate stay per-runner, documented under
 * their own headings in docs/safety/TRUST_AND_SAFETY.md.
 *
 * Startup has two stages because validating `runnerKind` requires the complete
 * registry. Built-ins load first. Startup then admits configured external
 * adapters before the settings layer rebuilds its derived schemas.
 *
 * Adding a bundled runner remains a deliberate rollout decision because the id
 * crosses `/api/runners`, `/api/config`, and `settings.json`. The built-in list
 * is currently `codex`, `claude_code`, `deepseek`, and `cursor`; a test rejects
 * an unreviewed fifth entry. See `DEEPSEEK_HARNESS_RUNNER.md` for the downgrade
 * hazard and Mac-side guard, and `CURSOR_SDK_RUNNER.md` for the fourth id.
 */

/**
 * Where the backend delivers a *standing* instruction — one that is constant for
 * the life of a session, so a runner able to install it once should.
 *
 * - `turn` — `AgentTurnContextAssembler` composes it into every turn prompt.
 * - `system` — the adapter installs it on the runner's own system prompt, so the
 *   assembler must not repeat it per turn. Claude Code caches that prompt;
 *   repeating a constant per turn would both spoil the cache and pay for the
 *   same tokens on every turn.
 *
 * This governs standing instructions only. The volatile per-turn injections (the
 * diagram human-edit summary and the diagram render feedback) ride the turn
 * prompt for **every** runner regardless, because a value that changes between
 * turns cannot live in a cached system prompt.
 */
export type RunnerPromptDelivery = "turn" | "system";

/**
 * Who reports what a turn changed on disk.
 *
 * - `runner` — the adapter emits its own diff (Codex `turn/diff/updated`).
 * - `settle_time_git` — the adapter reports none, so `AgentTurnGitDiffTracker`
 *   snapshots the workspace's read-only Git status at turn start and emits the
 *   settle-time delta as that turn's `coding_diff_updated`.
 *
 * Taking a baseline for a `runner` source would double-report the same turn,
 * which is why this is a policy rather than a belt-and-braces default.
 */
export type RunnerTurnDiffSource = "runner" | "settle_time_git";

/**
 * How a runner exposes clarifying questions.
 *
 * - `native` means the adapter receives a real protocol callback/request and
 *   maps it into the canonical question pair.
 * - `prompt_contract` means the runner has no request channel, so the turn
 *   assembler teaches it AgentRoom's bounded in-band block and the adapter
 *   parses that block from assistant text.
 * - `none` means AgentRoom offers no question mechanism for this runner.
 *
 * This is dispatch policy only. The native payload and the prompt-contract
 * parser stay inside their adapters.
 */
export type RunnerClarifyingQuestions =
  | { readonly mode: "native" }
  | { readonly mode: "prompt_contract"; readonly instruction: string }
  | { readonly mode: "none" };

/**
 * Whether a session of this runner kind actually loads the workspace skills that
 * the bounded skills read (`GET /api/workspaces/:id/skills`) lists.
 *
 * - `native` — always loaded (Codex loads repo skills with no isolation toggle).
 * - `gated` — loaded only under the adapter's own trust rule. The policy names
 *   *that* a gate exists and calls through to the adapter's rule rather than
 *   restating it, because restating a trust posture here is exactly how two
 *   runners' postures get flattened into one lossy enum.
 * - `none` — never loaded.
 *
 * A discriminated union rather than a bare tag plus an optional predicate: the
 * compiler then requires the gate on the branch that needs one, so "gated with
 * no gate" — which would have to default closed and be untestable — cannot be
 * registered at all.
 */
export type RunnerWorkspaceSkills =
  | { readonly mode: "native" }
  | { readonly mode: "none" }
  | { readonly mode: "gated"; readonly gate: (config: ServiceConfig) => boolean };

/**
 * Everything the backend needs to know about a runner that is not the runner's
 * own protocol. Adding a runner is adding a row: the id joins
 * {@link registeredRunnerKinds} and the compiler then demands the descriptor.
 */
export interface RunnerDescriptor {
  /**
   * A built-in id, or the id an operator gave an external adapter. Descriptors
   * are looked up by this value, so it is the registry's key as well as its
   * name.
   */
  readonly id: string;
  /** Presentation only — never a behavioral input. */
  readonly displayName: string;
  readonly promptDelivery: RunnerPromptDelivery;
  readonly turnDiffSource: RunnerTurnDiffSource;
  readonly clarifyingQuestions: RunnerClarifyingQuestions;
  readonly workspaceSkills: RunnerWorkspaceSkills;
  /** Fixed committed skill directories this runner natively loads, in precedence order. */
  readonly skillSourceDirs: readonly string[];
  /** The token a client's composer inserts to invoke a skill (`/name`, `$name`). */
  readonly skillInvocationPrefix: string;
  /**
   * The camelCase prefix this runner's *flat* managed setting keys carry —
   * `codex` for `codexModel`, `claudeCode` for `claudeCodePermissionMode`.
   *
   * It exists so nothing outside this file has to know that `codexSandboxMode`
   * belongs to Codex: the version-1 flat key is `prefix + Field` and the
   * version-2 address of the same setting is `runners.<id>.<field>`, so
   * `config/settingsStore.ts` can serve, validate, and migrate both shapes
   * without naming a runner.
   *
   * Prefixes must stay mutually non-prefixing, or one runner's keys would
   * resolve to another's — `apps/backend/test/runnerRegistry.test.ts` asserts it.
   */
  readonly settingsKeyPrefix: string;
  /**
   * The managed settings this runner owns, in file order.
   *
   * These keys once appeared in the settings schema, environment table, tier
   * table, defaults map, and Swift mirrors. That duplication made a runner's
   * model setting depend on unrelated files.
   * Declared here, a runner's settings reach `GET /api/config`, `PATCH`, the
   * settings file, and environment resolution because the settings layer walks
   * the descriptors, not because someone remembered to add five rows.
   *
   * The declarations reuse the same schema objects `serviceConfigSchema` is built
   * from, which is what keeps "a file that parses can never make startup throw"
   * true by construction rather than by review.
   */
  readonly settings: readonly ManagedSettingDefinition[];
  /**
   * How a conversation whose child process is gone is restored. The shared
   * session host arms an idle timer only for a runner it can restore, so this
   * value decides whether reaping is safe at all — see
   * `runner/shared/PersistentRunnerSessionHost.ts`.
   */
  readonly restoreStrategy: RunnerRestoreStrategy;
  /**
   * Whether the bootstrap configuration this adapter cannot start without is
   * present. Deliberately **not** a readiness probe: it spawns nothing and asks
   * only whether the operator supplied the settings. Runtime readiness (can the
   * backend actually spawn the child and complete the handshake?) is a separate
   * authority reported by runtime capability discovery.
   */
  readonly isConfigured: (config: ServiceConfig) => boolean;
}

/**
 * The **built-in** runner ids. This tuple is the compile-time admission list:
 * the `RegisteredRunnerKind` type and the descriptor table's exhaustiveness
 * derive from it, so adding a built-in runner is adding a row the compiler then
 * demands.
 *
 * This is not the complete runtime admission list. Operator-defined adapters
 * join through {@link registerExternalRunnerDescriptors}; this tuple stays
 * closed to what the build ships.
 *
 * Adding `deepseek` exposed a downgrade hazard that still applies to future
 * built-in ids. An unknown
 * `runners.<id>` namespace in the settings document is preserved-but-never-
 * applied by both readers, so a third runner's *settings* are safe on an older
 * build — but `global.runnerKind` is a **known** key, and a malformed known
 * value still makes the whole file unusable. Selecting a bundled runner an
 * older AgentRoom does not know therefore drops that operator's entire trust
 * posture onto defaults on a downgrade. That is a documented consequence with a
 * Mac-side guard, not a reason to relax the whole-file rule.
 */
export const registeredRunnerKinds = ["codex", "claude_code", "deepseek", "cursor"] as const;

export type RegisteredRunnerKind = (typeof registeredRunnerKinds)[number];

/**
 * The runner id schema every external-input boundary validates against.
 *
 * It resolves against the **live** registry rather than a fixed enum, because
 * which runners exist is now partly a startup-time answer: the built-in table
 * plus whatever external adapters stage 1 admitted. That keeps the property the
 * enum had — a registered runner is accepted everywhere at once and an
 * unregistered one is rejected everywhere at once — while letting an operator's
 * configured adapter be a session's `runnerKind`.
 *
 * Note the direction: `domain/schemas.ts` imports and re-exports this rather
 * than declaring it. The domain owns contracts, but *which runners exist* is the
 * registry's answer. A second hand-maintained copy would drift.
 */
export const agentRunnerKindSchema = z
  .string()
  .superRefine((value, ctx) => {
    if (isRegisteredRunnerKind(value)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown runner kind: ${value}`
    });
  });

const builtInRunnerDescriptors: Record<RegisteredRunnerKind, RunnerDescriptor> = {
  codex: {
    id: "codex",
    displayName: "Codex",
    // Codex has no stable system-prompt surface AgentRoom can install into, so
    // the standing contract is composed into each turn.
    promptDelivery: "turn",
    // `turn/diff/updated` arrives on the runner's own stream.
    turnDiffSource: "runner",
    clarifyingQuestions: { mode: "native" },
    // Repo skills load natively with no isolation toggle; registering the
    // workspace is the trust decision (docs/safety/TRUST_AND_SAFETY.md).
    workspaceSkills: { mode: "native" },
    skillSourceDirs: [".codex/skills", ".agents/skills"],
    skillInvocationPrefix: "$",
    settingsKeyPrefix: "codex",
    settings: [
      { field: "model", schema: codingAgentModelIdSchema.optional(), tier: 1, env: "CODEX_MODEL", valueKind: "string" },
      {
        field: "reasoningEffort",
        schema: codingAgentReasoningEffortSchema.optional(),
        tier: 1,
        env: "CODEX_REASONING_EFFORT",
        valueKind: "string"
      },
      {
        field: "serviceTier",
        schema: codingAgentServiceTierIdSchema.optional(),
        tier: 1,
        env: "CODEX_SERVICE_TIER",
        valueKind: "string"
      },
      // Codex's trust posture, and deliberately not reconciled with Claude
      // Code's below into one permission enum: an approval policy and a
      // permission mode are different questions with different answers.
      // See docs/safety/TRUST_AND_SAFETY.md.
      {
        field: "approvalPolicy",
        schema: codexApprovalPolicySchema.optional(),
        tier: 2,
        env: "CODEX_APPROVAL_POLICY",
        valueKind: "string",
        defaultValue: "never"
      },
      {
        field: "sandboxMode",
        schema: codexSandboxModeSchema.optional(),
        tier: 2,
        env: "CODEX_SANDBOX_MODE",
        valueKind: "string",
        defaultValue: "workspace-write"
      },
      {
        field: "workspaceNetworkAccess",
        schema: z.boolean().optional(),
        tier: 2,
        env: "CODEX_WORKSPACE_NETWORK_ACCESS",
        valueKind: "boolean",
        defaultValue: false
      }
    ],
    restoreStrategy: "native_resume",
    isConfigured: (config) => Boolean(config.codexExecutable)
  },
  claude_code: {
    id: "claude_code",
    displayName: "Claude Code",
    // The SDK session carries a cached system prompt, so the adapter appends the
    // standing contract there once (runner/claudeCode/settings.ts) instead of
    // paying for it on every turn.
    promptDelivery: "system",
    // The SDK stream has no `turn/diff/updated` analog.
    turnDiffSource: "settle_time_git",
    clarifyingQuestions: { mode: "native" },
    workspaceSkills: {
      mode: "gated",
      // Called through rather than referenced, so the binding resolves at call
      // time: the adapter's rule is `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS` honored
      // only under `bypassPermissions`, and it stays the adapter's.
      gate: (config) => loadsWorkspaceSettings(config)
    },
    skillSourceDirs: [".claude/skills"],
    skillInvocationPrefix: "/",
    settingsKeyPrefix: "claudeCode",
    settings: [
      {
        field: "model",
        schema: codingAgentModelIdSchema.optional(),
        tier: 1,
        env: "CLAUDE_CODE_MODEL",
        valueKind: "string"
      },
      {
        field: "reasoningEffort",
        schema: codingAgentReasoningEffortSchema.optional(),
        tier: 1,
        env: "CLAUDE_CODE_REASONING_EFFORT",
        valueKind: "string"
      },
      {
        field: "permissionMode",
        schema: claudeCodePermissionModeSchema.optional(),
        tier: 2,
        env: "CLAUDE_CODE_PERMISSION_MODE",
        valueKind: "string",
        defaultValue: defaultClaudeCodePermissionMode
      },
      {
        field: "loadWorkspaceSkills",
        schema: z.boolean().optional(),
        tier: 2,
        env: "CLAUDE_CODE_LOAD_WORKSPACE_SKILLS",
        valueKind: "boolean",
        defaultValue: defaultClaudeCodeLoadWorkspaceSkills
      },
      {
        field: "inheritProviderAuth",
        schema: z.boolean().optional(),
        tier: 2,
        env: "CLAUDE_CODE_INHERIT_PROVIDER_AUTH",
        valueKind: "boolean",
        defaultValue: false
      }
    ],
    restoreStrategy: "native_resume",
    // The Claude Agent SDK resolves its own bundled CLI when
    // `CLAUDE_CODE_EXECUTABLE` is unset, so there is no bootstrap value the
    // backend must have. Whether the operator is signed in is Mac bootstrap
    // readiness, which the backend learns from runtime capability discovery.
    isConfigured: () => true
  },
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek Harness",
    // The SDK runtime's `initialize` carries no system-prompt parameter — the
    // persona belongs to the composition its own cordis.yml selects — so the
    // standing contract rides each turn prompt, as it does for Codex.
    promptDelivery: "turn",
    // The session log has no diff event, so AgentTurnGitDiffTracker derives the
    // turn's diff from the workspace's Git status at settlement.
    turnDiffSource: "settle_time_git",
    // The SDK wire has no server-to-client request. The adapter recognizes one
    // bounded line-start block in assistant text, then sends the person's
    // answer as another SDK prompt while the same AgentRoom turn stays open.
    clarifyingQuestions: {
      mode: "prompt_contract",
      instruction: DEEPSEEK_QUESTION_PROMPT_INSTRUCTION
    },
    // `dsh` discovers skills through its own filesystem provider, but *whether*
    // a given composition loads one is the profile's answer and not something
    // this backend can see from the wire. Reporting `none` is the honest state
    // until that is verified against a real runtime: advertising invocations a
    // session would ignore is the failure the skills read exists to avoid.
    workspaceSkills: { mode: "none" },
    skillSourceDirs: [],
    skillInvocationPrefix: "/",
    settingsKeyPrefix: "deepseek",
    settings: [
      {
        field: "model",
        schema: codingAgentModelIdSchema.optional(),
        tier: 1,
        env: "DEEPSEEK_MODEL",
        valueKind: "string"
      },
      {
        field: "provider",
        schema: deepseekProviderSchema.optional(),
        tier: 1,
        env: "DEEPSEEK_PROVIDER",
        valueKind: "string"
      },
      {
        field: "maxTokens",
        schema: z.number().int().positive().optional(),
        tier: 1,
        env: "DEEPSEEK_MAX_TOKENS",
        valueKind: "number"
      },
      // The harness's own approval posture, and deliberately not reconciled with
      // the Codex approval policy or the Claude Code permission mode above: all
      // three are different decisions with different vocabularies, and this one's
      // belongs to the operator's composed profile rather than to AgentRoom.
      // See docs/safety/TRUST_AND_SAFETY.md.
      {
        field: "permissionMode",
        schema: deepseekPermissionModeSchema.optional(),
        tier: 2,
        env: "DEEPSEEK_PERMISSION_MODE",
        valueKind: "string"
      }
    ],
    // The SDK wire has no resume method, and the same session id creates a fresh
    // pair when the selected composition did not mount persistence. Because the
    // handshake cannot prove that capability, AgentRoom must not idle-reap this
    // child or claim a killed/crashed one can continue its conversation.
    restoreStrategy: "unsupported",
    // Both halves are bootstrap this runner cannot start without. The runtime
    // demands an explicit Cordis composition and exits nonzero when it has
    // none, so an executable on its own is not a configured runner — reporting
    // one would put a runner in every picker that fails its first turn with the
    // child's one-line usage error.
    isConfigured: (config) => Boolean(config.deepseekExecutable && config.deepseekCordisConfig)
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor",
    // `AgentOptions` has no system-prompt parameter, so the standing contract
    // rides each turn prompt, as it does for Codex and DeepSeek.
    promptDelivery: "turn",
    // The stream carries per-call tool results but no turn-level diff, so
    // AgentTurnGitDiffTracker derives the turn's diff at settlement.
    turnDiffSource: "settle_time_git",
    // A real callback: the adapter registers one custom tool whose execute()
    // holds the SDK's tool call open on the shared question wait
    // (docs/engineering/CURSOR_SDK_RUNNER.md, "Questions and permissions").
    // The model calls a tool and the adapter receives a
    // callback; that the callback rides AgentRoom's own wire to the host child
    // is adapter-internal.
    clarifyingQuestions: { mode: "native" },
    workspaceSkills: {
      mode: "gated",
      // Called through, as for Claude Code: the rule is the adapter's.
      gate: (config) => loadsCursorWorkspaceSettings(config)
    },
    // Cursor loads all four under its `project` settings source and none of
    // the user-level directories (fact 6); the order is the vendor's documented
    // precedence.
    skillSourceDirs: [".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
    skillInvocationPrefix: "/",
    settingsKeyPrefix: "cursor",
    settings: [
      { field: "model", schema: codingAgentModelIdSchema.optional(), tier: 1, env: "CURSOR_MODEL", valueKind: "string" },
      // Open rather than the closed `codingAgentReasoningEffortSchema`: each
      // Cursor model declares its own depth parameter and vocabulary, so the
      // live catalog is the authority and the adapter applies this default only
      // where the selected model offers it (`runner/cursor/settings.ts`).
      {
        field: "reasoningEffort",
        schema: cursorReasoningEffortSchema.optional(),
        tier: 1,
        env: "CURSOR_REASONING_EFFORT",
        valueKind: "string"
      },
      {
        field: "serviceTier",
        schema: cursorServiceTierSchema.optional(),
        tier: 1,
        env: "CURSOR_SERVICE_TIER",
        valueKind: "string"
      },
      // Cursor's trust posture, three booleans the adapter passes straight to
      // the SDK, and deliberately not reconciled with the Codex sandbox mode or
      // the Claude Code permission mode: `sandbox` bounds writes and network,
      // not reads (fact 7), which neither of those vocabularies can say. See
      // docs/safety/TRUST_AND_SAFETY.md.
      {
        field: "sandbox",
        schema: z.boolean().optional(),
        tier: 2,
        env: "CURSOR_SANDBOX",
        valueKind: "boolean",
        defaultValue: defaultCursorSandbox
      },
      {
        field: "autoReview",
        schema: z.boolean().optional(),
        tier: 2,
        env: "CURSOR_AUTO_REVIEW",
        valueKind: "boolean",
        defaultValue: defaultCursorAutoReview
      },
      {
        field: "loadWorkspaceSettings",
        schema: z.boolean().optional(),
        tier: 2,
        env: "CURSOR_LOAD_WORKSPACE_SETTINGS",
        valueKind: "boolean",
        defaultValue: defaultCursorLoadWorkspaceSettings
      }
    ],
    // `Agent.resume(agentId)` continues a persisted agent from a fresh process
    // when the store is pinned under STATE_DIR (fact 1).
    restoreStrategy: "native_resume",
    // The SDK is bundled and resolves its own credential (`CURSOR_API_KEY`,
    // else the stored web sign-in), so there is no bootstrap value the backend
    // must hold: the same answer as Claude Code's. Whether the operator is
    // signed in is Mac bootstrap readiness, and the backend learns it from
    // runtime capability discovery.
    isConfigured: () => true
  }
};

/**
 * Externally configured (tier-3) adapters, admitted at startup.
 *
 * This is stage 1 of the two-stage startup, finally carrying what the earlier
 * phases only reserved room for. It is a module-level map rather than a
 * constructor argument because the descriptor table is what
 * {@link agentRunnerKindSchema} resolves against, and that schema is imported
 * as a value all over the domain — threading a registry instance through every
 * import site would be a larger change than the feature.
 *
 * Registration happens exactly once, before managed settings are parsed
 * (`config/serviceConfig.ts`), because validating the managed `runnerKind`
 * requires knowing which runners exist.
 */
const externalRunnerDescriptors = new Map<string, RunnerDescriptor>();

/**
 * Admit externally configured adapters. Replaces any previous set, so a test
 * (or a re-read of configuration) cannot accumulate stale ids.
 *
 * An id that collides with a built-in, or a settings prefix that collides with
 * or prefixes another runner's, is refused rather than silently shadowing:
 * `managedSettingScope` would otherwise resolve one runner's settings to
 * another's namespace, which is a trust posture landing on the wrong runner.
 */
export function registerExternalRunnerDescriptors(descriptors: readonly RunnerDescriptor[]): void {
  const candidates = new Map<string, RunnerDescriptor>();
  const reject = (message: string): never => {
    externalRunnerDescriptors.clear();
    rebuildRunnerSettingScopes();
    throw new Error(message);
  };

  for (const descriptor of descriptors) {
    if (Object.prototype.hasOwnProperty.call(builtInRunnerDescriptors, descriptor.id)) {
      reject(`External runner id "${descriptor.id}" collides with a built-in runner`);
    }
    if (candidates.has(descriptor.id)) {
      reject(`Duplicate external runner id "${descriptor.id}"`);
    }
    candidates.set(descriptor.id, descriptor);
  }

  const prefixOwners = new Map<string, string>();
  const candidateDescriptors = [
    ...registeredRunnerKinds.map((kind) => builtInRunnerDescriptors[kind]),
    ...candidates.values()
  ];
  for (const descriptor of candidateDescriptors) {
    const prefix = descriptor.settingsKeyPrefix;
    const duplicateOwner = prefixOwners.get(prefix);
    if (duplicateOwner) {
      reject(
        `Runner settings prefix "${prefix}" is shared by "${duplicateOwner}" and "${descriptor.id}"`
      );
    }
    for (const [otherPrefix, otherOwner] of prefixOwners) {
      if (prefix.startsWith(otherPrefix) || otherPrefix.startsWith(prefix)) {
        reject(
          `Runner settings prefix "${prefix}" for "${descriptor.id}" shadows "${otherPrefix}" for "${otherOwner}"`
        );
      }
    }
    prefixOwners.set(prefix, descriptor.id);
  }

  externalRunnerDescriptors.clear();
  for (const [id, descriptor] of candidates) externalRunnerDescriptors.set(id, descriptor);
  rebuildRunnerSettingScopes();
}

export function isRegisteredRunnerKind(value: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(builtInRunnerDescriptors, value)
    || externalRunnerDescriptors.has(value)
  );
}

/** True for an id this build ships, as opposed to a configured adapter. */
export function isBuiltInRunnerKind(value: string): value is RegisteredRunnerKind {
  return Object.prototype.hasOwnProperty.call(builtInRunnerDescriptors, value);
}

export function runnerDescriptor(runnerKind: string): RunnerDescriptor {
  const descriptor = isBuiltInRunnerKind(runnerKind)
    ? builtInRunnerDescriptors[runnerKind]
    : externalRunnerDescriptors.get(runnerKind);
  if (!descriptor) throw new Error(`Unknown runner kind: ${runnerKind}`);
  return descriptor;
}

/** Every registered descriptor: the built-ins first, then configured adapters. */
export function allRunnerDescriptors(): readonly RunnerDescriptor[] {
  return [
    ...registeredRunnerKinds.map((kind) => builtInRunnerDescriptors[kind]),
    ...externalRunnerDescriptors.values()
  ];
}

/**
 * Whether a session of this runner kind would actually load the workspace skills
 * the bounded skills read lists. Reported as `available: false` with an empty
 * list rather than advertising invocations an isolated session would ignore.
 */
export function workspaceSkillsAvailable(runnerKind: string, config: ServiceConfig): boolean {
  const policy = runnerDescriptor(runnerKind).workspaceSkills;
  switch (policy.mode) {
    case "native":
      return true;
    case "none":
      return false;
    case "gated":
      return policy.gate(config);
  }
}

/**
 * These states stay separate so the UI cannot report a runner as usable when
 * the backend cannot start it.
 *
 * - `registered` — the backend knows this runner id exists.
 * - `configured` — it has the bootstrap settings it needs.
 * - `enabled` — the operator has turned it on.
 *
 * The fourth state, `ready`, is a different authority and is deliberately not
 * resolved here: it is what the adapter's own capability discovery proved at
 * runtime (`runner/runtimeReadiness.ts`), so it is observed rather than derived
 * from configuration. It remains unknown until a capability request probes the
 * runner, so it belongs in the public projection rather than this record.
 */
export interface RunnerAvailability {
  readonly runnerKind: string;
  readonly registered: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
}

export function runnerAvailability(runnerKind: string, config: ServiceConfig): RunnerAvailability {
  if (!isRegisteredRunnerKind(runnerKind)) {
    return { runnerKind, registered: false, configured: false, enabled: false };
  }
  return {
    runnerKind,
    registered: true,
    configured: runnerDescriptor(runnerKind).isConfigured(config),
    // Built-in runners are enabled when registered. External adapters join the
    // registry only after their startup gate admits them.
    enabled: true
  };
}

/**
 * The safe/public descriptor projection `GET /api/runners` serves, and the only
 * shape of a descriptor that leaves this process.
 *
 * What is absent is the point. A descriptor's policy fields (`promptDelivery`,
 * `turnDiffSource`, `workspaceSkills`, `restoreStrategy`) are how the backend
 * decides things and are no client's business, and the tier-3 material a runner
 * needs to start — an executable path, an environment name, a Keychain slot —
 * is never in a descriptor at all. `isConfigured` is reported only as the
 * boolean `configured`, so "the operator supplied the bootstrap" crosses the
 * wire without what the bootstrap *is*. See docs/safety/TRUST_AND_SAFETY.md.
 */
export interface PublicRunnerDescriptor extends RunnerAvailability {
  readonly displayName: string;
  /**
   * What the adapter's own capability discovery proved about this runner in this
   * backend process.
   *
   * **Absent means unprobed, not unready.** Nothing spawns a child to answer
   * this route, so a runner no client has asked about carries no `ready` field
   * at all; reporting `false` there would be the "ready in the UI, unusable by
   * the backend" failure with the sign flipped. A client that wants the answer
   * asks for the runner's capabilities, which is the probe.
   */
  readonly ready?: boolean;
}

/**
 * What a runtime probe has observed, or `undefined` for a runner nothing has
 * probed. Passed in rather than read here: readiness belongs to the process that
 * spawned the children, and the offline catalog file — written at startup, when
 * by definition nothing has been probed — calls without it and emits no `ready`.
 */
export type RunnerReadinessLookup = (runnerKind: string) => boolean | undefined;

export function publicRunnerDescriptors(
  config: ServiceConfig,
  ready?: RunnerReadinessLookup
): PublicRunnerDescriptor[] {
  return allRunnerDescriptors().map((descriptor) => {
    const observed = ready?.(descriptor.id);
    return {
      ...runnerAvailability(descriptor.id, config),
      displayName: descriptor.displayName,
      ...(observed === undefined ? {} : { ready: observed })
    };
  });
}

/**
 * Where a managed setting lives in the version-2 settings document:
 * `global.<field>`, or `runners.<runnerKind>.<field>`.
 *
 * Resolving it here rather than from a hand-written table in `config/` is what
 * keeps the settings layer free of runner literals — a table there would be a
 * second admission list to maintain, and adding a runner would again mean
 * editing a file outside `runner/`.
 */
export type ManagedSettingScope =
  | { readonly scope: "global" }
  | { readonly scope: "runner"; readonly runnerKind: string; readonly field: string };

/** One runner-owned managed setting, with the version-1 flat key it answers to. */
export interface RunnerManagedSetting {
  readonly runnerKind: string;
  /** The version-1 flat key: `settingsKeyPrefix` + the capitalized field name. */
  readonly key: string;
  readonly definition: ManagedSettingDefinition;
}

/**
 * Every runner-owned managed setting, in registration order and then descriptor
 * order. The settings layer walks this instead of a hand-written table, so a
 * registered runner's settings exist everywhere at once.
 */
export function runnerManagedSettings(): RunnerManagedSetting[] {
  return allRunnerDescriptors().flatMap((descriptor) =>
    descriptor.settings.map((definition) => ({
      runnerKind: descriptor.id,
      key: runnerSettingKey(descriptor.settingsKeyPrefix, definition.field),
      definition
    }))
  );
}

export function managedSettingScope(key: string): ManagedSettingScope {
  const owned = runnerSettingScopes.get(key);
  // A key no descriptor declares is global — including one that merely *looks*
  // like a runner's (`codexish`), which belongs to nobody rather than silently
  // becoming `runners.codex.ish`. Prefix arithmetic used to answer this; the
  // declarations answer it exactly.
  return owned ?? { scope: "global" };
}

function runnerSettingKey(prefix: string, field: string): string {
  return `${prefix}${field[0].toUpperCase()}${field.slice(1)}`;
}

/**
 * Flat version-1 key → the version-2 address that owns it. Rebuilt whenever the
 * external descriptor set changes, so a configured adapter's settings are
 * addressable the moment it is admitted.
 */
const runnerSettingScopes = new Map<string, ManagedSettingScope>();

function rebuildRunnerSettingScopes(): void {
  runnerSettingScopes.clear();
  for (const descriptor of allRunnerDescriptors()) {
    for (const definition of descriptor.settings) {
      runnerSettingScopes.set(runnerSettingKey(descriptor.settingsKeyPrefix, definition.field), {
        scope: "runner",
        runnerKind: descriptor.id,
        field: definition.field
      });
    }
  }
}

rebuildRunnerSettingScopes();
