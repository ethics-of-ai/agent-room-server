import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A synthetic ACP v1 agent, written to disk and spawned like the real thing.
 *
 * The conformance spike established that the maintained reference agent
 * (`@agentclientprotocol/codex-acp`) cannot reach some required paths
 * guarantee — it resolves permission requests internally, so
 * `session/request_permission` never arrives, and it will not emit a
 * protocol-limit breach on request. It also needs a provider credential and a
 * network, which a unit suite must not.
 *
 * So conformance against the real agent stays a manual check, and *regression*
 * coverage lives here: a scripted peer that can be told to misbehave in exactly
 * the way each boundary is supposed to catch.
 */

export type SyntheticAgentMode =
  | "basic"
  | "no_restore"
  | "permission"
  | "permission_empty"
  | "fs_violation"
  | "never_answers"
  | "load_replay"
  | "oversized_frame"
  | "refusal"
  | "malformed_prompt"
  | "split_utf8"
  | "config_options"
  | "config_options_mode_only";

const AGENT_SOURCE = String.raw`#!/usr/bin/env node
"use strict";
const mode = process.argv[2] || "basic";
// "die": exit shortly after answering the first prompt, so the next turn has to
// restore a conversation whose child is gone — the reap/crash path.
const dieAfterTurn = process.argv.includes("die");
// "images": advertise promptCapabilities.image and report the content blocks
// each prompt actually arrived with, so a test can prove what was sent.
// "images_by_cwd": advertise it only from a child started in an "images-on"
// directory, so one runner can retain children with different negotiations.
const advertisesImages = process.argv.includes("images")
  || (process.argv.includes("images_by_cwd") && process.cwd().endsWith("images-on"));
const updatesConfigWhileIdle = process.argv.includes("config_update_idle");
const omitsSetConfigState = process.argv.includes("set_config_missing_state");
const ignoresConfigSet = process.argv.includes("set_config_ignored");
let turnsAnswered = 0;
// Which restore path this child was started through, so a test can prove the
// conversation was resumed rather than quietly restarted — both of which would
// otherwise produce identical output.
let restoredVia = null;
let buffer = "";
let sessionId = null;

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function sendAcrossUtf8Boundary(message, after) {
  const frame = Buffer.from(JSON.stringify(message) + "\n", "utf8");
  const marker = Buffer.from("🌍", "utf8");
  const markerIndex = frame.indexOf(marker);
  // Split inside the four-byte scalar, not merely between JSON tokens. A
  // transport that decodes each stdout chunk independently will corrupt it.
  process.stdout.write(frame.subarray(0, markerIndex + 1));
  setTimeout(() => {
    process.stdout.write(frame.subarray(markerIndex + 1));
    after();
  }, 20);
}
function update(update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

function capabilities() {
  const prompt = advertisesImages ? { promptCapabilities: { image: true } } : {};
  if (mode === "no_restore") return Object.assign({}, prompt);
  if (mode === "load_replay") return Object.assign({ loadSession: true }, prompt);
  return Object.assign({ loadSession: true, sessionCapabilities: { resume: {} } }, prompt);
}

// Session config selectors, shaped exactly as the reference agent's are: the
// spec's model / thought_level / model_config categories, plus the mode
// selector AgentRoom must refuse to project into a turn setting, and a
// non-spec category that must simply not map.
// (No backticks below: this whole file is one template literal.)
const configValues = { model: "m-fast", reasoning_effort: "low", "fast-mode": "off", mode: "agent" };
function configOptions() {
  if (mode === "config_options_mode_only") {
    return [
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: configValues.mode,
        options: [{ value: "agent", name: "Agent" }, { value: "agent-full-access", name: "Agent (full access)" }] }
    ];
  }
  if (mode !== "config_options") return undefined;
  return [
    { id: "mode", name: "Mode", description: "Approval and sandboxing preset", category: "mode", type: "select",
      currentValue: configValues.mode,
      options: [{ value: "read-only", name: "Read-only" }, { value: "agent", name: "Agent" },
                { value: "agent-full-access", name: "Agent (full access)" }] },
    { id: "collaboration_mode", name: "Collaboration mode", category: "collaboration_mode", type: "select",
      currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }] },
    { id: "model", name: "Model", category: "model", type: "select", currentValue: configValues.model,
      options: [{ value: "m-fast", name: "Fast", description: "Quick" }, { value: "m-deep", name: "Deep" },
                { value: "not a valid id!", name: "Unrepresentable" }] },
    { id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
      currentValue: configValues.reasoning_effort,
      options: [{ value: "low", name: "Low" }, { value: "high", name: "High" },
                { value: "ultra", name: "Ultra" }] },
    { id: "fast-mode", name: "Fast mode", category: "model_config", type: "select",
      currentValue: configValues["fast-mode"],
      options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
    { id: "verbose", name: "Verbose", category: "model_config", type: "boolean", value: false }
  ];
}

function describePrompt(blocks) {
  return (blocks || [])
    .map(function (block) {
      if (block.type !== "image") return block.type;
      return "image:" + block.mimeType + ":" + Buffer.from(block.data || "", "base64").length;
    })
    .join(",");
}

function emitTurn() {
  if (restoredVia) {
    update({ sessionUpdate: "agent_message_chunk", messageId: "m0", content: { type: "text", text: "RESTORED:" + restoredVia + " " } });
  }
  update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Hello " } });
  update({ sessionUpdate: "agent_thought_chunk", messageId: "r1", content: { type: "text", text: "thinking" } });
  update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress", kind: "read", title: "List files" });
  update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { exit_code: 0 } });
  update({ sessionUpdate: "plan", entries: [{ content: "Step one", status: "completed" }] });
  update({ sessionUpdate: "usage_update", used: 1234, size: 200000 });
  // No canonical reading; must produce no event at all.
  update({ sessionUpdate: "session_info_update" });
  update({ sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "world" } });
}

function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: capabilities() } });
    return;
  }
  if (method === "session/new") {
    sessionId = "synthetic-session-1";
    send({ jsonrpc: "2.0", id, result: { sessionId, configOptions: configOptions() } });
    return;
  }
  if (method === "session/set_config_option") {
    // Reject a value that was never offered, the way a real agent would, so the
    // client's own "only what the agent listed" check is not the only guard.
    const offered = (configOptions() || []).find((option) => option.id === params.configId);
    if (!offered || !(offered.options || []).some((option) => option.value === params.value)) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown config value" } });
      return;
    }
    if (omitsSetConfigState) {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (ignoresConfigSet) {
      send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
      return;
    }
    configValues[params.configId] = params.value;
    global.__configSets = (global.__configSets || []).concat([params.configId + "=" + params.value]);
    send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
    return;
  }
  if (method === "session/resume") {
    sessionId = params.sessionId;
    restoredVia = "resume";
    send({ jsonrpc: "2.0", id, result: { configOptions: configOptions() } });
    return;
  }
  if (method === "session/load") {
    sessionId = params.sessionId;
    restoredVia = "load";
    // Replay: the client must consume these without emitting anything.
    update({ sessionUpdate: "agent_message_chunk", messageId: "old", content: { type: "text", text: "REPLAYED" } });
    update({ sessionUpdate: "tool_call", toolCallId: "old-tool", status: "completed", title: "Old tool" });
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "session/prompt") {
    if (mode === "oversized_frame") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, pad: "x".repeat(3 * 1024 * 1024) } }) + "\n");
      return;
    }
    if (mode === "never_answers") {
      // Answers only a cancel.
      global.__pendingPromptId = id;
      return;
    }
    if (mode === "refusal") {
      send({ jsonrpc: "2.0", id, result: { stopReason: "refusal" } });
      return;
    }
    if (mode === "malformed_prompt") {
      send({ jsonrpc: "2.0", id, result: { stopReason: 42 } });
      return;
    }
    if (mode === "split_utf8") {
      sendAcrossUtf8Boundary(
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "split",
              content: { type: "text", text: "Hello 🌍" }
            }
          }
        },
        () => send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } })
      );
      return;
    }
    if (mode === "fs_violation") {
      send({ jsonrpc: "2.0", id: 9001, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
      global.__pendingPromptId = id;
      return;
    }
    if (mode === "permission" || mode === "permission_empty") {
      send({
        jsonrpc: "2.0",
        id: 9002,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { title: "Run rm -rf" },
          options: mode === "permission_empty" ? [] : [
            { optionId: "allow-1", kind: "allow_once", name: "Allow" },
            { optionId: "reject-1", kind: "reject_once", name: "Reject" }
          ]
        }
      });
      global.__pendingPromptId = id;
      return;
    }
    if (advertisesImages) {
      update({ sessionUpdate: "agent_message_chunk", messageId: "prompt", content: { type: "text", text: "PROMPT[" + describePrompt(params.prompt) + "] " } });
    }
    if (mode === "config_options" || mode === "config_options_mode_only") {
      // What the session is actually set to when the prompt arrives — the proof
      // that a selection was applied before the turn rather than merely accepted,
      // and that the sets were sent in the order the client claims.
      update({ sessionUpdate: "agent_message_chunk", messageId: "config", content: { type: "text",
        text: "CONFIG[" + JSON.stringify(configValues) + "|sets:" + (global.__configSets || []).join(",") + "] " } });
    }
    emitTurn();
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    turnsAnswered += 1;
    if (updatesConfigWhileIdle && turnsAnswered === 1) {
      setTimeout(function () {
        configValues.model = "m-deep";
        update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
      }, 20);
    }
    if (dieAfterTurn && turnsAnswered === 1) setTimeout(() => process.exit(0), 50);
    return;
  }
  if (method === "session/cancel") {
    const pending = global.__pendingPromptId;
    if (pending !== undefined) {
      global.__pendingPromptId = undefined;
      send({ jsonrpc: "2.0", id: pending, result: { stopReason: "cancelled" } });
    }
    return;
  }

  // A response to one of our own client requests.
  if (id !== undefined && method === undefined) {
    const pending = global.__pendingPromptId;
    global.__lastClientReply = message;
    if (pending !== undefined) {
      global.__pendingPromptId = undefined;
      // Report what the client answered so the test can assert on it.
      update({
        sessionUpdate: "agent_message_chunk",
        messageId: "reply",
        content: { type: "text", text: "CLIENT_REPLY:" + JSON.stringify(message.result ?? message.error) }
      });
      send({ jsonrpc: "2.0", id: pending, result: { stopReason: "end_turn" } });
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let start = 0;
  let nl = buffer.indexOf("\n", start);
  while (nl >= 0) {
    const line = buffer.slice(start, nl).trim();
    if (line) {
      try { handle(JSON.parse(line)); } catch (error) { /* ignore */ }
    }
    start = nl + 1;
    nl = buffer.indexOf("\n", start);
  }
  buffer = buffer.slice(start);
});
process.stdin.resume();
`;

export interface SyntheticAgent {
  readonly dir: string;
  readonly command: string;
  readonly workspace: string;
}

/** Write the agent to a fresh temp dir and make it executable. */
export function writeSyntheticAgent(): SyntheticAgent {
  const dir = mkdtempSync(join(tmpdir(), "acp-synthetic-"));
  const command = join(dir, "agent.js");
  writeFileSync(command, AGENT_SOURCE, "utf8");
  chmodSync(command, 0o755);
  const workspace = mkdtempSync(join(tmpdir(), "acp-workspace-"));
  return { dir, command, workspace };
}
