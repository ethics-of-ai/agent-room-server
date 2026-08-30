import type { AgentSession, AgentSessionTurn } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import { logger } from "../logging/logger";
import {
  boundedRunnerActivity,
  codingArtifactCompletedEvent,
  codingArtifactDeltaEvent,
  codingArtifactStartedEvent,
  codingAssistantMessageDeltaEvent,
  codingEventFromRunnerActivity,
  codingTokenUsageUpdatedEvent,
  codingTurnCompletedEvent,
  runnerSessionMetadataFromActivity,
  type CodingAgentEventCandidate
} from "../protocol/coding/events";
import { legacySessionMetadata } from "../protocol/coding/legacySessionMetadata";
import type {
  AgentRunnerActivity,
  AgentRunnerEvent,
  CanonicalQuestionSet,
  RunnerMetadata
} from "../runner/AgentRunner";
import { isValidQuestionRequestBatch } from "../runner/shared/PendingQuestionRequests";
import { renderQuestionAnswers } from "./questionTranscript";
import { ArtifactStreamParser, stripArtifactRegions, type ArtifactStreamOp } from "../artifact/ArtifactStreamParser";
import type { ArtifactStore } from "../artifact/ArtifactStore";
import type { AgentSessionMessageStore } from "./AgentSessionMessageStore";
import type { AgentTurnTelemetryStore } from "./AgentTurnTelemetryStore";

export interface OutstandingQuestionRequest {
  requestId: string;
  turnId: string;
  questionSets: CanonicalQuestionSet[];
}

/** The thread message for a restored thread whose runner did not resume it. */
export const RESUME_NOT_HONORED_MESSAGE =
  "This thread could not be resumed after a backend restart. The agent has started a new conversation and has not seen the messages above.";

export class AgentTurnEventApplier {
  // One in-band artifact parser per active turn, lazily created on the first
  // assistant delta and disposed when the turn settles. Only used when an
  // ArtifactStore is configured (i.e. artifacts are enabled).
  private readonly parsers = new Map<string, ArtifactStreamParser>();
  // The clarifying-question batches each session still holds open, by request
  // id: filled by the canonical request, consumed by the canonical resolution.
  // It exists for the late-joining client — a batch can stay outstanding for
  // minutes while the turn waits on it, long enough for the recent-event
  // replay to roll over — and for the transcript record of the answer, which
  // needs the sets' labels. Released with the session.
  private readonly outstandingQuestions = new Map<string, Map<string, OutstandingQuestionRequest>>();

  constructor(
    private readonly deps: {
      eventBus: EventBus;
      messages: AgentSessionMessageStore;
      telemetry: AgentTurnTelemetryStore;
      artifacts?: ArtifactStore;
      isSessionLive(sessionId: string): boolean;
      isTurnCancelled(turnId: string): boolean;
      completeCancelledTurn(session: AgentSession, turn: AgentSessionTurn): void;
      recordTokenUsage(
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
      ): void;
      succeedTurn(session: AgentSession, turn: AgentSessionTurn, event: AgentRunnerEvent & { type: "run_succeeded" }): void;
      failTurn(session: AgentSession, turn: AgentSessionTurn, error: string): void;
      /**
       * The session record changed in a way no message-store write reports
       * (the runner metadata assigned at session start). The service uses it
       * to mark the durable record.
       */
      sessionChanged?(sessionId: string): void;
      /**
       * The native id a session restored from the durable store was seeded
       * with, handed over once. Compared against the id the runner reports at
       * session start so a resume the runner did not honor is told to the
       * person in the thread rather than continued under the old thread's
       * name. Runner-agnostic by construction: two values of the same field.
       */
      takeHydratedSeed?(sessionId: string): string | undefined;
    }
  ) {}

  apply(session: AgentSession, turn: AgentSessionTurn, event: AgentRunnerEvent): void {
    // A cancelled turn's runner generator can drain its final events after the
    // session was deleted; applying them would publish events, mutate metrics,
    // and re-create message-store state for a session that no longer exists.
    if (!this.deps.isSessionLive(session.id)) return;

    if (event.type === "runner_audit") {
      this.deps.eventBus.publish("runner_audit", {
        sessionId: session.id,
        workspacePath: session.workspacePath,
        audit: event.audit
      });
      return;
    }

    if (this.deps.isTurnCancelled(turn.id) || turn.status === "cancelled") {
      if (event.type === "run_succeeded" || event.type === "run_failed") {
        // Dispose the parser WITHOUT flushing: a cancelled turn must not publish
        // late artifact/assistant deltas or append trailing prose to the message
        // (markAssistantMessage keeps existing content, so flushed prose would
        // stick to the cancelled turn).
        this.releaseTurn(turn.id);
        this.deps.completeCancelledTurn(session, turn);
      }
      return;
    }

    if (event.type === "token_usage_updated") {
      this.deps.telemetry.recordRunnerEvent(turn, event);
      this.deps.recordTokenUsage(session, turn, event);
      const contextCompactionThresholdTokens = event.contextCompactionThresholdTokens === null
        ? null
        : turn.contextCompactionThresholdTokens;
      this.deps.eventBus.publish("agent_turn_token_usage_updated", {
        sessionId: session.id,
        turnId: turn.id,
        workspaceId: session.workspaceId,
        workspacePath: session.workspacePath,
        runnerKind: session.runnerKind,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        totalTokens: turn.totalTokens,
        ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
        ...(event.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: event.reasoningOutputTokens } : {}),
        ...(session.contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens: session.contextWindowUsedTokens } : {}),
        ...(turn.modelContextWindowTokens !== undefined ? { modelContextWindowTokens: turn.modelContextWindowTokens } : {}),
        ...(contextCompactionThresholdTokens !== undefined
          ? { contextCompactionThresholdTokens }
          : {})
      });
      this.publishCodingEvent(codingTokenUsageUpdatedEvent({
        sessionId: session.id,
        turnId: turn.id,
        runnerKind: session.runnerKind,
        runner: event.runner,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        totalTokens: turn.totalTokens,
        cachedInputTokens: event.cachedInputTokens,
        reasoningOutputTokens: event.reasoningOutputTokens,
        contextWindowUsedTokens: session.contextWindowUsedTokens,
        modelContextWindowTokens: turn.modelContextWindowTokens,
        contextCompactionThresholdTokens
      }));
      return;
    }

    this.deps.telemetry.recordRunnerEvent(turn, event);

    if (event.type === "agent_update") {
      this.applyAgentUpdate(session, turn, event);
      return;
    }

    if (event.type === "agent_activity") {
      const runnerMetadata = runnerSessionMetadataFromActivity(event.activity);
      if (runnerMetadata) {
        this.reportUnhonoredResume(session, turn, runnerMetadata.nativeSessionId);
        session.runner = runnerMetadata;
        // Legacy per-runner session blocks, projected from the canonical one.
        Object.assign(session, legacySessionMetadata(session.runnerKind, runnerMetadata));
        this.deps.sessionChanged?.(session.id);
      }
      // The reconnect snapshot changes synchronously with the live event: a
      // subscriber that reacts to a request can immediately read it, and one
      // that reacts to a resolution cannot read a batch that has just settled.
      this.rememberQuestionRequest(session, turn, event.activity);
      const resolvedQuestion = this.takeResolvedQuestion(session, event.activity);
      this.deps.eventBus.publish("agent_turn_activity", {
        sessionId: session.id,
        turnId: turn.id,
        workspaceId: session.workspaceId,
        workspacePath: session.workspacePath,
        // Clamped like the canonical coding events: the raw runner params can
        // carry an unbounded tool-output chunk, which would otherwise bloat the
        // recent-event buffer and every status/logs/greeting payload.
        activity: boundedRunnerActivity(event.activity, session.runnerKind)
      });
      this.publishCodingEvent(codingEventFromRunnerActivity({
        sessionId: session.id,
        turnId: turn.id,
        runnerKind: session.runnerKind,
        activity: event.activity
      }));
      this.publishPermissionDecision(session, turn, event.activity);
      this.publishQuestionResolution(session, turn, event.activity, resolvedQuestion);
      return;
    }

    if (event.type === "run_succeeded") {
      const hadStreamingParser = this.parsers.has(turn.id);
      this.flushStreamingArtifacts(session, turn);
      if (!hadStreamingParser && this.recoverArtifactsFromTerminalMessage(session, turn, event)) {
        return;
      }
      this.deps.succeedTurn(session, turn, this.stripArtifactsFromCompletion(turn, event));
      return;
    }

    this.deps.recordTokenUsage(session, turn, event);
    this.flushStreamingArtifacts(session, turn);
    this.deps.failTurn(session, turn, event.error);
  }

  /**
   * A restored thread whose runner reports a different native id than the one
   * it was seeded with is in a fresh conversation: the transcript is on screen
   * and the agent has never seen it. Say so in the thread, once. The runner's
   * own warning stays in the log with the ids; the message carries neither,
   * since the transcript is for the person and the ids are diagnostics. A
   * start that reports no id at all proves nothing either way and is left
   * alone.
   */
  private reportUnhonoredResume(session: AgentSession, turn: AgentSessionTurn, reportedId: string | undefined): void {
    if (!reportedId) return;
    const seed = this.deps.takeHydratedSeed?.(session.id);
    if (!seed || reportedId === seed) return;
    logger.warn(
      { sessionId: session.id, turnId: turn.id, seededNativeSessionId: seed, reportedNativeSessionId: reportedId },
      "Restored agent session was not resumed by its runner; the agent has started a new conversation"
    );
    this.deps.messages.append({
      sessionId: session.id,
      turnId: turn.id,
      role: "system",
      content: RESUME_NOT_HONORED_MESSAGE,
      status: "sent",
      at: new Date().toISOString()
    });
  }

  /**
   * The durable record of a permission decision, beside the canonical event a
   * client renders.
   *
   * Keyed on the canonical activity kind like everything else here, so a runner
   * that grows an approval channel is recorded without this file learning its
   * name. What it keeps is the decision — which option, on whose authority —
   * and never the request: the tool call an agent was about to run is exactly
   * the payload a durable log should not hold.
   */
  private publishPermissionDecision(
    session: AgentSession,
    turn: AgentSessionTurn,
    activity: AgentRunnerActivity
  ): void {
    const canonical = activity.canonical;
    if (canonical?.kind !== "permission_resolved") return;
    this.deps.eventBus.publish("agent_permission_resolved", {
      sessionId: session.id,
      turnId: turn.id,
      workspaceId: session.workspaceId,
      workspacePath: session.workspacePath,
      runnerKind: session.runnerKind,
      audit: {
        ...(canonical.requestId ? { requestId: canonical.requestId } : {}),
        ...(canonical.optionId ? { optionId: canonical.optionId } : {}),
        ...(canonical.decidedBy ? { decidedBy: canonical.decidedBy } : {}),
        ...(canonical.status ? { status: canonical.status } : {})
      }
    });
  }

  /**
   * The clarifying-question side of the same rule. A request the runner is
   * holding open is remembered so a late joiner can still be shown it; its
   * resolution publishes the durable decision — which sets, which option ids,
   * on whose authority, never the person's free text — and, for a human answer,
   * appends the rendered answers to the thread as the user message they are.
   */
  private rememberQuestionRequest(
    session: AgentSession,
    turn: AgentSessionTurn,
    activity: AgentRunnerActivity
  ): void {
    const canonical = activity.canonical;
    if (canonical?.kind !== "question_requested" || !canonical.requestId) return;
    // The pending store normally proved this before the adapter published the
    // id. Keep the re-seed surface safe even if a future adapter violates that
    // boundary: never retain its raw, unbounded model text here.
    if (!isValidQuestionRequestBatch(canonical.questionSets)) return;
    const forSession = this.outstandingQuestions.get(session.id) ?? new Map<string, OutstandingQuestionRequest>();
    forSession.set(canonical.requestId, {
      requestId: canonical.requestId,
      turnId: turn.id,
      questionSets: canonical.questionSets
    });
    this.outstandingQuestions.set(session.id, forSession);
  }

  private takeResolvedQuestion(
    session: AgentSession,
    activity: AgentRunnerActivity
  ): OutstandingQuestionRequest | undefined {
    const canonical = activity.canonical;
    if (canonical?.kind !== "question_resolved") return undefined;

    const forSession = this.outstandingQuestions.get(session.id);
    const request = canonical.requestId ? forSession?.get(canonical.requestId) : undefined;
    if (canonical.requestId) forSession?.delete(canonical.requestId);
    if (forSession?.size === 0) this.outstandingQuestions.delete(session.id);
    return request;
  }

  private publishQuestionResolution(
    session: AgentSession,
    turn: AgentSessionTurn,
    activity: AgentRunnerActivity,
    request: OutstandingQuestionRequest | undefined
  ): void {
    const canonical = activity.canonical;
    if (canonical?.kind !== "question_resolved") return;

    this.deps.eventBus.publish("agent_question_resolved", {
      sessionId: session.id,
      turnId: turn.id,
      workspaceId: session.workspaceId,
      workspacePath: session.workspacePath,
      runnerKind: session.runnerKind,
      audit: {
        ...(canonical.requestId ? { requestId: canonical.requestId } : {}),
        ...(canonical.status ? { status: canonical.status } : {}),
        ...(canonical.decidedBy ? { decidedBy: canonical.decidedBy } : {}),
        ...(canonical.questionAnswers
          ? {
              answers: canonical.questionAnswers.map((answer) => ({
                setId: answer.setId,
                selectedOptionIds: [...answer.selectedOptionIds]
              }))
            }
          : {})
      }
    });

    if (canonical.decidedBy === "human" && request && canonical.questionAnswers) {
      this.deps.messages.append({
        sessionId: session.id,
        turnId: turn.id,
        role: "user",
        content: renderQuestionAnswers(request.questionSets, canonical.questionAnswers),
        context: { questionRequestId: request.requestId },
        status: "sent",
        at: new Date().toISOString()
      });
    }
  }

  /**
   * Settle any batch whose runner terminal path could no longer emit its own
   * resolution (interrupt, child loss, or a malformed adapter ending early).
   * The synthetic canonical resolution precedes the turn's terminal event and
   * removes the reconnect entry before either event is observed.
   */
  cancelOutstandingQuestionRequests(session: AgentSession, turn: AgentSessionTurn): void {
    const requests = [...(this.outstandingQuestions.get(session.id)?.values() ?? [])]
      .filter((request) => request.turnId === turn.id);
    for (const request of requests) {
      const activity: AgentRunnerActivity = {
        kind: "agentroom_question_cancelled",
        title: "Questions cancelled",
        content: { status: "cancelled" },
        canonical: {
          kind: "question_resolved",
          requestId: request.requestId,
          status: "cancelled"
        }
      };
      const resolved = this.takeResolvedQuestion(session, activity);
      this.publishCodingEvent(codingEventFromRunnerActivity({
        sessionId: session.id,
        turnId: turn.id,
        runnerKind: session.runnerKind,
        activity
      }));
      this.publishQuestionResolution(session, turn, activity, resolved);
    }
  }

  /** The batches a session still holds open, for a client joining late. */
  outstandingQuestionRequests(sessionId: string): OutstandingQuestionRequest[] {
    return [...(this.outstandingQuestions.get(sessionId)?.values() ?? [])];
  }

  /** Forget a deleted session's outstanding batches. */
  releaseSession(sessionId: string): void {
    this.outstandingQuestions.delete(sessionId);
  }

  /**
   * Drop a per-turn artifact parser without flushing. Called when a session is
   * deleted, since deletion's early return in apply() bypasses the normal
   * terminal flush path.
   */
  releaseTurn(turnId: string): void {
    this.parsers.delete(turnId);
  }

  private applyAgentUpdate(
    session: AgentSession,
    turn: AgentSessionTurn,
    event: AgentRunnerEvent & { type: "agent_update" }
  ): void {
    if (!this.deps.artifacts) {
      // Artifacts disabled: original passthrough behavior, full delta to transcript.
      this.recordMessage(session, turn, event);
      this.publishAssistantDelta(session, turn, event.message, event.runner);
      return;
    }
    const { prose, ops } = this.parserFor(turn.id).push(event.message);
    // Record token usage from the event and append only prose; the artifact body
    // is republished as coding_artifact_* events and stays out of the transcript.
    // recordMessage skips the transcript append when prose is empty.
    this.recordMessage(session, turn, { ...event, message: prose });
    if (prose) this.publishAssistantDelta(session, turn, prose, event.runner);
    this.applyArtifactOps(session, turn, ops, event.runner);
  }

  private publishAssistantDelta(
    session: AgentSession,
    turn: AgentSessionTurn,
    delta: string,
    runner: RunnerMetadata | undefined
  ): void {
    this.publishCodingEvent(codingAssistantMessageDeltaEvent({
      sessionId: session.id,
      turnId: turn.id,
      runnerKind: session.runnerKind,
      delta,
      runner
    }));
    this.deps.eventBus.publish("agent_turn_update", {
      sessionId: session.id,
      turnId: turn.id,
      message: delta
    });
  }

  private parserFor(turnId: string): ArtifactStreamParser {
    let parser = this.parsers.get(turnId);
    if (!parser) {
      parser = new ArtifactStreamParser(turnId);
      this.parsers.set(turnId, parser);
    }
    return parser;
  }

  private applyArtifactOps(
    session: AgentSession,
    turn: AgentSessionTurn,
    ops: ArtifactStreamOp[],
    runner: RunnerMetadata | undefined
  ): void {
    const store = this.deps.artifacts;
    if (!store || ops.length === 0) return;
    const now = new Date().toISOString();
    for (const op of ops) {
      if (op.type === "start") {
        const artifact = store.start({
          sessionId: session.id,
          turnId: turn.id,
          artifactId: op.artifactId,
          kind: op.kind,
          ...(op.title ? { title: op.title } : {}),
          at: now
        });
        if (!artifact) continue; // per-session artifact cap reached
        this.publishCodingEvent(codingArtifactStartedEvent({
          sessionId: session.id,
          turnId: turn.id,
          runnerKind: session.runnerKind,
          artifactId: op.artifactId,
          kind: op.kind,
          ...(op.title ? { title: op.title } : {}),
          runner
        }));
      } else if (op.type === "delta") {
        const result = store.append({ sessionId: session.id, artifactId: op.artifactId, delta: op.delta, at: now });
        // Skip when the artifact is missing/closed, or nothing fit under the cap:
        // publish only what the store actually retained so the live stream and the
        // reconnect snapshot stay in agreement.
        if (!result || !result.appended) continue;
        this.publishCodingEvent(codingArtifactDeltaEvent({
          sessionId: session.id,
          turnId: turn.id,
          runnerKind: session.runnerKind,
          artifactId: op.artifactId,
          delta: result.appended,
          runner
        }));
      } else {
        const result = store.complete({ sessionId: session.id, artifactId: op.artifactId, at: now });
        if (!result) continue; // never started (e.g. cap-rejected); no orphan completed event
        this.publishCodingEvent(codingArtifactCompletedEvent({
          sessionId: session.id,
          turnId: turn.id,
          runnerKind: session.runnerKind,
          artifactId: op.artifactId,
          bytes: result.byteLength,
          truncated: result.truncated,
          runner
        }));
      }
    }
  }

  private flushStreamingArtifacts(session: AgentSession, turn: AgentSessionTurn): void {
    const parser = this.parsers.get(turn.id);
    if (!parser) return;
    this.parsers.delete(turn.id);
    if (!this.deps.artifacts) return;
    const { prose, ops } = parser.flush();
    if (prose) {
      this.recordMessage(session, turn, { message: prose });
      this.publishAssistantDelta(session, turn, prose, undefined);
    }
    this.applyArtifactOps(session, turn, ops, undefined);
  }

  /**
   * Settle a turn's in-flight artifact when its runner generator throws instead
   * of emitting a terminal event (consumeTurn's catch path). Flushes and releases
   * the per-turn parser so a dangling artifact gets a completed event (clearing
   * the client's streaming spinner) rather than leaking and hanging open.
   */
  finalizeTurn(session: AgentSession, turn: AgentSessionTurn): void {
    if (!this.deps.isSessionLive(session.id)) {
      this.parsers.delete(turn.id);
      return;
    }
    this.flushStreamingArtifacts(session, turn);
  }

  /**
   * Some runners deliver an artifact only in the terminal result message, with no
   * streamed assistant deltas, so no per-turn parser was ever created. Parse that
   * message so the artifact is still published as coding_artifact_* events and
   * kept out of the transcript, mirroring the streaming path. Returns true when it
   * found an artifact and completed the turn here.
   */
  private recoverArtifactsFromTerminalMessage(
    session: AgentSession,
    turn: AgentSessionTurn,
    event: AgentRunnerEvent & { type: "run_succeeded" }
  ): boolean {
    if (!this.deps.artifacts || !event.message || turn.lastMessage) return false;
    const parser = new ArtifactStreamParser(turn.id);
    const head = parser.push(event.message);
    const tail = parser.flush();
    const ops = [...head.ops, ...tail.ops];
    if (ops.length === 0) return false;
    this.applyArtifactOps(session, turn, ops, undefined);
    const prose = head.prose + tail.prose;
    this.deps.succeedTurn(session, turn, prose === event.message ? event : { ...event, message: prose });
    return true;
  }

  private stripArtifactsFromCompletion(
    turn: AgentSessionTurn,
    event: AgentRunnerEvent & { type: "run_succeeded" }
  ): AgentRunnerEvent & { type: "run_succeeded" } {
    // Claude's terminal result carries the full assistant text including artifact
    // markup; strip it so an artifact-only turn does not leak raw source into the
    // transcript via succeedTurn's empty-lastMessage fallback. succeedTurn only
    // consults event.message when turn.lastMessage is empty, so skip the work
    // (a full re-scan of the transcript) whenever prose already streamed.
    if (!this.deps.artifacts || !event.message || turn.lastMessage) return event;
    const stripped = stripArtifactRegions(event.message);
    return stripped === event.message ? event : { ...event, message: stripped };
  }

  private recordMessage(
    session: AgentSession,
    turn: AgentSessionTurn,
    event: { message?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number }
  ): void {
    if (event.message) {
      const content = `${turn.lastMessage ?? ""}${event.message}`;
      turn.lastMessage = content;
      session.lastMessage = content;
      this.deps.messages.upsertAssistantMessage(session.id, turn.id, content, "running");
    }
    this.deps.recordTokenUsage(session, turn, event);
    session.updatedAt = new Date().toISOString();
  }

  private publishCodingEvent(candidate: CodingAgentEventCandidate | undefined): void {
    if (!candidate) return;
    this.deps.eventBus.publish(candidate.type, candidate.payload);
  }
}
