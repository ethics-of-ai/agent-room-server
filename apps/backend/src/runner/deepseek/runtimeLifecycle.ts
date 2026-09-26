import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { redactSecrets } from "../../util/redactSecrets";
import { DEEPSEEK_RUNTIME_BINARY } from "./settings";
import { DEEPSEEK_SDK_SERVER_NAME } from "./protocol";

const STDERR_TAIL_LIMIT_CHARS = 2_048;

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
    `DEEPSEEK_EXECUTABLE must be ${DEEPSEEK_RUNTIME_BINARY}, the packaged single-file runtime, or the interpreter that runs a source build's entrypoint — the dsh launcher boots profiles and serves no SDK protocol. ` +
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
