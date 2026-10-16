import type { AgentRunnerEvent } from "../AgentRunner";
import type { AsyncEventQueue } from "../shared/AsyncEventQueue";
import type { ClaudeSessionTools } from "./agentTools";
import type { ClaudeCodeBackgroundTasks } from "./backgroundTasks";
import type { ClaudeCodeToolUseDisplay } from "./messageMapper";
import type { ClaudeCodeQuery } from "./sdk";

export interface ClaudeCodeActiveTurn {
  runId: string;
  queue: AsyncEventQueue<AgentRunnerEvent>;
  finalEvent?: AgentRunnerEvent;
  completedByProtocol: boolean;
  /** The `uuid` the turn's prompt was sent with; the CLI echoes it on the turn's result. */
  sendUuid?: string;
  /** The agent started this turn itself, after background work finished. */
  agentStarted?: boolean;
}

export interface ClaudeCodeRunnerSession {
  key: string;
  query: ClaudeCodeQuery;
  input: AsyncEventQueue<unknown>;
  sdkSessionId?: string;
  model?: string;
  effort?: string;
  toolUses: Map<string, ClaudeCodeToolUseDisplay>;
  /** AgentRoom tools attached at spawn; absent when the child was spawned without any. */
  tools?: ClaudeSessionTools;
  activeTurn?: ClaudeCodeActiveTurn;
  /** The run id of the latest turn this child took, a person's or the agent's own. */
  latestRunId?: string;
  // One SDK `result` message arrives per pushed user message, in order. Turns
  // queue here when their prompt is pushed so completions route to the turn
  // that owns them — an interrupted turn's trailing result must not close the
  // steering follow-up that replaced it as the active turn.
  turnsAwaitingResult: ClaudeCodeActiveTurn[];
  /** The child's live background tasks and the notifications not yet answered. */
  background: ClaudeCodeBackgroundTasks;
  /**
   * The agent is answering background work in a turn the service refused. Its
   * events are dropped until its result, and no second turn opens for it.
   */
  refusedAgentTurn?: boolean;
}
