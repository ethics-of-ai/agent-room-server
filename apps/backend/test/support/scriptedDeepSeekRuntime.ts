import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One step a scripted DeepSeek runtime takes. `session` is `"root"` for the
 * AgentRoom session's own id, or a literal child session id.
 */
export type ScriptedStep =
  | { status: "running" | "idle" }
  | { event: string; session?: string; data: unknown }
  | { notify: string; params: unknown }
  | { wait: number }
  | { exit: number };

/**
 * Writes a fake `dsh` SDK runtime that answers `initialize`, and answers the
 * Nth `session/prompt` with a receipt followed by `prompts[N - 1]`, played in
 * order. A string inside any value equal to `"$root"` becomes the root session
 * id, so a script can name the owner of a job.
 */
export async function writeScriptedDeepSeekRuntime(prompts: ScriptedStep[][]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-scripted-dsh-"));
  const path = join(root, "scripted-dsh-runtime.cjs");
  await writeFile(path, `
const readline = require("node:readline");
const prompts = ${JSON.stringify(prompts)};
let seq = 0;
let promptNumber = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const resolve = (value, rootId) => JSON.parse(JSON.stringify(value), (_key, item) => item === "$root" ? rootId : item);

async function play(steps, rootId) {
  for (const step of steps) {
    if ("wait" in step) { await new Promise((done) => setTimeout(done, step.wait)); continue; }
    if ("exit" in step) process.exit(step.exit);
    if ("status" in step) {
      send({ jsonrpc: "2.0", method: "session.status", params: { sessionId: rootId, status: step.status } });
      continue;
    }
    if ("event" in step) {
      const sessionId = !step.session || step.session === "root" ? rootId : step.session;
      send({ jsonrpc: "2.0", method: "session.event", params: {
        sessionId, event: { type: step.event, seq: seq++, time: Date.now(), data: resolve(step.data, rootId) }
      } });
      continue;
    }
    send({ jsonrpc: "2.0", method: step.notify, params: resolve(step.params, rootId) });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    process.exit(0);
  }
  if (message.method !== "session/prompt") return;
  promptNumber += 1;
  send({ jsonrpc: "2.0", id: message.id, result: { messageId: "message-" + promptNumber } });
  void play(prompts[promptNumber - 1] || [], message.params.sessionId);
});
`, "utf8");
  return path;
}

/** The steps of one complete root turn: running, `turn/start`, the body, `turn/end`, idle. */
export function rootTurn(turn: number, body: ScriptedStep[], source: Record<string, unknown> = { kind: "user" }): ScriptedStep[] {
  return [
    { event: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [{ id: `message-${turn}`, source }] } },
    { status: "running" },
    { event: "turn/start", data: { turn } },
    { event: "user/message", data: { id: `message-${turn}`, source } },
    ...body,
    { event: "turn/end", data: { turn, reason: { kind: "completed" } } },
    { status: "idle" }
  ];
}

export function say(text: string, session = "root"): ScriptedStep {
  return { event: "assistant/message", session, data: { message: { role: "assistant", content: [{ type: "text", text }] } } };
}

export function toolCall(callId: string, name: string, args: Record<string, unknown>, session = "root"): ScriptedStep {
  return { event: "tool/call", session, data: { callId, name, arguments: JSON.stringify(args) } };
}

export function toolResult(callId: string, text: string, session = "root"): ScriptedStep {
  return {
    event: "tool/result",
    session,
    data: { message: { role: "tool", source: { kind: "tool", callId }, toolCallId: callId, content: [{ type: "text", text }] } }
  };
}

export function jobRegistered(jobId: string, label: string, callId: string, owner = "$root"): ScriptedStep {
  return {
    event: "job/registered",
    session: owner === "$root" ? "root" : owner,
    data: { jobId, owner, kind: "bash", label, startedAt: 1_760_000_000_000, toolCall: { callId, rootCallId: callId } }
  };
}

export function jobSettled(
  jobId: string,
  label: string,
  callId: string,
  status: "completed" | "killed" | "failed",
  owner = "$root"
): ScriptedStep {
  return {
    event: "job/settled",
    session: owner === "$root" ? "root" : owner,
    data: {
      jobId, owner, kind: "bash", label, startedAt: 1_760_000_000_000, toolCall: { callId, rootCallId: callId },
      finishedAt: 1_760_000_001_000, status, cause: status === "killed" ? "kill" : "producer", producerReported: true
    }
  };
}
