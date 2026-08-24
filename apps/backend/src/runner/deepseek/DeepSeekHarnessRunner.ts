import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
import { JsonRpcLineClient, type JsonRpcNotification } from "../shared/JsonRpcLineClient";
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
import { deepseekCapabilities } from "./capabilities";
import {
  DEEPSEEK_SDK_SERVER_NAME,
  initializeResultSchema,
  sessionEventNotificationSchema,
  sessionPromptResultSchema,
  sessionStatusNotificationSchema
} from "./protocol";
import {
  createDeepSeekTurnState,
  mapDeepSeekSessionEvent,
  type DeepSeekTurnState
} from "./sessionEventMapper";
import {
  DeepSeekPromptQuestionStreamParser,
  deepseekQuestionFollowUp,
  type DeepSeekPromptQuestionBatch
} from "./promptQuestions";
import {
  DEEPSEEK_RUNTIME_BINARY,
  deepseekChildEnv,
  deepseekCommandAudit,
  deepseekContentBlocks,
  deepseekInitializeParams,
  deepseekSessionRoot,
  effectiveDeepSeekSettings,
  type DeepSeekEffectiveSettings
} from "./settings";

interface DeepSeekActiveTurn {
  runId: string;
  queue: AsyncEventQueue<AgentRunnerEvent>;
  finalEvent?: AgentRunnerEvent;
  completedByProtocol: boolean;
  state: DeepSeekTurnState;
  /** Set once the runtime has reported this session's agent running. */
  sawRunning: boolean;
  /** Ignore a late duplicate `turn/end` after the idle backstop closed that cycle. */
  lastCompletedProtocolTurnNumber?: number;
  /** Present only while the managed clarifying-question channel is enabled. */
  questionParser?: DeepSeekPromptQuestionStreamParser;
  pendingQuestion?: DeepSeekPendingQuestion;
}

type DeepSeekQuestionOutcome = QuestionWaitOutcome | { status: "unavailable" };

interface DeepSeekPendingQuestion {
  batch: DeepSeekPromptQuestionBatch;
  requestId?: string;
  outcome?: DeepSeekQuestionOutcome;
  protocolCompleted: boolean;
  continuing: boolean;
}

interface DeepSeekRunnerSession {
  key: string;
  client: JsonRpcLineClient;
  child: ChildProcessWithoutNullStreams;
  stderrTail: () => string | undefined;
  /** The session id this child was handed — AgentRoom's own, see below. */
  sdkSessionId: string;
  /** The route this child was initialized on; a change needs a fresh child. */
  model?: string;
  provider?: string;
  activeTurn?: DeepSeekActiveTurn;
  /** Once a prompt is attempted, losing this non-restorable child ends the thread. */
  promptAttempted: boolean;
  /** Explicit AgentRoom-session deletion must not be mistaken for unexpected loss. */
  explicitlyClosed: boolean;
  /**
   * Skip the protocol `shutdown` step of the teardown ladder for this child.
   *
   * Set only by {@link DeepSeekHarnessRunner.cancel}: `shutdown` disposes the
   * root context so agents, subscriptions, and persistence *reach quiescence*,
   * which is the right ending for a released session and the wrong one for a
   * stop request — the operator asked for the turn to end, not to finish.
   */
  terminateImmediately: boolean;
}

/**
 * What the teardown ladder needs to end a runtime, which is deliberately less
 * than a session: the capability probe's throwaway child gets the same rungs,
 * because a runtime that ignores SIGTERM leaks just as thoroughly when nobody
 * was talking to it.
 */
interface TerminableRuntime {
  key: string;
  client: JsonRpcLineClient;
  child: ChildProcessWithoutNullStreams;
  terminateImmediately: boolean;
}

const CLIENT_LABEL = "DeepSeek Harness runtime";

// Startup requests are hang watchdogs rather than SLAs: a runtime that never
// answers `initialize` would otherwise leave the turn running forever with no
// events. Composing a plugin graph is real work, so the bound is generous.
const INITIALIZE_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 30_000;

// The teardown ladder, in the order the protocol documents and the vendor's own
// client walks it: ask for `shutdown` and let the plugin flush and dispose to
// quiescence, then close stdin (EOF is a documented exit path, but one that
// "may cut off an in-flight turn"), then signal, then insist. Each rung has its
// own bound because each can be the one that hangs, and the last rung cannot.
const SHUTDOWN_TIMEOUT_MS = 2_000;
const STDIN_EOF_GRACE_MS = 6_000;
const SIGTERM_GRACE_MS = 3_000;

// The shared host ignores this deadline for an `unsupported` restore strategy.
// It remains explicit so enabling a verified restore path later does not invent
// a runner-specific lifecycle default.
const IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

const STDERR_TAIL_LIMIT_CHARS = 2_048;

const CAPABILITIES_CACHE_TTL_MS = 5 * 60_000;

/**
 * DeepSeek Harness, driven through its first-party SDK runtime protocol
 * (`@deepseek-ai/dsh-sdk-jsonrpc-server`): newline-delimited JSON-RPC 2.0 over
 * the child's stdio, one persistent runtime per AgentRoom session.
 *
 * Three properties of that protocol shape this adapter, and none of them is
 * worked around — see `docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`:
 *
 * - **A prompt returns an enqueue receipt, not a result.** The protocol
 *   deliberately does not assign an assistant message or a turn ending to a
 *   prompt, so a turn is bracketed by the session log's own `turn/start` …
 *   `turn/end` events, with the whole-agent `running` → `idle` transition as the
 *   backstop for a runtime that ends a turn without recording one.
 * - **There is no cancel or verified restore method.** Cancelling kills the
 *   child and ends this AgentRoom session's usable conversation. A follow-up is
 *   refused rather than silently starting fresh under the same session id.
 * - **There are no server-to-client requests.** So there is no interactive
 *   permission channel to expose and no `answerPermissionRequest` hook.
 *   Clarifying questions use the descriptor-declared prompt contract instead:
 *   a bounded assistant block opens the shared question wait, and its answer
 *   becomes a second Harness prompt inside the same AgentRoom turn. What the
 *   agent may do is still its own configured posture (`DSH_PERMISSION_MODE`, a
 *   tier-2 managed setting).
 */
export class DeepSeekHarnessRunner implements AgentRunner {
  private readonly activeTurns = new Map<string, { session: DeepSeekRunnerSession; turn: DeepSeekActiveTurn }>();
  private readonly sessions: PersistentRunnerSessionHost<DeepSeekRunnerSession>;
  /** Sessions whose runtime held conversation state that can no longer be restored. */
  private readonly uncontinuableSessionIds = new Set<string>();
  private readonly initializeTimeoutMs: number;
  private readonly questions: PendingQuestionRequests;
  private disposing = false;
  private capabilitiesCache?: { promise: Promise<CodingAgentCapabilities>; expiresAtMs: number };

  constructor(
    private readonly config: ServiceConfig,
    deps: { idleSessionTimeoutMs?: number; initializeTimeoutMs?: number; questionTimeoutMs?: number } = {}
  ) {
    this.initializeTimeoutMs = deps.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS;
    this.questions = new PendingQuestionRequests(
      deps.questionTimeoutMs !== undefined ? { timeoutMs: deps.questionTimeoutMs } : {}
    );
    this.sessions = new PersistentRunnerSessionHost({
      runnerKind: "deepseek",
      // The registry owns this: the host arms an idle timer only for a runner it
      // can restore, so the value is a declared capability, not a local constant.
      restoreStrategy: runnerDescriptor("deepseek").restoreStrategy,
      idleSessionTimeoutMs: deps.idleSessionTimeoutMs ?? IDLE_SESSION_TIMEOUT_MS,
      // The host's teardown is synchronous, but a correct one is not: the
      // ladder below waits on the child between rungs. Releasing the session
      // slot immediately and letting the process end in the background is the
      // right trade — the host's invariant is that the slot is free, and a
      // caller blocked for up to eleven seconds on a wedged child would be a
      // worse answer than one that exits a moment after its session did.
      teardown: (session) => {
        this.questions.releaseSession(session.key);
        void this.terminateRuntime(session);
      },
      isBusy: (session) => session.activeTurn !== undefined,
      isReusable: (session) => session.child.exitCode === null && !session.child.killed,
      describe: (session) => ({ sdkSessionId: session.sdkSessionId })
    });
  }

  /**
   * The model catalog is static (the SDK wire has no `model/list` analog), but
   * readiness is still *proved*: this spawns the runtime, completes the
   * handshake, and checks the wire-stable server identity. That keeps the
   * capabilities read the runtime-readiness probe, so nothing spawns a child at
   * startup and `GET /api/runners` stays a read that initiates nothing.
   *
   * Successful results are cached per process; a result carrying an error is
   * not, so the next request retries a runtime the operator has since fixed.
   */
  async getCapabilities(): Promise<CodingAgentCapabilities> {
    const now = Date.now();
    if (this.capabilitiesCache && now < this.capabilitiesCache.expiresAtMs) {
      return this.capabilitiesCache.promise;
    }
    const entry = { promise: this.probeCapabilities(), expiresAtMs: now + CAPABILITIES_CACHE_TTL_MS };
    this.capabilitiesCache = entry;
    void entry.promise.then((capabilities) => {
      if (capabilities.error && this.capabilitiesCache === entry) {
        this.capabilitiesCache = undefined;
      }
    });
    return entry.promise;
  }

  /**
   * The bootstrap this runner cannot start without, as a message or nothing.
   *
   * Both halves are checked because the runtime treats them differently and
   * both failures are otherwise opaque: a missing executable is an ENOENT on
   * spawn, while a missing composition is a child that prints one line of usage
   * to stderr and exits 1 before answering anything. Neither reads as "you have
   * not finished setting this runner up" unless we say so.
   */
  private missingBootstrap(): string | undefined {
    if (!this.config.deepseekExecutable) {
      return `DeepSeek Harness runner requires DEEPSEEK_EXECUTABLE (the ${DEEPSEEK_RUNTIME_BINARY} runtime, not the dsh launcher)`;
    }
    if (!this.config.deepseekCordisConfig) {
      return "DeepSeek Harness runner requires DEEPSEEK_CORDIS_CONFIG: the runtime demands an explicit Cordis composition and exits without one";
    }
    return undefined;
  }

  /**
   * The pinned session root has to exist before the child looks for it: the
   * persistence plugin is handed a path, not asked to invent one, and a
   * composition that does not create it would fail the handshake for a reason
   * the operator cannot act on.
   */
  private ensureSessionRoot(): void {
    try {
      mkdirSync(deepseekSessionRoot(this.config), { recursive: true });
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Could not create the DeepSeek Harness session root"
      );
    }
  }

  private async probeCapabilities(): Promise<CodingAgentCapabilities> {
    const missingBootstrap = this.missingBootstrap();
    if (missingBootstrap) return deepseekCapabilities(this.config, missingBootstrap);
    const settings = effectiveDeepSeekSettings(this.config, undefined);
    this.ensureSessionRoot();
    let child: ChildProcessWithoutNullStreams | undefined;
    let client: JsonRpcLineClient | undefined;
    let stderrTail: () => string | undefined = () => undefined;
    try {
      // The probe runs in the backend's own cwd, never a registered workspace:
      // it exists to prove the runtime starts and answers, and it must not load
      // or execute a workspace's configuration merely to do that.
      child = spawn(this.config.deepseekExecutable as string, this.config.deepseekArgs, {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: deepseekChildEnv(this.config, process.cwd())
      });
      stderrTail = collectStderrTail(child);
      client = new JsonRpcLineClient(child, CLIENT_LABEL);
      const response = await withTimeout(
        client.request("initialize", deepseekInitializeParams(process.cwd(), settings)),
        this.initializeTimeoutMs,
        "Timed out initializing the DeepSeek Harness runtime"
      );
      const parsed = initializeResultSchema.safeParse(response);
      if (!parsed.success) {
        return deepseekCapabilities(
          this.config,
          appendStderrTail("The DeepSeek Harness runtime returned an unrecognized initialize result", stderrTail())
        );
      }
      if (parsed.data.serverInfo.name !== DEEPSEEK_SDK_SERVER_NAME) {
        // A different program answered. Saying so beats a turn that fails later
        // with a shape error, and naming the likely cause beats both: the usual
        // one is DEEPSEEK_EXECUTABLE pointing at the `dsh` launcher, which
        // serves profiles and never this protocol.
        return deepseekCapabilities(this.config, wrongServerMessage(parsed.data.serverInfo.name));
      }
      return deepseekCapabilities(this.config);
    } catch (error) {
      return deepseekCapabilities(
        this.config,
        appendStderrTail(error instanceof Error ? error.message : String(error), stderrTail())
      );
    } finally {
      // The probe proved what it came to prove; it never prompted, so there is
      // nothing to flush and the ladder starts at EOF.
      if (client && child) {
        void this.terminateRuntime({ key: "capability-probe", client, child, terminateImmediately: true });
      } else {
        client?.dispose();
      }
    }
  }

  /**
   * Images ride the prompt as content blocks and are not pre-refused here.
   *
   * Whether they are *usable* depends on the route the composition mounted, and
   * the runtime answers that explicitly — a provider that cannot read an image
   * fails the turn with its own reason. That is the outcome the posture asks
   * for: an attachment is never silently dropped, and a refusal a client can
   * render beats a guess this adapter would have to keep in step with a
   * developer preview.
   */
  validateInputParts(_inputParts: AgentRunnerInputPart[] | undefined): void {
    return;
  }

  async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
    const missingBootstrap = this.missingBootstrap();
    if (missingBootstrap) throw new Error(missingBootstrap);

    const startedAtMs = Date.now();
    const timing = createRunnerStreamTiming();
    const command = deepseekCommandAudit(this.config);
    const activeTurn: DeepSeekActiveTurn = {
      runId: input.runId,
      queue: new AsyncEventQueue<AgentRunnerEvent>(),
      completedByProtocol: false,
      state: createDeepSeekTurnState(),
      sawRunning: false,
      ...(this.config.clarifyingQuestionsEnabled !== false
        ? { questionParser: new DeepSeekPromptQuestionStreamParser() }
        : {})
    };
    let session: DeepSeekRunnerSession | undefined;

    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      inputPartCount: input.inputParts?.length ?? 0,
      promptBytes: Buffer.byteLength(input.prompt, "utf8")
    }, "DeepSeek Harness runner turn started");
    yield {
      type: "runner_audit",
      audit: { phase: "started", runnerKind: "deepseek", runId: input.runId, command }
    };

    try {
      const settings = effectiveDeepSeekSettings(this.config, input.settings);
      session = await this.getOrCreateSession(input, activeTurn, settings);
      this.activeTurns.set(input.runId, { session, turn: activeTurn });

      const contentBlocks = await deepseekContentBlocks(input.prompt, input.inputParts);
      // From this point onward the runtime may have accepted model-visible state.
      // If the child is lost, a retry under the same AgentRoom session id would
      // be a fresh conversation and must be refused.
      session.promptAttempted = true;
      const receipt = await withTimeout(
        session.client.request("session/prompt", {
          sessionId: session.sdkSessionId,
          contentBlocks
        }),
        PROMPT_TIMEOUT_MS,
        "Timed out queueing a DeepSeek Harness prompt"
      );
      // The receipt identifies the queued user message and nothing else — not a
      // later assistant message, a turn ending, or a result. It is logged as the
      // correlation handle it is and never treated as a completion.
      const parsedReceipt = sessionPromptResultSchema.safeParse(receipt);
      logger.debug({
        runId: input.runId,
        messageId: parsedReceipt.success ? parsedReceipt.data.messageId : undefined
      }, "DeepSeek Harness prompt queued");

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
        if (session.activeTurn === activeTurn) session.activeTurn = undefined;
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
    }, "DeepSeek Harness runner turn completed");
    yield {
      type: "runner_audit",
      audit: {
        phase: "completed",
        runnerKind: "deepseek",
        runId: input.runId,
        command,
        status: failed ? "failed" : "succeeded",
        durationMs,
        ...streamTiming
      }
    };
    yield finalEvent ?? { type: "run_failed", error: "The DeepSeek Harness runtime ended the turn without recording an outcome" };
  }

  /**
   * Cancellation is a kill, because the protocol has no prompt-cancel method.
   * The selected runtime composition is not guaranteed to persist sessions, so
   * this thread becomes uncontinuable: a later turn fails clearly instead of
   * silently generating against a fresh conversation.
   */
  async cancel(runId: string): Promise<void> {
    const active = this.activeTurns.get(runId);
    if (!active) return;
    this.cancelPendingQuestion(active.session, active.turn, "Questions cancelled");
    active.turn.completedByProtocol = true;
    active.turn.finalEvent = { type: "run_failed", error: "DeepSeek Harness turn interrupted" };
    this.questions.releaseSession(active.session.key);
    this.uncontinuableSessionIds.add(active.session.key);
    // Enter the ladder below `shutdown`: that rung disposes the runtime to
    // quiescence, which would let the work the operator just stopped run on.
    active.session.terminateImmediately = true;
    this.sessions.destroy(active.session);
    active.turn.queue.close();
    this.activeTurns.delete(runId);
  }

  answerQuestionRequest(input: {
    sessionId: string;
    requestId: string;
    answers: CanonicalQuestionAnswer[];
  }): QuestionAnswerResult {
    return this.questions.answer(input.sessionId, input.requestId, input.answers);
  }

  // Deleting the AgentRoom session releases its runtime child and forgets the
  // terminal marker, so an explicitly deleted thread leaves no runner state.
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.acquire(sessionId);
    if (session) session.explicitlyClosed = true;
    this.uncontinuableSessionIds.delete(sessionId);
    this.sessions.close(sessionId);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.questions.releaseAll();
    this.sessions.disposeAll();
    this.activeTurns.clear();
    this.uncontinuableSessionIds.clear();
  }

  private async getOrCreateSession(
    input: AgentRunnerInput,
    activeTurn: DeepSeekActiveTurn,
    settings: DeepSeekEffectiveSettings
  ): Promise<DeepSeekRunnerSession> {
    const key = input.sessionId ?? input.runId;
    if (this.uncontinuableSessionIds.has(key)) {
      throw new Error(
        "DeepSeek Harness cannot continue this session because its runtime stopped and no restore path is verified; create a new AgentRoom session"
      );
    }
    const existing = this.sessions.acquire(key);
    if (existing) {
      // Provider and model are `initialize` parameters, so they belong to the
      // child rather than to the prompt. A different selection requires a new
      // runtime, which is allowed only when the descriptor proves restoration.
      if (existing.model === settings.model && existing.provider === settings.provider) {
        existing.activeTurn = activeTurn;
        return existing;
      }
      if (!this.sessions.restorable) {
        throw new Error(
          "DeepSeek Harness cannot change model or provider within an existing session because no restore path is verified; create a new AgentRoom session"
        );
      }
      logger.info({
        sessionKey: key,
        from: existing.model,
        to: settings.model
      }, "Restarting the DeepSeek Harness runtime for a new model selection");
      this.sessions.destroy(existing);
    }

    this.ensureSessionRoot();
    const child = spawn(this.config.deepseekExecutable as string, this.config.deepseekArgs, {
      cwd: input.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: deepseekChildEnv(this.config, input.workspacePath)
    });
    const stderrTail = collectStderrTail(child);
    const client = new JsonRpcLineClient(child, CLIENT_LABEL);
    const session: DeepSeekRunnerSession = {
      key,
      client,
      child,
      stderrTail,
      // AgentRoom's own session id is the runtime's in-process session id. An
      // unknown id lazily creates the pair; that does not prove a new process
      // can recover the previous pair, which is why restoration is unsupported.
      sdkSessionId: key,
      model: settings.model,
      provider: settings.provider,
      activeTurn,
      promptAttempted: false,
      explicitlyClosed: false,
      terminateImmediately: false
    };

    client.onNotification((notification) => this.handleNotification(session, notification));
    child.on("close", (code, signal) => {
      this.markSessionUncontinuable(session);
      this.sessions.release(session);
      const active = session.activeTurn;
      if (!active || active.completedByProtocol) return;
      this.cancelPendingQuestion(session, active, "Questions cancelled");
      active.completedByProtocol = true;
      this.questions.releaseSession(session.key);
      active.finalEvent = {
        type: "run_failed",
        error: appendStderrTail(
          signal
            ? `The DeepSeek Harness runtime terminated by signal ${signal}`
            : `The DeepSeek Harness runtime exited with code ${code ?? 0}`,
          stderrTail()
        )
      };
      active.queue.close();
    });
    child.on("error", (error) => {
      this.markSessionUncontinuable(session);
      this.sessions.release(session);
      const active = session.activeTurn;
      if (!active) return;
      this.cancelPendingQuestion(session, active, "Questions cancelled");
      active.completedByProtocol = true;
      this.questions.releaseSession(session.key);
      active.finalEvent = { type: "run_failed", error: error.message };
      active.queue.close();
    });

    this.sessions.register(session);

    try {
      const response = await withTimeout(
        client.request("initialize", deepseekInitializeParams(input.workspacePath, settings)),
        this.initializeTimeoutMs,
        "Timed out initializing the DeepSeek Harness runtime"
      );
      const parsed = initializeResultSchema.safeParse(response);
      if (!parsed.success) {
        throw new Error(
          appendStderrTail("The DeepSeek Harness runtime returned an unrecognized initialize result", stderrTail())
        );
      }
      if (parsed.data.serverInfo.name !== DEEPSEEK_SDK_SERVER_NAME) {
        throw new Error(wrongServerMessage(parsed.data.serverInfo.name));
      }
    } catch (error) {
      // Registration precedes the handshake so close/error notifications can be
      // handled uniformly. Every unsuccessful handshake must undo it, otherwise
      // activeTurn keeps the child permanently busy and a later turn reuses an
      // uninitialized runtime.
      this.sessions.destroy(session);
      throw error;
    }

    activeTurn.queue.push({
      type: "agent_activity",
      activity: {
        kind: "deepseek_session_started",
        title: "DeepSeek Harness session started",
        content: { sdkSessionId: session.sdkSessionId },
        canonical: { kind: "session_started" },
        runner: this.runnerMetadata(session)
      }
    });
    return session;
  }

  private handleNotification(
    session: DeepSeekRunnerSession,
    notification: JsonRpcNotification
  ): void {
    const active = session.activeTurn;
    if (!active) return;

    if (notification.method === "session.status") {
      const parsed = sessionStatusNotificationSchema.safeParse(notification.params);
      if (!parsed.success || parsed.data.sessionId !== session.sdkSessionId) return;
      if (parsed.data.status === "running") {
        active.sawRunning = true;
        return;
      }
      // The whole-agent `running` → `idle` transition is the backstop: it ends
      // the interval when the runtime settled the turn without recording a
      // `turn/end` this adapter recognized. A turn that never settles is a worse
      // failure than one settled a beat early.
      if (active.sawRunning && !active.completedByProtocol) {
        this.completeProtocolCycle(
          session,
          active,
          { type: "run_succeeded" },
          active.state.turnNumber
        );
      }
      return;
    }

    if (notification.method !== "session.event") return;
    const parsed = sessionEventNotificationSchema.safeParse(notification.params);
    if (!parsed.success) return;
    // The runtime notifies for *every* session in its context, including the
    // sub-agents `dsh` can start. Only this session's own log is this turn's.
    if (parsed.data.sessionId !== session.sdkSessionId) return;

    const result = mapDeepSeekSessionEvent(parsed.data.event, {
      state: active.state,
      runner: this.runnerMetadata(session)
    });
    for (const event of result.events) this.pushMappedEvent(session, active, event);

    if (result.completion && !active.completedByProtocol) {
      this.completeProtocolCycle(
        session,
        active,
        result.completion.event,
        result.completion.turnNumber
      );
    }
  }

  /**
   * Apply one mapped DeepSeek event, intercepting only assistant prose when the
   * descriptor-selected prompt contract is enabled. The parser returns ordinary
   * prose unchanged and turns one valid structured block into a canonical batch.
   */
  private pushMappedEvent(
    session: DeepSeekRunnerSession,
    turn: DeepSeekActiveTurn,
    event: AgentRunnerEvent
  ): void {
    if (event.type !== "agent_update" || !turn.questionParser) {
      turn.queue.push(event);
      return;
    }
    const parsed = turn.questionParser.push(event.message);
    if (parsed.prose) turn.queue.push({ ...event, message: parsed.prose });
    if (parsed.batch) this.openPromptQuestion(session, turn, parsed.batch);
  }

  /**
   * Register the parsed batch before publishing its request id, exactly like
   * the native adapters. The SDK turn is allowed to finish, but the AgentRoom
   * turn remains open until this wait settles and a continuation prompt runs.
   */
  private openPromptQuestion(
    session: DeepSeekRunnerSession,
    turn: DeepSeekActiveTurn,
    batch: DeepSeekPromptQuestionBatch
  ): void {
    if (turn.pendingQuestion || turn.completedByProtocol) return;
    const requestId = `question-${randomUUID()}`;
    const wait = this.questions.wait({ sessionKey: session.key, requestId, sets: batch.sets });
    const pending: DeepSeekPendingQuestion = {
      batch,
      ...(wait ? { requestId } : {}),
      protocolCompleted: false,
      continuing: false,
      ...(!wait ? { outcome: { status: "unavailable" } as const } : {})
    };
    turn.pendingQuestion = pending;
    turn.queue.push({
      type: "agent_activity",
      activity: this.questionActivity(session, turn, {
        kind: "deepseek_question_requested",
        title: "Questions for you",
        content: { questionCount: batch.sets.length },
        canonical: {
          kind: "question_requested",
          ...(wait ? { requestId } : {}),
          questionSets: batch.sets
        }
      })
    });

    if (!wait) {
      turn.queue.push({
        type: "agent_activity",
        activity: this.questionActivity(session, turn, {
          kind: "deepseek_question_resolved",
          title: "Questions not presented",
          content: { status: "cancelled" },
          canonical: { kind: "question_resolved", status: "cancelled" }
        })
      });
      return;
    }

    void wait.then((outcome) => {
      if (turn.completedByProtocol || turn.pendingQuestion !== pending) return;
      pending.outcome = outcome;
      void this.continueAfterQuestion(session, turn, pending);
    });
  }

  /** Flush held parser state before the underlying Harness turn settles. */
  private completeProtocolCycle(
    session: DeepSeekRunnerSession,
    turn: DeepSeekActiveTurn,
    event: AgentRunnerEvent,
    protocolTurnNumber?: number
  ): void {
    // `running` → `idle` is the documented backstop for a missing turn end.
    // If the runtime records that end late, it still belongs to the cycle the
    // backstop already closed — never to a continuation prompt queued since.
    if (
      protocolTurnNumber !== undefined
      && turn.lastCompletedProtocolTurnNumber === protocolTurnNumber
    ) return;
    if (protocolTurnNumber !== undefined) {
      turn.lastCompletedProtocolTurnNumber = protocolTurnNumber;
    }

    const flushed = turn.questionParser?.flush();
    if (flushed?.prose) {
      turn.queue.push({ type: "agent_update", message: flushed.prose, runner: this.runnerMetadata(session) });
    }
    if (flushed?.batch) this.openPromptQuestion(session, turn, flushed.batch);

    const pending = turn.pendingQuestion;
    if (!pending || event.type === "run_failed") {
      if (pending) this.cancelPendingQuestion(session, turn, "Questions cancelled");
      this.settle(session, turn, event);
      return;
    }

    // `turn/end` belongs to the first Harness protocol turn, not the AgentRoom
    // turn. Hold the latter open until the answer route or timeout settles the
    // batch, then enqueue the continuation below.
    pending.protocolCompleted = true;
    void this.continueAfterQuestion(session, turn, pending);
  }

  private async continueAfterQuestion(
    session: DeepSeekRunnerSession,
    turn: DeepSeekActiveTurn,
    pending: DeepSeekPendingQuestion
  ): Promise<void> {
    if (
      turn.completedByProtocol
      || turn.pendingQuestion !== pending
      || pending.continuing
      || !pending.protocolCompleted
      || !pending.outcome
    ) return;

    const outcome = pending.outcome;
    if (outcome.status === "cancelled") {
      // Cancellation and teardown set `completedByProtocol` before releasing
      // the store. This branch is the conservative fallback for any future
      // release path that does not.
      this.settle(session, turn, { type: "run_failed", error: "DeepSeek Harness clarifying questions were cancelled" });
      return;
    }

    pending.continuing = true;
    if (pending.requestId) {
      turn.queue.push({
        type: "agent_activity",
        activity: this.questionActivity(session, turn, {
          kind: "deepseek_question_resolved",
          title: outcome.status === "answered" ? "Questions answered" : "Questions timed out",
          content: { status: outcome.status, ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}) },
          canonical: {
            kind: "question_resolved",
            requestId: pending.requestId,
            status: outcome.status,
            ...(outcome.status === "answered"
              ? {
                  decidedBy: outcome.decidedBy,
                  // A sensitive set's text reaches the next model prompt and
                  // nowhere else: not this event, the transcript, or audit.
                  questionAnswers: outcome.answers.map((answer) =>
                    pending.batch.sets.find((set) => set.setId === answer.setId)?.sensitive
                      ? { setId: answer.setId, selectedOptionIds: answer.selectedOptionIds }
                      : answer
                  )
                }
              : outcome.status === "timeout"
                ? { decidedBy: outcome.decidedBy }
                : {})
          }
        })
      });
    }

    const followUp = deepseekQuestionFollowUp(pending.batch, outcome);
    turn.pendingQuestion = undefined;
    // Keep cumulative usage counters for the AgentRoom turn, while allowing the
    // mapper to claim the next Harness turn number and publish its own metadata.
    turn.state.turnNumber = undefined;
    turn.sawRunning = false;
    turn.questionParser = this.config.clarifyingQuestionsEnabled !== false
      ? new DeepSeekPromptQuestionStreamParser()
      : undefined;

    try {
      const contentBlocks = await deepseekContentBlocks(followUp, undefined);
      const receipt = await withTimeout(
        session.client.request("session/prompt", {
          sessionId: session.sdkSessionId,
          contentBlocks
        }),
        PROMPT_TIMEOUT_MS,
        "Timed out queueing the DeepSeek Harness clarifying-question answer"
      );
      const parsedReceipt = sessionPromptResultSchema.safeParse(receipt);
      if (!parsedReceipt.success) {
        throw new Error("The DeepSeek Harness runtime returned an unrecognized prompt receipt for a clarifying-question answer");
      }
      logger.debug({
        runId: turn.runId,
        messageId: parsedReceipt.data.messageId
      }, "DeepSeek Harness clarifying-question answer queued");
    } catch (error) {
      this.settle(session, turn, {
        type: "run_failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private questionActivity(
    session: DeepSeekRunnerSession,
    turn: DeepSeekActiveTurn,
    activity: Omit<AgentRunnerActivity, "runner">
  ): AgentRunnerActivity {
    return {
      ...activity,
      runner: {
        ...this.runnerMetadata(session),
        ...(turn.state.turnNumber === undefined ? {} : { nativeTurnId: String(turn.state.turnNumber) })
      }
    };
  }

  /** Close a client deck before any terminal path makes the wait unreachable. */
  private cancelPendingQuestion(
    session: DeepSeekRunnerSession,
    turn: DeepSeekActiveTurn,
    title: string
  ): void {
    const pending = turn.pendingQuestion;
    if (!pending) return;
    turn.pendingQuestion = undefined;
    if (!pending.requestId) return;
    this.questions.cancel(session.key, pending.requestId);
    turn.queue.push({
      type: "agent_activity",
      activity: this.questionActivity(session, turn, {
        kind: "deepseek_question_resolved",
        title,
        content: { status: "cancelled" },
        canonical: { kind: "question_resolved", requestId: pending.requestId, status: "cancelled" }
      })
    });
  }

  /**
   * End a runtime process the way its protocol documents.
   *
   * `shutdown` is a request, not a signal: the plugin answers it, flushes the
   * response, disposes the root context so SDK-owned agents, subscriptions, and
   * persistence reach quiescence, and exits 0. Skipping it — which the previous
   * SIGTERM-only teardown did — ends the child mid-flush, so a composition with
   * JSONL persistence can lose the tail of the session it was writing.
   *
   * Every later rung exists because the one before it can fail to land, and the
   * ladder ends in `SIGKILL` because a teardown that can hang is not a teardown.
   * Cancellation enters at the second rung: see `terminateImmediately`.
   */
  private async terminateRuntime(session: TerminableRuntime): Promise<void> {
    const exited = waitForExit(session.child);
    try {
      if (!session.terminateImmediately && session.child.exitCode === null && !session.child.killed) {
        await withTimeout(
          session.client.request("shutdown", {}),
          SHUTDOWN_TIMEOUT_MS,
          "Timed out shutting down the DeepSeek Harness runtime"
        );
      }
    } catch {
      // A runtime that will not answer `shutdown` is exactly what the rest of
      // the ladder is for, so this is never worth failing a caller over.
    }
    session.client.dispose();
    if (await settled(exited, 0)) return;

    session.child.stdin.end();
    if (await settled(exited, STDIN_EOF_GRACE_MS)) return;

    session.child.kill("SIGTERM");
    if (await settled(exited, SIGTERM_GRACE_MS)) return;

    logger.warn(
      { sessionKey: session.key, pid: session.child.pid },
      "DeepSeek Harness runtime ignored SIGTERM; sending SIGKILL"
    );
    session.child.kill("SIGKILL");
  }

  private markSessionUncontinuable(session: DeepSeekRunnerSession): void {
    if (this.disposing || session.explicitlyClosed || !session.promptAttempted) return;
    this.uncontinuableSessionIds.add(session.key);
  }

  private settle(session: DeepSeekRunnerSession, turn: DeepSeekActiveTurn, event: AgentRunnerEvent): void {
    turn.completedByProtocol = true;
    turn.finalEvent = event;
    turn.queue.close();
    if (session.activeTurn === turn) session.activeTurn = undefined;
  }

  private runnerMetadata(session: DeepSeekRunnerSession): RunnerMetadata {
    return {
      nativeSessionId: session.sdkSessionId,
      ...(session.model ? { model: session.model } : {}),
      // The harness's own posture, deliberately not flattened into a shared
      // permission enum with the Codex approval policy or the Claude Code
      // permission mode. Absent when the operator has configured none, because
      // the effective posture is then the composed profile's and this backend
      // does not know it.
      ...(this.config.deepseekPermissionMode
        ? { posture: { label: "permissionMode", value: this.config.deepseekPermissionMode } }
        : {})
    };
  }
}

// The runtime writes diagnostics to stderr, and that pipe must always be
// drained: left unconsumed, the OS pipe buffer fills and blocks the child
// mid-write, silently wedging the session. Draining also keeps a bounded tail so
// startup and crash failures carry the child's own explanation.
/** Resolves once the child has actually gone, whatever ended it. */
function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

/** Whether `exited` won the race against `ms`, without leaving a live timer. */
async function settled(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([exited.then(() => true), elapsed]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Why a child that completed the handshake is still not our runtime.
 *
 * Named as its own helper because both the probe and the session path answer
 * it, and because the cause is worth stating rather than leaving to the
 * operator: `dsh` is the obvious binary to reach for and it can never work here.
 */
function wrongServerMessage(reportedName: string): string {
  return (
    `Expected the DeepSeek Harness SDK runtime (${DEEPSEEK_SDK_SERVER_NAME}) but the child identified as "${reportedName}". ` +
    `DEEPSEEK_EXECUTABLE must be ${DEEPSEEK_RUNTIME_BINARY}, the packaged single-file runtime, or the interpreter that runs a source build's entrypoint — the dsh launcher boots profiles and serves no SDK protocol. ` +
    // The other way to land here has nothing to do with the launcher: a source
    // checkout tracks a developer-preview master with no version negotiation,
    // so a renamed server is drift rather than misconfiguration, and an
    // operator reading only the sentence above would go looking for a mistake
    // they did not make.
    `If this is a source build, the runtime may have renamed its server on a newer commit`
  );
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

// The tail is the child's own text, not ours: a boot failure can quote a
// composition file or a plugin's diagnostics, so it is redacted before being
// appended to an error that reaches `/api/coding-agent/capabilities`,
// turn-failure events, and `/api/logs` — reads the mutating-method preHandler
// does not gate.
function appendStderrTail(message: string, stderrTail: string | undefined): string {
  return stderrTail ? `${message} (stderr: ${redactSecrets(stderrTail)})` : message;
}
