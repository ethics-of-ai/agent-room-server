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
  DurableAgentSessionDocument,
  ServiceConfig,
  StatusSnapshot
} from "../domain/models";
import { DURABLE_AGENT_SESSION_SCHEMA_VERSION } from "../domain/schemas";
import type { ArtifactSnapshot, ArtifactStore } from "../artifact/ArtifactStore";
import type { EventBus } from "../events/EventBus";
import { logger } from "../logging/logger";
import type { AgentRunner, AgentRunnerEvent, CanonicalQuestionAnswer } from "../runner/AgentRunner";
import { questionAnswerRefusal, type QuestionAnswerResult } from "../runner/shared/PendingQuestionRequests";
import { isRegisteredRunnerKind, runnerDescriptor } from "../runner/registry";
import type { DurableAgentSessionStore } from "../state/DurableAgentSessionStore";
import {
  codingDiffUpdatedEvent,
  codingTurnCancelledEvent,
  codingTurnCompletedEvent,
  codingTurnFailedEvent,
  type CodingAgentEventCandidate
} from "../protocol/coding/events";
import type { LocalWorkspaceRegistry } from "../workspace/LocalWorkspaceRegistry";
import { AgentBackgroundWork } from "./AgentBackgroundWork";
import { checkoutSessionBranch, validateRunnerInputParts } from "./sessionRunnerSupport";
import { AgentSessionMessageStore } from "./AgentSessionMessageStore";
import { AgentTurnEventApplier, type OutstandingQuestionRequest } from "./AgentTurnEventApplier";
import { AgentTurnGitDiffTracker } from "./AgentTurnGitDiffTracker";
import { AgentTurnTelemetryStore } from "./AgentTurnTelemetryStore";
import {
  agentSessionId,
  AgentSessionError,
  agentTurnId,
  BACKEND_RESTARTED_TURN_ERROR,
  hasSettings,
  type AgentTurnOpening,
  type CreateAgentSessionInput,
  type StartAgentTurnInput
} from "./agentSessionTypes";
import type { PlanReadResult, PlanTurnOutcome, ThreadPlanService } from "../plans/ThreadPlanService";
import { createSessionPlans, type ThreadPlanTurnTools } from "../plans/planTurnTools";
import { SessionTurnTools, type SessionSketches } from "./SessionTurnTools";
import type { PlanPersistedState } from "../plans/planModel";

export {
  AgentSessionError,
  BACKEND_RESTARTED_TURN_ERROR,
  type AgentTurnOpening,
  type CreateAgentSessionInput,
  type StartAgentTurnInput
} from "./agentSessionTypes";

export class AgentSessionService {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly turns = new Map<string, AgentSessionTurn>();
  private readonly messages = new AgentSessionMessageStore({
    onChange: (sessionId) => this.persist(sessionId)
  });
  private readonly telemetry = new AgentTurnTelemetryStore();
  /** Thread plans, committed through the durable store's own per-session chain. */
  readonly plans: ThreadPlanService;
  /** Per-turn plan tool bindings and the plan prompt each turn carries. */
  readonly planTools: ThreadPlanTurnTools;
  /** Every tool family's per-turn binding and standing instructions. */
  readonly turnTools: SessionTurnTools;
  private readonly runnerEvents: AgentTurnEventApplier;
  private readonly background: AgentBackgroundWork;
  private readonly turnGitDiffs: AgentTurnGitDiffTracker;
  private readonly cancelledTurnIds = new Set<string>();
  /** Hydrated non-restorable sessions that must refuse a fresh conversation. */
  private readonly uncontinuableSessionIds = new Set<string>();
  /** Native ids awaiting their one-time post-hydration resume check. */
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
      attachments?: { deleteSessionAttachments(session: Pick<AgentSession, "workspaceId" | "id">): Promise<void> };
      /** Decides which descriptor tool transports exist under this configuration. */
      runnerConfig?: ServiceConfig;
      /** Repository sketches the session's sketch tools act on; absent advertises none. */
      sketches?: SessionSketches;
      /** Optional durable session store; absent keeps sessions process-scoped. */
      durableSessions?: Pick<DurableAgentSessionStore, "initialize" | "schedule" | "remove" | "commit" | "hasUnresolvedCommit" | "reconcile">;
    }
  ) {
    ({ plans: this.plans, planTools: this.planTools } = createSessionPlans({
      eventBus: deps.eventBus,
      store: deps.durableSessions,
      snapshot: (id, plan) => this.snapshot(id, plan),
      runnerConfig: deps.runnerConfig
    }));
    this.turnTools = new SessionTurnTools(this.planTools, { sketches: deps.sketches, runnerConfig: deps.runnerConfig, sessions: this.sessions,
      turns: this.turns, activity: (session, turn, activity) => this.runnerEvents.apply(session, turn, { type: "agent_activity", activity }) });
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
    this.turnGitDiffs = new AgentTurnGitDiffTracker(deps.registry);
    this.background = new AgentBackgroundWork({ sessions: this.sessions, eventBus: deps.eventBus,
      openTurn: (session, opening) => this.openTurn(session, opening), consume: (session, turn, events) => void this.consumeTurn(session, turn, events) });
    for (const runner of Object.values(deps.runners)) runner?.watchBackgroundWork?.(this.background.listener);
  }

  /** Hydrate before routes open, settle and fail interrupted turns, and seed verified resume ids. */
  async initialize(): Promise<void> {
    const store = this.deps.durableSessions;
    if (!store) return;
    const inventory = await store.initialize();
    for (const document of inventory.documents) {
      await this.hydrate(document);
    }
    logger.info({ sessions: inventory.documents.length }, "Agent sessions restored from the durable store");
  }

  private async hydrate(document: DurableAgentSessionDocument): Promise<void> {
    // Unknown persisted runner ids stay readable; requireRunner refuses use.
    const session = document.session as AgentSession;
    if (this.sessions.has(session.id)) return;
    this.turnTools.describe(session);
    this.sessions.set(session.id, session);
    for (const turn of document.turns) {
      this.turns.set(turn.id, turn);
    }
    this.messages.restore(session.id, document.messages);
    this.plans.hydrate(session.id, document);

    const interruptedTurns = document.turns.filter((turn) => turn.status === "running");
    for (const turn of interruptedTurns) {
      await this.settleTurnWorkspace(session, turn);
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
      interrupted: interruptedTurns.length > 0,
      ...(document.nativeToolRegistration?.nativeSessionId === nativeSessionId ? { registeredToolNames: document.nativeToolRegistration.names } : {})
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
  private snapshot(sessionId: string, plan: PlanPersistedState = this.plans.persistedState(sessionId)): DurableAgentSessionDocument {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Agent session is no longer in memory");
    const toolRegistration = this.deps.runners[session.runnerKind]?.nativeToolRegistration?.(sessionId);
    return {
      schemaVersion: DURABLE_AGENT_SESSION_SCHEMA_VERSION,
      session: { ...session, backgroundTasks: undefined },
      turns: [...this.turns.values()].filter((turn) => turn.sessionId === sessionId).map((turn) => ({ ...turn })),
      messages: this.messages.list(sessionId),
      plan: plan.plan,
      planMutationReceipts: plan.planMutationReceipts,
      ...(toolRegistration ? { nativeToolRegistration: toolRegistration } : {})
    };
  }

  listSessions(): AgentSession[] {
    return [...this.sessions.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** The thread's plan, or undefined for an unknown session. */
  readPlan(sessionId: string): Promise<PlanReadResult> | undefined {
    return this.sessions.has(sessionId) ? this.plans.read(sessionId) : undefined;
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
      const result = await checkoutSessionBranch(this.deps, workspace.id, input.gitBranch.trim());
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
    this.turnTools.describe(session);
    this.sessions.set(session.id, session);
    this.messages.initializeSession(session.id);
    this.persist(session.id);
    this.deps.eventBus.publish("agent_session_created", { session });
    return session;
  }

  async startTurn(input: StartAgentTurnInput): Promise<AgentSessionTurn> {
    if (input.context?.sketch !== undefined) {
      throw new AgentSessionError("Sketch context is no longer supported. Open the sketch to edit it directly.", 400);
    }
    const requestStartedAtMs = Date.now();
    const session = this.requireSession(input.sessionId);
    this.refuseWhileRunning(session);
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
    const planToolsUnsupported = this.planTools.unsupportedReason(session.runnerKind, input.context);
    if (planToolsUnsupported) throw new AgentSessionError(planToolsUnsupported, 409);
    if (!(await this.plans.prepareForTurn(session.id))) {
      throw new AgentSessionError("This thread's plan state could not be saved; retry shortly", 503);
    }
    // Turn start only needs the workspace to still be registered, so skip the
    // full snapshot refresh here.
    const workspace = await this.deps.registry.findByIdWithoutGitRefresh(session.workspaceId);
    if (!workspace) {
      throw new AgentSessionError("Workspace is not registered", 404);
    }
    // The turn runs on whatever branch the Mac's checkout is on; AgentRoom never
    // switches it here. An accepted turn records that branch as history only. A
    // detached HEAD, or a read failure, leaves the last recorded branch.
    const branch = await this.deps.registry.gitCurrentBranch(session.workspaceId).catch(() => undefined);

    const runner = this.requireRunner(session.runnerKind);
    const runnerInput = await this.assembleRunnerInput(session, input.message, input.context);
    // The awaits above let a second start on this session interleave.
    this.refuseWhileRunning(session);
    validateRunnerInputParts(runner, runnerInput.inputParts);
    // A volatile prompt addition (currently human diagram edits) may only mark
    // itself delivered after all request validation has passed. A rejected turn
    // never reaches the runner and must leave that addition available to retry.
    runnerInput.acknowledgePromptContext?.();
    if (hasSettings(input.settings)) {
      session.settings = input.settings;
    }
    if (branch) session.gitBranch = branch;

    const turn = this.openTurn(session, {
      role: "user",
      content: input.message,
      ...(runnerInput.messageContext ? { context: runnerInput.messageContext } : {})
    });
    this.telemetry.logAccepted(session, turn, {
      requestStartedAtMs,
      promptBytes: Buffer.byteLength(input.message, "utf8"),
      contextPathCount: input.context?.paths?.length ?? 0,
      attachmentCount: input.context?.attachments?.length ?? 0,
      runnerInputPartCount: runnerInput.inputParts.length
    });
    // A fresh binding: live only while this turn is the session's running turn.
    const tools = this.turnTools.bind({
      session,
      turnId: turn.id,
      context: input.context,
      isLive: () => session.activeTurnId === turn.id && turn.status === "running" && !this.cancelledTurnIds.has(turn.id)
    });
    void this.consumeTurn(session, turn, runner.run({ runId: turn.id, sessionId: session.id, workspacePath: session.workspacePath,
      prompt: runnerInput.prompt, inputParts: runnerInput.inputParts, title: session.title, settings: session.settings, ...(tools ? { tools } : {}) }));
    return turn;
  }

  /** A person's turn waits for the running turn, and for an agent turn queued behind it. */
  private refuseWhileRunning(session: AgentSession): void {
    if (session.activeTurnId || this.background.isWaiting(session.id)) throw new AgentSessionError("Agent session already has a running turn", 409);
  }

  /** Record a turn and its opening message on an idle session, mark the session running, and announce it. */
  private openTurn(session: AgentSession, opening: AgentTurnOpening): AgentSessionTurn {
    const { id = agentTurnId(), trigger, ...message } = opening;
    const now = new Date().toISOString();
    const turn: AgentSessionTurn = {
      id, sessionId: session.id, status: "running", startedAt: now, inputTokens: 0, outputTokens: 0, totalTokens: 0, ...(trigger ? { trigger } : {})
    };
    this.turns.set(turn.id, turn);
    this.messages.append({ sessionId: session.id, turnId: turn.id, ...message, status: "sent", at: now });
    session.status = "running";
    session.activeTurnId = turn.id;
    session.error = undefined;
    session.updatedAt = now;
    this.persist(session.id);
    this.deps.eventBus.publish("agent_turn_started", { sessionId: session.id, turnId: turn.id, workspaceId: session.workspaceId,
      workspacePath: session.workspacePath, runnerKind: session.runnerKind, ...(trigger ? { trigger } : {}) });
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
      await this.settleTurnWorkspace(session, turn);
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
   * Answer an outstanding clarifying-question batch. A batch a backend tool
   * asked is answered in the session's own channel; any other goes to the
   * runner, which decides whether it is outstanding and every set and option
   * was offered. A batch nobody holds is a 404.
   */
  answerQuestionRequest(input: {
    sessionId: string;
    requestId: string;
    answers: CanonicalQuestionAnswer[];
  }): AgentSession {
    const session = this.requireSession(input.sessionId);
    const answer = this.turnTools.questions.answer(session.id, input.requestId, input.answers) ?? this.requireRunner(session.runnerKind).answerQuestionRequest?.({
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

  /** Stop one live background task; its end arrives as a task list change. */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<AgentSession> {
    const session = this.requireSession(sessionId);
    const result = await this.deps.runners[session.runnerKind]?.stopBackgroundTask?.({ sessionId, taskId });
    if (result === "stopped") return session;
    throw result === "unavailable" ? new AgentSessionError("This session cannot stop its background work", 409) : new AgentSessionError("Background task is not running in this session", 404);
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
    await this.plans.closeSession(sessionId);
    this.turnTools.closeSession(sessionId);
    await this.deps.durableSessions?.remove(sessionId);
    this.uncontinuableSessionIds.delete(sessionId);
    this.hydratedSeeds.delete(sessionId);
    this.background.forget(sessionId);
    this.deps.artifacts?.releaseSession(sessionId);
    this.sessions.delete(sessionId);
    this.messages.deleteSession(sessionId);
    this.runnerEvents.releaseSession(sessionId);
    for (const [turnId, turn] of this.turns) {
      if (turn.sessionId === sessionId) {
        this.turns.delete(turnId);
        this.cancelledTurnIds.delete(turnId);
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

  /** Drive one turn's runner events: a person's turn from `run()`, or one the agent started. */
  private async consumeTurn(session: AgentSession, turn: AgentSessionTurn, events: AsyncIterable<AgentRunnerEvent>): Promise<void> {
    this.telemetry.logRunnerStarted(session, turn);
    // Runners without native turn diffs get one settle-time Git delta.
    if (runnerDescriptor(session.runnerKind).turnDiffSource === "settle_time_git") {
      await this.turnGitDiffs.beginTurn(turn.id, session.workspaceId);
    }
    try {
      for await (const event of events) {
        if (event.type === "run_succeeded" || event.type === "run_failed") {
          // Before the terminal event applies, so the diff precedes
          // coding_turn_completed/failed — the order Codex diffs arrive in.
          await this.settleTurnWorkspace(session, turn);
        }
        this.runnerEvents.apply(session, turn, event);
        // A settle frees the session in this same tick, so no person's turn can take it first.
        this.background.openWaitingTurn(session);
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
        await this.settleTurnWorkspace(session, turn);
      }
      this.failTurn(session, turn, message);
    } finally {
      // A generator that ended without a terminal event leaves its baseline
      // unconsumed; drop it rather than let it outlive the turn. settleTurn
      // consumes the baseline synchronously at entry, so this cannot yank one
      // out from under an in-flight settle.
      this.turnGitDiffs.releaseTurn(turn.id);
      this.turnTools.release(turn.id);
      if (session.activeTurnId === turn.id && turn.status !== "running") {
        session.activeTurnId = undefined;
      }
      if (turn.status !== "running") {
        this.cancelledTurnIds.delete(turn.id);
      }
      this.background.openWaitingTurn(session);
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

  /** Every settlement path ends the turn's question requests and plan binding here, first. */
  private endTurnTools(session: AgentSession, turn: AgentSessionTurn, outcome: PlanTurnOutcome): void {
    this.runnerEvents.cancelOutstandingQuestionRequests(session, turn);
    void this.turnTools.settle(session.id, turn.id, outcome);
  }

  private succeedTurn(
    session: AgentSession,
    turn: AgentSessionTurn,
    event: { message?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  ): void {
    this.endTurnTools(session, turn, "succeeded");
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
    this.publishCodingEvent(codingTurnCompletedEvent({ sessionId: session.id, turnId: turn.id, runnerKind: session.runnerKind }));
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
      contextCompactionThresholdTokens?: number | null;
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
    // Undefined carries no new knowledge and preserves the cache. Null is an
    // authoritative clear from a runner that previously supplied a value.
    if (event.contextCompactionThresholdTokens === null) {
      delete turn.contextCompactionThresholdTokens;
      delete session.contextCompactionThresholdTokens;
    } else if (typeof event.contextCompactionThresholdTokens === "number") {
      turn.contextCompactionThresholdTokens = event.contextCompactionThresholdTokens;
      session.contextCompactionThresholdTokens = event.contextCompactionThresholdTokens;
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

    this.endTurnTools(session, turn, "failed");
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
    this.endTurnTools(session, turn, "cancelled");
    this.runnerEvents.releaseTurn(turn.id);
    const now = new Date().toISOString();
    // The stop and the runner's own end may both complete the turn; count it once.
    const firstCompletion = turn.status !== "cancelled";
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
    if (firstCompletion) {
      this.cancelledTurns += 1;
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

  // Before a turn's terminal event, a restart's included: emit the settle-time
  // Git delta if the turn still holds a baseline. settleTurn takes it before its
  // first await.
  private async settleTurnWorkspace(session: AgentSession, turn: AgentSessionTurn): Promise<void> {
    const diff = await this.turnGitDiffs.settleTurn(turn.id);
    if (!diff || !this.sessions.has(session.id)) return;
    this.publishCodingEvent(codingDiffUpdatedEvent({ sessionId: session.id, turnId: turn.id, runnerKind: session.runnerKind,
      files: diff.files, ...(diff.truncated ? { truncated: true } : {}) }));
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
