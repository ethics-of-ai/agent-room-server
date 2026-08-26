/**
 * Loose structural types for `@cursor/sdk`, and the loaders that resolve the
 * real package inside the host child.
 *
 * The host is the only file in the backend that touches the SDK, and it does so
 * through these structural shapes rather than the SDK's published types — the
 * same choice `runner/claudeCode/sdk.ts` made and for the same reason: version
 * drift then surfaces in `cursorHost.test.ts` (which injects a fake SDK) instead
 * of failing the build, and the 1.0.x preview's type surface never couples to
 * this compile. Unlike the Claude Agent SDK, `@cursor/sdk` ships a CommonJS
 * entry (`dist/cjs`), so a plain `require` resolves it; the loader stays a
 * function so a fake can replace it in tests.
 */

/** A model selection in the SDK's `{ id, params }` shape. */
export interface CursorModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

/** One `send` image, the SDK's inlined local-image source. */
export interface CursorSdkImage {
  data: string;
  mimeType: string;
}

/** The custom tool the host registers for clarifying questions. */
export interface CursorSdkCustomTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: { toolCallId?: string }
  ) => Promise<unknown> | unknown;
}

export interface CursorSdkSandboxOptions {
  enabled: boolean;
}

export interface CursorLocalAgentOptions {
  cwd?: string;
  settingSources?: string[];
  sandboxOptions?: CursorSdkSandboxOptions;
  autoReview?: boolean;
  customTools?: Record<string, CursorSdkCustomTool>;
  store?: unknown;
  force?: boolean;
}

export interface CursorAgentOptions {
  model?: CursorModelSelection;
  apiKey?: string;
  disallowedTools?: string[];
  agentId?: string;
  local?: CursorLocalAgentOptions;
}

export interface CursorSendOptions {
  model?: CursorModelSelection;
  mode?: "agent" | "plan";
  onDelta?: (args: { update: { type: string; [key: string]: unknown } }) => void;
  local?: { force?: boolean; customTools?: Record<string, CursorSdkCustomTool> };
}

export interface CursorRunResult {
  id: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: { message: string; code?: string };
  durationMs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
}

export interface CursorRun {
  readonly id: string;
  stream(): AsyncIterable<{ type: string; [key: string]: unknown }>;
  wait(): Promise<CursorRunResult>;
  cancel(): Promise<void>;
}

export interface CursorSdkAgent {
  readonly agentId: string;
  send(message: { text: string; images?: CursorSdkImage[] }, options?: CursorSendOptions): Promise<CursorRun>;
  close(): void;
}

/** The two SDK entry points and the store factory the host uses. */
export interface CursorSdk {
  Agent: {
    create(options: CursorAgentOptions & { local?: CursorLocalAgentOptions }): Promise<CursorSdkAgent>;
    resume(agentId: string, options?: CursorAgentOptions & { local?: CursorLocalAgentOptions }): Promise<CursorSdkAgent>;
  };
  Cursor: {
    models: { list(options?: { apiKey?: string }): Promise<unknown[]> };
  };
  openStore(options: { workspaceRef: string; stateRoot: string }): Promise<unknown>;
  version: string;
}

export type CursorSdkLoader = () => CursorSdk;

/** `Cursor.auth.status()`: signed in or out, and never the key. */
export type CursorSdkAuthStatus =
  | { status: "logged-out" }
  | { status: "logged-in"; backendUrl?: string; email?: string; apiKeyExpiresAtMs?: number };

export interface CursorSdkLoginOptions {
  /**
   * Left undefined so the SDK keeps its own default: open the system browser
   * when that is likely to work, skip it in an SSH session or under
   * `NO_OPEN_BROWSER`.
   */
  openBrowser?: boolean | ((url: string) => void | Promise<void>);
  /** Always called with the login URL before the SDK waits on its poll. */
  onLoginUrl?: (url: string) => void;
  /** The minted key's display name in the Cursor dashboard's API-keys list. */
  apiKeyName?: string;
}

/**
 * The SDK's sign-in surface (`Cursor.auth`). Only the operator's `cursor:login`
 * command uses it: the host never signs in, it resolves the stored credential
 * the SDK finds on its own.
 */
export interface CursorSdkAuth {
  login(options?: CursorSdkLoginOptions): Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }>;
  status(): Promise<CursorSdkAuthStatus>;
}

export function loadCursorSdkAuth(): CursorSdkAuth {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require("@cursor/sdk") as { Cursor: { auth: CursorSdkAuth } };
  return sdk.Cursor.auth;
}

/**
 * Resolve the real `@cursor/sdk` and `@cursor/sdk/sqlite`. Uses `require`
 * because the package's `require` export is CommonJS; a rejected resolution is
 * a first-turn error the adapter reports rather than a crash at import.
 */
export function loadCursorSdk(): CursorSdk {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sdk = require("@cursor/sdk") as {
    Agent: CursorSdk["Agent"];
    Cursor: CursorSdk["Cursor"];
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqlite = require("@cursor/sdk/sqlite") as {
    SqliteLocalAgentStore: { open(options: { workspaceRef: string; stateRoot: string }): Promise<unknown> };
  };
  let version = "unknown";
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    version = (require("@cursor/sdk/package.json") as { version?: string }).version ?? "unknown";
  } catch {
    // The package restricts `./package.json` in its exports on some Node
    // versions; the version string is diagnostic only, so a miss is harmless.
  }
  return {
    Agent: sdk.Agent,
    Cursor: sdk.Cursor,
    openStore: (options) => sqlite.SqliteLocalAgentStore.open(options),
    version
  };
}
