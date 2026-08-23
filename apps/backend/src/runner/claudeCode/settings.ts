import { readFile } from "node:fs/promises";
import type { CodingAgentTurnSettings, ServiceConfig } from "../../domain/models";
// From the import-free defaults leaf, not `domain/schemas`: the registry that
// carries this module's workspace-settings gate is what `domain/schemas` now
// derives its runner-id schema from, so importing schemas here would close a
// require cycle. See `domain/runnerDefaults.ts`.
import { defaultClaudeCodeLoadWorkspaceSkills, defaultClaudeCodePermissionMode } from "../../domain/runnerDefaults";
import type { AgentRunnerInputPart } from "../AgentRunner";
import { commandAudit } from "../shared/commandAudit";
import { DIAGRAM_PROMPT_INSTRUCTION } from "../../scene/diagram/prompt";

export type ClaudeCodeEffortLevel = "low" | "medium" | "high" | "xhigh";

export interface ClaudeCodeEffectiveSettings {
  model?: string;
  effort?: ClaudeCodeEffortLevel;
}

export function effectiveClaudeCodeSettings(
  config: ServiceConfig,
  settings: CodingAgentTurnSettings | undefined
): ClaudeCodeEffectiveSettings {
  const model = settings?.model ?? config.claudeCodeModel;
  const effort = claudeCodeEffort(settings?.reasoningEffort ?? config.claudeCodeReasoningEffort);
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  };
}

/**
 * Map a requested effort onto the four levels the Claude Code CLI accepts.
 *
 * The parameter is a bounded id rather than `CodingAgentReasoningEffort` because
 * a turn's effort is the *advertising runner's* vocabulary since Phase 4 of
 * `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md`, and another registered
 * runner may legitimately offer values this one has never heard of. An
 * unrecognized value is refused here rather than silently running at the CLI's
 * default. The shared turn schema bounds shape rather than vocabulary so an ACP
 * runner can advertise its own ids; that makes this runner boundary responsible
 * for rejecting a value Claude Code did not advertise.
 */
export function claudeCodeEffort(value: string | undefined): ClaudeCodeEffortLevel | undefined {
  if (value === undefined) return undefined;
  if (value === "none" || value === "minimal" || value === "low") return "low";
  if (value === "medium" || value === "high" || value === "xhigh") return value;
  throw new Error(`Claude Code does not offer the reasoning effort "${value}"`);
}

// Billing source must be deterministic: unless the operator explicitly opts
// into inherited provider credentials, scrub every ANTHROPIC_* variable and
// the Claude Code OAuth token so the spawned CLI falls through to the Mac
// user's `claude login` subscription.
//
// AgentRoom's own bearer token is scrubbed unconditionally — it is our
// transport secret, not a provider credential, so the `inherit provider auth`
// opt-in does not cover it and it must not reach the CLI or the tools a
// `bypassPermissions` turn runs. Mirrors terminal/TerminalSessionService.ts and
// `codexChildEnv` in runner/CodexAppServerRunner.ts.
export function claudeCodeChildEnv(config: ServiceConfig): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AUTH_TOKEN;
  if (config.claudeCodeInheritProviderAuth) return env;
  for (const name of Object.keys(env)) {
    if (name.startsWith("ANTHROPIC_")) delete env[name];
  }
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

// Whether to load the registered workspace's `project` settings source
// (`.claude/settings.json`, `.mcp.json`, `CLAUDE.md`, skills, subagents) for a
// session. Loading it means the workspace's own hooks, MCP servers, `env` /
// `apiKeyHelper`, and `permissions.*` rules take effect inside the spawned CLI,
// so it is only honored when the operator has enabled the toggle AND is running
// the fully-permissive `bypassPermissions` posture — which already trusts the
// registered workspace. Under a stricter configured `permissionMode` the
// workspace's `permissions.allow`/hooks could silently widen the operator's
// chosen posture, so we force isolation (`settingSources: []`) instead of
// documenting the hole. See docs/safety/TRUST_AND_SAFETY.md.
export function loadsWorkspaceSettings(config: ServiceConfig): boolean {
  const permissionMode = config.claudeCodePermissionMode ?? defaultClaudeCodePermissionMode;
  const loadWorkspaceSkills = config.claudeCodeLoadWorkspaceSkills ?? defaultClaudeCodeLoadWorkspaceSkills;
  return loadWorkspaceSkills && permissionMode === "bypassPermissions";
}

export function claudeCodeQueryOptions(
  config: ServiceConfig,
  workspacePath: string,
  settings: ClaudeCodeEffectiveSettings,
  // Capability discovery spawns a probe session in the backend's own cwd (never
  // a registered workspace) and needs only the model list, so it forces
  // isolation: it must never load or execute the backend cwd's project settings
  // (hooks, MCP servers) merely to read `supportedModels()`.
  // `resume` continues a previous SDK session (the SDK reloads its on-disk
  // transcript) after the child process was lost; every other option —
  // including the settings-isolation posture — is rebuilt as for a fresh
  // session, so resuming cannot relax the documented gating.
  options: { forceIsolation?: boolean; resume?: string } = {}
): Record<string, unknown> {
  const permissionMode = config.claudeCodePermissionMode ?? defaultClaudeCodePermissionMode;
  const loadWorkspaceSettings = !options.forceIsolation && loadsWorkspaceSettings(config);
  const diagramInstruction = !options.forceIsolation && config.sceneEngineEnabled !== false
    ? DIAGRAM_PROMPT_INSTRUCTION
    : undefined;
  return {
    cwd: workspacePath,
    env: claudeCodeChildEnv(config),
    ...(options.resume ? { resume: options.resume } : {}),
    includePartialMessages: true,
    // When workspace settings load, discover the `project` source and enable
    // every discovered skill; otherwise pass `[]` for full SDK isolation so no
    // on-disk settings/skills/CLAUDE.md/hooks/MCP servers are read.
    settingSources: loadWorkspaceSettings ? ["project"] : [],
    ...(loadWorkspaceSettings ? { skills: "all" } : {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(diagramInstruction ? { append: diagramInstruction } : {})
    },
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    ...(config.claudeCodeExecutable ? { pathToClaudeCodeExecutable: config.claudeCodeExecutable } : {})
  };
}

export function claudeCodeCommandAudit(config: ServiceConfig): { executableName: string; argsCount: number } {
  return commandAudit(config.claudeCodeExecutable ?? "claude", []);
}

export async function claudeCodeUserMessage(
  prompt: string,
  inputParts: AgentRunnerInputPart[] | undefined,
  sdkSessionId: string | undefined
): Promise<Record<string, unknown>> {
  // The Claude Agent SDK has no local-file image source, so each attachment is
  // read off STATE_DIR and inlined as a base64 image block alongside the text.
  const imageBlocks = await Promise.all(
    (inputParts ?? [])
      .filter((part) => part.type === "localImage")
      .map(async (part) => ({
        type: "image",
        source: {
          type: "base64",
          media_type: part.contentType ?? "image/png",
          data: (await readFile(part.path)).toString("base64")
        }
      }))
  );
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }, ...imageBlocks]
    },
    parent_tool_use_id: null,
    ...(sdkSessionId ? { session_id: sdkSessionId } : {})
  };
}
