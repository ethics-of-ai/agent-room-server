import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CodingAgentTurnSettings, ServiceConfig } from "../../domain/models";
import type { AgentRunnerInputPart } from "../AgentRunner";
import { commandAudit } from "../shared/commandAudit";

/** The provider route the runtime mounts when the operator names none. */
export const DEFAULT_DEEPSEEK_PROVIDER = "deepseek-official";

/**
 * The model a turn runs when neither the turn nor the operator names one.
 *
 * It is the catalog's own first entry, and the same id
 * `GET /api/coding-agent/capabilities` already reports as
 * `defaultSettings.model`. Having a default at all is what keeps that response
 * honest: the read exists to tell a client which models there are, so requiring
 * a model to be configured *before* it can answer would make readiness
 * unprovable until the operator guessed one — and refusing a turn that names no
 * model would refuse the very default the same response advertised.
 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

/**
 * The runtime that serves this protocol, named for diagnostics only.
 *
 * The `dsh` launcher serves the SDK wire when it boots a profile whose graph
 * mounts the SDK server. AgentRoom appends `--profile agentroom --patch <file>`
 * itself, so the executable is `dsh`, or Node running its built CLI entrypoint.
 */
export const DEEPSEEK_RUNTIME_BINARY = "dsh";

export interface DeepSeekEffectiveSettings {
  model: string;
  provider: string;
  maxTokens?: number;
}

/**
 * A turn's model selection layered over the operator's configured defaults.
 *
 * Provider and `maxTokens` are deliberately *not* per-turn: they are
 * `initialize` parameters, so they belong to the child process rather than to
 * the prompt. A turn that selects a different model therefore needs a fresh
 * handshake — see `DeepSeekHarnessRunner.getOrCreateSession`.
 */
export function effectiveDeepSeekSettings(
  config: ServiceConfig,
  settings: CodingAgentTurnSettings | undefined
): DeepSeekEffectiveSettings {
  return {
    model: settings?.model ?? config.deepseekModel ?? DEFAULT_DEEPSEEK_MODEL,
    provider: config.deepseekProvider ?? DEFAULT_DEEPSEEK_PROVIDER,
    ...(config.deepseekMaxTokens ? { maxTokens: config.deepseekMaxTokens } : {})
  };
}

/**
 * The `initialize` parameters for one SDK session.
 *
 * `cwd` is the registered workspace: the runtime records it on every session
 * header and every SDK-created agent runs there. `model` is required by the
 * protocol and {@link effectiveDeepSeekSettings} always resolves one, so the
 * value here is the turn's selection, else the operator's configured default,
 * else {@link DEFAULT_DEEPSEEK_MODEL} — never the composition's own preference,
 * which would run a different model than `/api/config` reports.
 */
export function deepseekInitializeParams(
  workspacePath: string,
  settings: DeepSeekEffectiveSettings
): Record<string, unknown> {
  return {
    cwd: workspacePath,
    provider: settings.provider,
    model: settings.model,
    ...(settings.maxTokens ? { maxTokens: settings.maxTokens } : {})
  };
}

/**
 * The prompt's content blocks, sent verbatim as one user message.
 *
 * The SDK protocol has no local-file image source, so an attachment is read off
 * `STATE_DIR` and inlined as a base64 image block beside the text — the same
 * shape the Claude Code adapter builds, and for the same reason.
 */
export async function deepseekContentBlocks(
  prompt: string,
  inputParts: AgentRunnerInputPart[] | undefined
): Promise<Record<string, unknown>[]> {
  const imageBlocks = await Promise.all(
    (inputParts ?? [])
      .filter((part) => part.type === "localImage")
      .map(async (part) => ({
        type: "image",
        mimeType: part.contentType ?? "image/png",
        data: (await readFile(part.path)).toString("base64")
      }))
  );
  return [{ type: "text", text: prompt }, ...imageBlocks];
}

/**
 * Where the runtime's JSONL session log is written.
 *
 * Under `STATE_DIR`, never the registered workspace — the same rule attachments
 * and artifacts follow. The stock profiles put sessions under the Harness
 * home, and an operator composition may choose any root, including one
 * relative to the workspace. Left unpinned the harness could write its session
 * log into the operator's repository: a dirty working tree, entries in the
 * settle-time Git diff this runner already derives, and material a later
 * commit could sweep up.
 *
 * Each setup mode has its own root under `sessions-v2`. The Harness store
 * scans its whole root on first use and refuses it when any log there uses
 * the other encoding (`.jsonl` or `.jsonl.zstd`). The 0.1.0 runtime wrote
 * zstd logs to the earlier root, `deepseek/sessions`, and the first managed
 * graph wrote uncompressed ones beside them, so at Harness 86a40220 that root
 * failed every new session. Restore is unsupported, so the earlier root holds
 * nothing a session can continue, and it is left for the operator to delete.
 * Managed setup writes `compression: none`. A custom patch chooses its own
 * encoding, with zstd as the upstream default, so the two modes never share a
 * root that switching between them could poison. For the same reason each
 * custom patch gets its own root under `custom`, named by a hash of the
 * patch's contents: two patches, or one patch edited to another encoding,
 * never share a root either.
 */
export function deepseekSessionRoot(config: ServiceConfig): string {
  // STATE_DIR may be operator-supplied as a relative path. Resolve it in the
  // backend process before handing it to a child with a different cwd,
  // otherwise the same string names two different directories.
  if (config.deepseekCompositionMode === "managed") {
    return resolve(config.stateDir, "deepseek", "sessions-v2", "managed");
  }
  const patch = customPatchKey(config.deepseekCordisConfig);
  return resolve(config.stateDir, "deepseek", "sessions-v2", "custom", ...(patch ? [patch] : []));
}

/**
 * Names a custom patch's session root. An edit that changes nothing but the
 * encoding still changes the hash, which is the point; a new root costs
 * nothing, since restore is unsupported.
 */
function customPatchKey(patchPath: string | undefined): string | undefined {
  if (!patchPath) return undefined;
  const path = resolve(patchPath);
  let source: string | Buffer = path;
  try {
    source = readFileSync(path);
  } catch {
    // The launch reports an unreadable patch itself. Its path still names a
    // root, so the session root stays a pure function of the configuration.
  }
  return createHash("sha256").update(source).digest("hex").slice(0, 16);
}

/**
 * The runtime inherits the operator's environment so it can find its own
 * provider credentials (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`), minus
 * AgentRoom's bearer token: `AUTH_TOKEN` is our transport secret, nothing the
 * harness or the tools a turn runs has any use for, and it would otherwise
 * propagate into every process the turn spawns — including the sub-agents the
 * harness can start. Mirrors `codexChildEnv` and `claudeCodeChildEnv`.
 *
 * Three values are then **pinned** rather than left to the composition's own
 * fallbacks, for the reason the Codex adapter pins `network_access`: a
 * composition is an operator-authored file this backend cannot inspect, so a
 * value AgentRoom depends on has to be stated in both directions rather than
 * assumed from a default that a config layer may quietly have changed. The
 * launch adds `DSH_HOME`; see `deepseekHome`.
 *
 * - `DSH_CWD` — the agent workspace the composition's bash and filesystem tools
 *   bind to. The child's own cwd is the backend-owned Harness home, because the
 *   launcher loads a `.env` file from its cwd, so the workspace reaches the
 *   graph only through this value and the `initialize` cwd.
 * - `DSH_SESSION_ROOT` — see {@link deepseekSessionRoot}.
 * - `DSH_PERMISSION_MODE` — the harness's own approval posture, which the SDK
 *   wire carries no parameter for. An operator-exported value is deliberately
 *   overridden by the managed setting, so the posture a client reads on
 *   `/api/config` is the posture the child actually gets.
 *
 * `DSH_CORDIS_CONFIG` is removed: the launcher no longer reads it, and the
 * composition travels as a `--patch` argument.
 */
export function deepseekChildEnv(config: ServiceConfig, agentCwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTH_TOKEN;
  delete env.AGENTROOM_DEEPSEEK_CORDIS_PLUGIN;
  delete env.AGENTROOM_DEEPSEEK_TOOLS_FD;
  delete env.DSH_CORDIS_CONFIG;
  env.DSH_CWD = agentCwd;
  env.DSH_SESSION_ROOT = deepseekSessionRoot(config);
  if (config.deepseekPermissionMode) {
    env.DSH_PERMISSION_MODE = config.deepseekPermissionMode;
  }
  return env;
}

export function deepseekCommandAudit(config: ServiceConfig): { executableName: string; argsCount: number } {
  return commandAudit(config.deepseekExecutable ?? DEEPSEEK_RUNTIME_BINARY, config.deepseekArgs);
}
