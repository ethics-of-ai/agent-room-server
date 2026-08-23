#!/usr/bin/env node
/**
 * ACP conformance tee launcher.
 *
 * A pass-through launcher for an external ACP agent that records both
 * directions of the NDJSON wire to a log file, so the conformance procedure in
 * `docs/engineering/ACP_CONFORMANCE.md` can observe what an agent actually sent
 * — notably the `session/new` response every Phase 4 mapping decision rests on
 * — while driving the real product path rather than a throwaway client.
 *
 * It exists for two reasons beyond logging:
 *
 * - **It satisfies admission.** `runner/acp/admission.ts` requires an absolute,
 *   non-symlink, regular, executable file. A globally installed npm bin is
 *   normally a symlink, which is refused by design (a symlink's target can be
 *   repointed after the operator reviewed it). This file is a real file in the
 *   repo, so it can be named directly.
 * - **It forwards the allowlisted environment.** An ACP child receives only the
 *   base allowlist plus the operator's explicit `envGrants`, never an
 *   inheritance. Whatever this process was given is what the agent gets.
 *
 * Usage (as the adapter's `command`, with the agent as its `args`):
 *
 *   command: /abs/path/to/scripts/acp-conformance-agent.mjs
 *   args:    ["/abs/path/to/node", "/abs/path/to/codex-acp/dist/index.js"]
 *
 * The log path is `ACP_TEE_LOG` when granted, else
 * `$TMPDIR/agentroom-acp-conformance.log`. **The log contains prompts, agent
 * output, and anything else that crossed the wire — treat it as sensitive, keep
 * it outside the repository, and delete it when the run is done.**
 *
 * This is a diagnostic tool. It is not part of the backend, is not shipped by
 * `scripts/package-macos.mjs`, and no product behavior depends on it.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [program, ...programArgs] = process.argv.slice(2);

if (!program) {
  process.stderr.write(
    "acp-conformance-agent: usage: acp-conformance-agent.mjs <agent-executable> [args...]\n"
  );
  process.exit(2);
}

const logPath = process.env.ACP_TEE_LOG || join(process.env.TMPDIR || tmpdir(), "agentroom-acp-conformance.log");

/**
 * Logging is strictly best-effort: a failed write must never disturb the
 * protocol, because a dropped or delayed frame would turn a diagnostic tool
 * into the thing under test.
 */
let log = null;
try {
  log = createWriteStream(logPath, { flags: "a" });
  log.on("error", () => {
    log = null;
  });
} catch {
  log = null;
}

/** Keep one pathological frame (a base64 image prompt) from filling the disk. */
const MAX_LOGGED_LINE = 256 * 1024;

function write(direction, line) {
  if (!log || line.length === 0) return;
  const body = line.length > MAX_LOGGED_LINE
    ? `${line.slice(0, MAX_LOGGED_LINE)}…[truncated ${line.length - MAX_LOGGED_LINE} chars]`
    : line;
  log.write(`${new Date().toISOString()} ${direction} ${body}\n`);
}

/**
 * Log line-by-line while the bytes themselves pass through untouched: the
 * transport is NDJSON, so a per-chunk prefix would interleave mid-frame and the
 * capture would be unreadable exactly when it mattered.
 */
function lineTee(direction) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        write(direction, buffer.slice(0, index).trimEnd());
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      write(direction, buffer.trimEnd());
      buffer = "";
    }
  };
}

write("###", `launch ${JSON.stringify([program, ...programArgs])}`);

const child = spawn(program, programArgs, {
  stdio: ["pipe", "pipe", "pipe"],
  // Forward exactly what this process received. The backend already reduced it
  // to the base allowlist plus explicit grants.
  env: process.env
});

child.on("error", (error) => {
  write("###", `spawn failed: ${error.message}`);
  process.stderr.write(`acp-conformance-agent: cannot spawn ${program}: ${error.message}\n`);
  process.exit(127);
});

const toAgent = lineTee("-->");
const fromAgent = lineTee("<--");
const stderrTee = lineTee("!!!");

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

process.stdin.on("data", (chunk) => toAgent.push(chunk));
child.stdout.on("data", (chunk) => fromAgent.push(chunk));
child.stderr.on("data", (chunk) => stderrTee.push(chunk));

// A broken pipe on either side is an ordinary shutdown race, not an error worth
// crashing the launcher over — the child's exit is what decides our status.
process.stdin.on("error", () => {});
child.stdin.on("error", () => {});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    write("###", `forwarding ${signal}`);
    child.kill(signal);
  });
}

child.on("close", (code, signal) => {
  toAgent.flush();
  fromAgent.flush();
  stderrTee.flush();
  write("###", `agent exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  const exit = () => process.exit(signal ? 128 : (code ?? 0));
  if (log) log.end(exit);
  else exit();
});
