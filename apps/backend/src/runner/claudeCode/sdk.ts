// Loose structural types for the Claude Agent SDK. The runner intentionally
// avoids compile-time coupling to the SDK's published types so tests can
// inject a fake query function and version drift surfaces in the runner test
// suite instead of the build.
export interface ClaudeCodeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<void>;
  setModel?(model?: string): Promise<void>;
  applyFlagSettings?(settings: Record<string, unknown>): Promise<void>;
  supportedModels?(): Promise<unknown[]>;
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

// The SDK is ESM-only and this package compiles to CommonJS; a literal
// import() would be transformed into require() by tsc, so route through an
// untransformed dynamic import.
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<Record<string, unknown>>;

let cachedQuery: Promise<ClaudeCodeQueryFunction> | undefined;

export function loadClaudeCodeQuery(): Promise<ClaudeCodeQueryFunction> {
  if (!cachedQuery) {
    const loading = dynamicImport("@anthropic-ai/claude-agent-sdk").then((module) => {
      const query = module.query;
      if (typeof query !== "function") {
        throw new Error("@anthropic-ai/claude-agent-sdk did not export a query function");
      }
      return query as ClaudeCodeQueryFunction;
    });
    // A rejected import must not poison the cache: drop it so the next call
    // retries instead of failing forever until a backend restart.
    loading.catch(() => {
      if (cachedQuery === loading) {
        cachedQuery = undefined;
      }
    });
    cachedQuery = loading;
  }
  return cachedQuery;
}
