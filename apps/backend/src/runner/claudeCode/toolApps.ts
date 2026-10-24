import { logger } from "../../logging/logger";
import { redactSecrets } from "../../util/redactSecrets";
import type { AgentRunnerEvent, AgentRunnerToolApp, ToolAppCallResult } from "../AgentRunner";
import { withTimeout } from "../shared/asyncUtils";
import { arrayValue, booleanValue, objectValue, stringValue } from "../shared/jsonValues";
import type { ClaudeCodeQuery } from "./sdk";

// MCP Apps (SEP-1865) for Claude Code. A tool declares its view as
// `_meta.ui.resourceUri`; the CLI reports that `_meta` through
// `mcpServerStatus()` and reads the `ui://` resource for us through
// `readMcpResource`, from the server it dialed itself, so the backend never
// holds the server's credentials. The call's full result rides the SDK user
// message as `tool_use_result`.
//
// A view that cannot be read is logged and dropped: the call still shows as an
// ordinary tool activity. A tool with no view is the normal case and is not
// logged.

const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
// A status or resource round trip that outlives this is abandoned: the call
// still shows as an ordinary tool activity, and the session's message loop,
// which waits on this, moves on.
const READ_TIMEOUT_MS = 10_000;
// A view's tool call that outlives this is answered as failed. The CLI's own
// call is not cancelled and its late answer is dropped.
const CALL_TIMEOUT_MS = 60_000;

interface PendingCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolView {
  serverName: string;
  toolName: string;
  resourceUri: string;
  /** The tool as an MCP `Tool`, for the view's `hostContext.toolInfo`. */
  tool: Record<string, unknown>;
}

/** Why a declared view was not shown; the message is the log's `reason`. */
class ToolViewDropped extends Error {
  constructor(reason: string, readonly causeMessage?: string) {
    super(reason);
  }

  static wrapping(reason: string) {
    return (error: unknown): never => {
      throw new ToolViewDropped(reason, redactSecrets(error instanceof Error ? error.message : String(error)));
    };
  }
}

export class ClaudeCodeToolApps {
  private readonly calls = new Map<string, PendingCall>();
  /**
   * Every tool the latest `mcpServerStatus()` listed, by CLI tool name, with
   * its view or null. A result for a listed tool needs no status round trip;
   * only a name the last status did not list fetches a fresh one. A server
   * that changes a listed tool's view mid-session is not noticed until the
   * child restarts.
   */
  private views = new Map<string, ToolView | null>();

  constructor(private readonly query: ClaudeCodeQuery) {}

  /** Whether `callTool` can reach the CLI: the SDK's private `request()` is there. */
  get supportsToolCalls(): boolean {
    return typeof this.query.request === "function" && typeof this.query.mcpServerStatus === "function";
  }

  /**
   * Run one of `serverName`'s tools for a view through the CLI's `mcp_call`
   * control request, with no model turn and no `canUseTool` check; the client
   * asks the person first. The status is read fresh, never from the view
   * cache, so a tool hidden from apps since the view rendered is refused.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolAppCallResult> {
    const { request, mcpServerStatus } = this.query;
    if (typeof request !== "function" || typeof mcpServerStatus !== "function") return { kind: "unavailable" };
    try {
      const statuses = await withTimeout(mcpServerStatus.call(this.query), READ_TIMEOUT_MS, "the server status read timed out");
      if (!isAppVisible(statuses, serverName, toolName)) return { kind: "unknown_tool" };
      const reply = objectValue(await withTimeout(
        request.call(this.query, { subtype: "mcp_call", tool: cliToolName(serverName, toolName), arguments: args }),
        CALL_TIMEOUT_MS,
        "the tool call timed out"
      ));
      return { kind: "called", result: callToolResult(objectValue(reply?.response) ?? {}) };
    } catch (error) {
      return { kind: "failed", message: redactSecrets(error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * The tool-app events a message completes. The session loop awaits this
   * before it routes the message, so an app lands in the turn that made the
   * call, ahead of that turn's result.
   */
  async eventsFor(message: unknown): Promise<AgentRunnerEvent[]> {
    const object = objectValue(message);
    if (!object) return [];
    const type = stringValue(object.type);
    if (type === "assistant") {
      this.rememberCalls(object);
      return [];
    }
    if (type !== "user") return [];
    const results = arrayValue(objectValue(object.message)?.content)
      .map(objectValue)
      .filter((block): block is Record<string, unknown> => stringValue(block?.type) === "tool_result");
    // `tool_use_result` is the message's one result; a message carrying
    // several cannot say which block it belongs to.
    const fullResult = objectValue(object.tool_use_result);
    if (results.length !== 1 || !fullResult) {
      for (const block of results) this.forget(block);
      return [];
    }
    const block = results[0]!;
    const toolId = stringValue(block.tool_use_id);
    const call = toolId ? this.calls.get(toolId) : undefined;
    this.forget(block);
    if (!toolId || !call || booleanValue(block.is_error)) return [];
    try {
      const app = await withTimeout(this.resolve(toolId, call, fullResult), READ_TIMEOUT_MS, "the view read timed out");
      return app ? [{ type: "tool_app", app }] : [];
    } catch (error) {
      logger.warn({
        runnerKind: "claudeCode",
        tool: call.name,
        reason: error instanceof Error ? error.message : "unknown",
        ...(error instanceof ToolViewDropped && error.causeMessage ? { error: error.causeMessage } : {})
      }, "Dropped an MCP tool view; the call shows as a plain tool activity");
      return [];
    }
  }

  private rememberCalls(object: Record<string, unknown>): void {
    for (const block of arrayValue(objectValue(object.message)?.content)) {
      const blockObject = objectValue(block);
      if (stringValue(blockObject?.type) !== "tool_use") continue;
      const id = stringValue(blockObject?.id);
      const name = stringValue(blockObject?.name);
      if (!id || !name?.startsWith("mcp__")) continue;
      this.calls.set(id, { name, input: objectValue(blockObject?.input) ?? {} });
    }
  }

  private forget(block: Record<string, unknown>): void {
    const toolId = stringValue(block.tool_use_id);
    if (toolId) this.calls.delete(toolId);
  }

  private async resolve(
    toolId: string,
    call: PendingCall,
    fullResult: Record<string, unknown>
  ): Promise<AgentRunnerToolApp | undefined> {
    if (!this.query.mcpServerStatus || !this.query.readMcpResource) return undefined;
    const view = await this.viewFor(call.name, this.query.mcpServerStatus.bind(this.query));
    if (!view) return undefined;
    const read = objectValue(await this.query.readMcpResource(view.serverName, view.resourceUri)
      .catch(ToolViewDropped.wrapping("the resource read failed")));
    const contents = arrayValue(read?.contents).map(objectValue);
    const resource = contents.find((item) => stringValue(item?.uri) === view.resourceUri) ?? contents[0];
    if (!resource) throw new ToolViewDropped("the resource read returned no contents");
    const mimeType = normalizedMimeType(stringValue(resource.mimeType));
    if (mimeType !== MCP_APP_MIME_TYPE) throw new ToolViewDropped(`the resource's MIME type is ${mimeType ?? "missing"}`);
    const html = resourceText(resource);
    if (!html) throw new ToolViewDropped("the resource has no HTML");
    const resourceMeta = objectValue(objectValue(resource._meta)?.ui);
    return {
      toolId,
      title: toolTitle(view.toolName),
      serverName: view.serverName,
      toolName: view.toolName,
      resourceUri: view.resourceUri,
      tool: view.tool,
      html,
      ...(resourceMeta ? { resourceMeta } : {}),
      toolInput: call.input,
      toolResult: callToolResult(fullResult),
      ...(this.supportsToolCalls ? { supportsToolCalls: true } : {})
    };
  }

  private async viewFor(cliToolName: string, status: () => Promise<unknown[]>): Promise<ToolView | undefined> {
    const known = this.views.get(cliToolName);
    if (known !== undefined) return known ?? undefined;
    this.views = toolViews(await status().catch(ToolViewDropped.wrapping("the server status read failed")));
    return this.views.get(cliToolName) ?? undefined;
  }
}

/**
 * The name the CLI gives a server's tool: `mcp__<server>__<tool>`, with every
 * character of the server name outside `[A-Za-z0-9_-]` replaced by `_`, so
 * `claude.ai optima-agents` becomes `claude_ai_optima-agents`.
 */
function cliToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName.replace(/[^A-Za-z0-9_-]/g, "_")}__${toolName}`;
}

/**
 * Whether a status lists `toolName` on the server named exactly `serverName`
 * and lets apps call it. Under SEP-1865 a tool with no `_meta.ui.visibility`
 * is visible to both the model and apps.
 */
export function isAppVisible(statuses: unknown[], serverName: string, toolName: string): boolean {
  const server = statuses.map(objectValue).find((status) => stringValue(status?.name) === serverName);
  const tool = arrayValue(server?.tools).map(objectValue).find((entry) => stringValue(entry?.name) === toolName);
  if (!tool) return false;
  const visibility = objectValue(objectValue(tool._meta)?.ui)?.visibility;
  return visibility === undefined || arrayValue(visibility).includes("app");
}

/** Every tool in a status, by the name the CLI gives it, with its declared view or null. */
export function toolViews(statuses: unknown[]): Map<string, ToolView | null> {
  const views = new Map<string, ToolView | null>();
  for (const status of statuses) {
    const server = objectValue(status);
    const serverName = stringValue(server?.name);
    if (!server || !serverName) continue;
    for (const tool of arrayValue(server.tools).map(objectValue)) {
      const toolName = stringValue(tool?.name);
      if (!tool || !toolName) continue;
      const meta = objectValue(tool._meta);
      const resourceUri = stringValue(objectValue(meta?.ui)?.resourceUri) ?? stringValue(meta?.["ui/resourceUri"]);
      views.set(
        cliToolName(serverName, toolName),
        resourceUri?.startsWith("ui://") ? { serverName, toolName, resourceUri, tool: mcpTool(toolName, tool) } : null
      );
    }
  }
  return views;
}

// The CLI reports MCP `ToolAnnotations` under shortened names.
const ANNOTATION_HINTS = { readOnly: "readOnlyHint", destructive: "destructiveHint", openWorld: "openWorldHint" };

/**
 * A status entry as an MCP `Tool`. The CLI reports no input schema, so it
 * gets `{ "type": "object" }`, the widest one MCP allows.
 */
function mcpTool(toolName: string, tool: Record<string, unknown>): Record<string, unknown> {
  const description = stringValue(tool.description);
  const reported = objectValue(tool.annotations) ?? {};
  const annotations = Object.fromEntries(Object.entries(ANNOTATION_HINTS).flatMap(([key, hint]) => {
    const value = booleanValue(reported[key]);
    return value === undefined ? [] : [[hint, value]];
  }));
  const meta = objectValue(tool._meta);
  return {
    name: toolName,
    ...(description ? { description } : {}),
    inputSchema: { type: "object" },
    ...(Object.keys(annotations).length ? { annotations } : {}),
    ...(meta ? { _meta: meta } : {})
  };
}

/** The SDK's `tool_use_result` as an MCP `CallToolResult`; the CLI can flatten `content` to a string. */
function callToolResult(result: Record<string, unknown>): Record<string, unknown> {
  const content = typeof result.content === "string"
    ? [{ type: "text", text: result.content }]
    : arrayValue(result.content);
  const structuredContent = objectValue(result.structuredContent);
  const meta = objectValue(result._meta);
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(meta ? { _meta: meta } : {})
  };
}

function resourceText(resource: Record<string, unknown>): string | undefined {
  const text = stringValue(resource.text);
  if (text) return text;
  const blob = stringValue(resource.blob);
  return blob ? Buffer.from(blob, "base64").toString("utf8") : undefined;
}

function normalizedMimeType(mimeType: string | undefined): string | undefined {
  return mimeType?.replace(/\s+/g, "").toLowerCase();
}

/** `show_usage_dashboard` reads as "Show usage dashboard". */
function toolTitle(toolName: string): string {
  const words = toolName.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool view";
}
