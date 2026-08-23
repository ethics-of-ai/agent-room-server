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
  StatusSnapshot
} from "../domain/models";
import type { ArtifactSnapshot, ArtifactStore } from "../artifact/ArtifactStore";
import type { EventBus } from "../events/EventBus";
import { logger } from "../logging/logger";
import { AgentRunnerInputError, type AgentRunner, type AgentRunnerInputPart } from "../runner/AgentRunner";
import { runnerDescriptor } from "../runner/registry";
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
import { AgentTurnEventApplier } from "./AgentTurnEventApplier";
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

export class AgentSessionService {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly turns = new Map<string, AgentSessionTurn>();
  private readonly messages = new AgentSessionMessageStore();
  private readonly telemetry = new AgentTurnTelemetryStore();
  private readonly runnerEvents: AgentTurnEventApplier;
  private readonly turnGitDiffs: AgentTurnGitDiffTracker;
  private readonly cancelledTurnIds = new Set<string>();
  private readonly countedCancelledTurnIds = new Set<string>();
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
      failTurn: (session, turn, error) => this.failTurn(session, turn, error)
    });
    this.turnGitDiffs = new AgentTurnGitDiffTracker({
      gitStatus: (workspaceId) => deps.registry.gitStatus(workspaceId)
    });
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
    this.deps.eventBus.publish("agent_session_created", { session });
    return session;
  }

  async startTurn(input: StartAgentTurnInput): Promise<AgentSessionTurn> {
    const requestStartedAtMs = Date.now();
    const session = this.requireSession(input.sessionId);
    if (session.activeTurnId) {
      throw new AgentSessionError("Agent session already has a running turn", 409);
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
    this.deps.artifacts?.releaseSession(sessionId);
    this.sessions.delete(sessionId);
    this.messages.deleteSession(sessionId);
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
  }

  private failTurn(session: AgentSession, turn: AgentSessionTurn, error: string): void {
    if (this.cancelledTurnIds.has(turn.id) || turn.status === "cancelled") {
      this.completeCancelledTurn(session, turn);
      return;
    }

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
    this.failedTurns += 1;
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
