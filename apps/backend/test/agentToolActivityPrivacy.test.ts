import { describe, expect, it } from "vitest";
import type { AgentRunnerEvent } from "../src/runner/AgentRunner";
import { mapClaudeCodeMessage } from "../src/runner/claudeCode/messageMapper";
import { mapCodexNotification } from "../src/runner/codex/notificationMapper";
import { createCursorTurnState, mapCursorMessage } from "../src/runner/cursor/messageMapper";
import "../src/sketch/agent/sketchToolContract";

// AgentRoom tool arguments and results never reach `agent_turn_activity`,
// which `/api/events` carries. DeepSeek's mapper has its own test; these are
// the other three transports. A built-in tool keeps its arguments.

const SECRET = "secret-sketch-text";
const editArguments = {
  sketch: "board.sketch.json", baseRevision: 1, label: SECRET,
  operations: [{ op: "create", objectId: "t", kind: "text", text: SECRET }]
};
const serialized = (events: AgentRunnerEvent[]) => JSON.stringify(events);

describe("AgentRoom tool arguments stay out of activities", () => {
  it("Claude Code keeps the name and drops the input of AgentRoom MCP tools", () => {
    const events = mapClaudeCodeMessage({
      type: "assistant", session_id: "s",
      message: { content: [
        { type: "tool_use", id: "toolu_1", name: "mcp__agentroom__agentroom_sketch_edit", input: editArguments },
        { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } }
      ] }
    }, new Map());
    expect(serialized(events)).not.toContain(SECRET);
    expect(serialized(events)).toContain("agentroom_sketch_edit");
    expect(serialized(events)).toContain('"command":"ls"');
  });

  it("Codex drops the arguments and result of an AgentRoom dynamic tool item", () => {
    const item = { id: "item-1", type: "dynamicToolCall", tool: "agentroom_sketch_edit", arguments: editArguments,
      contentItems: [{ type: "inputText", text: SECRET }], status: "completed" };
    const events = [
      ...mapCodexNotification({ method: "item/started", params: { threadId: "th", turnId: "tu", item } }),
      ...mapCodexNotification({ method: "item/completed", params: { threadId: "th", turnId: "tu", item } })
    ];
    expect(events).toHaveLength(2);
    expect(serialized(events)).not.toContain(SECRET);
    expect(serialized(events)).toContain("agentroom_sketch_edit");
    const builtIn = mapCodexNotification({ method: "item/started", params: { item: { type: "commandExecution", command: "ls" } } });
    expect(serialized(builtIn)).toContain('"command":"ls"');
  });

  it("Cursor keeps the tool name and drops the arguments and result of an AgentRoom custom tool", () => {
    const args = { providerIdentifier: "custom-user-tools", toolName: "agentroom_sketch_edit", args: editArguments };
    const context = { runId: "run-1", base: {}, state: createCursorTurnState() };
    const events = [
      ...mapCursorMessage({ type: "tool_call", call_id: "c1", name: "mcp", status: "running", args }, context),
      ...mapCursorMessage({ type: "tool_call", call_id: "c1", name: "mcp", status: "completed", args, result: { value: SECRET } }, context)
    ];
    expect(events).toHaveLength(2);
    expect(serialized(events)).not.toContain(SECRET);
    expect(serialized(events)).toContain("agentroom_sketch_edit");
  });
});
