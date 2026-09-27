import type { CodingAgentReadinessCheck } from "../../domain/models";
import { withTimeout } from "../shared/asyncUtils";
import { booleanValue, objectValue, stringValue } from "../shared/jsonValues";

export const CODEX_LOGIN_CHECK_ID = "codex_login";

export interface CodexRequestClient {
  request(method: string, params: unknown): Promise<unknown>;
}

export const codexLoginNotChecked: CodingAgentReadinessCheck = {
  id: CODEX_LOGIN_CHECK_ID,
  status: "not_checked",
  message: "This Codex version cannot report its sign-in. A turn will say if it is signed out."
};

/**
 * `refreshToken: false` reads the stored sign-in without spending a token
 * refresh on a settings read. A timeout or error reads as `not_checked`.
 */
export async function readCodexLoginCheck(client: CodexRequestClient): Promise<CodingAgentReadinessCheck> {
  try {
    const response = await withTimeout(
      client.request("account/read", { refreshToken: false }),
      2_000,
      "Timed out reading Codex sign-in"
    );
    return codexLoginCheck(response);
  } catch {
    return codexLoginNotChecked;
  }
}

/**
 * Reads the app-server's `account/read` answer. A ChatGPT sign-in, a stored
 * API key, or a Bedrock account names its `type`. With no account, Codex is
 * signed out only when its provider needs OpenAI auth; a custom provider that
 * authenticates elsewhere reports `requiresOpenaiAuth: false` and passes. The
 * message never carries the account email or plan.
 */
export function codexLoginCheck(response: unknown): CodingAgentReadinessCheck {
  const object = objectValue(response);
  if (!object) return codexLoginNotChecked;
  if (stringValue(objectValue(object.account)?.type)) {
    return { id: CODEX_LOGIN_CHECK_ID, status: "ready", message: "Codex is signed in." };
  }
  const requiresOpenaiAuth = booleanValue(object.requiresOpenaiAuth);
  if (object.account === null && requiresOpenaiAuth === false) {
    return { id: CODEX_LOGIN_CHECK_ID, status: "ready", message: "Codex uses a provider that does not need an OpenAI sign-in." };
  }
  if (object.account === null && requiresOpenaiAuth === true) {
    return {
      id: CODEX_LOGIN_CHECK_ID,
      status: "unavailable",
      message: "Codex is not signed in. Sign in to Codex, then check again."
    };
  }
  return codexLoginNotChecked;
}
