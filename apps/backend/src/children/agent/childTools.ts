import type { ZodError } from "zod";
import { MAX_AGENT_TOOL_RESULT_CHARS, type AgentToolHandler, type AgentToolInvocationContext } from "../../agentTools/dispatch";
import { inputIssueText } from "../../agentTools/jsonSchema";
import type { AgentSessionService } from "../../agent/AgentSessionService";
import { AgentSessionError } from "../../agent/agentSessionTypes";
import type { AgentTurnTrigger } from "../../domain/backgroundWork";
import { CHILD_TOOL_IDS } from "../../domain/childThreads";
import type { AgentSession, ServiceConfig } from "../../domain/models";
import { runnerAdvertisedToolIds } from "../../runner/shared/agentToolSets";
import { redactSecrets } from "../../util/redactSecrets";
import { hasHiddenPathSegment } from "../../workspace/explorer/bounds";
import type { LocalWorkspaceRegistry } from "../../workspace/LocalWorkspaceRegistry";
import { ChildThreadError } from "../ChildThreadError";
import { readWorktreeChanges } from "../childThreadSummary";
import type { ChildThreadService } from "../ChildThreadService";
import { OFFER_MESSAGES, offerOutcome, offerSets, type ChildOfferAsk, type OfferDecision } from "./childOffers";
import {
  CHILD_TOOLS_INSTRUCTION,
  CHILD_TOOL_LIMITS,
  childToolFailure,
  childToolInputSchemas,
  childToolSuccess,
  type ChildChangedFiles,
  type ChildStartInput,
  type ChildStartTaskResult,
  type ChildToolErrorCode,
  type ChildToolId,
  type ChildTranscript
} from "./childToolContract";

type ChildToolService = Pick<ChildThreadService, "create" | "list" | "summarize" | "freeSlots" | "continuable">;
type ChildToolSessions = Pick<
  AgentSessionService,
  "getSession" | "listSessions" | "startTurn" | "cancelTurn" | "listSessionMessages" | "hasWaitingAgentTurn"
>;

/** An answer kept for replay: a start's non-created task answers, or a message's turn. */
type RememberedAnswer =
  | { kind: "start"; fingerprint: string; tasks: Map<number, ChildStartTaskResult> }
  | { kind: "message"; fingerprint: string; childSessionId: string; turnId: string };

/**
 * The parent agent's child tools. Every handler closes over the calling
 * session, and a target resolves only when its `parent.sessionId` is that
 * session (rule 10); any other id, a closed-and-deleted child included, is
 * `unknown_child`. Children bind none of these tools (rule 1), and no handler
 * reaches Land, Update or Close (rule 6).
 *
 * `agentroom_child_start` with `initiation: "offer"` asks the person first,
 * through the offer card in `childOffers.ts`, and creates a child only for a
 * task answered **New worktree thread**. `person_asked` skips the card, and
 * only a turn the person started may use it.
 *
 * Replay: a created child carries `<operationId>:<task index>` as its
 * `parent.operationId`, so a replayed start returns that child after a
 * restart too. Other answers (`do_here`, a timed-out card's `unanswered`,
 * refusals), and a message's turn id, are kept in memory, the newest 64 per
 * session, so a replay in this process asks nothing again.
 */
export class ChildTurnTools {
  private readonly answers = new Map<string, Map<string, RememberedAnswer>>();

  constructor(private readonly deps: {
    service: ChildToolService;
    sessions: ChildToolSessions;
    registry: Pick<LocalWorkspaceRegistry, "git" | "findByIdWithoutGitRefresh">;
  }) {}

  /** The child tool ids this session may bind: none for a child, or for a runner whose descriptor lacks `children`. */
  advertised(session: Pick<AgentSession, "runnerKind" | "parent">, config: ServiceConfig | undefined): string[] {
    return session.parent ? [] : runnerAdvertisedToolIds(session.runnerKind, CHILD_TOOL_IDS, config);
  }

  get instruction(): string {
    return CHILD_TOOLS_INSTRUCTION;
  }

  /**
   * One handler per child tool for one turn. `trigger` reads the calling
   * turn's origin when a call runs; `ask` reaches the person through the
   * session question channel, and without it an offer cannot be made.
   */
  handlers(caller: AgentSession, trigger: () => AgentTurnTrigger | undefined, ask?: ChildOfferAsk): Record<ChildToolId, AgentToolHandler> {
    return {
      "children.start": (input, call) => this.start(caller, trigger(), input, ask, call),
      "children.list": (input) => this.listChildren(caller, input),
      "children.read": (input) => this.read(caller, input),
      "children.message": (input) => this.message(caller, input),
      "children.stop": (input) => this.stop(caller, input)
    };
  }

  /** Forget a deleted session's remembered answers. */
  forgetSession(sessionId: string): void {
    this.answers.delete(sessionId);
  }

  private async start(
    caller: AgentSession,
    trigger: AgentTurnTrigger | undefined,
    input: unknown,
    ask: ChildOfferAsk | undefined,
    call: AgentToolInvocationContext
  ): Promise<string> {
    const parsed = childToolInputSchemas["children.start"].safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { tasks, operationId } = parsed.data;
    const fingerprint = JSON.stringify(tasks);
    const key = `start:${operationId}`;
    const remembered = this.answers.get(caller.id)?.get(key);
    if (remembered && (remembered.kind !== "start" || remembered.fingerprint !== fingerprint)) return operationConflict(operationId);

    // A created child is the durable half of a replay; it survives a restart.
    const created = new Map<number, AgentSession>();
    for (const session of this.deps.sessions.listSessions()) {
      const index = taskIndex(session, caller.id, operationId);
      if (index !== undefined) created.set(index, session);
    }
    // The session stores its title trimmed.
    if ([...created].some(([index, child]) => tasks[index]?.title.trim() !== child.title)) return operationConflict(operationId);
    const results: Array<ChildStartTaskResult | undefined> = await Promise.all(tasks.map(async (task, index) => {
      const child = created.get(index);
      if (child) return { title: task.title, outcome: "created" as const, child: await this.deps.service.summarize(child) };
      return remembered?.kind === "start" ? remembered.tasks.get(index) : undefined;
    }));
    const pending = tasks.flatMap((task, index) => (results[index] ? [] : [{ task, index }]));
    const replayed = created.size > 0 || remembered !== undefined;
    if (pending.length > 0) {
      const refusal = this.refuseStart(caller, trigger, parsed.data, pending.length);
      if (refusal) return refusal;
      let decisions: Map<number, OfferDecision> | undefined;
      if (parsed.data.initiation === "offer") {
        const offered = await this.offer(caller, pending, ask, call);
        if (typeof offered === "string") return offered;
        decisions = offered;
      }
      const answers = new Map<number, ChildStartTaskResult>();
      for (const { task, index } of pending) {
        const decision = decisions?.get(index) ?? "worktree";
        results[index] = decision === "worktree"
          ? await this.createOne(caller, operationId, index, task, parsed.data.initiation)
          : decision === "here"
            ? { title: task.title, outcome: "do_here" }
            : { title: task.title, outcome: "refused", code: "unanswered", message: OFFER_MESSAGES.unansweredTask };
        if (results[index]?.outcome !== "created") answers.set(index, results[index]!);
      }
      const kept = remembered?.kind === "start" ? remembered.tasks : [];
      this.remember(caller.id, key, { kind: "start", fingerprint, tasks: new Map([...kept, ...answers]) });
    }
    // Every task unanswered is a card that timed out, now or in the call this replays.
    if (results.every((result) => result?.outcome === "refused" && result.code === "unanswered")) {
      return childToolFailure("unanswered", OFFER_MESSAGES.unanswered);
    }
    return childToolSuccess({ tasks: results, operationId, ...(replayed ? { replayed: true } : {}) });
  }

  /**
   * Asks the person about each pending task (decision 5). Returns a decision
   * per task, or the call-level refusal that creates nothing. A timed-out
   * card is remembered, so a replay of this call does not ask again.
   */
  private async offer(
    caller: AgentSession,
    pending: Array<{ task: ChildStartInput["tasks"][number]; index: number }>,
    ask: ChildOfferAsk | undefined,
    call: AgentToolInvocationContext
  ): Promise<Map<number, OfferDecision> | string> {
    if (!ask) return childToolFailure("offer_unavailable", OFFER_MESSAGES.offer_unavailable);
    const base = await this.baseCommit(caller);
    if (typeof base !== "string") return childToolFailure(base.code, base.message);
    const outcome = offerOutcome(await ask(offerSets(pending, base), call.signal), pending.map(({ index }) => index));
    // An answer that lands as the turn ends creates nothing.
    if (outcome.kind === "answered" && !call.isLive()) return childToolFailure("unavailable", OFFER_MESSAGES.unavailable);
    if (outcome.kind === "answered") return outcome.decisions;
    // Remembered per task, so a replay answers `unanswered` without a second card.
    if (outcome.code === "unanswered") return new Map(pending.map(({ index }) => [index, "unanswered"]));
    return childToolFailure(outcome.code, OFFER_MESSAGES[outcome.code]);
  }

  /** The call-level refusal for a start that would create up to `count` children, if any; checked before any card. */
  private refuseStart(caller: AgentSession, trigger: AgentTurnTrigger | undefined, input: ChildStartInput, count: number): string | undefined {
    // Only a person's message can name a worktree; a backend-started turn has none.
    if (input.initiation === "person_asked" && trigger) {
      return childToolFailure("offer_required", "person_asked is accepted only in a turn the person started. Do the work here or ask the person.");
    }
    const free = this.deps.service.freeSlots(caller.id);
    if (count > free) {
      return childToolFailure("child_limit_reached",
        `Only ${free} more child threads can be open now. Start at most ${free}, or ask the person to close one.`, { freeSlots: free });
    }
    return undefined;
  }

  private async createOne(
    caller: AgentSession,
    operationId: string,
    index: number,
    task: ChildStartInput["tasks"][number],
    initiation: ChildStartInput["initiation"]
  ): Promise<ChildStartTaskResult> {
    try {
      const { session } = await this.deps.service.create(caller.id, {
        title: task.title,
        task: task.task,
        ...(task.runnerKind ? { runnerKind: task.runnerKind } : {}),
        initiation,
        operationId: `${operationId}:${index}`
      });
      return { title: task.title, outcome: "created", child: await this.deps.service.summarize(session) };
    } catch (error) {
      const code = (error instanceof ChildThreadError || error instanceof AgentSessionError ? error.code : undefined) ?? "start_failed";
      return { title: task.title, outcome: "refused", code, message: errorText(error) };
    }
  }

  /** The parent's current `HEAD`, which the card names, or the refusal that leaves nothing to offer. */
  private async baseCommit(caller: AgentSession): Promise<string | { code: ChildToolErrorCode; message: string }> {
    const workspace = await this.deps.registry.findByIdWithoutGitRefresh(caller.workspaceId);
    if (!workspace) return { code: "workspace_missing", message: "This thread's workspace is not registered, so no child can branch from it." };
    const { git } = this.deps.registry;
    if (!(await git.isRepository(workspace.path))) return { code: "not_a_repository", message: "This thread's workspace is not a Git repository, so no child can branch from it." };
    const commit = await git.headCommit(workspace.path).catch(() => undefined);
    return commit ?? { code: "unborn_head", message: "This checkout has no commit for a child to branch from, so nothing was offered. Do the work here." };
  }

  private async listChildren(caller: AgentSession, input: unknown): Promise<string> {
    const parsed = childToolInputSchemas["children.list"].safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { children, waitingReports } = await this.deps.service.list(caller.id);
    return childToolSuccess({ children, waitingReports });
  }

  private async read(caller: AgentSession, input: unknown): Promise<string> {
    const parsed = childToolInputSchemas["children.read"].safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const child = this.ownChild(caller, parsed.data.childSessionId);
    if (!child) return unknownChild(parsed.data.childSessionId);
    const include = new Set(parsed.data.include ?? []);
    const result: { child: unknown; transcript?: ChildTranscript; files?: ChildChangedFiles } = {
      child: await this.deps.service.summarize(child),
      ...(include.has("diff") ? { files: await this.changedFiles(child) } : {}),
      ...(include.has("transcript") ? { transcript: this.transcript(child.id) } : {})
    };
    let text = childToolSuccess(result);
    // Whatever the parts hold, the whole stays under the dispatch cap.
    if (text.length > MAX_AGENT_TOOL_RESULT_CHARS && result.files) text = childToolSuccess({ ...result, files: { files: [], hidden: result.files.hidden, truncated: true } });
    if (text.length > MAX_AGENT_TOOL_RESULT_CHARS) text = childToolSuccess({ child: result.child });
    return text;
  }

  private async message(caller: AgentSession, input: unknown): Promise<string> {
    const parsed = childToolInputSchemas["children.message"].safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const { childSessionId, message, operationId } = parsed.data;
    const child = this.ownChild(caller, childSessionId);
    if (!child) return unknownChild(childSessionId);
    const key = `message:${operationId}`;
    const fingerprint = JSON.stringify([childSessionId, message]);
    const remembered = this.answers.get(caller.id)?.get(key);
    if (remembered) {
      if (remembered.kind !== "message" || remembered.fingerprint !== fingerprint) return operationConflict(operationId);
      return childToolSuccess({ outcome: "started", turnId: remembered.turnId, operationId, replayed: true });
    }
    if (child.closedAt) return childToolFailure("child_closed", "This child thread is closed.");
    if (!this.deps.service.continuable(child)) {
      return childToolFailure("child_cannot_continue",
        "This child cannot take another turn because its runner lost the conversation. Tell the person; they can close it and start a new child.");
    }
    if (child.activeTurnId || this.deps.sessions.hasWaitingAgentTurn(child.id)) return childBusy();
    try {
      const turn = await this.deps.sessions.startTurn({
        sessionId: child.id,
        origin: {
          kind: "parent_message",
          trigger: { kind: "parent_task", parentSessionId: caller.id, tasks: [] },
          message: childFollowUpMessage(message)
        }
      });
      this.remember(caller.id, key, { kind: "message", fingerprint, childSessionId, turnId: turn.id });
      return childToolSuccess({ outcome: "started", turnId: turn.id, operationId });
    } catch (error) {
      // Closed, closing, or landing or updating.
      if (error instanceof AgentSessionError && error.code) return childToolFailure(error.code, error.message);
      // Another turn won the race for the child.
      if (error instanceof AgentSessionError && error.statusCode === 409 && this.deps.sessions.getSession(child.id)?.activeTurnId) return childBusy();
      return childToolFailure("start_failed", errorText(error));
    }
  }

  private async stop(caller: AgentSession, input: unknown): Promise<string> {
    const parsed = childToolInputSchemas["children.stop"].safeParse(input);
    if (!parsed.success) return invalidInput(parsed.error);
    const child = this.ownChild(caller, parsed.data.childSessionId);
    if (!child) return unknownChild(parsed.data.childSessionId);
    const turnId = child.activeTurnId;
    if (!turnId) return childToolFailure("not_running", "This child has no running turn.");
    try {
      await this.deps.sessions.cancelTurn(child.id);
    } catch (error) {
      return childToolFailure("stop_failed", errorText(error));
    }
    return childToolSuccess({ outcome: "stopped", turnId, continuable: this.deps.service.continuable(child) });
  }

  /** The caller's own child, or undefined (rule 10). */
  private ownChild(caller: AgentSession, childSessionId: string): AgentSession | undefined {
    const child = this.deps.sessions.getSession(childSessionId);
    return child?.parent?.sessionId === caller.id ? child : undefined;
  }

  /** The newest messages that fit the cap, oldest kept first, secret-redacted. */
  private transcript(childSessionId: string): ChildTranscript {
    const messages = this.deps.sessions.listSessionMessages(childSessionId) ?? [];
    const kept: ChildTranscript["messages"] = [];
    let used = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      const entry = { role: message.role, at: message.at, ...(message.turnId ? { turnId: message.turnId } : {}), content: redactSecrets(message.content) };
      const size = JSON.stringify(entry).length + 1;
      if (used + size <= CHILD_TOOL_LIMITS.transcriptChars) {
        kept.unshift(entry);
        used += size;
        continue;
      }
      // The newest message alone is too long: keep its end, where the outcome is.
      if (kept.length === 0) {
        const room = Math.max(0, CHILD_TOOL_LIMITS.transcriptChars - (size - JSON.stringify(entry.content).length) - 64);
        kept.unshift({ ...entry, content: tailWithin(entry.content, room), truncated: true });
      }
      break;
    }
    return { messages: kept, omittedMessages: messages.length - kept.length };
  }

  /**
   * Files the child changed since its base commit: tracked changes with their
   * line counts, then untracked files. `diffSinceCommit` returns raw paths, so
   * every one passes the explorer's hidden and secret name rule first.
   */
  private async changedFiles(child: AgentSession): Promise<ChildChangedFiles> {
    const worktree = (await this.deps.registry.findByIdWithoutGitRefresh(child.workspaceId))?.worktree;
    const changes = worktree ? await readWorktreeChanges(this.deps.registry.git, worktree.worktreePath, worktree.baseCommit) : undefined;
    if (!changes) return { files: [], hidden: 0, truncated: false };
    const { diff, entries } = changes;
    const candidates: ChildChangedFiles["files"] = [
      ...(diff?.files ?? []).map(({ path, additions, deletions }) => ({
        path, ...(additions === undefined ? {} : { insertions: additions }), ...(deletions === undefined ? {} : { deletions })
      })),
      ...entries.filter((entry) => entry.indexStatus === "?").map((entry) => ({ path: entry.path, untracked: true as const }))
    ];
    const visible = candidates.filter((file) => !hasHiddenPathSegment(file.path));
    const files: ChildChangedFiles["files"] = [];
    let used = 0;
    for (const file of visible) {
      const size = JSON.stringify(file).length + 1;
      if (files.length >= CHILD_TOOL_LIMITS.files || used + size > CHILD_TOOL_LIMITS.filesChars) break;
      files.push(file);
      used += size;
    }
    return { files, hidden: candidates.length - visible.length, truncated: files.length < visible.length || diff?.truncated === true };
  }

  private remember(sessionId: string, key: string, answer: RememberedAnswer): void {
    const answers = this.answers.get(sessionId) ?? new Map<string, RememberedAnswer>();
    answers.delete(key);
    answers.set(key, answer);
    while (answers.size > CHILD_TOOL_LIMITS.rememberedAnswers) answers.delete(answers.keys().next().value!);
    this.answers.set(sessionId, answers);
  }
}

/** The system message a follow-up turn opens with. */
export function childFollowUpMessage(message: string): string {
  return `Message from your parent thread:\n\n${message}`;
}

/** Which task of start `operationId` a child was created for, when the caller created it. */
function taskIndex(session: AgentSession, callerId: string, operationId: string): number | undefined {
  const stored = session.parent?.sessionId === callerId ? session.parent.operationId : undefined;
  if (!stored?.startsWith(`${operationId}:`)) return undefined;
  const index = Number(stored.slice(operationId.length + 1));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

function tailWithin(text: string, room: number): string {
  let tail = text.slice(-room);
  // JSON escaping can make the tail longer than its character count.
  while (tail.length > 0 && JSON.stringify(tail).length > room) tail = tail.slice(Math.ceil(tail.length / 8));
  return tail;
}

function invalidInput(error: ZodError): string {
  return childToolFailure("invalid_input", inputIssueText(error));
}

function unknownChild(childSessionId: string): string {
  return childToolFailure("unknown_child", `No child thread of this thread has the id ${childSessionId.slice(0, 200)}. Call agentroom_child_list.`);
}

function childBusy(): string {
  return childToolFailure("child_busy", "This child has a running turn. Wait for its report, or stop it first.");
}

function operationConflict(operationId: string): string {
  return childToolFailure("operation_conflict", `operationId ${operationId} was already used for a different call. Use a new operationId.`);
}

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 512);
}
