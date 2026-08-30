import type { AgentRunnerActivity, AgentRunnerEvent, CanonicalPlanStep, RunnerMetadata } from "../AgentRunner";
import type { JsonRpcNotification } from "../shared/JsonRpcLineClient";
import { compactDisplayText, displayTextValue } from "../shared/displayText";
import { arrayValue, nonnegativeIntegerValue, objectValue, positiveIntegerValue, stringValue } from "../shared/jsonValues";
import { codexDiffSummary } from "./diffSummary";

const MAX_PLAN_STEPS = 50;

// Codex item types AgentRoom renders as tool activity. An item of any other
// type still reaches the legacy `agent_turn_activity` event, but gets no
// canonical reading, so it produces no `coding_*` event. Deciding that here is
// what keeps the renderability rule Codex knowledge rather than a special case
// in the shared mapper.
const RENDERABLE_ITEM_TYPES = new Set([
  "command",
  "commandExecution",
  "tool",
  "toolCall",
  "mcpToolCall",
  "functionCall",
  "fileChange",
  "applyPatch",
  "patch"
]);

export function mapCodexNotification(notification: JsonRpcNotification): AgentRunnerEvent[] {
  const params = objectValue(notification.params);

  if (notification.method === "item/agentMessage/delta") {
    const delta = stringValue(params?.delta);
    return delta ? [{ type: "agent_update", message: delta, runner: runnerMetadataFromNotification(notification) }] : [];
  }

  const tokenUsageEvent = tokenUsageEventFromNotification(notification);
  if (tokenUsageEvent) return [tokenUsageEvent];

  const activity = activityFromNotification(notification);
  return activity ? [{ type: "agent_activity", activity }] : [];
}

export function completionFromNotification(notification: JsonRpcNotification): AgentRunnerEvent | undefined {
  const params = objectValue(notification.params);
  if (notification.method === "turn/completed") {
    const turn = objectValue(params?.turn);
    const status = stringValue(turn?.status);
    const error = objectValue(turn?.error);
    if (status === "failed") {
      return {
        type: "run_failed",
        error: stringValue(error?.message) ?? "Codex app-server turn failed"
      };
    }
    return { type: "run_succeeded", message: "Codex app-server turn completed" };
  }

  if (notification.method === "error") {
    const error = objectValue(params?.error);
    return {
      type: "run_failed",
      error: stringValue(error?.message) ?? "Codex app-server reported an error"
    };
  }

  return undefined;
}

/**
 * Correlation and display metadata for one Codex notification, in the
 * runner-agnostic envelope shape. The JSON-RPC method name has no canonical
 * home, so it rides the bounded `native` blob — which is also where the legacy
 * `codex` wire block's `method` field is rebuilt from.
 */
export function runnerMetadataFromNotification(notification: JsonRpcNotification): RunnerMetadata {
  const params = objectValue(notification.params);
  const thread = objectValue(params?.thread);
  const nativeSessionId = stringValue(params?.threadId) ?? stringValue(thread?.id);
  const nativeTurnId = stringValue(params?.turnId) ?? stringValue(objectValue(params?.turn)?.id);
  const nativeItemId = stringValue(params?.itemId) ?? stringValue(objectValue(params?.item)?.id);
  const model = stringValue(params?.model) ?? stringValue(thread?.model);
  const cwd = stringValue(params?.cwd) ?? stringValue(thread?.cwd);
  const approvalPolicy = stringValue(params?.approvalPolicy) ?? stringValue(thread?.approvalPolicy);
  const sandbox = params?.sandbox ?? thread?.sandbox;
  return {
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    ...(nativeItemId ? { nativeItemId } : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    ...(approvalPolicy ? { posture: { label: "approvalPolicy", value: approvalPolicy } } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    native: { method: notification.method }
  };
}

function activityFromNotification(notification: JsonRpcNotification): AgentRunnerActivity | undefined {
  const params = objectValue(notification.params);
  const runner = runnerMetadataFromNotification(notification);

  if (notification.method === "thread/started") {
    return {
      kind: "codex_thread_started",
      title: "Thread started",
      content: params ?? {},
      canonical: { kind: "session_started" },
      runner
    };
  }

  if (notification.method === "turn/started") {
    return {
      kind: "codex_turn_started",
      title: "Turn started",
      content: params ?? {},
      canonical: { kind: "turn_started" },
      runner
    };
  }

  if (notification.method === "turn/plan/updated") {
    return {
      kind: "codex_plan_updated",
      title: "Plan updated",
      content: params ?? {},
      canonical: {
        kind: "plan_updated",
        ...(stringValue(params?.explanation) ? { explanation: stringValue(params?.explanation) } : {}),
        steps: planSteps(params?.plan)
      },
      runner
    };
  }

  if (notification.method === "turn/diff/updated") {
    const diff = codexDiffSummary(params ?? {});
    return {
      kind: "codex_diff_updated",
      title: "Diff updated",
      content: params ?? {},
      canonical: {
        kind: "diff_updated",
        ...(stringValue(params?.summary) ? { summary: stringValue(params?.summary) } : {}),
        files: diff.files,
        ...(diff.truncated ? { truncated: true } : {})
      },
      runner
    };
  }

  // Ahead of the generic item branches below, and deliberately not by adding
  // the type to RENDERABLE_ITEM_TYPES: that set is what makes an item a tool
  // call, and a compaction is not one. Its own content is dropped rather than
  // passed through, because a compaction item may carry the summary.
  if (notification.method === "item/started" && isContextCompactionItem(params)) {
    return {
      kind: "codex_context_compaction_started",
      title: "Compacting context",
      content: {},
      canonical: { kind: "context_compaction_started" },
      runner
    };
  }

  if (notification.method === "item/completed" && isContextCompactionItem(params)) {
    return {
      kind: "codex_context_compaction_completed",
      title: "Context compacted",
      content: {},
      // Codex reports no counts and no trigger with the item, and this adapter
      // does not invent either. `thread/compacted` is deliberately unmapped:
      // whether it arrives, the item does, or both is unconfirmed, and mapping
      // both would complete one compaction twice.
      canonical: { kind: "context_compaction_completed" },
      runner
    };
  }

  if (notification.method === "item/started") {
    const itemDisplay = itemDisplayInfo(params, "Item started");
    return {
      kind: "codex_item_started",
      title: itemDisplay.title,
      ...(itemDisplay.description ? { description: itemDisplay.description } : {}),
      content: params ?? {},
      ...(isRenderableItem(params)
        ? { canonical: { kind: "tool_started", ...(runner.nativeItemId ? { toolId: runner.nativeItemId } : {}) } as const }
        : {}),
      runner
    };
  }

  if (notification.method === "item/completed") {
    const itemDisplay = itemDisplayInfo(params, "Item completed");
    return {
      kind: "codex_item_completed",
      title: itemDisplay.title,
      ...(itemDisplay.description ? { description: itemDisplay.description } : {}),
      content: params ?? {},
      ...(isRenderableItem(params)
        ? { canonical: { kind: "tool_completed", ...(runner.nativeItemId ? { toolId: runner.nativeItemId } : {}) } as const }
        : {}),
      runner
    };
  }

  if (notification.method.endsWith("/outputDelta")) {
    const delta = stringValue(params?.delta) ?? stringValue(params?.text) ?? stringValue(params?.output);
    return {
      kind: "codex_output_delta",
      title: "Tool output",
      content: params ?? {},
      canonical: {
        kind: "tool_output",
        ...(runner.nativeItemId ? { toolId: runner.nativeItemId } : {}),
        ...(delta ? { delta } : {})
      },
      runner
    };
  }

  if (notification.method === "permission/requested") {
    return {
      kind: "codex_permission_requested",
      title: "Permission requested",
      content: params ?? {},
      canonical: { kind: "permission_requested", request: objectValue(params?.request) ?? params ?? {} },
      runner
    };
  }

  if (notification.method === "permission/resolved") {
    return {
      kind: "codex_permission_resolved",
      title: "Permission resolved",
      content: params ?? {},
      canonical: {
        kind: "permission_resolved",
        ...(stringValue(params?.requestId) ? { requestId: stringValue(params?.requestId) } : {}),
        ...(stringValue(params?.status) ? { status: stringValue(params?.status) } : {})
      },
      runner
    };
  }

  if (notification.method.startsWith("item/reasoning/")) {
    const delta = stringValue(params?.delta) ??
      stringValue(params?.text) ??
      stringValue(params?.summary) ??
      stringValue(params?.message);
    return {
      kind: "codex_reasoning",
      title: "Reasoning update",
      content: params ?? {},
      canonical: { kind: "reasoning", ...(delta ? { delta } : {}) },
      runner
    };
  }

  return undefined;
}

/** The `ThreadItem` variant Codex reports a context compaction as. */
function isContextCompactionItem(params: Record<string, unknown> | undefined): boolean {
  return stringValue(objectValue(params?.item)?.type) === "contextCompaction";
}

function isRenderableItem(params: Record<string, unknown> | undefined): boolean {
  const itemType = stringValue(objectValue(params?.item)?.type);
  return Boolean(itemType && RENDERABLE_ITEM_TYPES.has(itemType));
}

function planSteps(value: unknown): CanonicalPlanStep[] {
  return arrayValue(value).slice(0, MAX_PLAN_STEPS).flatMap((item) => {
    const object = objectValue(item);
    const step = stringValue(object?.step);
    if (!step) return [];
    return [{ step, status: stringValue(object?.status) ?? "unknown" }];
  });
}

function tokenUsageEventFromNotification(notification: JsonRpcNotification): AgentRunnerEvent | undefined {
  if (notification.method !== "thread/tokenUsage/updated") return undefined;
  const params = objectValue(notification.params);
  const tokenUsage = objectValue(params?.tokenUsage);
  const total = objectValue(tokenUsage?.total);
  const inputTokens = nonnegativeIntegerValue(total?.inputTokens);
  const cachedInputTokens = nonnegativeIntegerValue(total?.cachedInputTokens);
  const outputTokens = nonnegativeIntegerValue(total?.outputTokens);
  const reasoningOutputTokens = nonnegativeIntegerValue(total?.reasoningOutputTokens);
  const totalTokens = nonnegativeIntegerValue(total?.totalTokens);
  // `total` accumulates across every request in the thread; `last` is the most
  // recent request, which is what actually reflects context-window occupancy.
  const contextWindowUsedTokens = nonnegativeIntegerValue(objectValue(tokenUsage?.last)?.totalTokens);
  const modelContextWindowTokens = positiveIntegerValue(tokenUsage?.modelContextWindow);

  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined &&
    totalTokens === undefined &&
    contextWindowUsedTokens === undefined &&
    modelContextWindowTokens === undefined
  ) {
    return undefined;
  }

  return {
    type: "token_usage_updated",
    runner: runnerMetadataFromNotification(notification),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
    ...(modelContextWindowTokens !== undefined ? { modelContextWindowTokens } : {})
  };
}

interface ItemDisplayInfo {
  title: string;
  description?: string;
}

function itemDisplayInfo(params: Record<string, unknown> | undefined, fallback: string): ItemDisplayInfo {
  const item = objectValue(params?.item);
  const type = stringValue(item?.type);
  if (!type) return { title: fallback };

  const title = codexItemTitle(type) ?? `${fallback}: ${type}`;
  const description = item ? codexItemDescription(type, item) : undefined;
  return {
    title,
    ...(description ? { description } : {})
  };
}

function codexItemTitle(type: string): string | undefined {
  switch (type) {
    case "command":
    case "commandExecution":
      return "Run command";
    case "mcpToolCall":
      return "Call MCP tool";
    case "functionCall":
    case "tool":
    case "toolCall":
      return "Call tool";
    case "fileChange":
      return "Edit files";
    case "applyPatch":
    case "patch":
      return "Apply patch";
    default:
      return undefined;
  }
}

function codexItemDescription(type: string, item: Record<string, unknown>): string | undefined {
  switch (type) {
    case "command":
    case "commandExecution":
      return commandDescription(item);
    case "mcpToolCall":
      return mcpToolDescription(item);
    case "functionCall":
    case "tool":
    case "toolCall":
      return functionToolDescription(item);
    case "fileChange":
      return fileChangeDescription(item);
    case "applyPatch":
    case "patch":
      return patchDescription(item);
    default:
      return stringFromFields(item, ["title", "name", "description"]);
  }
}

function commandDescription(item: Record<string, unknown>): string | undefined {
  return stringFromFields(item, [
    "command",
    "cmd",
    "commandLine",
    "command_line",
    "input",
    "inputText",
    "script",
    "parsedCmd",
    "parsed_cmd",
    "action"
  ]) ?? commandActionsDescription(item.commandActions);
}

function mcpToolDescription(item: Record<string, unknown>): string | undefined {
  const invocation = objectValue(item.invocation);
  const server = stringFromFields(item, ["server", "serverName", "mcpServer", "namespace"]) ??
    stringFromFields(invocation, ["server", "serverName", "mcpServer", "namespace"]);
  const tool = stringFromFields(item, ["tool", "toolName", "name"]) ??
    stringFromFields(invocation, ["tool", "toolName", "name"]);
  const target = [server, tool].filter(Boolean).join(".");
  return compactDisplayText(target) ?? stringFromFields(item, ["title", "description"]);
}

function functionToolDescription(item: Record<string, unknown>): string | undefined {
  const namespace = stringFromFields(item, ["namespace", "server", "serverName"]);
  const name = stringFromFields(item, ["name", "tool", "toolName", "functionName"]);
  const target = [namespace, name].filter(Boolean).join(".");
  return compactDisplayText(target) ?? stringFromFields(item, ["title", "description"]);
}

function fileChangeDescription(item: Record<string, unknown>): string | undefined {
  return stringFromFields(item, ["path", "file", "filePath", "targetPath"]) ??
    pathsDescription(item.paths) ??
    pathsDescription(item.files);
}

function patchDescription(item: Record<string, unknown>): string | undefined {
  return stringFromFields(item, ["path", "file", "filePath", "targetPath", "move_path"]) ??
    pathsDescription(item.paths) ??
    pathsDescription(item.files);
}

function commandActionsDescription(value: unknown): string | undefined {
  const actions = arrayValue(value)
    .flatMap((item) => {
      const action = objectValue(item);
      if (!action) return [];
      const display = stringFromFields(action, ["command", "cmd", "query", "path", "pattern", "type"]);
      return display ? [display] : [];
    });
  if (actions.length === 0) return undefined;
  return compactDisplayText(actions.join(", "));
}

function pathsDescription(value: unknown): string | undefined {
  const paths = arrayValue(value)
    .flatMap((item) => {
      const text = displayTextValue(item);
      return text ? [text] : [];
    });
  if (paths.length === 0) return undefined;
  if (paths.length === 1) return paths[0];
  return compactDisplayText(`${paths.length} files`);
}

function stringFromFields(object: Record<string, unknown> | undefined, fields: string[]): string | undefined {
  if (!object) return undefined;
  for (const field of fields) {
    const value = displayTextValue(object[field]);
    if (value) return value;
  }
  return undefined;
}

