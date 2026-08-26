import type { CodingAgentTurnSettings, ServiceConfig } from "../../domain/models";
// From the import-free defaults leaf, not `domain/schemas`: the registry that
// carries this module's workspace-settings gate is what `domain/schemas` derives
// its runner-id schema from, so importing schemas here would close a require
// cycle. Same reason as `runner/claudeCode/settings.ts`.
import {
  defaultCursorAutoReview,
  defaultCursorLoadWorkspaceSettings,
  defaultCursorSandbox
} from "../../domain/runnerDefaults";
import type { AgentRunnerInputPart } from "../AgentRunner";
import { commandAudit } from "../shared/commandAudit";
import type { CursorModelSelection } from "./protocol";
import { defaultCursorModelId, fallbackCursorCatalog, type CursorModelCatalog } from "./capabilities";

/**
 * Whether a Cursor session loads the registered workspace's `project` settings
 * source: `AGENTS.md`, `.cursor/rules/*.mdc`, `.cursor/hooks.json`,
 * `.cursor/mcp.json`, and skills from `.cursor/skills`, `.agents/skills`,
 * `.claude/skills`, and `.codex/skills` (fact 6 of
 * docs/engineering/CURSOR_SDK_RUNNER.md). Loading it means the workspace's own
 * hooks and MCP servers take effect inside the turn, so it is the same class of
 * trust decision as Claude Code's `project` source, and it is the tier-2 managed
 * `runners.cursor.loadWorkspaceSettings`. The capability-discovery probe never
 * consults it: discovery always forces `settingSources: []` in the backend's
 * own cwd.
 */
export function loadsCursorWorkspaceSettings(config: ServiceConfig): boolean {
  return config.cursorLoadWorkspaceSettings ?? defaultCursorLoadWorkspaceSettings;
}

/**
 * Where a turn setting came from decides what happens when the selected model
 * does not offer it. A turn's own selection names a value the client read off
 * this model's capability row, so a mismatch is an error and the turn is
 * refused. The operator's managed default is one value for every model, and
 * Cursor's vocabularies differ per model (`high` exists on Claude Opus 5 and not
 * on `composer-2.5`), so it applies where the model offers it and otherwise
 * leaves the model at its own default rather than failing every turn on a model
 * the default never fit.
 */
export interface CursorSettingSelection {
  value: string;
  source: "turn" | "config";
}

export interface CursorEffectiveSettings {
  modelId: string;
  reasoningEffort?: CursorSettingSelection;
  serviceTier?: CursorSettingSelection;
  /** `local.sandboxOptions.enabled`. */
  sandbox: boolean;
  /** `local.autoReview`. */
  autoReview: boolean;
  /** `settingSources: ['project']` when true, else `[]`. */
  loadWorkspaceSettings: boolean;
}

/**
 * A turn's selection layered over the operator's configured Cursor defaults.
 * The catalog supplies the model that runs when neither names one; the fallback
 * catalog's answer is Cursor's own Auto model.
 */
export function effectiveCursorSettings(
  config: ServiceConfig,
  settings: CodingAgentTurnSettings | undefined,
  catalog: CursorModelCatalog = fallbackCursorCatalog
): CursorEffectiveSettings {
  return {
    modelId: settings?.model ?? defaultCursorModelId(catalog, config),
    ...(selection(settings?.reasoningEffort, config.cursorReasoningEffort, "reasoningEffort")),
    ...(selection(settings?.serviceTier, config.cursorServiceTier, "serviceTier")),
    sandbox: config.cursorSandbox ?? defaultCursorSandbox,
    autoReview: config.cursorAutoReview ?? defaultCursorAutoReview,
    loadWorkspaceSettings: loadsCursorWorkspaceSettings(config)
  };
}

function selection(
  fromTurn: string | undefined,
  fromConfig: string | undefined,
  field: "reasoningEffort" | "serviceTier"
): Partial<Pick<CursorEffectiveSettings, "reasoningEffort" | "serviceTier">> {
  if (fromTurn) return { [field]: { value: fromTurn, source: "turn" } };
  if (fromConfig) return { [field]: { value: fromConfig, source: "config" } };
  return {};
}

/**
 * The `{ id, params }` the SDK takes on `Agent.create`, `Agent.resume`, and
 * `send`, built against the catalog the session learned.
 *
 * The depth value rides whichever parameter the model declares (`effort` or
 * `reasoning`), and the speed value rides `fast` as `"true"`/`"false"`. A
 * selection the model does not offer is refused when the turn made it and
 * skipped when the operator's default did (see {@link CursorSettingSelection});
 * a model the catalog has never heard of offers nothing, so the same rule
 * applies. Sending no params runs the model's own `isDefault` variant.
 */
export function cursorModelSelection(
  catalog: CursorModelCatalog,
  settings: CursorEffectiveSettings
): CursorModelSelection {
  const model = catalog.models.find((entry) => entry.id === settings.modelId);
  const params: Array<{ id: string; value: string }> = [];

  if (settings.reasoningEffort) {
    const { value, source } = settings.reasoningEffort;
    if (model?.depth && model.depth.values.includes(value)) {
      params.push({ id: model.depth.parameter, value });
    } else if (source === "turn") {
      throw new Error(`Cursor model "${settings.modelId}" does not offer the reasoning effort "${value}"`);
    }
  }

  if (settings.serviceTier) {
    const { value, source } = settings.serviceTier;
    if (model?.speed && (value === "fast" || value === "standard")) {
      params.push({ id: "fast", value: value === "fast" ? "true" : "false" });
    } else if (source === "turn") {
      throw new Error(`Cursor model "${settings.modelId}" does not offer the speed "${value}"`);
    }
  }

  return { id: settings.modelId, ...(params.length > 0 ? { params } : {}) };
}

/**
 * The `agent/start` parameters the adapter hands the host, minus `cwd` and
 * `agentId` which the session layer supplies.
 *
 * `disallowedTools` always carries `askQuestion`: fact 3 showed the built-in
 * tool is absent from the headless catalog already, so this is belt-and-braces
 * against a future SDK adding it without an answer path. The question custom
 * tool is registered only when the clarifying-question channel is on.
 */
export function cursorAgentStartPosture(
  config: ServiceConfig,
  settings: CursorEffectiveSettings,
  model: CursorModelSelection
): {
  model: CursorModelSelection;
  settingSources: string[];
  sandbox: boolean;
  autoReview: boolean;
  disallowedTools: string[];
  questionTool: boolean;
} {
  return {
    model,
    settingSources: settings.loadWorkspaceSettings ? ["project"] : [],
    sandbox: settings.sandbox,
    autoReview: settings.autoReview,
    disallowedTools: ["askQuestion"],
    questionTool: config.clarifyingQuestionsEnabled !== false
  };
}

/** The runner's own posture label/value pair for `RunnerMetadata.posture`. */
export function cursorPosture(settings: CursorEffectiveSettings): { label: string; value: string } {
  return { label: "sandbox", value: settings.sandbox ? "sandboxed" : "unsandboxed" };
}

/**
 * The host child's environment: the operator's, minus AgentRoom's bearer token,
 * plus an explicit `CURSOR_API_KEY` only when the operator configured one.
 *
 * `AUTH_TOKEN` is our transport secret and has no business in the SDK's shell
 * tool, which inherits this environment verbatim (fact 2) — the same reflex as
 * `codexChildEnv` and `claudeCodeChildEnv`. When `cursorApiKey` is unset the SDK
 * resolves its stored web sign-in from `~/.cursor/sdk/auth.json`, so `HOME`
 * stays the operator's and a turn bills the signed-in account.
 */
export function cursorHostEnv(config: ServiceConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTH_TOKEN;
  if (config.cursorApiKey) env.CURSOR_API_KEY = config.cursorApiKey;
  if (config.cursorBackendUrl) env.CURSOR_BACKEND_URL = config.cursorBackendUrl;
  return env;
}

/** The images a turn's `agent/send` carries, read off `STATE_DIR` and inlined. */
export async function cursorSendImages(
  inputParts: AgentRunnerInputPart[] | undefined
): Promise<Array<{ data: string; mimeType: string }>> {
  const { readFile } = await import("node:fs/promises");
  return Promise.all(
    (inputParts ?? [])
      .filter((part) => part.type === "localImage")
      .map(async (part) => ({
        data: (await readFile(part.path)).toString("base64"),
        mimeType: part.contentType ?? "image/png"
      }))
  );
}

/**
 * The audit row for a Cursor turn. The SDK runs inside a host child the backend
 * spawns with its own Node runtime (`process.execPath`), so the executable name
 * is `node` and the argument count is the host entry's — never a workspace path
 * and never a credential.
 */
export function cursorCommandAudit(): { executableName: string; argsCount: number } {
  return commandAudit(process.execPath, [CURSOR_HOST_ENTRY]);
}

/** The compiled host entry the adapter spawns, relative to `dist/runner/cursor/`. */
export const CURSOR_HOST_ENTRY = "host.js";
