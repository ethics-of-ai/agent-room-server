// Loose structural types for the Claude Agent SDK. The runner intentionally
// avoids compile-time coupling to the SDK's published types so tests can
// inject a fake query function and version drift surfaces in the runner test
// suite instead of the build.
export interface ClaudeCodeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  setModel?(model?: string): Promise<void>;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  supportedModels?(): Promise<unknown[]>;
  /**
   * The SDK's `get_context_usage` control request: a round trip to the live
   * child rather than a model call, so reading it costs no tokens. Optional
   * for the same reason `supportedModels` is: an SDK version without it must
   * leave the runner working, with no threshold reported.
   */
  getContextUsage?(): Promise<unknown>;
  /** The signed-in account, read from the child without a model call. */
  accountInfo?(): Promise<unknown>;
  /** Connection status of each configured MCP server; a control round trip, not a model call. */
  mcpServerStatus?(): Promise<unknown[]>;
  return?(value?: unknown): Promise<IteratorResult<unknown>>;
}

/**
 * The SDK's `canUseTool` callback, typed structurally for the same reason as
 * the query: AgentRoom passes it to hold the `AskUserQuestion` tool open for a
 * human answer and to refuse every other interactive prompt, and a fake query
 * in the tests exercises both paths.
 */
export type ClaudeCodeCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal?: AbortSignal; toolUseID?: string }
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean }
>;

export type ClaudeCodeQueryFunction = (params: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => ClaudeCodeQuery;

export type ClaudeCodeQueryLoader = () => Promise<ClaudeCodeQueryFunction>;

/**
 * The SDK's `createSdkMcpServer`, typed to the low-level server surface the
 * AgentRoom tool server uses. Injectable beside the query loader so tests can
 * run the real in-process server against a fake child.
 */
export type ClaudeCodeMcpServerFactory = (options: { name: string; tools?: unknown[] }) => {
  type: string;
  name: string;
  instance: {
    server: {
      registerCapabilities(capabilities: Record<string, unknown>): void;
      setRequestHandler(schema: unknown, handler: (request: any, extra: any) => Promise<unknown>): void;
    };
    connect(transport: unknown): Promise<void>;
  };
};

export type ClaudeCodeMcpServerLoader = () => Promise<ClaudeCodeMcpServerFactory>;

// The SDK is ESM-only and this package compiles to CommonJS; a literal
// import() would be transformed into require() by tsc, so route through an
// untransformed dynamic import.
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<Record<string, unknown>>;

let cachedModule: Promise<Record<string, unknown>> | undefined;

function loadSdkModule(): Promise<Record<string, unknown>> {
  if (!cachedModule) {
    const loading = dynamicImport("@anthropic-ai/claude-agent-sdk");
    // A rejected import must not poison the cache: drop it so the next call
    // retries instead of failing forever until a backend restart.
    loading.catch(() => {
      if (cachedModule === loading) {
        cachedModule = undefined;
      }
    });
    cachedModule = loading;
  }
  return cachedModule;
}

export async function loadClaudeCodeQuery(): Promise<ClaudeCodeQueryFunction> {
  const query = (await loadSdkModule()).query;
  if (typeof query !== "function") {
    throw new Error("@anthropic-ai/claude-agent-sdk did not export a query function");
  }
  return query as ClaudeCodeQueryFunction;
}

export async function loadClaudeCodeMcpServerFactory(): Promise<ClaudeCodeMcpServerFactory> {
  const factory = (await loadSdkModule()).createSdkMcpServer;
  if (typeof factory !== "function") {
    throw new Error("@anthropic-ai/claude-agent-sdk did not export createSdkMcpServer");
  }
  return factory as ClaudeCodeMcpServerFactory;
}
