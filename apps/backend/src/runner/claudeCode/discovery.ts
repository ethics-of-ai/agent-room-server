import type { CodingAgentCapabilities, CodingAgentReadinessCheck, ServiceConfig } from "../../domain/models";
import { AsyncEventQueue } from "../shared/AsyncEventQueue";
import { withTimeout } from "../shared/asyncUtils";
import { objectValue, stringValue } from "../shared/jsonValues";
import { capabilitiesFromSupportedModels, fallbackClaudeCodeCapabilities } from "./capabilities";
import type { ClaudeCodeQuery, ClaudeCodeQueryLoader } from "./sdk";
import { claudeCodeQueryOptions, effectiveClaudeCodeSettings } from "./settings";

// Both are control round trips to a child expected to answer at once.
const CONTROL_REQUEST_TIMEOUT_MS = 5_000;

export const CLAUDE_CODE_LOGIN_CHECK_ID = "claude_login";

/**
 * Spawns one isolated SDK session in the backend's own cwd and reads the model
 * list and the signed-in account from it. Neither is a model call. The child
 * gets the same scrubbed environment as a turn, so the account it reports is
 * the one a turn would bill.
 */
export async function discoverClaudeCodeCapabilities(
  config: ServiceConfig,
  loadQuery: ClaudeCodeQueryLoader
): Promise<CodingAgentCapabilities> {
  const fallback = fallbackClaudeCodeCapabilities(config);
  let session: { query: ClaudeCodeQuery; input: AsyncEventQueue<unknown> } | undefined;
  try {
    const queryFunction = await loadQuery();
    const input = new AsyncEventQueue<unknown>();
    const query = queryFunction({
      prompt: input,
      // Discovery runs in the backend's own cwd, not a registered workspace,
      // so force isolation: never load or execute that directory's project
      // settings (hooks, MCP servers) just to read the model list.
      options: claudeCodeQueryOptions(
        config,
        process.cwd(),
        effectiveClaudeCodeSettings(config, undefined),
        { forceIsolation: true }
      )
    });
    session = { query, input };
    const [models, login] = await Promise.all([
      query.supportedModels
        ? withTimeout(query.supportedModels(), CONTROL_REQUEST_TIMEOUT_MS, "Timed out reading the Claude Code model list")
        : undefined,
      readLoginCheck(query)
    ]);
    return {
      ...(models ? capabilitiesFromSupportedModels(models, config) : fallback),
      checks: [login]
    };
  } catch (error) {
    return {
      ...fallback,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (session) {
      session.input.close();
      void Promise.resolve(session.query.return?.(undefined)).catch(() => undefined);
    }
  }
}

async function readLoginCheck(query: ClaudeCodeQuery): Promise<CodingAgentReadinessCheck> {
  if (!query.accountInfo) return loginNotChecked;
  try {
    const account = await withTimeout(query.accountInfo(), CONTROL_REQUEST_TIMEOUT_MS, "Timed out");
    return claudeCodeLoginCheck(account);
  } catch {
    return loginNotChecked;
  }
}

const loginNotChecked: CodingAgentReadinessCheck = {
  id: CLAUDE_CODE_LOGIN_CHECK_ID,
  status: "not_checked",
  message: "This Claude Code version cannot report its sign-in. A turn will say if it is signed out."
};

/**
 * Reads the SDK's `accountInfo()` answer. Only a signed-out CLI names
 * `tokenSource: "none"` with no API key source. A `claude auth login`
 * subscription omits `tokenSource` altogether (Claude Code 2.1.261), so a
 * missing field is not a signed-out answer. Bedrock, Vertex, and gateway
 * providers authenticate outside `claude auth login`, so they always pass.
 * Workspace project settings can still add an API key helper that this
 * isolated probe never loads; that case reads as signed out here and works
 * in the turn.
 */
export function claudeCodeLoginCheck(account: unknown): CodingAgentReadinessCheck {
  const object = objectValue(account);
  if (!object) return loginNotChecked;
  const provider = stringValue(object.apiProvider) ?? "firstParty";
  const tokenSource = stringValue(object.tokenSource);
  const apiKeySource = stringValue(object.apiKeySource);
  if (provider !== "firstParty" || apiKeySource || tokenSource !== "none") {
    return { id: CLAUDE_CODE_LOGIN_CHECK_ID, status: "ready", message: "Claude Code is signed in." };
  }
  return {
    id: CLAUDE_CODE_LOGIN_CHECK_ID,
    status: "unavailable",
    message: "Claude Code is not signed in. Sign in to Claude, then check again."
  };
}
