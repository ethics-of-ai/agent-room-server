import type { AgentSession, AgentSessionTurn } from "../domain/models";
import type { EventBus } from "../events/EventBus";
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
import type { AgentRunnerActivity, AgentRunnerEvent, RunnerMetadata } from "../runner/AgentRunner";
import { ArtifactStreamParser, stripArtifactRegions, type ArtifactStreamOp } from "../artifact/ArtifactStreamParser";
import type { ArtifactStore } from "../artifact/ArtifactStore";
import type { AgentSessionMessageStore } from "./AgentSessionMessageStore";
import type { AgentTurnTelemetryStore } from "./AgentTurnTelemetryStore";

export class AgentTurnEventApplier {
  // One in-band artifact parser per active turn, lazily created on the first
  // assistant delta and disposed when the turn settles. Only used when an
  // ArtifactStore is configured (i.e. artifacts are enabled).
  private readonly parsers = new Map<string, ArtifactStreamParser>();

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
        }
      ): void;
      succeedTurn(session: AgentSession, turn: AgentSessionTurn, event: AgentRunnerEvent & { type: "run_succeeded" }): void;
      failTurn(session: AgentSession, turn: AgentSessionTurn, error: string): void;
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
        ...(turn.modelContextWindowTokens !== undefined ? { modelContextWindowTokens: turn.modelContextWindowTokens } : {})
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
        modelContextWindowTokens: turn.modelContextWindowTokens
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
        session.runner = runnerMetadata;
        // Legacy per-runner session blocks, projected from the canonical one.
        Object.assign(session, legacySessionMetadata(session.runnerKind, runnerMetadata));
      }
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
