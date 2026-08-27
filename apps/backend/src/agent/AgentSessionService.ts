import { randomUUID } from "node:crypto";
import {
  AgentTurnContextAssemblyError,
  type AgentTurnContextAssembler,
  type AssembledAgentTurnInput
} from "./AgentTurnContextAssembler";
import type {
  AgentBridgeMetrics,
  AgentSession,
  AgentSessionMessage,
  AgentSessionTurn,
  AgentTurnContext,
  AgentRunnerKind,
  CodingAgentTurnSettings,
  DurableAgentSessionDocument,
  StatusSnapshot
} from "../domain/models";
import { DURABLE_AGENT_SESSION_SCHEMA_VERSION } from "../domain/schemas";
import type { ArtifactSnapshot, ArtifactStore } from "../artifact/ArtifactStore";
import type { EventBus } from "../events/EventBus";
import { logger } from "../logging/logger";
import {
  AgentRunnerInputError,
  type AgentRunner,
  type AgentRunnerInputPart,
  type CanonicalQuestionAnswer
} from "../runner/AgentRunner";
import type { QuestionAnswerResult } from "../runner/shared/PendingQuestionRequests";
import { isRegisteredRunnerKind, runnerDescriptor } from "../runner/registry";
import type { DurableAgentSessionStore } from "../state/DurableAgentSessionStore";
import {
  codingDiffUpdatedEvent,
  codingTurnCancelledEvent,
  codingTurnCompletedEvent,
  codingTurnFailedEvent,
  type CodingAgentEventCandidate
} from "../protocol/coding/events";
import {
  LocalWorkspaceRegistryError,
  type CheckoutLocalWorkspaceBranchResult,
  type LocalWorkspaceRegistry
} from "../workspace/LocalWorkspaceRegistry";
import { AgentSessionMessageStore } from "./AgentSessionMessageStore";
import { AgentTurnEventApplier, type OutstandingQuestionRequest } from "./AgentTurnEventApplier";
import { AgentTurnGitDiffTracker } from "./AgentTurnGitDiffTracker";
import { AgentTurnTelemetryStore } from "./AgentTurnTelemetryStore";

export class AgentSessionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

// The one message per way a batch answer can be refused. The agent decides
// what it is willing to be told — a set or option it did not offer, a second
// choice on a single-select set, free text where none was invited — and each
// refusal names the rule rather than forwarding the answer.
const questionAnswerRefusal: Record<Exclude<QuestionAnswerResult, "answered" | "unknown_request">, string> = {
  empty_batch: "Question answer needs at least one answered set",
  unknown_set: "Question set was not offered for this request",
  duplicate_set: "Question set was answered more than once",
  unknown_option: "Question option was not offered for this set",
  duplicate_option: "Question option was selected more than once",
  selection_limit: "Question set accepts a single selection",
  discussion_not_offered: "Question set does not accept free text",
  discussion_required: "Question set requires free text",
  empty_answer: "Question set answer needs a selection or free text"
};

export interface CreateAgentSessionInput {
  workspaceId: string;
  runnerKind?: AgentRunnerKind;
  gitBranch?: string;
  settings?: CodingAgentTurnSettings;
  title?: string;
}

export interface StartAgentTurnInput {
  sessionId: string;
  message: string;
  context?: AgentTurnContext;
  settings?: CodingAgentTurnSettings;
}

/**
 * The fixed reason a turn that was running when the backend ended settles
 * with. A restart is an interruption, not a decision: nobody chose, so the
 * turn fails rather than being reported as cancelled or completed.
 */
export const BACKEND_RESTARTED_TURN_ERROR = "Backend restarted during this turn";

export class AgentSessionService {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly turns = new Map<string, AgentSessionTurn>();
  private readonly messages = new AgentSessionMessageStore({
    onChange: (sessionId) => this.persist(sessionId)
  });
  private readonly telemetry = new AgentTurnTelemetryStore();
  private readonly runnerEvents: AgentTurnEventApplier;
  private readonly turnGitDiffs: AgentTurnGitDiffTracker;
  private readonly cancelledTurnIds = new Set<string>();
  private readonly countedCancelledTurnIds = new Set<string>();
  /**
   * Hydrated sessions whose runner declares no restore path but which had a
   * native conversation. Their next turn is refused rather than started as a
   * fresh conversation under the old thread's id. Derived from the document
   * and the descriptor at every hydration, never persisted.
   */
  private readonly uncontinuableSessionIds = new Set<string>();
  /**
   * The native id each hydrated session was seeded with, held until its
   * runner reports a session start. A reported id that differs means the
   * resume did not take and the agent is in a fresh conversation, which the
   * person is told rather than left to discover. Consumed on first report,
   * so the comparison runs once per hydrated session.
   */
  private readonly hydratedSeeds = new Map<string, string>();
  private completedTurns = 0;
  private failedTurns = 0;
  private cancelledTurns = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private totalTokens = 0;

  constructor(
    private readonly deps: {
      registry: LocalWorkspaceRegistry;
      runners: Partial<Record<AgentRunnerKind, AgentRunner>>;
      defaultRunnerKind?: AgentRunnerKind;
      eventBus: EventBus;
      contextAssembler: AgentTurnContextAssembler;
      artifacts?: ArtifactStore;
      attachments?: {
        deleteSessionAttachments(session: Pick<AgentSession, "workspaceId" | "id">): Promise<void>;
      };
      /**
       * Where session records outlive this process. Absent, the list is
       * process-scoped exactly as it was before the store existed.
       */
      durableSessions?: Pick<DurableAgentSessionStore, "initialize" | "schedule" | "remove">;
    }
  ) {
    this.runnerEvents = new AgentTurnEventApplier({
      eventBus: deps.eventBus,
      messages: this.messages,
      telemetry: this.telemetry,
      ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
      isSessionLive: (sessionId) => this.sessions.has(sessionId),
      isTurnCancelled: (turnId) => this.cancelledTurnIds.has(turnId),
      completeCancelledTurn: (session, turn) => this.completeCancelledTurn(session, turn),
      recordTokenUsage: (session, turn, event) => this.recordTokenUsage(session, turn, event),
      succeedTurn: (session, turn, event) => this.succeedTurn(session, turn, event),
      failTurn: (session, turn, error) => this.failTurn(session, turn, error),
      sessionChanged: (sessionId) => this.persist(sessionId),
      takeHydratedSeed: (sessionId) => {
        const seed = this.hydratedSeeds.get(sessionId);
        this.hydratedSeeds.delete(sessionId);
        return seed;
      }
    });
    this.turnGitDiffs = new AgentTurnGitDiffTracker({
      gitStatus: (workspaceId) => deps.registry.gitStatus(workspaceId)
    });
  }

  /**
   * Read every session record the durable store holds and restore it as if
   * its mutations had happened in this process. Awaited before any route
   * registers, so the first request sees the restored list.
   *
   * Three things happen per record beyond populating the maps. A turn that was
   * running when the previous process ended settles through the ordinary
   * failure path with a fixed reason, publishing at boot on purpose: the audit
   * store is attached before this service is built, so the interruption reaches
   * durable audit. A session with a native conversation id is seeded into its
   * runner through the optional `rememberResumableId` hook, so the next turn
   * resumes that conversation; a runner without the hook is left alone. And a
   * session whose runner declares no restore path is marked uncontinuable, so
   * a restart never begins a fresh conversation under an existing thread's id.
   * None of it reads which runner a session belongs to — only the descriptor
   * field and the hook's presence.
   */
  async initialize(): Promise<void> {
    const store = this.deps.durableSessions;
    if (!store) return;
    const inventory = await store.initialize();
    for (const document of inventory.documents) {
      this.hydrate(document);
    }
    logger.info({ sessions: inventory.documents.length }, "Agent sessions restored from the durable store");
  }

  private hydrate(document: DurableAgentSessionDocument): void {
    // The document validated `runnerKind` as a string so a thread from a
    // runner this process does not register stays readable; the record type
    // narrows it, and `requireRunner` is what refuses a turn on it.
    const session = document.session as AgentSession;
    if (this.sessions.has(session.id)) return;
    this.sessions.set(session.id, session);
    for (const turn of document.turns) {
      this.turns.set(turn.id, turn);
    }
    this.messages.restore(session.id, document.messages);

    const interruptedTurns = document.turns.filter((turn) => turn.status === "running");
    for (const turn of interruptedTurns) {
      this.failTurn(session, turn, BACKEND_RESTARTED_TURN_ERROR, { countMetric: false });
    }
    if (session.activeTurnId && !this.turns.has(session.activeTurnId)) {
      // A record can only name a turn it also holds, so this is defensive:
      // without clearing it the session would refuse every turn as busy.
      session.activeTurnId = undefined;
      session.status = "failed";
      session.error = BACKEND_RESTARTED_TURN_ERROR;
      session.updatedAt = new Date().toISOString();
      this.persist(session.id);
    }
    const interrupted = interruptedTurns.length > 0;

    const nativeSessionId = session.runner?.nativeSessionId;
    if (!nativeSessionId) return;
    if (isRegisteredRunnerKind(session.runnerKind) && runnerDescriptor(session.runnerKind).restoreStrategy === "unsupported") {
      this.uncontinuableSessionIds.add(session.id);
      return;
    }
    this.hydratedSeeds.set(session.id, nativeSessionId);
    this.deps.runners[session.runnerKind]?.rememberResumableId?.({
      sessionId: session.id,
      nativeSessionId,
      interrupted
    });
  }

  /** Mark a session's durable record dirty. Cheap: one map write per call. */
  private persist(sessionId: string): void {
    const store = this.deps.durableSessions;
    if (!store || !this.sessions.has(sessionId)) return;
    void store.schedule(sessionId, () => this.snapshot(sessionId));
  }

  /**
   * Taken at write time, not at mark time, so the file always reflects the
   * newest state however many marks coalesced into the write.
   */
  private snapshot(sessionId: string): DurableAgentSessionDocument {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Agent session is no longer in memory");
    }
    return {
      schemaVersion: DURABLE_AGENT_SESSION_SCHEMA_VERSION,
      session: { ...session },
      turns: [...this.turns.values()].filter((turn) => turn.sessionId === sessionId).map((turn) => ({ ...turn })),
      messages: this.messages.list(sessionId)
    };
  }

  listSessions(): AgentSession[] {
    return [...this.sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessionMessages(sessionId: string): AgentSessionMessage[] | undefined {
    if (!this.sessions.has(sessionId)) return undefined;
    return this.messages.list(sessionId);
  }

  // Accumulated artifact snapshots for reconnect/late-join: the WS stream only
  // carries deltas and its bounded recent-event replay drops early ones on long
  // sketches, so clients seed from this on session open.
  listSessionArtifacts(sessionId: string): ArtifactSnapshot[] | undefined {
    if (!this.sessions.has(sessionId)) return undefined;
    return this.deps.artifacts?.snapshot(sessionId) ?? [];
  }

  getStatusSnapshot(recentEvents: unknown[]): StatusSnapshot {
    const sessions = this.listSessions();
    return {
      runnerKind: this.defaultRunnerKind(),
      uptimeSeconds: Math.floor(process.uptime()),
      sessions,
      activeSessionIds: sessions.filter((session) => session.status === "running").map((session) => session.id),
      recentEvents,
      metrics: this.metrics()
    };
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const runnerKind = input.runnerKind ?? this.defaultRunnerKind();
    this.requireRunner(runnerKind);
    let workspace = await this.deps.registry.findById(input.workspaceId);
    if (!workspace) {
      throw new AgentSessionError("Workspace is not registered", 404);
    }
    if (input.gitBranch?.trim()) {
      const result = await this.checkoutSessionBranch(workspace.id, input.gitBranch.trim());
      workspace = result.workspace;
    }

    const now = new Date().toISOString();
    const session: AgentSession = {
      id: agentSessionId(),
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      ...(workspace.git.branch ? { gitBranch: workspace.git.branch } : {}),
      runnerKind,
      ...(hasSettings(input.settings) ? { settings: input.settings } : {}),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      status: "idle",
      turnCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    this.messages.initializeSession(session.id);
    this.persist(session.id);
    this.deps.eventBus.publish("agent_session_created", { session });
    return session;
  }

  async startTurn(input: StartAgentTurnInput): Promise<AgentSessionTurn> {
    const requestStartedAtMs = Date.now();
    const session = this.requireSession(input.sessionId);
    if (session.activeTurnId) {
      throw new AgentSessionError("Agent session already has a running turn", 409);
    }
    if (this.uncontinuableSessionIds.has(session.id)) {
      // The same refusal the adapter gives after cancellation or child loss.
      // It has to live here as well because the adapter's own mark is
      // in-memory and a restart empties it; without this the next turn would
      // spawn a fresh runtime and begin a new conversation under this thread.
      throw new AgentSessionError(
        `${runnerDescriptor(session.runnerKind).displayName} cannot continue this session because its runtime stopped and no restore path is verified; create a new AgentRoom session`,
        409
      );
    }
    // Turn start only needs the workspace to still be registered; the branch
    // restore below probes git itself, so skip the full snapshot refresh here.
    const workspace = await this.deps.registry.findByIdWithoutGitRefresh(session.workspaceId);
    if (!workspace) {
      throw new AgentSessionError("Workspace is not registered", 404);
    }
    if (session.gitBranch) {
      await this.checkoutSessionBranch(session.workspaceId, session.gitBranch);
    }

    const runner = this.requireRunner(session.runnerKind);
    const runnerInput = await this.assembleRunnerInput(session, input.message, input.context);
    this.validateRunnerInputParts(runner, runnerInput.inputParts);
    // A volatile prompt addition (currently human diagram edits) may only mark
    // itself delivered after all request validation has passed. A rejected turn
    // never reaches the runner and must leave that addition available to retry.
    runnerInput.acknowledgePromptContext?.();
    if (hasSettings(input.settings)) {
      session.settings = input.settings;
    }

    const now = new Date().toISOString();
    const turn: AgentSessionTurn = {
      id: agentTurnId(),
      sessionId: session.id,
      status: "running",
      startedAt: now,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    this.turns.set(turn.id, turn);
    const acceptedAtMs = Date.now();
    this.telemetry.accept(turn.id, requestStartedAtMs, acceptedAtMs);
    logger.info({
      sessionId: session.id,
      turnId: turn.id,
      workspaceId: session.workspaceId,
      runnerKind: session.runnerKind,
      acceptDurationMs: acceptedAtMs - requestStartedAtMs,
      promptBytes: Buffer.byteLength(input.message, "utf8"),
      contextPathCount: input.context?.paths?.length ?? 0,
      attachmentCount: input.context?.attachments?.length ?? 0,
      runnerInputPartCount: runnerInput.inputParts.length
    }, "Agent turn accepted");
    this.messages.append({
      sessionId: session.id,
      turnId: turn.id,
      role: "user",
      content: input.message,
      ...(runnerInput.messageContext ? { context: runnerInput.messageContext } : {}),
      status: "sent",
      at: now
    });
    session.status = "running";
    session.activeTurnId = turn.id;
    session.error = undefined;
    session.updatedAt = now;
    this.persist(session.id);

    this.deps.eventBus.publish("agent_turn_started", {
      sessionId: session.id,
      turnId: turn.id,
      workspaceId: session.workspaceId,
      workspacePath: session.workspacePath,
      runnerKind: session.runnerKind
    });
    void this.consumeTurn(runner, session, turn, runnerInput.prompt, runnerInput.inputParts, session.settings);
    return turn;
  }

  async cancelTurn(sessionId: string): Promise<AgentSession> {
    const session = this.requireSession(sessionId);
    const turnId = session.activeTurnId;
    if (!turnId) return session;

    this.cancelledTurnIds.add(turnId);
    await this.requireRunner(session.runnerKind).cancel(turnId);
    const turn = this.turns.get(turnId);
    if (turn) {
      // A stopped turn's partial writes are still real work; report them like
      // Codex would have through its in-turn diff stream.
      await this.publishTurnGitDiff(session, turn);
      this.completeCancelledTurn(session, turn, { publishEvents: true });
    } else {
      const now = new Date().toISOString();
      if (session.activeTurnId === turnId) {
        session.activeTurnId = undefined;
      }
      if (!session.activeTurnId) {
        session.status = "idle";
        session.error = undefined;
      }
      session.updatedAt = now;
      this.persist(session.id);
      this.deps.eventBus.publish("agent_turn_cancelled", { sessionId: session.id, turnId });
      this.publishCodingEvent(codingTurnCancelledEvent({
        sessionId: session.id,
        turnId,
        runnerKind: session.runnerKind
      }));
    }
    return session;
  }

  /**
   * Answer an outstanding permission request with an option the runner is
   * holding for it.
   *
   * The runner decides whether the request is still outstanding and whether the
   * option was one the agent offered; this only maps those answers onto status
   * codes. A runner with no approval channel has no outstanding request either,
   * which is the same 404 — the route never reads which runner this is.
   */
  answerPermissionRequest(input: { sessionId: string; requestId: string; optionId: string }): AgentSession {
    const session = this.requireSession(input.sessionId);
    const answer = this.requireRunner(session.runnerKind).answerPermissionRequest?.({
      sessionId: session.id,
      requestId: input.requestId,
      optionId: input.optionId
    }) ?? "unknown_request";
    if (answer === "unknown_request") {
      throw new AgentSessionError("Permission request is not outstanding for this session", 404);
    }
    if (answer === "unknown_option") {
      // The agent decides what it is willing to be told; an option it did not
      // offer is refused rather than forwarded.
      throw new AgentSessionError("Permission option was not offered for this request", 400);
    }
    return session;
  }

  /**
   * Answer an outstanding clarifying-question batch with selections from the
   * sets the runner is holding for it, plus the person's own free text where a
   * set offered it. As with permissions, the runner decides whether the batch
   * is still outstanding and whether every named set and option was offered;
   * this maps those answers onto status codes, and a runner with no way to ask
   * has no outstanding batch, which is the same 404.
   */
  answerQuestionRequest(input: {
    sessionId: string;
    requestId: string;
    answers: CanonicalQuestionAnswer[];
  }): AgentSession {
    const session = this.requireSession(input.sessionId);
    const answer = this.requireRunner(session.runnerKind).answerQuestionRequest?.({
      sessionId: session.id,
      requestId: input.requestId,
      answers: input.answers
    }) ?? "unknown_request";
    if (answer === "unknown_request") {
      throw new AgentSessionError("Question request is not outstanding for this session", 404);
    }
    if (answer !== "answered") {
      throw new AgentSessionError(questionAnswerRefusal[answer], 400);
    }
    return session;
  }

  /** The clarifying-question batches a session still holds open, for a late joiner. */
  listOutstandingQuestions(sessionId: string): OutstandingQuestionRequest[] | undefined {
    if (!this.sessions.has(sessionId)) return undefined;
    return this.runnerEvents.outstandingQuestionRequests(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const activeTurnId = session.activeTurnId;
    if (activeTurnId) {
      // The cancelled marker stays in place until the session is removed
      // below: the runner's generator can drain its final failure event after
      // cancel() resolves, and that event must not be treated as a failure.
      this.cancelledTurnIds.add(activeTurnId);
      await this.requireRunner(session.runnerKind).cancel(activeTurnId);
    }
    // Release the runner's persistent per-session resources (e.g. the spawned
    // agent child process) even when the session is idle.
    await this.deps.runners[session.runnerKind]?.closeSession?.(sessionId);

    await this.deps.attachments?.deleteSessionAttachments(session);
    // The document goes before the in-memory record and before the delete is
    // reported, so an explicitly deleted thread is never hydrated; and after
    // the runner and attachment releases, so a delete that fails midway leaves
    // the file rather than losing it. Nothing below this line awaits, so no
    // late runner event can mark the record between the unlink and the
    // in-memory delete that makes the session not live.
    await this.deps.durableSessions?.remove(sessionId);
    this.uncontinuableSessionIds.delete(sessionId);
    this.hydratedSeeds.delete(sessionId);
    this.deps.artifacts?.releaseSession(sessionId);
    this.sessions.delete(sessionId);
    this.messages.deleteSession(sessionId);
    this.runnerEvents.releaseSession(sessionId);
    for (const [turnId, turn] of this.turns) {
      if (turn.sessionId === sessionId) {
        this.turns.delete(turnId);
        this.cancelledTurnIds.delete(turnId);
        this.countedCancelledTurnIds.delete(turnId);
        this.telemetry.delete(turnId);
        this.runnerEvents.releaseTurn(turnId);
        this.turnGitDiffs.releaseTurn(turnId);
      }
    }

    this.deps.eventBus.publish("agent_session_deleted", {
      sessionId,
      workspaceId: session.workspaceId,
      runnerKind: session.runnerKind,
      ...(activeTurnId ? { activeTurnId } : {})
    });
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentSessionError("Agent session was not found", 404);
    }
    return session;
  }

  private defaultRunnerKind(): AgentRunnerKind {
    return this.deps.defaultRunnerKind ?? "codex";
  }

  private requireRunner(runnerKind: AgentRunnerKind): AgentRunner {
    const runner = this.deps.runners[runnerKind];
    if (!runner) {
      throw new AgentSessionError(`Runner kind ${runnerKind} is not configured`, 400);
    }
    return runner;
  }

  private async checkoutSessionBranch(workspaceId: string, branch: string): Promise<CheckoutLocalWorkspaceBranchResult> {
    try {
      const result = await this.deps.registry.checkoutBranch(workspaceId, branch);
      if (result.changed) {
        this.deps.eventBus.publish("workspace_branch_changed", {
          workspaceId: result.workspace.id,
          path: result.workspace.path,
          previousBranch: result.previousBranch,
          branch: result.branch
        });
      }
      return result;
    } catch (error) {
      if (error instanceof LocalWorkspaceRegistryError) {
        throw new AgentSessionError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private async consumeTurn(
    runner: AgentRunner,
    session: AgentSession,
    turn: AgentSessionTurn,
    message: string,
    inputParts: AgentRunnerInputPart[] | undefined,
    settings: CodingAgentTurnSettings | undefined
  ): Promise<void> {
    const telemetry = this.telemetry.markRunnerStarted(turn.id);
    logger.info({
      sessionId: session.id,
      turnId: turn.id,
      workspaceId: session.workspaceId,
      runnerKind: session.runnerKind,
      timeToRunnerStartMs: telemetry.runnerStartedAtMs && telemetry.requestStartedAtMs
        ? telemetry.runnerStartedAtMs - telemetry.requestStartedAtMs
        : undefined
    }, "Agent turn runner consumption started");
    // A runner whose descriptor reports no turn diff of its own (Claude Code —
    // the SDK stream has no `turn/diff/updated` analog) gets a Git status
    // snapshot before the runner starts, and the settle-time delta becomes this
    // turn's coding_diff_updated. A `runner` source reports its own diffs; a
    // second source would double-report the same turn.
    if (runnerDescriptor(session.runnerKind).turnDiffSource === "settle_time_git") {
      await this.turnGitDiffs.beginTurn(turn.id, session.workspaceId);
    }
    try {
      for await (const event of runner.run({
        runId: turn.id,
        sessionId: session.id,
        workspacePath: session.workspacePath,
        prompt: message,
        inputParts,
        title: session.title,
        settings
      })) {
        if (event.type === "run_succeeded" || event.type === "run_failed") {
          // Before the terminal event applies, so the diff precedes
          // coding_turn_completed/failed — the order Codex diffs arrive in.
          await this.publishTurnGitDiff(session, turn);
        }
        this.runnerEvents.apply(session, turn, event);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A thrown generator never delivers a terminal run_succeeded/run_failed
      // event, so the applier's normal finalize path is bypassed. Settle any
      // in-flight artifact here (unless the turn was cancelled, which must not
      // publish late deltas) so it gets a completed event instead of leaking the
      // parser and hanging the client's streaming spinner open.
      if (this.cancelledTurnIds.has(turn.id) || turn.status === "cancelled") {
        this.runnerEvents.releaseTurn(turn.id);
      } else {
        this.runnerEvents.finalizeTurn(session, turn);
        await this.publishTurnGitDiff(session, turn);
      }
      this.failTurn(session, turn, message);
    } finally {
      // A generator that ended without a terminal event leaves its baseline
      // unconsumed; drop it rather than let it outlive the turn. settleTurn
      // consumes the baseline synchronously at entry, so this cannot yank one
      // out from under an in-flight settle.
      this.turnGitDiffs.releaseTurn(turn.id);
      if (session.activeTurnId === turn.id && turn.status !== "running") {
        session.activeTurnId = undefined;
      }
      if (turn.status !== "running") {
        this.cancelledTurnIds.delete(turn.id);
        this.countedCancelledTurnIds.delete(turn.id);
      }
    }
  }

  private async assembleRunnerInput(
    session: AgentSession,
    message: string,
    context: AgentTurnContext | undefined
  ): Promise<AssembledAgentTurnInput> {
    try {
      return await this.deps.contextAssembler.assemble({ session, message, context });
    } catch (error) {
      if (error instanceof AgentTurnContextAssemblyError) {
        throw new AgentSessionError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private validateRunnerInputParts(runner: AgentRunner, inputParts: AgentRunnerInputPart[]): void {
    try {
      runner.validateInputParts(inputParts);
    } catch (error) {
      if (error instanceof AgentRunnerInputError) {
        throw new AgentSessionError(error.message, error.statusCode);
      }
      throw error;
    }
  }

  private succeedTurn(
    session: AgentSession,
    turn: AgentSessionTurn,
    event: { message?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  ): void {
    this.runnerEvents.cancelOutstandingQuestionRequests(session, turn);
    const finalMessage = event.message && !turn.lastMessage ? event.message : undefined;
    if (finalMessage) {
      const content = `${turn.lastMessage ?? ""}${finalMessage}`;
      turn.lastMessage = content;
      session.lastMessage = content;
      this.messages.upsertAssistantMessage(session.id, turn.id, content, "running");
      this.recordTokenUsage(session, turn, event);
      session.updatedAt = new Date().toISOString();
      this.deps.eventBus.publish("agent_turn_update", {
        sessionId: session.id,
        turnId: turn.id,
        message: finalMessage
      });
    }
    this.recordTokenUsage(session, turn, event);
    const now = new Date().toISOString();
    turn.status = "succeeded";
    turn.completedAt = now;
    this.messages.markAssistantMessage(session.id, turn.id, "succeeded");
    session.status = "idle";
    session.activeTurnId = undefined;
    session.turnCount += 1;
    this.completedTurns += 1;
    session.updatedAt = now;
    this.persist(session.id);
    this.deps.eventBus.publish("agent_turn_succeeded", { sessionId: session.id, turnId: turn.id });
    this.publishCodingEvent(codingTurnCompletedEvent({
      sessionId: session.id,
      turnId: turn.id,
      runnerKind: session.runnerKind
    }));
    this.telemetry.logTurnTiming(session, turn, "succeeded");
  }

  private recordTokenUsage(
    session: AgentSession,
    turn: AgentSessionTurn,
    event: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      contextWindowUsedTokens?: number;
      modelContextWindowTokens?: number;
    }
  ): void {
    const previousInputTokens = turn.inputTokens;
    const previousOutputTokens = turn.outputTokens;
    const previousTotalTokens = turn.totalTokens;
    if (typeof event.inputTokens === "number") turn.inputTokens = event.inputTokens;
    if (typeof event.outputTokens === "number") turn.outputTokens = event.outputTokens;
    if (typeof event.totalTokens === "number") turn.totalTokens = event.totalTokens;
    this.inputTokens += turn.inputTokens - previousInputTokens;
    this.outputTokens += turn.outputTokens - previousOutputTokens;
    this.totalTokens += turn.totalTokens - previousTotalTokens;
    // Occupancy is the latest request's footprint, never the cumulative
    // billed totals — those re-count cached context per tool round-trip.
    if (typeof event.contextWindowUsedTokens === "number") {
      session.contextWindowUsedTokens = event.contextWindowUsedTokens;
    }
    if (typeof event.modelContextWindowTokens === "number") {
      turn.modelContextWindowTokens = event.modelContextWindowTokens;
      session.modelContextWindowTokens = event.modelContextWindowTokens;
    }
    session.updatedAt = new Date().toISOString();
    this.persist(session.id);
  }

  private failTurn(
    session: AgentSession,
    turn: AgentSessionTurn,
    error: string,
    options: { countMetric?: boolean } = {}
  ): void {
    if (this.cancelledTurnIds.has(turn.id) || turn.status === "cancelled") {
      this.completeCancelledTurn(session, turn);
      return;
    }

    this.runnerEvents.cancelOutstandingQuestionRequests(session, turn);
    const now = new Date().toISOString();
    turn.status = "failed";
    turn.error = error;
    turn.completedAt = now;
    this.messages.upsertAssistantMessage(session.id, turn.id, error, "failed");
    session.status = "failed";
    session.error = error;
    session.lastMessage = error;
    session.activeTurnId = undefined;
    session.updatedAt = now;
    if (options.countMetric !== false) this.failedTurns += 1;
    this.persist(session.id);
    this.deps.eventBus.publish("agent_turn_failed", { sessionId: session.id, turnId: turn.id, error });
    this.publishCodingEvent(codingTurnFailedEvent({
      sessionId: session.id,
      turnId: turn.id,
      runnerKind: session.runnerKind,
      error
    }));
    this.telemetry.logTurnTiming(session, turn, "failed");
  }

  private completeCancelledTurn(
    session: AgentSession,
    turn: AgentSessionTurn,
    options: { publishEvents?: boolean } = {}
  ): void {
    this.runnerEvents.cancelOutstandingQuestionRequests(session, turn);
    this.runnerEvents.releaseTurn(turn.id);
    const now = new Date().toISOString();
    turn.status = "cancelled";
    turn.completedAt = turn.completedAt ?? now;
    turn.error = undefined;
    this.messages.markAssistantMessage(session.id, turn.id, "cancelled", "Turn stopped.");
    if (session.activeTurnId === turn.id) {
      session.activeTurnId = undefined;
    }
    if (!session.activeTurnId) {
      session.status = "idle";
      session.error = undefined;
    }
    session.updatedAt = now;
    this.persist(session.id);
    if (!this.countedCancelledTurnIds.has(turn.id)) {
      this.cancelledTurns += 1;
      this.countedCancelledTurnIds.add(turn.id);
      this.telemetry.logTurnTiming(session, turn, "cancelled");
    }
    if (options.publishEvents) {
      this.deps.eventBus.publish("agent_turn_cancelled", { sessionId: session.id, turnId: turn.id });
      this.publishCodingEvent(codingTurnCancelledEvent({
        sessionId: session.id,
        turnId: turn.id,
        runnerKind: session.runnerKind
      }));
    }
  }

  // Emits the settle-time Git delta as the turn's coding_diff_updated. No-op
  // when the turn holds no baseline (non-claude_code turns, a non-Git
  // workspace, an already-settled turn) or the delta is empty; a Git read
  // failure inside the tracker never fails or delays the turn's settlement
  // beyond the read itself.
  private async publishTurnGitDiff(session: AgentSession, turn: AgentSessionTurn): Promise<void> {
    const diff = await this.turnGitDiffs.settleTurn(turn.id);
    if (!diff || !this.sessions.has(session.id)) return;
    this.publishCodingEvent(codingDiffUpdatedEvent({
      sessionId: session.id,
      turnId: turn.id,
      runnerKind: session.runnerKind,
      files: diff.files,
      ...(diff.truncated ? { truncated: true } : {})
    }));
  }

  private publishCodingEvent(candidate: CodingAgentEventCandidate | undefined): void {
    if (!candidate) return;
    this.deps.eventBus.publish(candidate.type, candidate.payload);
  }

  private metrics(): AgentBridgeMetrics {
    return {
      totalSessions: this.sessions.size,
      runningSessions: [...this.sessions.values()].filter((session) => session.status === "running").length,
      completedTurns: this.completedTurns,
      failedTurns: this.failedTurns,
      cancelledTurns: this.cancelledTurns,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.totalTokens
    };
  }
}

function agentSessionId(): string {
  return `agent-session-${randomUUID()}`;
}

function agentTurnId(): string {
  return `agent-turn-${randomUUID()}`;
}

function hasSettings(settings: CodingAgentTurnSettings | undefined): settings is CodingAgentTurnSettings {
  return Boolean(settings?.model || settings?.reasoningEffort || settings?.serviceTier);
}
