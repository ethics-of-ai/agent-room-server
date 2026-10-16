import type { JsonRpcNotification } from "../shared/JsonRpcLineClient";
import { runnerMetadataFromNotification } from "./notificationMapper";
import type { CodexActiveTurn, CodexRunnerSession } from "./types";

// Native turn ids a session has finished, newest last. A trailing event of
// one of them must not land in the next turn while that turn's own id is
// still unknown.
const ENDED_TURN_LIMIT = 16;

/** The native ids of the turns one session finished, newest last, bounded. */
export class EndedTurns {
  private readonly ids: string[] = [];

  remember(turnId: string | undefined): void {
    if (!turnId || this.ids.includes(turnId)) return;
    this.ids.push(turnId);
    if (this.ids.length > ENDED_TURN_LIMIT) this.ids.shift();
  }

  includes(turnId: string): boolean {
    return this.ids.includes(turnId);
  }
}

/**
 * Whether a notification may come from `threadId`. One that names no thread
 * may, and so does any notification while `threadId` is still empty.
 */
export function fromThread(threadId: string, notification: JsonRpcNotification): boolean {
  const notificationThreadId = runnerMetadataFromNotification(notification).nativeSessionId;
  return !threadId || !notificationThreadId || notificationThreadId === threadId;
}

/**
 * Whether a notification comes from the session's own thread. The
 * app-server attaches every thread it spawns to every connection, so a
 * subagent's `turn/*` and `item/*` notifications arrive here under the
 * child's thread id. Before `thread/start` answers, no child can exist yet.
 * Background work reads a subagent's thread first, so this runs after it.
 */
export function isSessionThread(session: CodexRunnerSession, notification: JsonRpcNotification): boolean {
  return fromThread(session.threadId, notification);
}

/**
 * Whether a notification from the session's thread belongs to the running
 * turn. One that names another native turn does not: the turn's own id once
 * known, or a turn the session already finished.
 */
export function belongsToTurn(session: CodexRunnerSession, active: CodexActiveTurn, notification: JsonRpcNotification): boolean {
  const turnId = runnerMetadataFromNotification(notification).nativeTurnId;
  if (!turnId) return true;
  if (active.turnId) return turnId === active.turnId;
  return !session.endedTurns.includes(turnId);
}
