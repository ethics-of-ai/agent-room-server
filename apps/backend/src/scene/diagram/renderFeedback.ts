// Closes the agent's visual-feedback loop on its own spatial-diagram writes.
//
// An agent that writes an unknown role, a validation error, or an over-cap
// document never learns it — compose warnings surface only in the volume, and
// the human has to relay them by hand. This module supplies the return path: a
// bounded, per-session line in the *next* turn prompt naming what each
// `*.diagram.json` the agent wrote last turn actually rendered as.
//
// It is deliberately keyed on turn settlement, not on `workspace_file_written`.
// That event is the human-edit tracker's authorship discrimination — the
// bounded PUT publishes it and agent file edits never do — and this channel
// needs the opposite author. The agent-authorship signal that already exists is
// the settling turn's own diff summary (`coding_diff_updated`: the
// settle-time Git delta for Claude Code, Codex's own `turn/diff/updated`
// stream), so a diagram base path among its files triggers one bounded
// validation read per diagram at settlement — off the turn-start path — and the
// outcome waits in memory for the session's next turn. No fs-watcher, no new
// event type, no route, no scan of the workspace, and nothing persisted.
//
// Settlement work is serialized per session and prompt preparation awaits the
// session's in-flight chain: a session's turns are already sequential, so the
// chain costs nothing in the normal case, and it removes the two races a
// detached job would allow — a queued follow-up turn assembling its prompt
// before the previous turn's reads land, and an older settlement's outcome
// recording over a newer one's. Preparation never *starts* a read; it only
// waits for reads that settlement already started, so the turn-start path
// stays read-free.
//
// The diff attribution caveat is inherited knowingly: the Claude Code settle
// delta attributes any concurrent workspace change to the turn (the same caveat
// the bounded file write documents), so a human editing a diagram mid-turn can
// be validated here. The read reports what is actually on disk either way, and
// a human's 422-rejected edit never lands, so the deliberate "do not
// double-report what the client already surfaced" answer holds.

import type { EventBus } from "../../events/EventBus";
import { maxWriteBytes, type WorkspaceExplorer } from "../../workspace/WorkspaceExplorer";
import { composeDiagram } from "./compose";
import { diagramDocumentSchema, isDiagramBasePath } from "./schemas";

// Bounds. Every one degrades to "the agent is told less and the volume remains
// the source of truth", never to an unbounded read or prompt.
const maxTrackedTurns = 256;
const maxTrackedSessions = 512;
const maxTrackedPathsPerTurn = 16;
const maxReportedDiagrams = 4;
const maxPendingDiagramsPerSession = 8;
const maxReportedDetailsPerDiagram = 4;
const maxSummaryChars = 1200;
// Room the entry loop leaves for the two short tail lines (the pending-report
// and unchecked counts), so hitting the character cap can never silently drop
// the admission that something was left out.
const summaryTailReserveChars = 120;

interface TrackedTurn {
  sessionId: string;
  workspaceId: string;
  // Diagram base paths from the turn's latest diff summary. Replaced, not
  // unioned, on each diff event: Codex streams the whole turn diff
  // cumulatively, so the last event is the honest final file set, and Claude
  // Code publishes exactly one at settlement.
  paths: string[];
  // Diagram base paths the diff reports gone — deleted outright, or renamed
  // away (the file entry's `oldPath`). Nothing to validate, but a pending
  // report for one is stale and must not outlive the file.
  removedPaths: string[];
  omitted: number;
  // Set when the session is deleted while this turn's validation is in
  // flight, so a completing read cannot resurrect state for a dead session.
  cancelled: boolean;
}

interface PendingReport {
  revision: number;
  detail: string;
}

interface SessionFeedback {
  reports: Map<string, PendingReport>;
  // Diagram writes a turn's read cap left unvalidated — reported as a count so
  // a capped settlement never reads as "everything else was clean".
  unchecked: number;
  lastRevision: number;
}

type DiagramValidationOutcome =
  | { kind: "skipped" }
  | { kind: "clean" }
  | { kind: "report"; detail: string };

export interface PreparedDiagramRenderFeedback {
  summary?: string;
  acknowledge(): void;
}

export interface DiagramRenderFeedbackTrackerDeps {
  eventBus: Pick<EventBus, "subscribe">;
  explorer: Pick<WorkspaceExplorer, "filePreview">;
}

export class DiagramRenderFeedbackTracker {
  private readonly turns = new Map<string, TrackedTurn>();
  private readonly sessions = new Map<string, SessionFeedback>();
  // One settlement chain per session: each settling turn's validation runs
  // after the previous turn's finished, so outcomes always record in turn
  // order and prepareSummaryForTurn has exactly one promise to wait on.
  private readonly settlements = new Map<string, Promise<void>>();
  private readonly activeJobs = new Set<TrackedTurn>();
  private revision = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: DiagramRenderFeedbackTrackerDeps) {
    this.unsubscribe = deps.eventBus.subscribe((event) => {
      switch (event.type) {
        case "agent_turn_started":
          this.recordTurnStart(event.payload as { sessionId?: unknown; turnId?: unknown; workspaceId?: unknown });
          return;
        case "coding_diff_updated":
          this.recordTurnDiff(event.payload as { turnId?: unknown; files?: unknown });
          return;
        case "coding_turn_completed":
        case "coding_turn_failed":
        case "coding_turn_cancelled":
          this.settleTurn(event.payload as { turnId?: unknown });
          return;
        case "agent_session_deleted":
          this.releaseSession(event.payload as { sessionId?: unknown });
          return;
        default:
          return;
      }
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.turns.clear();
    this.sessions.clear();
    this.settlements.clear();
    for (const turn of this.activeJobs) turn.cancelled = true;
    this.activeJobs.clear();
  }

  // Test seam: drains every session's settlement chain.
  async settled(): Promise<void> {
    while (this.settlements.size > 0) {
      await Promise.all([...this.settlements.values()]);
    }
  }

  // Prepares the prompt fragment for a prospective turn, first waiting out the
  // session's in-flight settlement chain so a follow-up turn fired the instant
  // the previous one settled still carries that turn's feedback. Waiting never
  // starts a read. Acknowledgement is separate for the same reason as the
  // human-edit tracker's: a request can be rejected after prompt assembly, and
  // only an accepted turn may consume what it was shown — a retry must be told
  // again, and reports the character cap squeezed out are not consumed at all.
  async prepareSummaryForTurn(session: { id: string }): Promise<PreparedDiagramRenderFeedback | undefined> {
    for (
      let pending = this.settlements.get(session.id);
      pending !== undefined;
      pending = this.settlements.get(session.id)
    ) {
      await pending;
      if (this.settlements.get(session.id) === pending) break;
    }
    const state = this.sessions.get(session.id);
    if (!state) return undefined;
    const candidates = [...state.reports.entries()]
      .sort((left, right) => left[1].revision - right[1].revision)
      .slice(0, maxReportedDiagrams);
    const unchecked = state.unchecked;
    if (candidates.length === 0 && unchecked === 0) return undefined;

    // Build against the cap line by line: only entries whose lines actually
    // fit are delivered — and only delivered entries may be acknowledged. The
    // first entry is always delivered (truncated if it alone overflows) so an
    // oversized report cannot wedge the queue.
    const included: Array<[string, PendingReport]> = [];
    const lines: string[] = [];
    const budget = maxSummaryChars - summaryTailReserveChars;
    let length = feedbackHeader.length;
    for (const [path, report] of candidates) {
      const line = `- ${path} — ${report.detail}`;
      const lineBudget = budget - length - 1;
      if (line.length > lineBudget && included.length > 0) break;
      const bounded = line.length > lineBudget ? capText(line, Math.max(16, lineBudget)) : line;
      lines.push(bounded);
      length += 1 + bounded.length;
      included.push([path, report]);
    }
    const remaining = state.reports.size - included.length;
    if (remaining > 0) {
      lines.push(`- (+${remaining} more diagram${remaining === 1 ? "" : "s"} with pending feedback)`);
    }
    if (unchecked > 0) {
      lines.push(`- (+${unchecked} more diagram write${unchecked === 1 ? "" : "s"} not checked)`);
    }
    return {
      summary: capText([feedbackHeader, ...lines].join("\n"), maxSummaryChars),
      acknowledge: () => {
        const current = this.sessions.get(session.id);
        if (!current) return;
        for (const [path, report] of included) {
          // Guarded by revision so a settlement that re-reported the same path
          // between prepare and acknowledge is not consumed unseen.
          if (current.reports.get(path)?.revision === report.revision) {
            current.reports.delete(path);
          }
        }
        current.unchecked = Math.max(0, current.unchecked - unchecked);
        this.dropIfEmpty(session.id);
      }
    };
  }

  private recordTurnStart(payload: { sessionId?: unknown; turnId?: unknown; workspaceId?: unknown }): void {
    const { sessionId, turnId, workspaceId } = payload;
    if (typeof sessionId !== "string" || typeof turnId !== "string" || typeof workspaceId !== "string") return;
    // Terminal events are the normal release path; the cap is the backstop for
    // turns whose settlement this process never observed.
    if (!this.turns.has(turnId) && this.turns.size >= maxTrackedTurns) {
      const oldest = this.turns.keys().next();
      if (!oldest.done) this.turns.delete(oldest.value);
    }
    this.turns.set(turnId, {
      sessionId,
      workspaceId,
      paths: [],
      removedPaths: [],
      omitted: 0,
      cancelled: false
    });
  }

  private recordTurnDiff(payload: { turnId?: unknown; files?: unknown }): void {
    const { turnId, files } = payload;
    if (typeof turnId !== "string" || !Array.isArray(files)) return;
    const turn = this.turns.get(turnId);
    if (!turn) return;
    const paths: string[] = [];
    const removedPaths: string[] = [];
    let omitted = 0;
    const collect = (target: string[], path: string): void => {
      if (target.includes(path)) return;
      if (target.length >= maxTrackedPathsPerTurn) omitted += 1;
      else target.push(path);
    };
    for (const file of files as Array<{ path?: unknown; oldPath?: unknown; status?: unknown }>) {
      if (typeof file?.path === "string" && isDiagramBasePath(file.path)) {
        collect(file.status === "deleted" ? removedPaths : paths, file.path);
      }
      // A rename's source is gone from disk exactly like a deletion; the
      // destination (handled above, when it is itself a diagram) is what gets
      // validated.
      if (typeof file?.oldPath === "string" && isDiagramBasePath(file.oldPath)) {
        collect(removedPaths, file.oldPath);
      }
    }
    turn.paths = paths;
    turn.removedPaths = removedPaths;
    turn.omitted = omitted;
  }

  private settleTurn(payload: { turnId?: unknown }): void {
    const { turnId } = payload;
    if (typeof turnId !== "string") return;
    const turn = this.turns.get(turnId);
    this.turns.delete(turnId);
    if (!turn) return;
    if (turn.paths.length === 0 && turn.removedPaths.length === 0) return;
    // Chain onto the session's previous settlement so outcomes record in turn
    // order — removals included, so a stale report can never be cleared by a
    // newer turn and then re-recorded by an older one still in flight.
    this.activeJobs.add(turn);
    const previous = this.settlements.get(turn.sessionId) ?? Promise.resolve();
    const job: Promise<void> = previous
      .then(() => this.processTurn(turn))
      .catch(() => undefined)
      .finally(() => {
        this.activeJobs.delete(turn);
        if (this.settlements.get(turn.sessionId) === job) {
          this.settlements.delete(turn.sessionId);
        }
      });
    this.settlements.set(turn.sessionId, job);
  }

  private releaseSession(payload: { sessionId?: unknown }): void {
    if (typeof payload?.sessionId !== "string") return;
    this.sessions.delete(payload.sessionId);
    for (const [turnId, turn] of this.turns) {
      if (turn.sessionId === payload.sessionId) this.turns.delete(turnId);
    }
    // A validation already in flight must not recreate the state on
    // completion: mark it cancelled and let the chain drain inertly.
    for (const turn of this.activeJobs) {
      if (turn.sessionId === payload.sessionId) turn.cancelled = true;
    }
  }

  private async processTurn(turn: TrackedTurn): Promise<void> {
    if (turn.cancelled) return;
    for (const path of turn.removedPaths) {
      this.sessions.get(turn.sessionId)?.reports.delete(path);
      this.dropIfEmpty(turn.sessionId);
    }
    const toValidate = turn.paths.slice(0, maxReportedDiagrams);
    for (const path of toValidate) {
      if (turn.cancelled) return;
      const outcome = await this.validateDiagram(turn.workspaceId, path);
      if (turn.cancelled) return;
      this.recordOutcome(turn.sessionId, path, outcome);
    }
    const unchecked = turn.paths.length - toValidate.length + turn.omitted;
    if (unchecked > 0 && !turn.cancelled) {
      this.sessionState(turn.sessionId).unchecked += unchecked;
    }
  }

  // One bounded read per diagram, through the explorer's preview path like
  // every other workspace read this surface makes. The outcome mirrors what the
  // compose route serves the volume: an over-cap file is a 413 there, invalid
  // JSON/schema is the bounded error document, and unknown vocabulary is the
  // composed `warnings` list.
  private async validateDiagram(workspaceId: string, path: string): Promise<DiagramValidationOutcome> {
    let content: string;
    try {
      const preview = await this.deps.explorer.filePreview(workspaceId, { path, maxBytes: maxWriteBytes });
      if (preview.truncated) {
        return { kind: "report", detail: "exceeds the 256 KB cap and cannot render" };
      }
      content = preview.content;
    } catch {
      // Absent, refused, or unregistered: skipped silently by design — the
      // turn owes the runner nothing and the pending state is left as it was.
      return { kind: "skipped" };
    }
    let json: unknown;
    try {
      json = JSON.parse(content) as unknown;
    } catch {
      return { kind: "report", detail: "does not render: file is not valid JSON" };
    }
    const parsed = diagramDocumentSchema.safeParse(json);
    if (!parsed.success) {
      const details = parsed.error.issues.map((issue) => {
        const issuePath = ["base", ...issue.path].join(".");
        return `${issuePath}: ${issue.message}`;
      });
      return {
        kind: "report",
        detail: `does not render; validation errors: ${formatDetails(details)}`
      };
    }
    try {
      // Composed without the human layer: vocabulary warnings come from the
      // base document alone, and the human's own layer is not this channel's
      // author (see the module comment's double-reporting decision).
      const composed = composeDiagram(parsed.data, undefined);
      if (composed.warnings.length === 0) return { kind: "clean" };
      const count = composed.warnings.length;
      return {
        kind: "report",
        detail: `rendered with ${count} warning${count === 1 ? "" : "s"}: ${formatDetails(composed.warnings)}`
      };
    } catch {
      return { kind: "skipped" };
    }
  }

  private recordOutcome(sessionId: string, path: string, outcome: DiagramValidationOutcome): void {
    if (outcome.kind === "skipped") return;
    if (outcome.kind === "clean") {
      // A clean render supersedes an earlier report for the same diagram, so a
      // fix landed before the report was ever delivered is never relayed stale.
      this.sessions.get(sessionId)?.reports.delete(path);
      this.dropIfEmpty(sessionId);
      return;
    }
    const state = this.sessionState(sessionId);
    this.revision += 1;
    if (!state.reports.has(path) && state.reports.size >= maxPendingDiagramsPerSession) {
      evictLowestRevision(state.reports);
    }
    state.reports.set(path, { revision: this.revision, detail: outcome.detail });
    state.lastRevision = this.revision;
  }

  private sessionState(sessionId: string): SessionFeedback {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    // `agent_session_deleted` is the normal release path; this cap is the
    // backstop for a process that outlives a great many sessions.
    if (this.sessions.size >= maxTrackedSessions) {
      let oldestId: string | undefined;
      let oldestRevision = Number.POSITIVE_INFINITY;
      for (const [id, state] of this.sessions) {
        if (state.lastRevision < oldestRevision) {
          oldestRevision = state.lastRevision;
          oldestId = id;
        }
      }
      if (oldestId !== undefined) this.sessions.delete(oldestId);
    }
    const created: SessionFeedback = { reports: new Map(), unchecked: 0, lastRevision: 0 };
    this.sessions.set(sessionId, created);
    return created;
  }

  private dropIfEmpty(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state && state.reports.size === 0 && state.unchecked === 0) {
      this.sessions.delete(sessionId);
    }
  }
}

const feedbackHeader =
  "Diagram render feedback — what the `*.diagram.json` document(s) your last turn wrote actually rendered as in the volume (fix by editing the base document; the standing contract lists the supported roles and kinds):";

function formatDetails(details: string[]): string {
  const shown = details.slice(0, maxReportedDetailsPerDiagram);
  const remaining = details.length - shown.length;
  return `${shown.join("; ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`;
}

function capText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function evictLowestRevision(reports: Map<string, PendingReport>): void {
  let lowestPath: string | undefined;
  let lowestRevision = Number.POSITIVE_INFINITY;
  for (const [path, report] of reports) {
    if (report.revision < lowestRevision) {
      lowestRevision = report.revision;
      lowestPath = path;
    }
  }
  if (lowestPath !== undefined) reports.delete(lowestPath);
}
