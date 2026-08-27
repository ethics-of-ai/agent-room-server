import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";
import type { CodingAgentCapabilities, ServiceConfig } from "../../domain/models";
import { logger } from "../../logging/logger";
import { redactSecrets } from "../../util/redactSecrets";
import type {
  AgentRunner,
  AgentRunnerActivity,
  AgentRunnerEvent,
  AgentRunnerInput,
  AgentRunnerInputPart,
  CanonicalQuestionAnswer,
  RunnerMetadata
} from "../AgentRunner";
import { AsyncEventQueue } from "../shared/AsyncEventQueue";
import { withTimeout } from "../shared/asyncUtils";
import {
  JsonRpcLineClient,
  JsonRpcMethodNotFoundError,
  type JsonRpcNotification,
  type JsonRpcRequest
} from "../shared/JsonRpcLineClient";
import { PersistentRunnerSessionHost } from "../shared/PersistentRunnerSessionHost";
import {
  PendingQuestionRequests,
  type QuestionAnswerResult,
  type QuestionWaitOutcome
} from "../shared/PendingQuestionRequests";
import {
  createRunnerStreamTiming,
  observeRunnerStreamEvent,
  runnerStreamTimingAudit
} from "../shared/streamTiming";
import { runnerDescriptor } from "../registry";
import {
  cursorCapabilities,
  cursorCatalogFromModels,
  fallbackCursorCapabilities,
  fallbackCursorCatalog,
  type CursorModelCatalog
} from "./capabilities";
import {
  createCursorTurnState,
  mapCursorDelta,
  mapCursorMessage,
  type CursorTurnState
} from "./messageMapper";
import {
  cursorQuestionBatch,
  cursorQuestionToolResult,
  type CursorQuestionBatch
} from "./questions";
import {
  agentStartResultSchema,
  agentSendResultSchema,
  HOST_QUESTION_METHOD,
  initializeResultSchema,
  modelsListResultSchema,
  questionAskParamsSchema,
  runMessageNotificationSchema,
  runResultNotificationSchema,
  runDeltaNotificationSchema
} from "./protocol";
import {
  CURSOR_HOST_ENTRY,
  cursorAgentStartPosture,
  cursorCommandAudit,
  cursorHostEnv,
  cursorModelSelection,
  cursorPosture,
  cursorSendImages,
  effectiveCursorSettings,
  type CursorEffectiveSettings
} from "./settings";

interface CursorActiveTurn {
  runId: string;
  cursorRunId?: string;
  sendAttempted: boolean;
  queue: AsyncEventQueue<AgentRunnerEvent>;
  finalEvent?: AgentRunnerEvent;
  completed: boolean;
  state: CursorTurnState;
  base: RunnerMetadata;
  pendingQuestionRequestId?: string;
  /** Resolved when the turn settles, so the cancel ladder can wait on it. */
  onSettled?: () => void;
}

interface CursorRunnerSession {
  key: string;
  client: JsonRpcLineClient;
  child: ChildProcessWithoutNullStreams;
  stderrTail: () => string | undefined;
  agentId?: string;
  base: RunnerMetadata;
  activeTurn?: CursorActiveTurn;
  sessionStartedEmitted: boolean;
  explicitlyClosed: boolean;
}

const CLIENT_LABEL = "Cursor SDK host";

const INITIALIZE_TIMEOUT_MS = 30_000;
const AGENT_START_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 30_000;
const MODELS_LIST_TIMEOUT_MS = 15_000;
const RUN_CANCEL_TIMEOUT_MS = 5_000;
// How long a cancel waits for the host's `run/result: cancelled` before it kills
// the child. Past this rung the session is still restorable through resume.
const CANCEL_SETTLE_MS = 3_000;
const SIGKILL_GRACE_MS = 2_000;

const IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CAPABILITIES_CACHE_TTL_MS = 5 * 60_000;
const STDERR_TAIL_LIMIT_CHARS = 2_048;

/**
 * Cursor, driven through `@cursor/sdk` inside a host child the backend spawns
 * (docs/engineering/CURSOR_SDK_RUNNER.md).
 *
 * The SDK runs its agent loop inline in whatever process imports it, so the
 * adapter never imports it: it spawns `host.ts` with a scrubbed environment and
 * speaks newline-delimited JSON-RPC to it over the shared `JsonRpcLineClient`.
 * That keeps the `AUTH_TOKEN` scrub literal (the SDK's shell tool inherits the
 * host's environment verbatim), and it keeps `PersistentRunnerSessionHost`,
 * `commandAudit`, `streamTiming`, and the cancel ladder unchanged — the host is
 * a child like Codex's and DeepSeek's.
 *
 * Three properties shape the adapter:
 *
 * - **Questions are a real callback.** The host registers one custom tool whose
 *   `execute` sends `question/ask` to the backend; the adapter's `onRequest`
 *   handler opens the shared question wait and answers with the person's own
 *   words. No parser, no grammar the model can get wrong.
 * - **There is no permission channel.** The SDK exposes no approval callback, so
 *   the runner implements no `answerPermissionRequest` and the permissions
 *   route's `404` reads the absence of a channel rather than the runner's name.
 * - **Resume is native.** `Agent.resume(agentId)` continues a persisted agent
 *   from a fresh host when the store is pinned under `STATE_DIR` (fact 1), so a
 *   reaped or crashed child restores the conversation on the next turn.
 */
export class CursorSdkRunner implements AgentRunner {
  private readonly activeTurns = new Map<string, { session: CursorRunnerSession; turn: CursorActiveTurn }>();
  private readonly sessions: PersistentRunnerSessionHost<CursorRunnerSession>;
  private readonly questions: PendingQuestionRequests;
  private readonly hostModulePath: string;
  private readonly usesDefaultHost: boolean;
  private readonly initializeTimeoutMs: number;
  /** Sessions whose persisted agent may still record an active run after a killed host. */
  private readonly forceNextSends = new Set<string>();
  private capabilitiesCache?: { promise: Promise<CodingAgentCapabilities>; expiresAtMs: number };
  /**
   * The model catalog a turn's effort and speed are mapped against. Starts as
   * the static fallback and is replaced by every successful `models/list`,
   * whether from the capability probe or from a session's own host at start.
   * It has no TTL of its own: the parameter names a model declares change with
   * the catalog, not with time, and a stale name costs one refused turn rather
   * than a wrong posture. The capability *response* keeps its five-minute cache
   * so a client's picker still refreshes.
   */
  private catalog: CursorModelCatalog = fallbackCursorCatalog;

  constructor(
    private readonly config: ServiceConfig,
    deps: {
      idleSessionTimeoutMs?: number;
      initializeTimeoutMs?: number;
      questionTimeoutMs?: number;
      /** A fake host module for tests; defaults to the compiled `host.js` beside this file. */
      hostModulePath?: string;
    } = {}
  ) {
    this.initializeTimeoutMs = deps.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
    this.usesDefaultHost = deps.hostModulePath === undefined;
    this.hostModulePath = deps.hostModulePath ?? resolve(__dirname, `host${extname(__filename)}`);
    this.questions = new PendingQuestionRequests(
      deps.questionTimeoutMs !== undefined ? { timeoutMs: deps.questionTimeoutMs } : {}
    );
    this.sessions = new PersistentRunnerSessionHost({
      runnerKind: "cursor",
      // The registry owns this: the host arms an idle timer only for a runner it
      // can restore, so the value is a declared capability, not a local constant.
      restoreStrategy: runnerDescriptor("cursor").restoreStrategy,
      idleSessionTimeoutMs: deps.idleSessionTimeoutMs ?? IDLE_SESSION_TIMEOUT_MS,
      teardown: (session) => {
        this.questions.releaseSession(session.key);
        session.client.dispose();
        this.killChild(session.child);
      },
      isBusy: (session) => session.activeTurn !== undefined,
      isReusable: (session) => session.child.exitCode === null && !session.child.killed,
      describe: (session) => (session.agentId ? { agentId: session.agentId } : {})
    });
  }

  /**
   * Discovery spawns a throwaway host, initializes it, reads the live model
   * list, and shuts it down — the read is the runtime-readiness probe. A
   * successful result is cached per process; one carrying an error is not, so
   * the next request retries a runner the operator has since signed into.
   */
  async getCapabilities(): Promise<CodingAgentCapabilities> {
    const now = Date.now();
    if (this.capabilitiesCache && now < this.capabilitiesCache.expiresAtMs) {
      return this.capabilitiesCache.promise;
    }
    const entry = { promise: this.probeCapabilities(), expiresAtMs: now + CAPABILITIES_CACHE_TTL_MS };
    this.capabilitiesCache = entry;
    void entry.promise.then((capabilities) => {
      if (capabilities.error && this.capabilitiesCache === entry) this.capabilitiesCache = undefined;
    });
    return entry.promise;
  }

  private async probeCapabilities(): Promise<CodingAgentCapabilities> {
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: JsonRpcLineClient | undefined;
    let stderrTail: () => string | undefined = () => undefined;
    try {
      // The probe runs in the backend's own cwd and never opens the store: it
      // proves the host starts, signs in, and answers `models/list`, nothing more.
      const spawned = this.spawnHost(process.cwd());
      child = spawned.child;
      client = spawned.client;
      stderrTail = spawned.stderrTail;
      const initializeResponse = await withTimeout(
        client.request("initialize", this.initializeParams()),
        this.initializeTimeoutMs,
        "Timed out initializing the Cursor SDK host"
      );
      initializeResultSchema.parse(initializeResponse);
      const response = await withTimeout(
        client.request("models/list", {}),
        MODELS_LIST_TIMEOUT_MS,
        "Timed out reading the Cursor model list"
      );
      const parsed = modelsListResultSchema.safeParse(response);
      const catalog = parsed.success ? cursorCatalogFromModels(parsed.data.models) : undefined;
      if (!catalog) {
        return fallbackCursorCapabilities(
          this.config,
          appendStderrTail("The Cursor SDK host returned an unrecognized model list", stderrTail())
        );
      }
      this.catalog = catalog;
      return cursorCapabilities(catalog, this.config);
    } catch (error) {
      return fallbackCursorCapabilities(
        this.config,
        appendStderrTail(error instanceof Error ? error.message : String(error), stderrTail())
      );
    } finally {
      if (child && client) {
        try {
          await withTimeout(client.request("shutdown", {}), 2_000, "shutdown");
        } catch {
          // The child is torn down below regardless; shutdown is best-effort.
        }
      }
      client?.dispose();
      if (child) this.killChild(child);
    }
  }

  /** Images ride the SDK's own `send` contract, so nothing is pre-refused. */
  validateInputParts(_inputParts: AgentRunnerInputPart[] | undefined): void {
    return;
  }

  async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
    const startedAtMs = Date.now();
    const timing = createRunnerStreamTiming();
    const command = cursorCommandAudit();
    const activeTurn: CursorActiveTurn = {
      runId: input.runId,
      queue: new AsyncEventQueue<AgentRunnerEvent>(),
      completed: false,
      sendAttempted: false,
      state: createCursorTurnState(),
      base: {}
    };
    let session: CursorRunnerSession | undefined;

    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      inputPartCount: input.inputParts?.length ?? 0,
      promptBytes: Buffer.byteLength(input.prompt, "utf8")
    }, "Cursor SDK runner turn started");
    yield { type: "runner_audit", audit: { phase: "started", runnerKind: "cursor", runId: input.runId, command } };

    try {
      const settings = effectiveCursorSettings(this.config, input.settings, this.catalog);
      session = await this.getOrCreateSession(input, activeTurn, settings);
      this.activeTurns.set(input.runId, { session, turn: activeTurn });
      // Against the catalog the session learned at start, so a turn's effort or
      // speed rides the parameter name this model actually declares. A value
      // the model does not offer is refused here, before anything is sent.
      const model = cursorModelSelection(this.catalog, settings);
      session.base = { ...session.base, model: model.id };
      activeTurn.base = session.base;

      const images = await cursorSendImages(input.inputParts);
      const force = this.forceNextSends.has(session.key);
      activeTurn.sendAttempted = true;
      const sendResponse = await withTimeout(
        session.client.request("agent/send", {
          text: input.prompt,
          ...(images.length > 0 ? { images } : {}),
          model,
          ...(force ? { force: true } : {})
        }),
        SEND_TIMEOUT_MS,
        "Timed out sending a Cursor turn"
      );
      const sendResult = agentSendResultSchema.parse(sendResponse);
      if (force) this.forceNextSends.delete(session.key);
      activeTurn.cursorRunId = sendResult.runId;
      activeTurn.queue.push(this.turnStartedEvent(session, sendResult.runId));

      for await (const event of activeTurn.queue) {
        observeRunnerStreamEvent(timing, event);
        yield event;
      }
    } catch (error) {
      activeTurn.finalEvent ??= {
        type: "run_failed",
        error: redactSecrets(error instanceof Error ? error.message : String(error))
      };
    } finally {
      this.activeTurns.delete(input.runId);
      if (session) {
        this.sessions.touch(session);
        if (session.activeTurn === activeTurn) session.activeTurn = undefined;
        // A question belongs to the turn that asked it; nothing stays open once
        // the turn has settled.
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
      status: failed ? "failed" : "succeeded",
      durationMs,
      ...streamTiming
    }, "Cursor SDK runner turn completed");
    yield {
      type: "runner_audit",
      audit: {
        phase: "completed",
        runnerKind: "cursor",
        runId: input.runId,
        command,
        status: failed ? "failed" : "succeeded",
        durationMs,
        ...streamTiming
      }
    };
    yield finalEvent ?? { type: "run_failed", error: "The Cursor SDK host ended the turn without recording an outcome" };
  }

  /**
   * Cancellation is a ladder: `run/cancel` (the SDK's `run.cancel()`), a bounded
   * wait for the host's `run/result: cancelled`, then a kill. Past the first
   * rung the conversation is still restorable through `Agent.resume`.
   */
  async cancel(runId: string): Promise<void> {
    const active = this.activeTurns.get(runId);
    if (!active) return;
    const { session, turn } = active;
    this.cancelPendingQuestion(session, turn);

    const settled = new Promise<void>((resolveSettled) => {
      turn.onSettled = resolveSettled;
    });
    if (turn.cursorRunId) {
      try {
        await withTimeout(
          session.client.request("run/cancel", { runId: turn.cursorRunId }),
          RUN_CANCEL_TIMEOUT_MS,
          "Timed out cancelling a Cursor run"
        );
      } catch {
        // The kill below is the next rung; a host that will not answer cancel is
        // exactly what it is for.
      }
    }

    const didSettle = await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), CANCEL_SETTLE_MS).unref?.())
    ]);
    if (!didSettle) {
      this.settle(session, turn, { type: "run_failed", error: "Cursor turn interrupted" });
      // Teardown kills the child; the kept agentId restores the conversation on
      // the next turn.
      if (turn.sendAttempted) this.forceNextSends.add(session.key);
      this.sessions.destroy(session);
    }
    this.activeTurns.delete(runId);
  }

  answerQuestionRequest(input: {
    sessionId: string;
    requestId: string;
    answers: CanonicalQuestionAnswer[];
  }): QuestionAnswerResult {
    return this.questions.answer(input.sessionId, input.requestId, input.answers);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.forceNextSends.delete(sessionId);
    const session = this.sessions.acquire(sessionId);
    if (session) session.explicitlyClosed = true;
    this.sessions.close(sessionId);
  }

  // An agent id hydrated from the durable session store: the next turn's
  // acquire miss starts a fresh host with it, exactly as after a reap. A turn
  // that was running when the backend ended may have left the SDK's persisted
  // run active, which is the same state a host crash mid-send leaves, so it
  // gets the same `force` on the first send.
  rememberResumableId(input: { sessionId: string; nativeSessionId: string; interrupted: boolean }): void {
    this.sessions.rememberResumableId(input.sessionId, input.nativeSessionId);
    if (input.interrupted) this.forceNextSends.add(input.sessionId);
  }

  async dispose(): Promise<void> {
    this.questions.releaseAll();
    this.sessions.disposeAll();
    this.activeTurns.clear();
    this.forceNextSends.clear();
  }

  private async getOrCreateSession(
    input: AgentRunnerInput,
    activeTurn: CursorActiveTurn,
    settings: CursorEffectiveSettings
  ): Promise<CursorRunnerSession> {
    const key = input.sessionId ?? input.runId;
    const existing = this.sessions.acquire(key);
    if (existing) {
      existing.activeTurn = activeTurn;
      return existing;
    }

    const { child, client, stderrTail } = this.spawnHost(input.workspacePath);
    const session: CursorRunnerSession = {
      key,
      client,
      child,
      stderrTail,
      base: {},
      activeTurn,
      sessionStartedEmitted: false,
      explicitlyClosed: false
    };

    client.onNotification((notification) => this.handleNotification(session, notification));
    client.onRequest((request) => this.handleHostRequest(session, request));
    child.on("close", () => this.handleChildGone(session, "The Cursor SDK host exited", stderrTail));
    child.on("error", (error) => this.handleChildGone(session, error.message, stderrTail));

    this.sessions.register(session);

    try {
      const initializeResponse = await withTimeout(
        client.request("initialize", this.initializeParams()),
        this.initializeTimeoutMs,
        "Timed out initializing the Cursor SDK host"
      );
      initializeResultSchema.parse(initializeResponse);
      // The session's own host answers `models/list` once, so the parameter
      // mapping below runs against the live catalog without a throwaway probe.
      await this.refreshCatalog(client);
      const model = cursorModelSelection(this.catalog, settings);
      const resumeAgentId = this.sessions.resumableId(key);
      const startResponse = await withTimeout(
        client.request("agent/start", {
          cwd: input.workspacePath,
          ...(resumeAgentId ? { agentId: resumeAgentId } : {}),
          ...cursorAgentStartPosture(this.config, settings, model)
        }),
        AGENT_START_TIMEOUT_MS,
        "Timed out starting the Cursor agent"
      );
      const start = agentStartResultSchema.parse(startResponse);
      session.agentId = start.agentId;
      this.sessions.rememberResumableId(key, start.agentId);
      session.base = {
        nativeSessionId: start.agentId,
        model: settings.modelId,
        cwd: input.workspacePath,
        posture: cursorPosture(settings)
      };
    } catch (error) {
      // Registration precedes the handshake so child close/error is handled
      // uniformly; every unsuccessful handshake must undo it.
      this.sessions.destroy(session);
      throw error;
    }

    if (!session.sessionStartedEmitted) {
      session.sessionStartedEmitted = true;
      activeTurn.queue.push({
        type: "agent_activity",
        activity: {
          kind: "cursor_session_started",
          title: "Session started",
          content: { agentId: session.agentId },
          canonical: { kind: "session_started" },
          runner: session.base
        }
      });
    }
    return session;
  }

  private handleNotification(session: CursorRunnerSession, notification: JsonRpcNotification): void {
    const turn = session.activeTurn;
    if (!turn) return;

    if (notification.method === "run/message") {
      const parsed = runMessageNotificationSchema.safeParse(notification.params);
      if (!parsed.success) return;
      for (const event of mapCursorMessage(parsed.data.message, { runId: parsed.data.runId, base: session.base, state: turn.state })) {
        turn.queue.push(event);
      }
      return;
    }
    if (notification.method === "run/delta") {
      const parsed = runDeltaNotificationSchema.safeParse(notification.params);
      if (!parsed.success) return;
      for (const event of mapCursorDelta(parsed.data.update, { base: session.base })) {
        turn.queue.push(event);
      }
      return;
    }
    if (notification.method === "run/result") {
      const parsed = runResultNotificationSchema.safeParse(notification.params);
      if (!parsed.success) return;
      this.settleFromResult(session, turn, parsed.data);
    }
  }

  private settleFromResult(
    session: CursorRunnerSession,
    turn: CursorActiveTurn,
    result: { status: "finished" | "error" | "cancelled"; result?: string; error?: { message: string }; usage?: Record<string, number | undefined> }
  ): void {
    if (turn.completed) return;
    if (result.usage) {
      turn.queue.push({
        type: "token_usage_updated",
        runner: turn.base,
        ...(result.usage.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
        ...(result.usage.cacheReadTokens !== undefined ? { cachedInputTokens: result.usage.cacheReadTokens } : {}),
        ...(result.usage.outputTokens !== undefined ? { outputTokens: result.usage.outputTokens } : {}),
        ...(result.usage.reasoningTokens !== undefined ? { reasoningOutputTokens: result.usage.reasoningTokens } : {}),
        ...(result.usage.totalTokens !== undefined ? { totalTokens: result.usage.totalTokens } : {})
      });
    }
    if (result.status === "finished") {
      this.settle(session, turn, { type: "run_succeeded", ...(result.result ? { message: result.result } : {}) });
      return;
    }
    if (result.status === "cancelled") {
      this.settle(session, turn, { type: "run_failed", error: "Cursor turn interrupted" });
      return;
    }
    this.settle(session, turn, {
      type: "run_failed",
      error: appendStderrTail(
        redactSecrets(result.error?.message ?? "The Cursor turn failed"),
        session.stderrTail()
      )
    });
  }

  /** Serve the host's one request: the clarifying-question custom tool's callback. */
  private async handleHostRequest(session: CursorRunnerSession, request: JsonRpcRequest): Promise<{ result: string }> {
    if (request.method !== HOST_QUESTION_METHOD) {
      // The shared client refuses an unknown method with -32601 when the handler
      // throws; do the same by name so a future host method is not silently
      // answered.
      throw new JsonRpcMethodNotFoundError(request.method);
    }
    const params = questionAskParamsSchema.parse(request.params);
    const batch = cursorQuestionBatch(params.input);
    if ("error" in batch) return { result: batch.error };

    const turn = session.activeTurn;
    const requestId = `question-${randomUUID()}`;
    const wait = turn && !turn.finalEvent
      ? this.questions.wait({ sessionKey: session.key, requestId, sets: batch.sets })
      : undefined;
    this.pushQuestionRequested(session, turn, batch, wait ? requestId : undefined);
    if (!wait || !turn) {
      this.pushQuestionResolved(session, turn, batch, requestId, { status: "cancelled" }, false);
      return { result: cursorQuestionToolResult(batch, { status: "unavailable" }) };
    }

    turn.pendingQuestionRequestId = requestId;
    const outcome = await wait;
    if (turn.pendingQuestionRequestId === requestId) turn.pendingQuestionRequestId = undefined;
    this.pushQuestionResolved(session, turn, batch, requestId, outcome, true);
    return { result: cursorQuestionToolResult(batch, outcome) };
  }

  private pushQuestionRequested(
    session: CursorRunnerSession,
    turn: CursorActiveTurn | undefined,
    batch: CursorQuestionBatch,
    requestId: string | undefined
  ): void {
    const target = turn ?? session.activeTurn;
    if (!target || target.finalEvent) return;
    target.queue.push({
      type: "agent_activity",
      activity: this.questionActivity(session, {
        kind: "cursor_question_requested",
        title: "Questions for you",
        content: { questionCount: batch.sets.length },
        canonical: { kind: "question_requested", ...(requestId ? { requestId } : {}), questionSets: batch.sets }
      })
    });
  }

  private pushQuestionResolved(
    session: CursorRunnerSession,
    turn: CursorActiveTurn | undefined,
    batch: CursorQuestionBatch,
    requestId: string,
    outcome: QuestionWaitOutcome | { status: "cancelled" },
    withRequestId: boolean
  ): void {
    const target = turn ?? session.activeTurn;
    if (!target || target.finalEvent) return;
    target.queue.push({
      type: "agent_activity",
      activity: this.questionActivity(session, {
        kind: "cursor_question_resolved",
        title:
          outcome.status === "answered" ? "Questions answered" : outcome.status === "timeout" ? "Questions timed out" : "Questions cancelled",
        content: { status: outcome.status, ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}) },
        canonical: {
          kind: "question_resolved",
          ...(withRequestId ? { requestId } : {}),
          status: outcome.status,
          ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
          ...(outcome.status === "answered"
            ? {
                // A sensitive set's text reaches only the tool result. Ordinary
                // invited discussion remains in the canonical event and thread.
                questionAnswers: outcome.answers.map((answer) =>
                  batch.sets.find((set) => set.setId === answer.setId)?.sensitive
                    ? { setId: answer.setId, selectedOptionIds: answer.selectedOptionIds }
                    : answer
                )
              }
            : {})
        }
      })
    });
  }

  private cancelPendingQuestion(session: CursorRunnerSession, turn: CursorActiveTurn): void {
    const requestId = turn.pendingQuestionRequestId;
    if (!requestId) return;
    turn.pendingQuestionRequestId = undefined;
    this.questions.cancel(session.key, requestId);
  }

  private questionActivity(session: CursorRunnerSession, activity: Omit<AgentRunnerActivity, "runner">): AgentRunnerActivity {
    return { ...activity, runner: session.base };
  }

  private turnStartedEvent(session: CursorRunnerSession, cursorRunId: string): AgentRunnerEvent {
    return {
      type: "agent_activity",
      activity: {
        kind: "cursor_turn_started",
        title: "Turn started",
        content: { runId: cursorRunId },
        canonical: { kind: "turn_started" },
        runner: { ...session.base, nativeTurnId: cursorRunId }
      }
    };
  }

  private handleChildGone(
    session: CursorRunnerSession,
    reason: string,
    stderrTail: () => string | undefined
  ): void {
    this.sessions.release(session);
    const turn = session.activeTurn;
    if (!turn || turn.completed) return;
    if (turn.sendAttempted) this.forceNextSends.add(session.key);
    this.settle(session, turn, {
      type: "run_failed",
      error: appendStderrTail(redactSecrets(reason), stderrTail())
    });
  }

  private settle(session: CursorRunnerSession, turn: CursorActiveTurn, event: AgentRunnerEvent): void {
    if (turn.completed) return;
    turn.completed = true;
    turn.finalEvent = event;
    turn.queue.close();
    if (session.activeTurn === turn) session.activeTurn = undefined;
    turn.onSettled?.();
  }

  /**
   * Read the live catalog off a session host that has just initialized. A
   * failure keeps the catalog already held (the fallback, or an earlier live
   * list) and is logged rather than raised: if the sign-in is really gone,
   * `agent/start` fails next with the SDK's own message, and if only this read
   * stalled, the turn still runs with the parameter names last known.
   */
  private async refreshCatalog(client: JsonRpcLineClient): Promise<void> {
    try {
      const response = await withTimeout(
        client.request("models/list", {}),
        MODELS_LIST_TIMEOUT_MS,
        "Timed out reading the Cursor model list"
      );
      const parsed = modelsListResultSchema.safeParse(response);
      const catalog = parsed.success ? cursorCatalogFromModels(parsed.data.models) : undefined;
      if (!catalog) return;
      this.catalog = catalog;
      // The same data the probe would have produced, so the next capabilities
      // read costs no child.
      this.capabilitiesCache = {
        promise: Promise.resolve(cursorCapabilities(catalog, this.config)),
        expiresAtMs: Date.now() + CAPABILITIES_CACHE_TTL_MS
      };
    } catch (error) {
      logger.warn(
        { issue: redactSecrets(error instanceof Error ? error.message : String(error)) },
        "Cursor model list unavailable at session start; mapping turn settings against the last known catalog"
      );
    }
  }

  private initializeParams(): { apiKey?: string; stateRoot: string; backendUrl?: string } {
    return {
      ...(this.config.cursorApiKey ? { apiKey: this.config.cursorApiKey } : {}),
      stateRoot: resolve(this.config.stateDir, "cursor", "agents"),
      ...(this.config.cursorBackendUrl ? { backendUrl: this.config.cursorBackendUrl } : {})
    };
  }

  private spawnHost(cwd: string): {
    child: ChildProcessWithoutNullStreams;
    client: JsonRpcLineClient;
    stderrTail: () => string | undefined;
  } {
    // The default host is run by the backend's own Node runtime and needs its
    // exec args (the tsx loader under `pnpm dev`, nothing under the packaged
    // runtime). A test's fake host is a plain script, so it is run bare.
    const args = this.usesDefaultHost ? [...process.execArgv, this.hostModulePath] : [this.hostModulePath];
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: cursorHostEnv(this.config)
    });
    const stderrTail = collectStderrTail(child);
    const client = new JsonRpcLineClient(child, CLIENT_LABEL);
    return { child, client, stderrTail };
  }

  private killChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }, SIGKILL_GRACE_MS);
    timer.unref?.();
    child.once("close", () => clearTimeout(timer));
  }
}

function collectStderrTail(child: ChildProcessWithoutNullStreams): () => string | undefined {
  let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT_CHARS);
  });
  return () => {
    const text = tail.trim();
    return text.length > 0 ? text : undefined;
  };
}

// The tail is the child's own text — a boot failure can quote a sign-in URL or a
// composition path — so it is redacted before it reaches a capabilities error or
// a turn-failure event, both of which the mutating-method preHandler does not gate.
function appendStderrTail(message: string, stderrTail: string | undefined): string {
  return stderrTail ? `${message} (stderr: ${redactSecrets(stderrTail)})` : message;
}

export { CURSOR_HOST_ENTRY };
