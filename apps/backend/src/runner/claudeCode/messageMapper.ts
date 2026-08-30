import type { AgentRunnerEvent, RunnerMetadata } from "../AgentRunner";
import { arrayValue, booleanValue, nonnegativeIntegerValue, objectValue, positiveIntegerValue, stringValue } from "../shared/jsonValues";
import { compactDisplayText } from "../shared/displayText";

export interface ClaudeCodeToolUseDisplay {
  title: string;
  description?: string;
}

export function mapClaudeCodeMessage(
  message: unknown,
  toolUses: Map<string, ClaudeCodeToolUseDisplay>
): AgentRunnerEvent[] {
  const object = objectValue(message);
  if (!object) return [];
  const type = stringValue(object.type);
  const claudeCode = runnerMetadataFromMessage(object);

  if (type === "system" && stringValue(object.subtype) === "init") {
    const content = initContent(object);
    return [{
      type: "agent_activity",
      activity: {
        kind: "claude_code_session_started",
        title: "Session started",
        content,
        canonical: { kind: "session_started" },
        runner: withSessionInit(claudeCode, object)
      }
    }];
  }

  if (type === "system" && stringValue(object.subtype) === "status") {
    return compactionStatusEvents(object, claudeCode);
  }

  if (type === "system" && stringValue(object.subtype) === "compact_boundary") {
    return compactBoundaryEvents(object, claudeCode);
  }

  if (type === "stream_event") {
    return streamEventUpdates(object, claudeCode);
  }

  if (type === "assistant") {
    const occupancy = contextOccupancyFromAssistant(object, claudeCode);
    return [
      ...(occupancy ? [occupancy] : []),
      ...assistantToolActivities(object, claudeCode, toolUses)
    ];
  }

  if (type === "user") {
    return toolResultActivities(object, claudeCode, toolUses);
  }

  if (type === "result") {
    const tokenUsage = tokenUsageFromResult(object, claudeCode);
    return tokenUsage ? [tokenUsage] : [];
  }

  return [];
}

export function completionFromClaudeCodeMessage(message: unknown): AgentRunnerEvent | undefined {
  const object = objectValue(message);
  if (!object || stringValue(object.type) !== "result") return undefined;

  const subtype = stringValue(object.subtype);
  const isError = booleanValue(object.is_error) ?? false;
  if (subtype === "success" && !isError) {
    const finalText = stringValue(object.result);
    return {
      type: "run_succeeded",
      ...(finalText ? { message: finalText } : {})
    };
  }

  const errors = arrayValue(object.errors).flatMap((error) => {
    const text = stringValue(error);
    return text ? [text] : [];
  });
  return {
    type: "run_failed",
    error: errors.length > 0 ? errors.join("; ") : `Claude Code turn ended with ${subtype ?? "an unknown error"}`
  };
}

/**
 * Correlation and display metadata for one SDK message, in the runner-agnostic
 * envelope shape. The SDK's message uuid and subagent parent id have no
 * canonical home, so they ride the bounded `native` blob — which is also where
 * the legacy `claudeCode` wire block rebuilds them from.
 */
export function runnerMetadataFromMessage(object: Record<string, unknown>): RunnerMetadata {
  const inner = objectValue(object.message);
  const nativeSessionId = stringValue(object.session_id);
  const messageUuid = stringValue(object.uuid);
  const parentToolUseId = stringValue(object.parent_tool_use_id);
  const model = stringValue(inner?.model);
  const native = {
    ...(messageUuid ? { messageUuid } : {}),
    ...(parentToolUseId ? { parentToolUseId } : {})
  };
  return {
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(native).length > 0 ? { native } : {})
  };
}

/** The `system`/`init` message is the only one carrying session-wide posture. */
function withSessionInit(metadata: RunnerMetadata, object: Record<string, unknown>): RunnerMetadata {
  const model = stringValue(object.model);
  const cwd = stringValue(object.cwd);
  const permissionMode = stringValue(object.permissionMode);
  return {
    ...metadata,
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(permissionMode ? { posture: { label: "permissionMode", value: permissionMode } } : {})
  };
}

/** The subagent (Task tool) parent id, as the adapter's own rules read it. */
function parentToolUseId(metadata: RunnerMetadata): string | undefined {
  return stringValue(metadata.native?.parentToolUseId);
}

function initContent(object: Record<string, unknown>): Record<string, unknown> {
  const sessionId = stringValue(object.session_id);
  const model = stringValue(object.model);
  const cwd = stringValue(object.cwd);
  const permissionMode = stringValue(object.permissionMode);
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(permissionMode ? { permissionMode } : {})
  };
}

function streamEventUpdates(
  object: Record<string, unknown>,
  claudeCode: RunnerMetadata
): AgentRunnerEvent[] {
  // Subagent (Task tool) stream events carry a parent_tool_use_id; their text
  // and thinking deltas must not interleave into the top-level assistant
  // message. The subagent's work surfaces through its tool activity instead.
  if (parentToolUseId(claudeCode)) return [];
  const event = objectValue(object.event);
  if (stringValue(event?.type) !== "content_block_delta") return [];
  const delta = objectValue(event?.delta);
  const deltaType = stringValue(delta?.type);

  if (deltaType === "text_delta") {
    const text = stringValue(delta?.text);
    return text ? [{ type: "agent_update", message: text, runner: claudeCode }] : [];
  }

  if (deltaType === "thinking_delta") {
    const thinking = stringValue(delta?.thinking);
    return thinking
      ? [{
          type: "agent_activity",
          activity: {
            kind: "claude_code_reasoning",
            title: "Reasoning update",
            content: { delta: thinking },
            canonical: { kind: "reasoning", delta: thinking },
            runner: claudeCode
          }
        }]
      : [];
  }

  return [];
}

function assistantToolActivities(
  object: Record<string, unknown>,
  claudeCode: RunnerMetadata,
  toolUses: Map<string, ClaudeCodeToolUseDisplay>
): AgentRunnerEvent[] {
  const content = arrayValue(objectValue(object.message)?.content);
  return content.flatMap((block) => {
    const blockObject = objectValue(block);
    if (stringValue(blockObject?.type) !== "tool_use" || !blockObject) return [];
    const name = stringValue(blockObject.name) ?? "tool";
    const input = objectValue(blockObject.input) ?? {};
    const display: ClaudeCodeToolUseDisplay = {
      title: claudeCodeToolTitle(name),
      ...(claudeCodeToolDescription(name, input) ? { description: claudeCodeToolDescription(name, input) } : {})
    };
    const toolUseId = stringValue(blockObject.id);
    if (toolUseId) toolUses.set(toolUseId, display);
    return [{
      type: "agent_activity",
      activity: {
        kind: "claude_code_tool_started",
        title: display.title,
        ...(display.description ? { description: display.description } : {}),
        content: {
          ...(toolUseId ? { toolUseId } : {}),
          name,
          input
        },
        canonical: { kind: "tool_started", ...(toolUseId ? { toolId: toolUseId } : {}) },
        runner: toolUseId ? { ...claudeCode, nativeItemId: toolUseId } : claudeCode
      }
    } satisfies AgentRunnerEvent];
  });
}

function toolResultActivities(
  object: Record<string, unknown>,
  claudeCode: RunnerMetadata,
  toolUses: Map<string, ClaudeCodeToolUseDisplay>
): AgentRunnerEvent[] {
  const content = arrayValue(objectValue(object.message)?.content);
  return content.flatMap((block) => {
    const blockObject = objectValue(block);
    if (stringValue(blockObject?.type) !== "tool_result" || !blockObject) return [];
    const toolUseId = stringValue(blockObject.tool_use_id);
    const display = toolUseId ? toolUses.get(toolUseId) : undefined;
    if (toolUseId) toolUses.delete(toolUseId);
    return [{
      type: "agent_activity",
      activity: {
        kind: "claude_code_tool_completed",
        title: display?.title ?? "Tool completed",
        ...(display?.description ? { description: display.description } : {}),
        content: {
          ...(toolUseId ? { toolUseId } : {}),
          ...(booleanValue(blockObject.is_error) !== undefined ? { isError: booleanValue(blockObject.is_error) } : {})
        },
        canonical: { kind: "tool_completed", ...(toolUseId ? { toolId: toolUseId } : {}) },
        runner: toolUseId ? { ...claudeCode, nativeItemId: toolUseId } : claudeCode
      }
    } satisfies AgentRunnerEvent];
  });
}

/**
 * The `system`/`status` message, which reports both that a compaction is under
 * way and that one has ended.
 *
 * Only `compacting` means a compaction is taking place: `requesting` is an
 * ordinary model call and `null` is the return to idle. And only a *failed*
 * outcome completes here — a success is already announced by the
 * `compact_boundary` message below, and reporting both would complete one
 * compaction twice. `compact_error` is the child's own text and is dropped
 * rather than relayed.
 */
function compactionStatusEvents(
  object: Record<string, unknown>,
  claudeCode: RunnerMetadata
): AgentRunnerEvent[] {
  // A subagent compacting its own window is not this thread compacting, the
  // same rule `contextOccupancyFromAssistant` applies to occupancy. Neither
  // compaction message declares `parent_tool_use_id` today (SDK 0.3.172), so
  // this is a guard against the SDK growing one rather than a filter that
  // currently fires — and if it never does, a subagent's compaction is
  // indistinguishable from the thread's on this wire.
  if (parentToolUseId(claudeCode)) return [];

  if (stringValue(object.compact_result) === "failed") {
    return [{
      type: "agent_activity",
      activity: {
        kind: "claude_code_context_compaction_completed",
        title: "Compaction failed",
        content: { failed: true },
        canonical: { kind: "context_compaction_completed", failed: true },
        runner: claudeCode
      }
    }];
  }

  if (stringValue(object.status) !== "compacting") return [];
  return [{
    type: "agent_activity",
    activity: {
      kind: "claude_code_context_compaction_started",
      title: "Compacting context",
      content: {},
      canonical: { kind: "context_compaction_started" },
      runner: claudeCode
    }
  }];
}

/**
 * The `system`/`compact_boundary` message: one compaction, completed, with the
 * before and after counts already computed.
 *
 * It also carries the badge correction. The occupancy the thread has been
 * reporting was measured before the compaction, so the number would sit stale
 * until the next assistant response; emitting `post_tokens` as an ordinary
 * `token_usage_updated` beside the activity lands the drop and its cause in
 * the same tick, on the path every other occupancy report already takes.
 */
function compactBoundaryEvents(
  object: Record<string, unknown>,
  claudeCode: RunnerMetadata
): AgentRunnerEvent[] {
  // The same forward-looking guard as the status message above.
  if (parentToolUseId(claudeCode)) return [];
  const metadata = objectValue(object.compact_metadata);
  const trigger = compactionTrigger(metadata?.trigger);
  const preTokens = nonnegativeIntegerValue(metadata?.pre_tokens);
  const postTokens = nonnegativeIntegerValue(metadata?.post_tokens);
  const reported = {
    ...(trigger ? { trigger } : {}),
    ...(preTokens !== undefined ? { preTokens } : {}),
    ...(postTokens !== undefined ? { postTokens } : {})
  };

  return [
    {
      type: "agent_activity",
      activity: {
        kind: "claude_code_context_compaction_completed",
        title: "Context compacted",
        content: reported,
        canonical: { kind: "context_compaction_completed", ...reported },
        runner: claudeCode
      }
    },
    ...(postTokens !== undefined
      ? [{ type: "token_usage_updated", runner: claudeCode, contextWindowUsedTokens: postTokens } satisfies AgentRunnerEvent]
      : [])
  ];
}

/** The two triggers the SDK declares. An unfamiliar one reports none. */
function compactionTrigger(value: unknown): "auto" | "manual" | undefined {
  const trigger = stringValue(value);
  return trigger === "auto" || trigger === "manual" ? trigger : undefined;
}

/**
 * Live context occupancy from one assistant API response: this request's
 * input (direct + cache creation + cache reads) plus its output. The result
 * message's `usage` aggregates every request in the turn, so it re-counts the
 * cached conversation per tool round-trip and cannot measure occupancy.
 */
function contextOccupancyFromAssistant(
  object: Record<string, unknown>,
  claudeCode: RunnerMetadata
): AgentRunnerEvent | undefined {
  // Subagent (Task tool) requests run in their own context window; their
  // usage must not overwrite the top-level session's occupancy.
  if (parentToolUseId(claudeCode)) return undefined;
  const usage = objectValue(objectValue(object.message)?.usage);
  if (!usage) return undefined;
  const directInputTokens = nonnegativeIntegerValue(usage.input_tokens);
  if (directInputTokens === undefined) return undefined;
  const cacheCreationTokens = nonnegativeIntegerValue(usage.cache_creation_input_tokens) ?? 0;
  const cachedInputTokens = nonnegativeIntegerValue(usage.cache_read_input_tokens) ?? 0;
  const outputTokens = nonnegativeIntegerValue(usage.output_tokens) ?? 0;

  return {
    type: "token_usage_updated",
    runner: claudeCode,
    contextWindowUsedTokens: directInputTokens + cacheCreationTokens + cachedInputTokens + outputTokens
  };
}

function tokenUsageFromResult(
  object: Record<string, unknown>,
  claudeCode: RunnerMetadata
): AgentRunnerEvent | undefined {
  const usage = objectValue(object.usage);
  if (!usage) return undefined;
  const directInputTokens = nonnegativeIntegerValue(usage.input_tokens);
  const cacheCreationTokens = nonnegativeIntegerValue(usage.cache_creation_input_tokens) ?? 0;
  const cachedInputTokens = nonnegativeIntegerValue(usage.cache_read_input_tokens) ?? 0;
  const outputTokens = nonnegativeIntegerValue(usage.output_tokens);
  if (directInputTokens === undefined && outputTokens === undefined) return undefined;

  const inputTokens = (directInputTokens ?? 0) + cacheCreationTokens + cachedInputTokens;
  const totalTokens = inputTokens + (outputTokens ?? 0);
  const modelContextWindowTokens = contextWindowFromModelUsage(object.modelUsage);

  return {
    type: "token_usage_updated",
    runner: claudeCode,
    inputTokens,
    cachedInputTokens,
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens,
    ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {})
  };
}

function contextWindowFromModelUsage(value: unknown): number | undefined {
  const modelUsage = objectValue(value);
  if (!modelUsage) return undefined;
  const windows = Object.values(modelUsage).flatMap((entry) => {
    const contextWindow = positiveIntegerValue(objectValue(entry)?.contextWindow);
    return contextWindow !== undefined ? [contextWindow] : [];
  });
  if (windows.length === 0) return undefined;
  return Math.max(...windows);
}

function claudeCodeToolTitle(name: string): string {
  if (name.startsWith("mcp__")) return "Call MCP tool";
  switch (name) {
    case "Bash":
    case "BashOutput":
      return "Run command";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "Edit files";
    case "Read":
      return "Read file";
    case "Grep":
    case "Glob":
      return "Search files";
    case "WebFetch":
    case "WebSearch":
      return "Search the web";
    case "Task":
    case "Agent":
      return "Run subagent";
    case "TodoWrite":
      return "Update plan";
    case "AskUserQuestion":
      return "Ask the user";
    default:
      return "Call tool";
  }
}

function claudeCodeToolDescription(name: string, input: Record<string, unknown>): string | undefined {
  if (name.startsWith("mcp__")) return compactDisplayText(name);
  if (name === "AskUserQuestion") {
    // The first question's text; the batch itself rides the canonical
    // `question_requested` activity the runner raises from the SDK callback.
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const first = questions[0] && typeof questions[0] === "object" ? (questions[0] as Record<string, unknown>) : undefined;
    const text = stringValue(first?.question);
    return text ? compactDisplayText(text) : undefined;
  }
  const fieldsByTool: Record<string, string[]> = {
    Bash: ["command"],
    Edit: ["file_path"],
    Write: ["file_path"],
    MultiEdit: ["file_path"],
    NotebookEdit: ["notebook_path"],
    Read: ["file_path"],
    Grep: ["pattern"],
    Glob: ["pattern"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    Task: ["description"],
    Agent: ["description"]
  };
  const fields = fieldsByTool[name] ?? ["command", "file_path", "path", "pattern", "query", "url", "description"];
  for (const field of fields) {
    const value = stringValue(input[field]);
    if (value) return compactDisplayText(value);
  }
  return undefined;
}
