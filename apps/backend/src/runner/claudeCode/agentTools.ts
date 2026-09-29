import { z } from "zod";
import { agentToolInputSpec, unboundAgentToolResult, type AgentToolAdvertisement } from "../../agentTools/dispatch";
import type { AgentRunnerToolBinding } from "../AgentRunner";
import { withTimeout } from "../shared/asyncUtils";
import type { ClaudeCodeMcpServerFactory, ClaudeCodeQuery } from "./sdk";

/**
 * AgentRoom tools for Claude Code: an in-process SDK MCP server attached to
 * each child. Its low-level `tools/list` and `tools/call` handlers serve the
 * shared catalog verbatim. The SDK's `tool()` helper is not used: it strips
 * unknown keys before the handler runs and answers validation failures with
 * its own text, which would pre-empt the shared result envelope
 * (test/claudeSdkToolTransport.test.ts).
 *
 * A call carries the CLI's `_meta["claudecode/toolUseId"]`, the id of the
 * assistant `tool_use` block that asked for it. The stream consumer records
 * which turn's stream carried that block; the handler dispatches only into
 * that turn's binding, never into whichever turn happens to be active.
 */

export const AGENTROOM_MCP_SERVER_NAME = "agentroom";
const TOOL_USE_META = "claudecode/toolUseId";
/** How long a call waits for its `tool_use` block to be read off the SDK stream. */
const ORIGIN_WAIT_MS = 2_000;
const STATUS_TIMEOUT_MS = 5_000;
const STATUS_POLL_MS = 50;

/** Exact permission entries for the bound tool names; never a wildcard. */
export function claudeAllowedToolNames(names: readonly string[]): string[] {
  return names.map((name) => `mcp__${AGENTROOM_MCP_SERVER_NAME}__${name}`);
}

/** Maps a native tool-use id to the AgentRoom turn whose stream carried it. */
export class ClaudeToolUseOrigins {
  private readonly owners = new Map<string, string>();
  private readonly waiters = new Map<string, Array<(runId: string) => void>>();

  observe(toolUseId: string, runId: string): void {
    if (this.owners.has(toolUseId)) return;
    this.owners.set(toolUseId, runId);
    for (const wake of this.waiters.get(toolUseId) ?? []) wake(runId);
    this.waiters.delete(toolUseId);
  }

  /** The owning turn, waiting a bounded time for the stream to catch up with the call. */
  resolve(toolUseId: string, timeoutMs = ORIGIN_WAIT_MS): Promise<string | undefined> {
    const known = this.owners.get(toolUseId);
    if (known) return Promise.resolve(known);
    return new Promise((resolve) => {
      const wake = (runId: string | undefined): void => {
        clearTimeout(timer);
        resolve(runId);
      };
      const timer = setTimeout(() => {
        const list = this.waiters.get(toolUseId)?.filter((entry) => entry !== wake);
        if (list?.length) this.waiters.set(toolUseId, list);
        else this.waiters.delete(toolUseId);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(toolUseId, [...(this.waiters.get(toolUseId) ?? []), wake]);
    });
  }

  /** Forget the ids a settled turn owned. */
  release(runId: string): void {
    for (const [toolUseId, owner] of this.owners) if (owner === runId) this.owners.delete(toolUseId);
  }
}

/** The `tool_use` block ids an SDK message announces, from whole or partial assistant messages. */
export function toolUseIdsFromMessage(message: unknown): string[] {
  const record = message as { type?: unknown; message?: { content?: unknown }; event?: { type?: unknown; content_block?: unknown } };
  if (record?.type === "assistant" && Array.isArray(record.message?.content)) {
    return record.message.content.flatMap((block: { type?: unknown; id?: unknown }) =>
      block?.type === "tool_use" && typeof block.id === "string" ? [block.id] : []
    );
  }
  const started = record?.type === "stream_event" && record.event?.type === "content_block_start"
    ? (record.event.content_block as { type?: unknown; id?: unknown } | undefined)
    : undefined;
  return started?.type === "tool_use" && typeof started.id === "string" ? [started.id] : [];
}

type ToolCallHandler = (call: { name: string; arguments: unknown; toolUseId: string; signal: AbortSignal }) => Promise<string>;

/** Build the child's MCP server for a catalog. Unattributable calls get the tool's unavailable text. */
export function agentRoomMcpServer(
  createServer: ClaudeCodeMcpServerFactory,
  catalog: readonly AgentToolAdvertisement[],
  call: ToolCallHandler
): Record<string, unknown> {
  const server = createServer({ name: AGENTROOM_MCP_SERVER_NAME, tools: [] });
  const low = server.instance.server;
  low.registerCapabilities({ tools: { listChanged: false } });
  low.setRequestHandler(z.object({ method: z.literal("tools/list"), params: z.unknown().optional() }), async () => ({
    tools: catalog.map(agentToolInputSpec)
  }));
  low.setRequestHandler(
    z.object({ method: z.literal("tools/call"), params: z.object({ name: z.string() }).passthrough() }),
    async (request: { params: { name: string; arguments?: unknown } }, extra: { signal: AbortSignal; _meta?: Record<string, unknown> }) => {
      const name = request.params.name;
      const toolUseId = extra._meta?.[TOOL_USE_META];
      const text = typeof toolUseId === "string"
        ? await call({ name, arguments: request.params.arguments ?? {}, toolUseId, signal: extra.signal })
        : unboundAgentToolResult(name);
      return { content: [{ type: "text", text }] };
    }
  );
  return server as unknown as Record<string, unknown>;
}

/**
 * Whether the child connected the AgentRoom server, so its tools are really
 * in the model's list. Undefined when the SDK cannot say (no status method,
 * or still pending or unlisted at the deadline); required turns then fail
 * rather than trusting it. Verified live against CLI 2.1.283, which lists the
 * server as `agentroom` with source `sdk` once the child has initialized.
 */
export async function agentRoomServerConnected(query: ClaudeCodeQuery): Promise<boolean | undefined> {
  if (!query.mcpServerStatus) return undefined;
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  for (;;) {
    let status: string | undefined;
    try {
      const statuses = await withTimeout(Promise.resolve(query.mcpServerStatus()), STATUS_TIMEOUT_MS, "Timed out reading MCP status");
      status = (statuses as Array<{ name?: unknown; status?: unknown }>)
        .find((entry) => entry?.name === AGENTROOM_MCP_SERVER_NAME)?.status as string | undefined;
    } catch {
      return undefined;
    }
    if (status === "connected") return true;
    // Not listed yet reads like `pending`: a freshly spawned child reports its
    // servers only once it has initialized them.
    if (status !== undefined && status !== "pending") return false;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
}

/**
 * The AgentRoom tool plumbing of one Claude Code child: its MCP server, the
 * tool-use origins read off its stream, and the live turn bindings calls may
 * reach. Built once per spawn (a resumed child gets a fresh one), so a
 * catalog change takes effect on the next child and a live child keeps its
 * own.
 */
export class ClaudeSessionTools {
  private readonly origins = new ClaudeToolUseOrigins();
  private readonly bindings = new Map<string, AgentRunnerToolBinding>();
  private readonly names: ReadonlySet<string>;
  private readonly server: Record<string, unknown>;
  private confirmed = false;

  constructor(createServer: ClaudeCodeMcpServerFactory, catalog: readonly AgentToolAdvertisement[]) {
    this.names = new Set(catalog.map((entry) => entry.name));
    this.server = agentRoomMcpServer(createServer, catalog, async (call) => {
      const runId = await this.origins.resolve(call.toolUseId);
      const binding = runId ? this.bindings.get(runId) : undefined;
      if (!binding) return unboundAgentToolResult(call.name);
      return binding.invoke({ callId: call.toolUseId, name: call.name, arguments: call.arguments, signal: call.signal });
    });
  }

  /** The query options that attach the server and pre-approve exactly its tools. */
  queryOptions(): { mcpServers: Record<string, unknown>; allowedTools: string[] } {
    return { mcpServers: { [AGENTROOM_MCP_SERVER_NAME]: this.server }, allowedTools: claudeAllowedToolNames([...this.names]) };
  }

  /** Whether a permission callback names one of this child's AgentRoom tools. */
  allows(toolName: string): boolean {
    return claudeAllowedToolNames([...this.names]).includes(toolName);
  }

  /** Record the owner of every `tool_use` block a stream message announces. */
  observe(message: unknown, runId: string): void {
    for (const toolUseId of toolUseIdsFromMessage(message)) this.origins.observe(toolUseId, runId);
  }

  bindTurn(runId: string, binding: AgentRunnerToolBinding): void {
    this.bindings.set(runId, binding);
  }

  releaseTurn(runId: string): void {
    this.bindings.delete(runId);
    this.origins.release(runId);
  }

  /** The names the child really registered, confirmed once through the MCP status read. */
  async registeredNames(query: ClaudeCodeQuery): Promise<ReadonlySet<string> | undefined> {
    if (this.confirmed) return this.names;
    const connected = await agentRoomServerConnected(query);
    if (connected === undefined) return undefined;
    this.confirmed = connected;
    return connected ? this.names : new Set();
  }
}
