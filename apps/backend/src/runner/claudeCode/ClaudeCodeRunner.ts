import { randomUUID } from "node:crypto";
import type { CodingAgentCapabilities, ServiceConfig } from "../../domain/models";
import { logger } from "../../logging/logger";
import {
  AgentRunnerInputError,
  type AgentRunner,
  type AgentRunnerActivity,
  type AgentRunnerEvent,
  type AgentRunnerInput,
  type AgentRunnerInputPart,
  type CanonicalQuestionAnswer
} from "../AgentRunner";
import { AsyncEventQueue } from "../shared/AsyncEventQueue";
import { delay, withTimeout } from "../shared/asyncUtils";
import { capabilitiesFromSupportedModels, fallbackClaudeCodeCapabilities } from "./capabilities";
import { compactionThresholdFromContextUsage } from "./contextUsage";
import {
  runnerMetadataFromMessage,
  completionFromClaudeCodeMessage,
  mapClaudeCodeMessage,
  type ClaudeCodeToolUseDisplay
} from "./messageMapper";
import {
  loadClaudeCodeQuery,
  type ClaudeCodeCanUseTool,
  type ClaudeCodeQuery,
  type ClaudeCodeQueryLoader
} from "./sdk";
import {
  claudeCodeCommandAudit,
  claudeCodeQueryOptions,
  claudeCodeUserMessage,
  effectiveClaudeCodeSettings,
  type ClaudeCodeEffectiveSettings
} from "./settings";
import {
  createRunnerStreamTiming,
  observeRunnerStreamEvent,
  runnerStreamTimingAudit
} from "../shared/streamTiming";
import { PersistentRunnerSessionHost } from "../shared/PersistentRunnerSessionHost";
import {
  PendingQuestionRequests,
  type QuestionAnswerResult,
  type QuestionWaitOutcome
} from "../shared/PendingQuestionRequests";
import { runnerDescriptor } from "../registry";
import {
  ASK_USER_QUESTION_TOOL,
  HEADLESS_PERMISSION_DENY_MESSAGE,
  askUserQuestionBatch,
  askUserQuestionUpdatedInput
} from "./askUserQuestion";

interface ClaudeCodeActiveTurn {
  runId: string;
  queue: AsyncEventQueue<AgentRunnerEvent>;
  finalEvent?: AgentRunnerEvent;
  completedByProtocol: boolean;
}

interface ClaudeCodeRunnerSession {
  key: string;
  query: ClaudeCodeQuery;
  input: AsyncEventQueue<unknown>;
  sdkSessionId?: string;
  model?: string;
  effort?: string;
  toolUses: Map<string, ClaudeCodeToolUseDisplay>;
  activeTurn?: ClaudeCodeActiveTurn;
  // One SDK `result` message arrives per pushed user message, in order. Turns
  // queue here when their prompt is pushed so completions route to the turn
  // that owns them — an interrupted turn's trailing result must not close the
  // steering follow-up that replaced it as the active turn.
  turnsAwaitingResult: ClaudeCodeActiveTurn[];
}

const CAPABILITIES_CACHE_TTL_MS = 5 * 60_000;

// Idle persistent children are reaped so N open AgentRoom threads do not pin
// N resident claude processes; the recorded SDK session id lets the next turn
// resume the conversation. Matches the terminal service's idle window.
const IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// The same ceiling capability discovery puts on `supportedModels()`: both are
// control round trips to a child that is expected to answer at once.
const CONTEXT_USAGE_TIMEOUT_MS = 5_000;

export class ClaudeCodeRunner implements AgentRunner {
  private readonly activeTurns = new Map<string, { session: ClaudeCodeRunnerSession; turn: ClaudeCodeActiveTurn }>();
  // Persistent per-session SDK sessions (each owning a spawned claude child),
  // their idle reaping, and the SDK session ids that outlive them: a session
  // whose child died, was killed by a slow cancel, or was idle-reaped resumes
  // its conversation (SDK `resume`, which reloads the on-disk transcript)
  // instead of silently starting a fresh thread with no memory.
  private readonly sessions: PersistentRunnerSessionHost<ClaudeCodeRunnerSession>;
  private readonly loadQuery: ClaudeCodeQueryLoader;
  // Clarifying-question batches held open for a human answer, keyed by the
  // AgentRoom session. The CLI's `AskUserQuestion` tool reaches `decideToolUse`
  // through the SDK `canUseTool` callback and waits here; the answer route
  // settles it. Released with the turn, the child, and the session.
  private readonly questions: PendingQuestionRequests;
  private capabilitiesCache?: { promise: Promise<CodingAgentCapabilities>; expiresAtMs: number };

  constructor(
    private readonly config: ServiceConfig,
    deps: { loadQuery?: ClaudeCodeQueryLoader; idleSessionTimeoutMs?: number; questionTimeoutMs?: number } = {}
  ) {
    this.loadQuery = deps.loadQuery ?? loadClaudeCodeQuery;
    this.questions = new PendingQuestionRequests(
      deps.questionTimeoutMs !== undefined ? { timeoutMs: deps.questionTimeoutMs } : {}
    );
    this.sessions = new PersistentRunnerSessionHost({
      runnerKind: "claude_code",
      // The registry owns this: the host arms an idle timer only for a runner it
      // can restore, so the value is a declared capability, not a local constant.
      restoreStrategy: runnerDescriptor("claude_code").restoreStrategy,
      idleSessionTimeoutMs: deps.idleSessionTimeoutMs ?? IDLE_SESSION_TIMEOUT_MS,
      teardown: (session) => {
        this.questions.releaseSession(session.key);
        session.input.close();
        void Promise.resolve(session.query.return?.(undefined)).catch(() => undefined);
      },
      isBusy: (session) => session.activeTurn !== undefined,
      describe: (session) => (session.sdkSessionId ? { sdkSessionId: session.sdkSessionId } : {})
    });
  }

  // Capability discovery spawns a full SDK session; the model list is stable
  // for the process lifetime, so cache it instead of spawning per request.
  // Fallback responses (carrying an error) are not cached so the next request
  // retries live discovery.
  async getCapabilities(): Promise<CodingAgentCapabilities> {
    const now = Date.now();
    if (this.capabilitiesCache && now < this.capabilitiesCache.expiresAtMs) {
      return this.capabilitiesCache.promise;
    }
    const entry = {
      promise: this.discoverCapabilities(),
      expiresAtMs: now + CAPABILITIES_CACHE_TTL_MS
    };
    this.capabilitiesCache = entry;
    void entry.promise.then((capabilities) => {
      if (capabilities.error && this.capabilitiesCache === entry) {
        this.capabilitiesCache = undefined;
      }
    });
    return entry.promise;
  }

  private async discoverCapabilities(): Promise<CodingAgentCapabilities> {
    const fallback = fallbackClaudeCodeCapabilities(this.config);
    let session: { query: ClaudeCodeQuery; input: AsyncEventQueue<unknown> } | undefined;
    try {
      const queryFunction = await this.loadQuery();
      const input = new AsyncEventQueue<unknown>();
      const query = queryFunction({
        prompt: input,
        // Discovery runs in the backend's own cwd, not a registered workspace,
        // so force isolation: never load or execute that directory's project
        // settings (hooks, MCP servers) just to read the model list.
        options: claudeCodeQueryOptions(
          this.config,
          process.cwd(),
          effectiveClaudeCodeSettings(this.config, undefined),
          { forceIsolation: true }
        )
      });
      session = { query, input };
      if (!query.supportedModels) {
        return fallback;
      }
      const models = await withTimeout(
        query.supportedModels(),
        5_000,
        "Timed out reading the Claude Code model list"
      );
      return capabilitiesFromSupportedModels(models, this.config);
    } catch (error) {
      return {
        ...fallback,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (session) {
        session.input.close();
        void Promise.resolve(session.query.return?.(undefined)).catch(() => undefined);
      }
    }
  }

  validateInputParts(inputParts: AgentRunnerInputPart[] | undefined): void {
    if (!inputParts?.length) return;
    // Each image is inlined as a base64 block, which requires an explicit
    // media_type the Claude Agent SDK can forward to the Messages API.
    for (const part of inputParts) {
      if (part.type !== "localImage") continue;
      if (!part.contentType) {
        throw new AgentRunnerInputError("Image attachment is missing a content type");
      }
    }
  }

  async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
    const startedAtMs = Date.now();
    const timing = createRunnerStreamTiming();
    const command = claudeCodeCommandAudit(this.config);
    const activeTurn: ClaudeCodeActiveTurn = {
      runId: input.runId,
      queue: new AsyncEventQueue<AgentRunnerEvent>(),
      completedByProtocol: false
    };
    let session: ClaudeCodeRunnerSession | undefined;

    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      protocol: "agent-sdk",
      promptBytes: Buffer.byteLength(input.prompt, "utf8")
    }, "Claude Code runner turn started");
    yield {
      type: "runner_audit",
      audit: {
        phase: "started",
        runnerKind: "claude_code",
        runId: input.runId,
        command
      }
    };

    try {
      // Turn effort ids are intentionally open at the shared API boundary. The
      // Claude-specific mapper validates its own advertised vocabulary here,
      // before a child is acquired or a prompt is sent.
      const settings = effectiveClaudeCodeSettings(this.config, input.settings);
      session = await this.getOrCreateSession(input, settings);
      session.activeTurn = activeTurn;
      this.activeTurns.set(input.runId, { session, turn: activeTurn });

      await this.applyTurnSettings(session, settings);
      this.readCompactionThreshold(session, activeTurn);
      activeTurn.queue.push({
        type: "agent_activity",
        activity: {
          kind: "claude_code_turn_started",
          title: "Turn started",
          content: {
            ...(session.sdkSessionId ? { session_id: session.sdkSessionId } : {})
          },
          canonical: { kind: "turn_started" },
          runner: {
            ...(session.sdkSessionId ? { nativeSessionId: session.sdkSessionId } : {})
          }
        }
      });
      session.turnsAwaitingResult.push(activeTurn);
      session.input.push(await claudeCodeUserMessage(input.prompt, input.inputParts, session.sdkSessionId));

      for await (const event of activeTurn.queue) {
        observeRunnerStreamEvent(timing, event);
        yield event;
      }
    } catch (error) {
      activeTurn.finalEvent ??= {
        type: "run_failed",
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      this.activeTurns.delete(input.runId);
      if (session) {
        this.sessions.touch(session);
        if (session.activeTurn === activeTurn) {
          session.activeTurn = undefined;
        }
        // A question belongs to the turn that asked it; nothing may stay open
        // for a person once the turn has settled.
        this.questions.releaseSession(session.key);
      }
    }

    const finalEvent = activeTurn.finalEvent;
    const failed = !finalEvent || finalEvent.type === "run_failed";
    const durationMs = Date.now() - startedAtMs;
    const streamTiming = runnerStreamTimingAudit(timing, startedAtMs);
    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      protocol: "agent-sdk",
      status: failed ? "failed" : "succeeded",
      durationMs,
      ...streamTiming
    }, "Claude Code runner turn completed");
    yield {
      type: "runner_audit",
      audit: {
        phase: "completed",
        runnerKind: "claude_code",
        runId: input.runId,
        command,
        status: failed ? "failed" : "succeeded",
        durationMs,
        ...streamTiming
      }
    };
    yield finalEvent ?? { type: "run_failed", error: "Claude Code turn ended without a completion event" };
  }

  async cancel(runId: string): Promise<void> {
    const active = this.activeTurns.get(runId);
    if (!active) return;

    let interrupted = false;
    const interrupt = active.session.query.interrupt()
      .then(() => {
        interrupted = true;
      })
      .catch(() => undefined);
    await Promise.race([interrupt, delay(1_000)]);

    active.turn.completedByProtocol = true;
    active.turn.finalEvent = { type: "run_failed", error: "Claude Code turn interrupted" };
    active.turn.queue.close();
    if (active.session.activeTurn === active.turn) {
      active.session.activeTurn = undefined;
    }
    // The interrupt aborts the callback's signal, which cancels the wait; this
    // covers an SDK that never aborted it.
    this.questions.releaseSession(active.session.key);
    if (!interrupted) {
      this.sessions.destroy(active.session);
    }
    this.activeTurns.delete(runId);
  }

  answerQuestionRequest(input: { sessionId: string; requestId: string; answers: CanonicalQuestionAnswer[] }): QuestionAnswerResult {
    return this.questions.answer(input.sessionId, input.requestId, input.answers);
  }

  // Evict the persistent SDK session (and its spawned claude child process)
  // when the AgentRoom session is deleted; without this every deleted thread
  // pins a live child process until backend shutdown. Deletion also forgets
  // the resumable SDK session id — an explicitly deleted session must never
  // be silently resumed.
  async closeSession(sessionId: string): Promise<void> {
    this.sessions.close(sessionId);
  }

  // An SDK session id hydrated from the durable session store: the next turn's
  // acquire miss passes it as `resume` exactly as after a reap.
  rememberResumableId(input: { sessionId: string; nativeSessionId: string }): void {
    this.sessions.rememberResumableId(input.sessionId, input.nativeSessionId);
  }

  async dispose(): Promise<void> {
    this.questions.releaseAll();
    this.sessions.disposeAll();
    this.activeTurns.clear();
  }

  private async getOrCreateSession(
    input: AgentRunnerInput,
    settings: ClaudeCodeEffectiveSettings
  ): Promise<ClaudeCodeRunnerSession> {
    const key = input.sessionId ?? input.runId;
    const existing = this.sessions.acquire(key);
    if (existing) return existing;

    const queryFunction = await this.loadQuery();
    const sessionInput = new AsyncEventQueue<unknown>();
    // A recorded SDK session id means the previous child for this AgentRoom
    // session is gone (died, killed by cancel, or idle-reaped); resume it so
    // the conversation continues instead of silently restarting. The rest of
    // the options — including the settings-isolation posture — are rebuilt
    // exactly as for a fresh session.
    const resumeSessionId = this.sessions.resumableId(key);
    // The callback closes over the session record assigned just below, before
    // the first prompt is pushed, so it can never run with it unset. It is
    // supplied only while the clarifying-question channel is enabled: without
    // it the SDK passes no permission-prompt tool and the CLI behaves exactly
    // as it did before the channel existed.
    let session: ClaudeCodeRunnerSession | undefined;
    const canUseTool: ClaudeCodeCanUseTool | undefined = this.config.clarifyingQuestionsEnabled !== false
      ? (toolName, toolInput, options) => this.decideToolUse(key, () => session, toolName, toolInput, options)
      : undefined;
    const query = queryFunction({
      prompt: sessionInput,
      options: claudeCodeQueryOptions(this.config, input.workspacePath, settings, {
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(canUseTool ? { canUseTool } : {})
      })
    });
    session = {
      key,
      query,
      input: sessionInput,
      model: settings.model,
      effort: settings.effort,
      toolUses: new Map(),
      turnsAwaitingResult: []
    };
    this.sessions.register(session);
    void this.consumeSession(session);
    return session;
  }

  /**
   * The SDK `canUseTool` callback for one AgentRoom session.
   *
   * `AskUserQuestion` is the one tool it holds open: the questions become a
   * canonical batch announced on the turn's event stream, the wait sits in the
   * shared store until the answer route settles it (or the clock, or the
   * turn's own interrupt through `signal`), and the answers go back as the
   * tool's `updatedInput`. Every other tool is refused with the CLI's own
   * headless wording — under `bypassPermissions` none reaches here, and under a
   * stricter mode they were refused headless before this callback existed —
   * so supplying it changes nothing about what an agent may do.
   */
  private async decideToolUse(
    sessionKey: string,
    getSession: () => ClaudeCodeRunnerSession | undefined,
    toolName: string,
    toolInput: Record<string, unknown>,
    options: { signal?: AbortSignal; toolUseID?: string }
  ): ReturnType<ClaudeCodeCanUseTool> {
    if (toolName !== ASK_USER_QUESTION_TOOL) {
      return { behavior: "deny", message: HEADLESS_PERMISSION_DENY_MESSAGE };
    }
    const batch = askUserQuestionBatch(toolInput);
    if ("error" in batch) return { behavior: "deny", message: batch.error };

    const session = getSession();
    const turn = session?.activeTurn;
    const requestId = `question-${randomUUID()}`;
    const wait = turn && !turn.finalEvent
      ? this.questions.wait({ sessionKey, requestId, sets: batch.sets })
      : undefined;
    const runner = {
      ...(session?.sdkSessionId ? { nativeSessionId: session.sdkSessionId } : {}),
      ...(options.toolUseID ? { nativeItemId: options.toolUseID } : {})
    };
    const pushActivity = (activity: AgentRunnerActivity): void => {
      const target = getSession()?.activeTurn;
      if (target && !target.finalEvent) target.queue.push({ type: "agent_activity", activity });
    };
    pushActivity({
      kind: "claude_code_question_requested",
      title: "Questions for you",
      content: { questionCount: batch.sets.length, ...(options.toolUseID ? { toolUseId: options.toolUseID } : {}) },
      canonical: { kind: "question_requested", ...(wait ? { requestId } : {}), questionSets: batch.sets },
      runner
    });
    if (!wait) {
      pushActivity({
        kind: "claude_code_question_resolved",
        title: "Questions not presented",
        content: { status: "cancelled" },
        canonical: { kind: "question_resolved", status: "cancelled" },
        runner
      });
      return { behavior: "allow", updatedInput: askUserQuestionUpdatedInput(toolInput, batch, { status: "unavailable" }) };
    }

    const abort = (): void => {
      this.questions.cancel(sessionKey, requestId);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let outcome: QuestionWaitOutcome;
    try {
      outcome = await wait;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    pushActivity({
      kind: "claude_code_question_resolved",
      title: outcome.status === "answered" ? "Questions answered" : outcome.status === "timeout" ? "Questions timed out" : "Questions cancelled",
      content: { status: outcome.status, ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}) },
      canonical: {
        kind: "question_resolved",
        requestId,
        status: outcome.status,
        ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
        ...(outcome.status === "answered" ? { questionAnswers: outcome.answers } : {})
      },
      runner
    });
    if (outcome.status === "cancelled") {
      return { behavior: "deny", message: "Turn cancelled" };
    }
    return { behavior: "allow", updatedInput: askUserQuestionUpdatedInput(toolInput, batch, outcome) };
  }

  private async consumeSession(session: ClaudeCodeRunnerSession): Promise<void> {
    try {
      for await (const message of session.query) {
        this.handleSessionMessage(session, message);
      }
      this.endSession(session, "Claude Code session ended unexpectedly");
    } catch (error) {
      this.endSession(session, error instanceof Error ? error.message : String(error));
    }
  }

  private handleSessionMessage(session: ClaudeCodeRunnerSession, message: unknown): void {
    this.sessions.touch(session);
    if (message && typeof message === "object") {
      session.sdkSessionId ??= runnerMetadataFromMessage(message as Record<string, unknown>).nativeSessionId;
      // Record eagerly rather than at death: the child can die on any path,
      // and the id is what lets the next turn resume the conversation.
      if (session.sdkSessionId) {
        this.sessions.rememberResumableId(session.key, session.sdkSessionId);
      }
    }
    const completion = completionFromClaudeCodeMessage(message);
    const target = completion
      ? this.resolveCompletionOwner(session, completion)
      : session.activeTurn;

    if (target && !target.finalEvent) {
      for (const event of mapClaudeCodeMessage(message, session.toolUses)) {
        target.queue.push(event);
      }
    }

    if (completion && target && !target.finalEvent) {
      target.completedByProtocol = true;
      target.finalEvent = completion;
      target.queue.close();
    }
  }

  // Results route to the oldest turn still owed one. A finalized owner means
  // the trailing result of an interrupted turn — absorb it silently. A
  // success result can never belong to an interrupted turn, so skip finalized
  // entries for it in case the SDK swallowed an interrupt's result entirely.
  private resolveCompletionOwner(
    session: ClaudeCodeRunnerSession,
    completion: AgentRunnerEvent
  ): ClaudeCodeActiveTurn | undefined {
    const awaiting = session.turnsAwaitingResult;
    if (completion.type === "run_succeeded") {
      while (awaiting.length > 0) {
        const turn = awaiting.shift()!;
        if (!turn.finalEvent) return turn;
      }
      const active = session.activeTurn;
      return active && !active.finalEvent ? active : undefined;
    }
    return awaiting.shift() ?? session.activeTurn;
  }

  private endSession(session: ClaudeCodeRunnerSession, error: string): void {
    // The SDK stream has already ended, so the entry and its idle timer are all
    // that need clearing — there is nothing left to tear down.
    this.questions.releaseSession(session.key);
    this.sessions.release(session);
    const openTurns = new Set(session.turnsAwaitingResult);
    if (session.activeTurn) openTurns.add(session.activeTurn);
    session.activeTurn = undefined;
    session.turnsAwaitingResult.length = 0;
    for (const turn of openTurns) {
      if (turn.completedByProtocol) continue;
      turn.completedByProtocol = true;
      turn.finalEvent = { type: "run_failed", error };
      turn.queue.close();
    }
  }

  /**
   * Report where this child's auto-compaction fires, on the turn it describes.
   *
   * Started at turn start rather than at settlement because
   * `handleSessionMessage` closes the turn's queue synchronously on the
   * `result` message: anything the runner learns after that has no open turn
   * to ride, and holding the queue open would cost every settlement a control
   * round trip. Turn start is also the stronger proof that the child is alive,
   * since the prompt is about to go to it, and `applyTurnSettings` has already
   * run, so the model this turn will use is final.
   *
   * Nothing is spawned, resumed, or awaited for it. The prompt never waits on
   * a display value, and a failed, timed-out, or unsupported read is silent:
   * no threshold, no surfaced error, and the badge renders exactly as it does
   * today.
   */
  private readCompactionThreshold(session: ClaudeCodeRunnerSession, turn: ClaudeCodeActiveTurn): void {
    const getContextUsage = session.query.getContextUsage;
    if (!getContextUsage) return;
    void withTimeout(
      Promise.resolve(getContextUsage.call(session.query)),
      CONTEXT_USAGE_TIMEOUT_MS,
      "Timed out reading the Claude Code context usage"
    ).then((usage) => {
      const contextCompactionThresholdTokens = compactionThresholdFromContextUsage(usage);
      // A settled turn has closed its queue; the next turn takes its own read.
      if (contextCompactionThresholdTokens === undefined || turn.finalEvent) return;
      turn.queue.push({
        type: "token_usage_updated",
        ...(session.sdkSessionId ? { runner: { nativeSessionId: session.sdkSessionId } } : {}),
        contextCompactionThresholdTokens
      });
    }).catch(() => undefined);
  }

  private async applyTurnSettings(session: ClaudeCodeRunnerSession, settings: ClaudeCodeEffectiveSettings): Promise<void> {
    if (settings.model && settings.model !== session.model && session.query.setModel) {
      await session.query.setModel(settings.model);
      session.model = settings.model;
    }
    if (settings.effort && settings.effort !== session.effort && session.query.applyFlagSettings) {
      await session.query.applyFlagSettings({ effortLevel: settings.effort });
      session.effort = settings.effort;
    }
  }
}
