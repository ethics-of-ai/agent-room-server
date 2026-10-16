import { randomUUID } from "node:crypto";
import type { CodingAgentCapabilities, ServiceConfig } from "../../domain/models";
import { logger } from "../../logging/logger";
import {
  AgentRunnerInputError,
  type AgentRunner,
  type AgentRunnerBackgroundListener,
  type BackgroundTaskStopResult,
  type CapabilitiesRequest,
  type AgentRunnerEvent,
  type AgentRunnerInput,
  type AgentRunnerInputPart,
  type CanonicalQuestionAnswer
} from "../AgentRunner";
import { AsyncEventQueue } from "../shared/AsyncEventQueue";
import { delay, withTimeout } from "../shared/asyncUtils";
import { arrayValue, objectValue, stringValue } from "../shared/jsonValues";
import { compactionThresholdFromContextUsage } from "./contextUsage";
import { discoverClaudeCodeCapabilities } from "./discovery";
import {
  runnerMetadataFromMessage,
  completionFromClaudeCodeMessage,
  mapClaudeCodeMessage
} from "./messageMapper";
import {
  loadClaudeCodeMcpServerFactory,
  loadClaudeCodeQuery,
  type ClaudeCodeCanUseTool,
  type ClaudeCodeMcpServerLoader,
  type ClaudeCodeQueryLoader
} from "./sdk";
import { ClaudeSessionTools } from "./agentTools";
import { promptWithRegisteredTools } from "../shared/agentToolSets";
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
import { PendingQuestionRequests, type QuestionAnswerResult } from "../shared/PendingQuestionRequests";
import { runnerDescriptor } from "../registry";
import { ClaudeCodeBackgroundTasks } from "./backgroundTasks";
import type { ClaudeCodeActiveTurn, ClaudeCodeRunnerSession } from "./runnerSession";
import { decideClaudeCodeToolUse } from "./toolDecision";

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
  private readonly loadMcpServer: ClaudeCodeMcpServerLoader;
  // Clarifying-question batches held open for a human answer, keyed by the
  // AgentRoom session. The CLI's `AskUserQuestion` tool reaches `decideToolUse`
  // through the SDK `canUseTool` callback and waits here; the answer route
  // settles it. Released with the turn, the child, and the session.
  private readonly questions: PendingQuestionRequests;
  private capabilitiesCache?: { promise: Promise<CodingAgentCapabilities>; expiresAtMs: number };
  private backgroundListener?: AgentRunnerBackgroundListener;

  constructor(
    private readonly config: ServiceConfig,
    deps: { loadQuery?: ClaudeCodeQueryLoader; loadMcpServer?: ClaudeCodeMcpServerLoader; idleSessionTimeoutMs?: number; questionTimeoutMs?: number } = {}
  ) {
    this.loadQuery = deps.loadQuery ?? loadClaudeCodeQuery;
    this.loadMcpServer = deps.loadMcpServer ?? loadClaudeCodeMcpServerFactory;
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
        session.background.reset();
        session.input.close();
        void Promise.resolve(session.query.return?.(undefined)).catch(() => undefined);
      },
      // Live background tasks die with the child, so they keep it from being reaped.
      isBusy: (session) => session.activeTurn !== undefined || session.background.hasLiveTasks,
      describe: (session) => (session.sdkSessionId ? { sdkSessionId: session.sdkSessionId } : {})
    });
  }

  // Capability discovery spawns a full SDK session; the model list is stable
  // for the process lifetime, so cache it instead of spawning per request.
  // Fallback responses (carrying an error) and a signed-out result are not
  // cached, so the next request sees a repair the operator has since made.
  async getCapabilities(request?: CapabilitiesRequest): Promise<CodingAgentCapabilities> {
    const now = Date.now();
    if (!request?.refresh && this.capabilitiesCache && now < this.capabilitiesCache.expiresAtMs) {
      return this.capabilitiesCache.promise;
    }
    const entry = {
      promise: discoverClaudeCodeCapabilities(this.config, this.loadQuery),
      expiresAtMs: now + CAPABILITIES_CACHE_TTL_MS
    };
    this.capabilitiesCache = entry;
    void entry.promise.then((capabilities) => {
      if ((capabilities.error || capabilities.checks?.some((check) => check.status === "unavailable")) && this.capabilitiesCache === entry) {
        this.capabilitiesCache = undefined;
      }
    });
    return entry.promise;
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
    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      protocol: "agent-sdk",
      promptBytes: Buffer.byteLength(input.prompt, "utf8")
    }, "Claude Code runner turn started");
    const activeTurn = newActiveTurn(input.runId);
    yield* this.streamTurn(activeTurn, input.sessionId, async (bound) => {
      // Turn effort ids are intentionally open at the shared API boundary. The
      // Claude-specific mapper validates its own advertised vocabulary here,
      // before a child is acquired or a prompt is sent.
      const settings = effectiveClaudeCodeSettings(this.config, input.settings);
      const session = await this.getOrCreateSession(input, settings);
      // The service refuses a turn while an agent-started one runs; this is the
      // adapter's own guard against the CLI folding a send into it.
      if (session.activeTurn?.agentStarted) throw new Error("Claude Code is still answering finished background work");
      bound.session = session;
      session.activeTurn = activeTurn;
      session.latestRunId = input.runId;
      this.activeTurns.set(input.runId, { session, turn: activeTurn });

      await this.applyTurnSettings(session, settings);
      const registered = input.tools?.binding.allowedNames.length
        ? await (session.tools?.registeredNames(session.query) ?? new Set<string>())
        : new Set<string>();
      const prompt = promptWithRegisteredTools(input, registered, "claude_code");
      if (input.tools) session.tools?.bindTurn(input.runId, input.tools.binding);
      this.readCompactionThreshold(session, activeTurn);
      pushTurnStarted(session, activeTurn);
      activeTurn.sendUuid = randomUUID();
      session.turnsAwaitingResult.push(activeTurn);
      session.input.push(await claudeCodeUserMessage(prompt, input.inputParts, session.sdkSessionId, activeTurn.sendUuid));
    });
  }

  /**
   * One turn's event stream: the audit bookends around everything the session
   * routes to `activeTurn`, then its terminal event. `start` binds the session
   * and, for a person's turn, sends the prompt.
   */
  private async *streamTurn(
    activeTurn: ClaudeCodeActiveTurn,
    sessionId: string | undefined,
    start: (bound: { session?: ClaudeCodeRunnerSession }) => Promise<void>
  ): AsyncGenerator<AgentRunnerEvent> {
    const startedAtMs = Date.now();
    const timing = createRunnerStreamTiming();
    const command = claudeCodeCommandAudit(this.config);
    const runId = activeTurn.runId;
    const bound: { session?: ClaudeCodeRunnerSession } = {};
    yield { type: "runner_audit", audit: { phase: "started", runnerKind: "claude_code", runId, command } };

    try {
      await start(bound);
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
      this.activeTurns.delete(runId);
      const session = bound.session;
      if (session) {
        session.tools?.releaseTurn(runId);
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
    // A sign-in can lapse mid-session; the next readiness read must ask again.
    if (failed) this.capabilitiesCache = undefined;
    const durationMs = Date.now() - startedAtMs;
    const streamTiming = runnerStreamTimingAudit(timing, startedAtMs);
    logger.info({
      runId,
      sessionId,
      protocol: "agent-sdk",
      status: failed ? "failed" : "succeeded",
      ...(activeTurn.agentStarted ? { agentStarted: true } : {}),
      durationMs,
      ...streamTiming
    }, "Claude Code runner turn completed");
    yield {
      type: "runner_audit",
      audit: {
        phase: "completed",
        runnerKind: "claude_code",
        runId,
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

  watchBackgroundWork(listener: AgentRunnerBackgroundListener): void {
    this.backgroundListener = listener;
  }

  async stopBackgroundTask(input: { sessionId: string; taskId: string }): Promise<BackgroundTaskStopResult> {
    const session = this.sessions.acquire(input.sessionId);
    if (!session?.query.stopTask || !session.background.isLive(input.taskId)) return "unknown_task";
    await session.query.stopTask(input.taskId);
    return "stopped";
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
      ? (toolName, toolInput, options) => decideClaudeCodeToolUse(this.questions, key, () => session, toolName, toolInput, options)
      : undefined;
    const tools = input.tools?.catalog.length ? new ClaudeSessionTools(await this.loadMcpServer(), input.tools.catalog) : undefined;
    const query = queryFunction({
      prompt: sessionInput,
      options: claudeCodeQueryOptions(this.config, input.workspacePath, settings, {
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        ...(canUseTool ? { canUseTool } : {}),
        ...(tools ? { agentTools: { ...tools.queryOptions(), ...(input.tools?.instructions ? { instructions: input.tools.instructions } : {}) } } : {})
      })
    });
    session = {
      key,
      query,
      input: sessionInput,
      model: settings.model,
      effort: settings.effort,
      toolUses: new Map(),
      ...(tools ? { tools } : {}),
      turnsAwaitingResult: [],
      background: new ClaudeCodeBackgroundTasks((tasks) => this.backgroundListener?.tasksChanged({ sessionId: key, tasks }))
    };
    this.sessions.register(session);
    void this.consumeSession(session);
    return session;
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
    const object = objectValue(message);
    if (object) {
      session.sdkSessionId ??= runnerMetadataFromMessage(object).nativeSessionId;
      // Record eagerly rather than at death: the child can die on any path,
      // and the id is what lets the next turn resume the conversation.
      if (session.sdkSessionId) {
        this.sessions.rememberResumableId(session.key, session.sdkSessionId);
      }
    }
    session.background.observe(message);
    const completion = completionFromClaudeCodeMessage(message);
    // The CLI starts a turn of its own when background work finishes. Its
    // `system/init` (or, failing that, its task-notification result) arriving
    // with no turn of ours open is that turn's start.
    const startsOwnTurn = object && (isSystemInit(object) || (completion && isTaskNotificationResult(object)));
    // A turn with its terminal event is closed even while its stream drains.
    const turnOpen = (session.activeTurn && !session.activeTurn.finalEvent) || session.turnsAwaitingResult.some((turn) => !turn.finalEvent);
    if (startsOwnTurn && !turnOpen && !session.refusedAgentTurn) {
      this.openAgentTurn(session);
    }
    // A tool call's owner is the oldest turn still owed a result, never the
    // active turn. With none, the call fails closed: a turn is awaited before
    // its prompt is sent, so none of its own calls can arrive earlier.
    const owner = session.turnsAwaitingResult.find((turn) => !turn.finalEvent);
    if (owner) session.tools?.observe(message, owner.runId);
    const target = completion
      ? this.resolveCompletionOwner(session, completion, object)
      : session.activeTurn;
    if (completion) {
      // A notification that arrives during a person's turn is folded into it.
      // One that arrives during the agent's own turn gets a turn of its own,
      // and an interrupted turn's trailing result answers nothing.
      if (target && !target.agentStarted && !target.finalEvent) session.background.turnEnded();
      session.refusedAgentTurn = false;
    }

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

  /**
   * The agent began a turn of its own. The service decides whether it becomes
   * an AgentRoom turn; a refusal leaves its events unrouted, as before this
   * existed, until its result.
   */
  private openAgentTurn(session: ClaudeCodeRunnerSession): void {
    let started = false;
    this.backgroundListener?.turnStarted({
      sessionId: session.key,
      // No turn of this child is open, so its latest turn has ended.
      ...(session.latestRunId ? { afterRunId: session.latestRunId } : {}),
      finished: session.background.takeFinished(),
      start: (runId) => {
        const turn: ClaudeCodeActiveTurn = { ...newActiveTurn(runId), agentStarted: true };
        started = true;
        session.activeTurn = turn;
        session.latestRunId = runId;
        session.turnsAwaitingResult.push(turn);
        this.activeTurns.set(runId, { session, turn });
        pushTurnStarted(session, turn);
        return this.streamTurn(turn, session.key, async (bound) => {
          bound.session = session;
        });
      }
    });
    if (!started) session.refusedAgentTurn = true;
  }

  // A result that echoes a send's uuid belongs to that send's turn. Without an
  // echo, results route to the oldest turn still owed one. A finalized owner
  // means the trailing result of an interrupted turn — absorb it silently. A
  // success result can never belong to an interrupted turn, so skip finalized
  // entries for it in case the SDK swallowed an interrupt's result entirely.
  private resolveCompletionOwner(
    session: ClaudeCodeRunnerSession,
    completion: AgentRunnerEvent,
    message: Record<string, unknown> | undefined
  ): ClaudeCodeActiveTurn | undefined {
    const awaiting = session.turnsAwaitingResult;
    const echoed = echoedSendUuids(message);
    const echoes = (turn: ClaudeCodeActiveTurn) => turn.sendUuid !== undefined && echoed.has(turn.sendUuid);
    // A merged result can echo an interrupted send as well as the follow-up
    // that replaced it; the turn still open is the one it answers.
    const openIndex = awaiting.findIndex((turn) => echoes(turn) && !turn.finalEvent);
    const echoedIndex = openIndex >= 0 ? openIndex : awaiting.findIndex(echoes);
    if (echoedIndex >= 0) {
      const [owner] = awaiting.splice(echoedIndex, 1);
      // The CLI answers sends in order, so a finalized turn queued ahead of
      // this one will never see a result of its own.
      session.turnsAwaitingResult = awaiting.filter((turn, index) => index >= echoedIndex || !turn.finalEvent);
      return owner;
    }
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
    session.background.reset();
    session.refusedAgentTurn = false;
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

function newActiveTurn(runId: string): ClaudeCodeActiveTurn {
  return { runId, queue: new AsyncEventQueue<AgentRunnerEvent>(), completedByProtocol: false };
}

function pushTurnStarted(session: ClaudeCodeRunnerSession, turn: ClaudeCodeActiveTurn): void {
  const nativeSessionId = session.sdkSessionId;
  turn.queue.push({
    type: "agent_activity",
    activity: {
      kind: "claude_code_turn_started",
      title: "Turn started",
      content: nativeSessionId ? { session_id: nativeSessionId } : {},
      canonical: { kind: "turn_started" },
      runner: nativeSessionId ? { nativeSessionId } : {}
    }
  });
}

function isSystemInit(object: Record<string, unknown>): boolean {
  return stringValue(object.type) === "system" && stringValue(object.subtype) === "init";
}

function isTaskNotificationResult(object: Record<string, unknown>): boolean {
  return stringValue(objectValue(object.origin)?.kind) === "task-notification";
}

/** The send uuids a result says it answered: every member of a merged batch, then the last. */
function echoedSendUuids(message: Record<string, unknown> | undefined): Set<string> {
  const uuids = arrayValue(message?.user_message_uuids).flatMap((value) => stringValue(value) ?? []);
  const last = stringValue(message?.user_message_uuid);
  return new Set(last ? [...uuids, last] : uuids);
}
