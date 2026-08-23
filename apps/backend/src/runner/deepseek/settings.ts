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
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

/**
 * The runtime that serves this protocol, named for diagnostics only.
 *
 * Deliberately **not** `dsh`. The `dsh` launcher boots profiles — `--profile
 * <name>`, `--profile headless "task"`, `web`, `plugin` — and none of those
 * entry modes serves the SDK JSON-RPC wire; pointing this runner at it yields a
 * web server or a usage error. The serving bin is `dsh-jsonrpc-agent`, or the
 * packaged single-file `dsh-jsonrpc-agent-pkg-<platform>-<arch>` runtime.
 */
export const DEEPSEEK_RUNTIME_BINARY = "dsh-jsonrpc-agent";

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
 * and artifacts follow. The stock compositions resolve their persistence root
 * as `process.env.DSH_SESSION_ROOT ?? './.sessions'`, and that relative default
 * is taken against the child's cwd, which *is* the registered workspace. Left
 * unpinned the harness would write its session log into the operator's
 * repository: a dirty working tree, entries in the settle-time Git diff this
 * runner already derives, and material a later commit could sweep up.
 */
export function deepseekSessionRoot(config: ServiceConfig): string {
  // STATE_DIR may be operator-supplied as a relative path. Resolve it in the
  // backend process before handing it to a child whose cwd is the registered
  // workspace, otherwise the same string names two different directories and
  // the runtime can put its persistence inside the repository.
  return resolve(config.stateDir, "deepseek", "sessions");
}

/**
 * The runtime inherits the operator's environment so it can find its own
 * provider credentials (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`), minus
 * AgentRoom's bearer token: `AUTH_TOKEN` is our transport secret, nothing the
 * harness or the tools a turn runs has any use for, and it would otherwise
 * propagate into every process the turn spawns — including the sub-agents the
 * harness can start. Mirrors `codexChildEnv` and `claudeCodeChildEnv`.
 *
 * Four values are then **pinned** rather than left to the composition's own
 * fallbacks, for the reason the Codex adapter pins `network_access`: a
 * composition is an operator-authored file this backend cannot inspect, so a
 * value AgentRoom depends on has to be stated in both directions rather than
 * assumed from a default that a config layer may quietly have changed.
 *
 * - `DSH_CORDIS_CONFIG` — the composition itself. The runtime exits nonzero
 *   without one, and the env channel outranks the argv positional, so pinning
 *   it here keeps `DEEPSEEK_ARGS` free for everything else.
 * - `DSH_CWD` — the agent workspace the composition's bash and filesystem tools
 *   bind to. The child's own cwd is already the registered workspace, so this
 *   agrees with the fallback rather than moving anything; what it buys is that
 *   a composition reading the variable cannot land the tools somewhere else.
 * - `DSH_SESSION_ROOT` — see {@link deepseekSessionRoot}.
 * - `DSH_PERMISSION_MODE` — the harness's own approval posture, which the SDK
 *   wire carries no parameter for. An operator-exported value is deliberately
 *   overridden by the managed setting, so the posture a client reads on
 *   `/api/config` is the posture the child actually gets.
 */
export function deepseekChildEnv(config: ServiceConfig, agentCwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTH_TOKEN;
  if (config.deepseekCordisConfig) {
    env.DSH_CORDIS_CONFIG = config.deepseekCordisConfig;
  }
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
