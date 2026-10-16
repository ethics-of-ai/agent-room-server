import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { redactSecrets } from "../../util/redactSecrets";

const STDERR_TAIL_LIMIT_CHARS = 2_048;

// The app-server writes diagnostics to stderr, and that pipe must always be
// drained: left unconsumed, the OS pipe buffer fills and blocks the child
// mid-write, silently wedging the session. Draining also keeps a bounded tail
// so startup and crash failures can carry the child's own explanation.
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

// The tail is the child's own text, not ours: it can quote a config line or an
// MCP server's diagnostics, so it is redacted before being appended to an error
// that reaches `/api/coding-agent/capabilities`, turn-failure events, and
// `/api/logs`.
export function appendStderrTail(message: string, stderrTail: string | undefined): string {
  return stderrTail ? `${message} (stderr: ${redactSecrets(stderrTail)})` : message;
}

// Codex inherits the operator's environment so it can find its own credentials
// and tooling, minus AgentRoom's bearer token: `AUTH_TOKEN` is our transport
// secret, nothing the app-server or the MCP servers it starts needs, and it
// would otherwise propagate into every process the turn spawns. Mirrors the
// scrubs in terminal/TerminalSessionService.ts and runner/claudeCode/settings.ts.
export function codexChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTH_TOKEN;
  return env;
}
