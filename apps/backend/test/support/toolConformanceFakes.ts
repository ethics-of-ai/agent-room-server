import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsyncEventQueue } from "../../src/runner/shared/AsyncEventQueue";
import type { ClaudeCodeQuery, ClaudeCodeQueryFunction } from "../../src/runner/claudeCode/sdk";
import { PROBE_TOOL_NAME } from "./probeAgentTool";

/**
 * Fake native agents for the AgentRoom tool conformance suite. Each speaks
 * its runner's real transport (Cursor host JSON-RPC, Codex app-server
 * dynamic tools, the DeepSeek Cordis tools pipe, Claude Code's in-process
 * MCP server) and behaves the same way: it reads one `AGENTROOM_SCRIPT`
 * directive from the prompt, makes the listed tool calls in order through
 * that transport, and reports what it saw as one `AGENTROOM_REPORT` line.
 *
 * `late` makes one call stamped with the previous turn's native identity (run
 * id, turn id, or tool-use id), the delayed call a turn boundary must refuse.
 */

export interface ToolScript {
  calls?: Array<{ name: string; arguments: unknown }>;
  /** A call made before this turn's own calls, with the previous turn's id unless the script names one. */
  late?: { name: string; arguments: unknown; toolUseId?: string };
}

export interface ToolReport {
  /** The tool names the native side registered. */
  tools: string[];
  /** Whether the prompt carried the unregistered or unconfirmed tools notice. */
  notice: boolean;
  results: string[];
  late?: string;
}

export const scriptPrompt = (script: ToolScript, text = "Use the tools."): string => `${text}\nAGENTROOM_SCRIPT ${JSON.stringify(script)}`;

export function reportFrom(text: string): ToolReport | undefined {
  const match = /AGENTROOM_REPORT (\{.*\})/.exec(text);
  return match ? (JSON.parse(match[1]!) as ToolReport) : undefined;
}

/** Shared by the child-process fakes: directive parsing and the report line. */
const SCRIPT_JS = `
function readScript(text) { const m = /AGENTROOM_SCRIPT (\\{.*\\})/.exec(text || ""); return m ? JSON.parse(m[1]) : {}; }
function report(value) { return "AGENTROOM_REPORT " + JSON.stringify(value); }
function hasNotice(text) { return /AgentRoom could not (register|confirm) (that )?these tools/.test(String(text || "")); }
`;

async function writeScript(prefix: string, body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const path = join(root, "fake.cjs");
  await writeFile(path, `${SCRIPT_JS}\n${body}`, "utf8");
  return path;
}

/** A Cursor SDK host: tools arrive at `agent/start` and calls go out as `tools/invoke`. */
export function writeCursorToolHost(): Promise<string> {
  return writeScript("agentroom-conformance-cursor-", `
const rl = require("node:readline").createInterface({ input: process.stdin });
let tools = []; let lastRunId; let runs = 0; let requests = 0;
const pending = new Map(); const cancelled = new Set();
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function request(method, params) {
  return new Promise((resolve) => { const id = "h" + requests++; pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
}
async function runTurn(runId, priorRunId, text) {
  const script = readScript(text);
  const out = { tools, notice: hasNotice(text), results: [] };
  if (script.late && priorRunId) {
    out.late = ((await request("tools/invoke", { tool: script.late.name, input: script.late.arguments, runId: priorRunId })) || {}).result;
  }
  for (const call of script.calls || []) {
    out.results.push(((await request("tools/invoke", { tool: call.name, input: call.arguments, runId })) || {}).result);
  }
  if (cancelled.has(runId)) return;
  notify("run/message", { runId, message: { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: report(out) }] } } });
  notify("run/result", { runId, status: "finished", result: "done" });
}
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined) { const resolve = pending.get(msg.id); if (resolve) { pending.delete(msg.id); resolve(msg.result); } return; }
  const respond = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": return respond({ sdkVersion: "fake-conformance" });
    case "models/list": return respond({ models: [{ id: "default", displayName: "Auto", parameters: [], variants: [{ isDefault: true, params: [] }] }] });
    case "agent/start":
      tools = (msg.params.tools || []).map((tool) => tool.name);
      return respond({ agentId: msg.params.agentId || "agent-fake", resumed: Boolean(msg.params.agentId) });
    case "agent/send": { const runId = "run-" + ++runs; const prior = lastRunId; lastRunId = runId; respond({ runId }); void runTurn(runId, prior, msg.params.text); return; }
    case "run/cancel": cancelled.add(msg.params.runId); respond({}); notify("run/result", { runId: msg.params.runId, status: "cancelled" }); return;
    case "shutdown": respond({}); setImmediate(() => process.exit(0)); return;
    default: send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
});
`);
}

/** A Codex app-server: tools arrive on `thread/start.dynamicTools` and calls go out as `item/tool/call`. */
export function writeCodexToolServer(): Promise<string> {
  return writeScript("agentroom-conformance-codex-", `
const rl = require("node:readline").createInterface({ input: process.stdin });
const threadId = "thread-conformance";
let tools = []; let turns = 0; let lastTurnId; let requests = 0;
const pending = new Map(); const interrupted = new Set();
function send(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
function notify(method, params) { send({ method, params }); }
function request(method, params) {
  return new Promise((resolve) => { const id = "s" + requests++; pending.set(id, resolve); send({ id, method, params }); });
}
const thread = () => ({ id: threadId, status: "running", cwd: "/tmp", turns: [] });
const turn = (id, status) => ({ id, status, items: [], error: null });
const textOf = (response) => (((response || {}).contentItems || [])[0] || {}).text;
async function runTurn(turnId, priorTurnId, text) {
  const script = readScript(text);
  const out = { tools, notice: hasNotice(text), results: [] };
  if (script.late && priorTurnId) {
    out.late = textOf(await request("item/tool/call", { threadId, turnId: priorTurnId, callId: "late", tool: script.late.name, arguments: script.late.arguments }));
  }
  let index = 0;
  for (const call of script.calls || []) {
    out.results.push(textOf(await request("item/tool/call", { threadId, turnId, callId: turnId + "-" + index++, tool: call.name, arguments: call.arguments })));
  }
  if (interrupted.has(turnId)) return;
  notify("item/agentMessage/delta", { threadId, turnId, itemId: "message-" + turnId, delta: report(out) });
  notify("turn/completed", { threadId, turn: turn(turnId, "completed") });
}
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method === undefined) { const resolve = pending.get(msg.id); if (resolve) { pending.delete(msg.id); resolve(msg.result); } return; }
  const respond = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize": return respond({ userAgent: "fake-conformance" });
    case "thread/start": tools = (msg.params.dynamicTools || []).map((tool) => tool.name); return respond({ thread: thread() });
    case "thread/resume": return respond({ thread: thread() });
    case "turn/start": {
      const turnId = "turn-" + ++turns; const prior = lastTurnId; lastTurnId = turnId;
      const text = (msg.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
      respond({ turn: turn(turnId, "inProgress") });
      notify("turn/started", { threadId, turn: turn(turnId, "inProgress") });
      void runTurn(turnId, prior, text);
      return;
    }
    case "turn/interrupt":
      interrupted.add(msg.params.turnId); respond({});
      notify("turn/completed", { threadId, turn: turn(msg.params.turnId, "interrupted") });
      return;
    default: send({ id: msg.id, error: { code: -32601, message: "Method not found: " + msg.method } });
  }
});
`);
}

/** A DeepSeek SDK runtime whose Cordis tools plugin is simulated on the inherited tools pipe. */
export function writeDeepSeekToolRuntime(): Promise<string> {
  return writeScript("agentroom-conformance-deepseek-", `
const rl = require("node:readline").createInterface({ input: process.stdin });
let seq = 0; let prompts = 0; let names = []; let bound; let lastRunId; let calls = 0;
const waiting = new Map();
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function event(sessionId, type, data) { send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type, seq: seq++, time: Date.now(), data } } }); }
function status(sessionId, value) { send({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: value } }); }
let pipe;
if (process.env.AGENTROOM_DEEPSEEK_TOOLS_FD) {
  pipe = new (require("node:net").Socket)({ fd: Number(process.env.AGENTROOM_DEEPSEEK_TOOLS_FD), readable: true, writable: true });
  pipe.setEncoding("utf8");
  let buffer = "";
  pipe.on("data", (chunk) => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf("\\n")) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.type === "catalog") { names = message.catalog.map((tool) => tool.name); pipeSend({ type: "ready", names }); }
      else if (message.type === "bind") { if (bound) lastRunId = bound; bound = message.runId; }
      else if (message.type === "unbind") { if (bound === message.runId) { lastRunId = bound; bound = undefined; } }
      else if (message.type === "result") { const resolve = waiting.get(message.callId); if (resolve) { waiting.delete(message.callId); resolve(message.result); } }
    }
  });
  pipeSend({ type: "hello" });
}
function pipeSend(message) { pipe.write(JSON.stringify({ version: 1, ...message }) + "\\n"); }
function invoke(runId, name, args) {
  if (!pipe) return Promise.resolve(undefined);
  return new Promise((resolve) => { const callId = "c" + ++calls; waiting.set(callId, resolve); pipeSend({ type: "invoke", runId, callId, name, arguments: args }); });
}
const usedRuns = new Set();
// The bind frame rides the tools pipe while the prompt rides stdin, so wait
// for this turn's binding rather than trusting arrival order across pipes.
async function currentBinding() {
  for (let spins = 0; pipe && spins < 400; spins += 1) {
    if (bound && !usedRuns.has(bound)) { usedRuns.add(bound); return bound; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return bound;
}
async function runTurn(sessionId, turn, text) {
  const script = readScript(text);
  const runId = (script.calls || script.late) ? await currentBinding() : bound;
  const out = { tools: names, notice: hasNotice(text), results: [] };
  if (script.late && lastRunId) out.late = await invoke(lastRunId, script.late.name, script.late.arguments);
  for (const call of script.calls || []) out.results.push(await invoke(runId, call.name, call.arguments));
  event(sessionId, "assistant/chunk", { turn, step: 1, chunk: { type: "text-delta", index: 0, text: report(out) } });
  event(sessionId, "assistant/message", { turn, step: 1, message: { role: "assistant", content: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
  event(sessionId, "turn/end", { turn, reason: { kind: "completed" } });
  status(sessionId, "idle");
}
rl.on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    return;
  }
  if (message.method === "shutdown") { send({ jsonrpc: "2.0", id: message.id, result: {} }); process.exit(0); }
  if (message.method !== "session/prompt") return;
  const sessionId = message.params.sessionId;
  const text = (message.params.contentBlocks || []).filter((block) => block.type === "text").map((block) => block.text).join("\\n");
  const turn = ++prompts;
  send({ jsonrpc: "2.0", id: message.id, result: { messageId: "message-" + turn } });
  status(sessionId, "running");
  event(sessionId, "turn/start", { turn });
  void runTurn(sessionId, turn, text);
});
`);
}

/**
 * An in-process stand-in for the Claude Code child. It connects to the real
 * SDK MCP server the runner attached, announces each call as an assistant
 * `tool_use` block, then calls `tools/call` with the CLI's tool-use id in
 * `_meta`, exactly as the bundled CLI does.
 */
export function fakeClaudeToolQuery(record: {
  options: Array<Record<string, unknown>>;
  /** Announce a `tool_use` with this id while the runner checks MCP status, before any turn awaits a result. */
  strayToolUseOnStatus?: string;
}): ClaudeCodeQueryFunction {
  return ({ prompt, options }) => {
    record.options.push(options);
    const output = new AsyncEventQueue<unknown>();
    const sessionId = "claude-conformance";
    let interrupted = false;
    let toolUses = 0;
    let lastToolUseId: string | undefined;
    const server = (options.mcpServers as Record<string, any> | undefined)?.agentroom;
    const mcp = server ? connectMcp(server.instance) : undefined;

    void (async () => {
      output.push({ type: "system", subtype: "init", session_id: sessionId });
      for await (const message of prompt) {
        interrupted = false;
        const text = ((message as any).message.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === "text").map((block) => block.text).join("\n");
        const script = scriptFrom(text);
        const client = mcp ? await mcp : undefined;
        const listed = client ? await client.request("tools/list", {}) : undefined;
        const out: ToolReport = { tools: (listed?.result?.tools ?? []).map((tool: { name: string }) => tool.name), notice: /AgentRoom could not (register|confirm) (that )?these tools/.test(text), results: [] };
        const callTool = async (name: string, args: unknown, toolUseId: string) => {
          if (!client) return undefined;
          const reply = await client.request("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } });
          return reply.result?.content?.[0]?.text as string | undefined;
        };
        const lateToolUseId = script.late?.toolUseId ?? lastToolUseId;
        if (script.late && lateToolUseId) out.late = await callTool(script.late.name, script.late.arguments, lateToolUseId);
        for (const call of script.calls ?? []) {
          const toolUseId = `toolu_${++toolUses}`;
          lastToolUseId = toolUseId;
          output.push({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: `mcp__agentroom__${call.name}`, input: call.arguments }] } });
          out.results.push((await callTool(call.name, call.arguments, toolUseId)) as string);
        }
        if (interrupted) continue;
        output.push({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `AGENTROOM_REPORT ${JSON.stringify(out)}` } } });
        output.push({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sessionId });
      }
    })();

    const query: ClaudeCodeQuery = {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      async interrupt() {
        interrupted = true;
        output.push({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId });
      },
      async mcpServerStatus() {
        if (record.strayToolUseOnStatus) {
          output.push({ type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: record.strayToolUseOnStatus, name: `mcp__agentroom__${PROBE_TOOL_NAME}`, input: {} }] } });
        }
        return server ? [{ name: "agentroom", status: "connected" }] : [];
      },
      async return() {
        output.close();
        return { done: true, value: undefined };
      }
    };
    return query;
  };
}

function scriptFrom(text: string): ToolScript {
  const match = /AGENTROOM_SCRIPT (\{.*\})/.exec(text);
  return match ? (JSON.parse(match[1]!) as ToolScript) : {};
}

/** Connect to an SDK MCP server instance over an in-memory transport. */
async function connectMcp(instance: { connect(transport: unknown): Promise<void> }) {
  const sent: Array<Record<string, any>> = [];
  const waiters = new Map<number, (reply: Record<string, any>) => void>();
  const transport: Record<string, any> = {
    start: async () => undefined,
    close: async () => undefined,
    send: async (message: Record<string, any>) => {
      sent.push(message);
      if (typeof message.id === "number") waiters.get(message.id)?.(message);
    }
  };
  await instance.connect(transport);
  let nextId = 0;
  const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, any>>((resolve) => {
    const id = ++nextId;
    waiters.set(id, resolve);
    transport.onmessage({ jsonrpc: "2.0", id, method, params });
  });
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
  transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request };
}
