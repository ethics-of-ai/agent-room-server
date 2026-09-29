import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentRunnerEvent, AgentRunnerToolSet } from "../AgentRunner";
import type { AsyncEventQueue } from "../shared/AsyncEventQueue";
import type { JsonRpcLineClient } from "../shared/JsonRpcLineClient";

/**
 * The app-server adapter's session and turn records, split out of
 * `CodexAppServerRunner.ts` so the question wait and the dynamic-tool relay
 * can serve requests against them without importing the runner.
 */

export interface CodexActiveTurn {
  runId: string;
  queue: AsyncEventQueue<AgentRunnerEvent>;
  finalEvent?: AgentRunnerEvent;
  completedByProtocol: boolean;
  /** The app-server's own id for this turn, from `turn/start` or `turn/started`. */
  turnId?: string;
  /** The session-supplied AgentRoom tools bound to this turn. */
  tools?: AgentRunnerToolSet;
  /** Aborted when the turn ends, ending any dynamic tool call still running. */
  toolCalls: AbortController;
  exitStatus?: { code: number | null; signal: NodeJS.Signals | null };
  failureCategory?: "process_error" | "process_exit" | "process_signal";
}

export interface CodexRunnerSession {
  key: string;
  client: JsonRpcLineClient;
  child: ChildProcessWithoutNullStreams;
  threadId: string;
  activeTurn?: CodexActiveTurn;
  /**
   * The dynamic tool names this process declared at `thread/start`. Undefined
   * after `thread/resume`, which carries no tool list: the thread keeps the
   * catalog it was started with, and the adapter cannot see it.
   */
  registeredToolNames?: ReadonlySet<string>;
}
