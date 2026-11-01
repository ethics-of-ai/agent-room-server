import type { AgentSessionService } from "../agent/AgentSessionService";
import { CHILD_THREAD_LIMITS, type ChildThreadSummary } from "../domain/childThreads";
import type { AgentSession, AgentSessionTurn } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type { AgentRoomEvent } from "../events/eventTypes";
import { logger } from "../logging/logger";
import { boundedMessage } from "./childThreadSummary";

/** `child_report` turns that may run in a row before reports wait for a person (decision 7). */
export const CHILD_REPORT_WAKE_BUDGET = 3;

/** One child's settled turn, waiting for its parent to hear about it. */
interface ChildReport {
  childSessionId: string;
  turnId: string;
  status: "succeeded" | "failed" | "cancelled";
  /** The turn's last message or error, taken when it settled, redacted and capped. */
  lastMessage?: string;
}

interface ReportEntry {
  report: ChildReport;
  summary: ChildThreadSummary;
}

/**
 * Report-back wakes. When a child's turn settles, its parent hears about it in
 * a turn the backend opens: a `child_report` turn whose system message holds
 * one block per child. It follows `AgentBackgroundWork`: a runner's own
 * waiting turn always goes first, and a report that cannot open a turn yet
 * waits. Every report waiting when the parent next frees goes into one wake.
 *
 * A wake opens only on a parent that is idle, continuable and not closed, with
 * no runner turn waiting on it, and with fewer than three `child_report`
 * turns in a row. A person's turn on the parent resets that count. Turns a
 * runner starts itself neither count nor reset it, because AgentRoom cannot
 * hold them back. Reports the budget or a parent that cannot continue holds
 * back ride the person's next turn on the parent as volatile prompt context,
 * through the turn context assembler, and are dropped once that turn is
 * accepted. The children list shows how many wait.
 *
 * Everything here is in memory. A restart loses waiting reports and the count;
 * the parent can still read every child through the children list.
 */
export class ChildReports {
  /** Reports waiting by parent session id, at most one per child, oldest first. */
  private readonly waiting = new Map<string, ChildReport[]>();
  /** `child_report` turns started in a row, by parent session id. */
  private readonly streak = new Map<string, number>();
  /** The last turn each child reported, so a turn's later events report nothing more. */
  private readonly reported = new Map<string, string>();
  /**
   * The last turn of each child that reached its parent, in a wake or a
   * person's turn. A wake that loses the parent to a person's turn puts its
   * reports back, and that turn may already have carried one of them.
   */
  private readonly delivered = new Map<string, string>();
  /** Parents whose wake is being assembled and started. */
  private readonly opening = new Set<string>();
  private unsubscribe?: () => void;

  constructor(
    private readonly deps: {
      sessions: Pick<AgentSessionService, "getSession" | "startTurn" | "latestTurn" | "hasWaitingAgentTurn">;
      /** Whether the session can take another turn, a live stop included (`ChildThreadService.continuable`). */
      continuable(session: AgentSession): boolean;
      eventBus: Pick<EventBus, "subscribe">;
      /** The child as its parent sees it, with fresh Git counts. */
      summary(child: AgentSession): Promise<ChildThreadSummary>;
    }
  ) {}

  start(): void {
    this.unsubscribe ??= this.deps.eventBus.subscribe((event) => this.observe(event));
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Reports waiting for this parent, for the children card. */
  waitingCount(parentSessionId: string): number {
    return this.waiting.get(parentSessionId)?.length ?? 0;
  }

  /**
   * Called after each runner event of any turn. A child's settled turn becomes
   * a report for its parent; any other session may be a parent that just
   * freed, so its waiting reports get their chance.
   */
  turnEvent(session: AgentSession, turn: AgentSessionTurn): void {
    const parentId = session.parent?.sessionId;
    if (!parentId) {
      this.open(session.id);
      return;
    }
    if (turn.status === "running" || this.reported.get(session.id) === turn.id) return;
    // A stopped turn's stream can end after the child's next turn has opened.
    if (this.deps.sessions.latestTurn(session.id)?.id !== turn.id) return;
    this.reported.set(session.id, turn.id);
    const lastMessage = boundedMessage(turn.lastMessage ?? turn.error);
    this.enqueue(parentId, [{ childSessionId: session.id, turnId: turn.id, status: turn.status, ...(lastMessage ? { lastMessage } : {}) }]);
    this.open(parentId);
  }

  /**
   * The waiting reports as volatile context for a person's turn on the
   * parent. A wake being opened takes its reports out first, so its own turn
   * gets none here. `acknowledge` runs only once the turn is accepted, and
   * keeps a newer report that arrived in between.
   */
  async prepareSummaryForTurn(session: AgentSession): Promise<{ summary?: string; acknowledge(): void } | undefined> {
    const reports = this.waiting.get(session.id);
    if (!reports?.length || this.opening.has(session.id)) return undefined;
    const taken = [...reports];
    const entries = await this.entries(taken);
    return {
      ...(entries.length > 0 ? { summary: childReportContext(entries) } : {}),
      acknowledge: () => this.drop(session.id, taken)
    };
  }

  private open(parentId: string): void {
    const reports = this.waiting.get(parentId);
    if (!reports?.length || this.opening.has(parentId) || !this.canWake(parentId)) return;
    const taken = reports.slice(0, CHILD_THREAD_LIMITS.reportsPerWake);
    const rest = reports.slice(taken.length);
    if (rest.length > 0) this.waiting.set(parentId, rest);
    else this.waiting.delete(parentId);
    this.opening.add(parentId);
    void this.wake(parentId, taken).then((opened) => {
      this.opening.delete(parentId);
      // A report that arrived while this wake opened, or a wake that settled
      // before this ran, would otherwise wait for an event that never comes.
      // A wake that did not open waits for the parent's next event instead,
      // so a refusal that repeats cannot spin.
      if (opened) this.open(parentId);
    });
  }

  private canWake(parentId: string): boolean {
    const parent = this.deps.sessions.getSession(parentId);
    if (!parent || parent.parent || parent.activeTurnId) return false;
    if (!this.deps.continuable(parent) || this.deps.sessions.hasWaitingAgentTurn(parentId)) return false;
    return (this.streak.get(parentId) ?? 0) < CHILD_REPORT_WAKE_BUDGET;
  }

  /** True when the wake's turn opened, or nothing was left to report. */
  private async wake(parentId: string, reports: ChildReport[]): Promise<boolean> {
    try {
      const entries = await this.entries(reports);
      if (entries.length === 0) return true;
      await this.deps.sessions.startTurn({
        sessionId: parentId,
        origin: {
          kind: "child_report",
          trigger: {
            kind: "child_report",
            reports: entries.map(({ report }) => ({ childSessionId: report.childSessionId, turnId: report.turnId, status: report.status })),
            tasks: []
          },
          message: childReportWakeMessage(entries)
        }
      });
      this.markDelivered(reports);
      return true;
    } catch (error) {
      // Usually a person's turn or a runner's own turn took the parent first.
      // Its settle frees the parent again, and these reports go then.
      this.enqueue(parentId, reports, { older: true });
      logger.debug({ err: error, sessionId: parentId }, "Child report wake did not open; its reports wait");
      return false;
    }
  }

  /** Children still known, each with its fresh summary. A deleted child's report is dropped. */
  private async entries(reports: ChildReport[]): Promise<ReportEntry[]> {
    const entries = await Promise.all(reports.map(async (report) => {
      const child = this.deps.sessions.getSession(report.childSessionId);
      return child ? { report, summary: await this.deps.summary(child) } : undefined;
    }));
    return entries.filter((entry): entry is ReportEntry => entry !== undefined);
  }

  /** One report per child: a newer report replaces an older one, and an older one never replaces a newer. A delivered report never returns. */
  private enqueue(parentId: string, reports: ChildReport[], options: { older?: boolean } = {}): void {
    const current = this.waiting.get(parentId) ?? [];
    const undelivered = reports.filter((report) => this.delivered.get(report.childSessionId) !== report.turnId);
    const kept = options.older
      ? undelivered.filter((report) => !current.some((entry) => entry.childSessionId === report.childSessionId))
      : undelivered;
    const others = current.filter((entry) => !kept.some((report) => report.childSessionId === entry.childSessionId));
    const next = options.older ? [...kept, ...others] : [...others, ...kept];
    if (next.length > 0) this.waiting.set(parentId, next);
  }

  private markDelivered(reports: ChildReport[]): void {
    for (const report of reports) this.delivered.set(report.childSessionId, report.turnId);
  }

  private drop(parentId: string, delivered: ChildReport[]): void {
    this.markDelivered(delivered);
    const left = (this.waiting.get(parentId) ?? []).filter((entry) =>
      !delivered.some((report) => report.childSessionId === entry.childSessionId && report.turnId === entry.turnId));
    if (left.length > 0) this.waiting.set(parentId, left);
    else this.waiting.delete(parentId);
  }

  private observe(event: AgentRoomEvent): void {
    const payload = event.payload as { sessionId?: unknown; trigger?: { kind?: unknown } } | undefined;
    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
    if (!sessionId) return;
    if (event.type === "agent_turn_started") {
      // Counted when the turn opens, so a wake that settles at once is already counted.
      const kind = payload?.trigger?.kind;
      if (kind === undefined) this.streak.delete(sessionId);
      else if (kind === "child_report") this.streak.set(sessionId, (this.streak.get(sessionId) ?? 0) + 1);
    } else if (event.type === "agent_session_deleted") {
      this.waiting.delete(sessionId);
      this.streak.delete(sessionId);
      this.reported.delete(sessionId);
      this.delivered.delete(sessionId);
      for (const [parentId, reports] of this.waiting) {
        const left = reports.filter((report) => report.childSessionId !== sessionId);
        if (left.length > 0) this.waiting.set(parentId, left);
        else this.waiting.delete(parentId);
      }
    }
  }
}

/** The system message a wake opens with, which is also the runner's input. */
export function childReportWakeMessage(entries: ReportEntry[]): string {
  const count = entries.length === 1 ? "A child thread" : `${entries.length} child threads`;
  return [
    `${count} finished a turn. Landing, updating and closing children are the person's actions.`,
    ...entries.map(childReportBlock)
  ].join("\n\n");
}

/** Reports that waited, as context ahead of a person's message on the parent. */
export function childReportContext(entries: ReportEntry[]): string {
  return [
    "Child thread reports that arrived while AgentRoom held back report turns. They are context for the person's message below.",
    ...entries.map(childReportBlock)
  ].join("\n\n");
}

function childReportBlock({ report, summary }: ReportEntry): string {
  const commits = `${summary.commitsAhead} ${summary.commitsAhead === 1 ? "commit" : "commits"}`;
  const files = `${summary.diff.files} ${summary.diff.files === 1 ? "file" : "files"}`;
  const lines = [
    `Child "${summary.title}" (${summary.sessionId}): ${report.status}`,
    `Branch: ${summary.branch || "unknown"}, ${commits} the parent checkout does not have`,
    summary.missing
      ? "Worktree: missing"
      : `Changes from the base: ${files}, +${summary.diff.insertions} -${summary.diff.deletions}; ` +
        (summary.uncommitted ? "uncommitted changes in the worktree" : "nothing uncommitted")
  ];
  if (report.lastMessage) lines.push(`Last message:\n${report.lastMessage}`);
  return lines.join("\n");
}
