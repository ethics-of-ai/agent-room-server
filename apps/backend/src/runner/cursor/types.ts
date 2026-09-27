import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentRunnerEvent, RunnerMetadata } from "../AgentRunner";
import type { AgentToolBinding } from "../../agentTools/dispatch";
import type { AsyncEventQueue } from "../shared/AsyncEventQueue";
import type { JsonRpcLineClient } from "../shared/JsonRpcLineClient";
import type { CursorTurnState } from "./messageMapper";

/**
 * The adapter's session and turn records. Split out of `CursorSdkRunner.ts`
 * so the tool relay (`toolRelay.ts`) can serve host requests and bind turn
 * tools against them without the runner and the relay importing each other.
 */

export interface CursorActiveTurn {
  runId: string;
  cursorRunId?: string;
  /**
   * Settles with the host's run id once `agent/send` answers, or with
   * `undefined` when the turn ends without one. The host can relay its first
   * tool call in the same stdout chunk as that answer, before `cursorRunId` is
   * recorded, so the relay waits on this rather than reading the call as stale.
   */
  cursorRunIdKnown: Promise<string | undefined>;
  settleCursorRunId: (runId: string | undefined) => void;
  sendAttempted: boolean;
  queue: AsyncEventQueue<AgentRunnerEvent>;
  finalEvent?: AgentRunnerEvent;
  completed: boolean;
  state: CursorTurnState;
  base: RunnerMetadata;
  pendingQuestionRequestId?: string;
  /** Resolved when the turn settles, so the cancel ladder can wait on it. */
  onSettled?: () => void;
}

export interface CursorRunnerSession {
  key: string;
  client: JsonRpcLineClient;
  child: ChildProcessWithoutNullStreams;
  stderrTail: () => string | undefined;
  agentId?: string;
  base: RunnerMetadata;
  activeTurn?: CursorActiveTurn;
  sessionStartedEmitted: boolean;
  explicitlyClosed: boolean;
  /**
   * The live turn's AgentRoom tool binding. Replaced at each turn start and
   * disposed at turn end, so a relayed call is dispatched only while the turn
   * that originated it is still the session's live turn.
   */
  toolBinding?: AgentToolBinding;
}
