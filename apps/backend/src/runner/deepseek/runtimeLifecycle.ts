import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { logger } from "../../logging/logger";
import { withTimeout } from "../shared/asyncUtils";
import type { JsonRpcLineClient } from "../shared/JsonRpcLineClient";
import { redactSecrets } from "../../util/redactSecrets";
import { DEEPSEEK_RUNTIME_BINARY } from "./settings";
import { DEEPSEEK_SDK_SERVER_NAME } from "./protocol";

const STDERR_TAIL_LIMIT_CHARS = 2_048;

/** How the JSON-RPC client names the child in its errors. */
export const DEEPSEEK_CLIENT_LABEL = "DeepSeek Harness runtime";

export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

export async function settled(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([exited.then(() => true), elapsed]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function wrongServerMessage(reportedName: string): string {
  return (
    `Expected the DeepSeek Harness SDK runtime (${DEEPSEEK_SDK_SERVER_NAME}) but the child identified as "${reportedName}". ` +
    `DEEPSEEK_EXECUTABLE must be the ${DEEPSEEK_RUNTIME_BINARY} launcher, or the interpreter that runs a source build's CLI entrypoint, and the composition must mount the SDK JSON-RPC server. ` +
    "If this is a source build, the runtime may have renamed its server on a newer commit"
  );
}

export function collectStderrTail(child: ChildProcessWithoutNullStreams): () => string | undefined {
  let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT_CHARS);
  });
  return () => {
    const text = tail.trim();
    return text.length > 0 ? text : undefined;
  };
}

export function appendStderrTail(message: string, stderrTail: string | undefined): string {
  return stderrTail ? `${message} (stderr: ${redactSecrets(stderrTail)})` : message;
}

/**
 * What the teardown ladder needs to end a runtime, which is deliberately less
 * than a session: the capability probe's throwaway child gets the same rungs,
 * because a runtime that ignores SIGTERM leaks just as thoroughly when nobody
 * was talking to it.
 */
export interface TerminableRuntime {
  key: string;
  client: JsonRpcLineClient;
  child: ChildProcessWithoutNullStreams;
  terminateImmediately: boolean;
}

// The teardown ladder, in the order the protocol documents and the vendor's own
// client walks it: ask for `shutdown` and let the plugin flush and dispose to
// quiescence, then close stdin (EOF is a documented exit path, but one that
// "may cut off an in-flight turn"), then signal, then insist. Each rung has its
// own bound because each can be the one that hangs, and the last rung cannot.
const SHUTDOWN_TIMEOUT_MS = 2_000;
const STDIN_EOF_GRACE_MS = 6_000;
const SIGTERM_GRACE_MS = 3_000;

export async function terminateDeepSeekRuntime(session: TerminableRuntime): Promise<void> {
  const exited = waitForExit(session.child);
  try {
    if (!session.terminateImmediately && session.child.exitCode === null && !session.child.killed) {
      await withTimeout(
        session.client.request("shutdown", {}),
        SHUTDOWN_TIMEOUT_MS,
        "Timed out shutting down the DeepSeek Harness runtime"
      );
    }
  } catch {
    // A runtime that will not answer `shutdown` is exactly what the rest of
    // the ladder is for, so this is never worth failing a caller over.
  }
  session.client.dispose();
  if (await settled(exited, 0)) return;

  session.child.stdin.end();
  if (await settled(exited, STDIN_EOF_GRACE_MS)) return;

  session.child.kill("SIGTERM");
  if (await settled(exited, SIGTERM_GRACE_MS)) return;

  logger.warn(
    { sessionKey: session.key, pid: session.child.pid },
    "DeepSeek Harness runtime ignored SIGTERM; sending SIGKILL"
  );
  session.child.kill("SIGKILL");
  await exited;
}
