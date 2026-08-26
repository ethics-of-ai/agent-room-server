import { redactSecrets } from "../../util/redactSecrets";
import type { CursorSdkAuth, CursorSdkAuthStatus } from "./sdk";
import { loadCursorSdkAuth } from "./sdk";

/**
 * The operator's Cursor sign-in command (docs/engineering/CURSOR_SDK_RUNNER.md,
 * Step 7; docs/clients/MACOS.md, *Signing in to Cursor*).
 *
 * It runs `Cursor.auth.login()` where the browser is. The SDK opens the system
 * browser when that is likely to work, and this command prints the login URL
 * as well, so an SSH or `NO_OPEN_BROWSER` session can finish the sign-in by
 * hand. The SDK then mints a named user API key (90-day default lifetime) and
 * writes it to `~/.cursor/sdk/auth.json` with mode 0600; this command reports
 * `Cursor.auth.status()` afterwards and never prints the key.
 *
 * It is a command and not a route on purpose: a bearer-gated route that minted
 * a key on the operator's Cursor account would be a new trust surface.
 *
 * From a checkout: `pnpm --filter @agentroom/backend cursor:login`. From the
 * packaged app: the bundled Node running `backend/dist/runner/cursor/login.js`.
 */

/** The name the minted key carries in the Cursor dashboard. */
export const CURSOR_LOGIN_API_KEY_NAME = "AgentRoom";

export interface CursorLoginIO {
  out(line: string): void;
  err(line: string): void;
}

/** Runs the sign-in and returns the process exit code. */
export async function runCursorLogin(auth: CursorSdkAuth, io: CursorLoginIO): Promise<number> {
  const before = await auth.status();
  if (before.status === "logged-in") {
    io.out(`Cursor is already signed in${describeAccount(before)}. Signing in again mints a new key and replaces the stored one.`);
  }

  try {
    await auth.login({
      apiKeyName: CURSOR_LOGIN_API_KEY_NAME,
      onLoginUrl: (url) => {
        io.out("Finish the Cursor sign-in in your browser. If it did not open, visit:");
        io.out(url);
      }
    });
  } catch (error) {
    io.err(`Cursor sign-in failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }

  const after = await auth.status();
  if (after.status !== "logged-in") {
    io.err("Cursor sign-in finished but left no stored login behind. Run the command again.");
    return 1;
  }
  io.out(`Cursor is signed in${describeAccount(after)}. Turns bill this account.`);
  io.out(
    "AgentRoom's Runner pane check reads the stored sign-in; the backend reports the runner ready once it can list models. Run this command again before the key expires."
  );
  return 0;
}

function describeAccount(status: CursorSdkAuthStatus): string {
  if (status.status !== "logged-in") return "";
  const parts: string[] = [];
  if (status.email) parts.push(`as ${status.email}`);
  if (typeof status.apiKeyExpiresAtMs === "number") {
    parts.push(`(key expires ${new Date(status.apiKeyExpiresAtMs).toISOString().slice(0, 10)})`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

if (require.main === module) {
  runCursorLogin(loadCursorSdkAuth(), {
    out: (line) => console.log(line),
    err: (line) => console.error(line)
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  );
}
