import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CodingAgentCapabilities, CodingAgentTurnSettings, ServiceConfig } from "../../domain/models";
import { logger } from "../../logging/logger";
import { redactSecrets } from "../../util/redactSecrets";
import { randomUUID } from "node:crypto";
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
import { TimeoutError, delay, withTimeout } from "../shared/asyncUtils";
import { commandAudit } from "../shared/commandAudit";
import { objectValue, stringValue } from "../shared/jsonValues";
import { capabilitiesFromModelList, fallbackCapabilities } from "./capabilities";
import { assistantTextFromCodexExecJsonLine, codexExecJsonOutput, codexTextOutputFilter } from "./execOutput";
import {
  runnerMetadataFromNotification,
  completionFromNotification,
  mapCodexNotification
} from "./notificationMapper";
import {
  effectiveSettings,
  jsonRpcArgs,
  jsonRpcRuntimeSettings,
  jsonRpcThreadSettings,
  jsonRpcTurnInput,
  jsonRpcTurnSettings,
  withSettingsOverrides
} from "./settings";
import {
  JsonRpcLineClient,
  JsonRpcMethodNotFoundError,
  type JsonRpcNotification,
  type JsonRpcRequest
} from "../shared/JsonRpcLineClient";
import {
  PendingQuestionRequests,
  type QuestionAnswerResult,
  type QuestionWaitOutcome
} from "../shared/PendingQuestionRequests";
import {
  CODEX_REQUEST_USER_INPUT_METHOD,
  codexUserInputBatch,
  codexUserInputRequestSchema,
  codexUserInputResponse
} from "./userInput";
import {
  createRunnerStreamTiming,
  observeRunnerStreamEvent,
  runnerStreamTimingAudit
} from "../shared/streamTiming";
import { PersistentRunnerSessionHost } from "../shared/PersistentRunnerSessionHost";
import { runnerDescriptor } from "../registry";

interface JsonRpcActiveTurn {
  runId: string;
  queue: AsyncEventQueue<AgentRunnerEvent>;
  finalEvent?: AgentRunnerEvent;
  completedByProtocol: boolean;
  turnId?: string;
  exitStatus?: { code: number | null; signal: NodeJS.Signals | null };
  failureCategory?: "process_error" | "process_exit" | "process_signal";
}

interface JsonRpcRunnerSession {
  key: string;
  client: JsonRpcLineClient;
  child: ChildProcessWithoutNullStreams;
  threadId: string;
  activeTurn?: JsonRpcActiveTurn;
}

// Startup requests get generous ceilings: they are hang watchdogs, not SLAs.
// A codex binary that never answers `initialize` or `thread/start` would
// otherwise leave the turn "running" forever with zero events. `thread/start`
// does real work — it loads the workspace's AGENTS.md and `.codex` config
// layer, which can spawn MCP servers — so it gets the widest bound.
const JSON_RPC_INITIALIZE_TIMEOUT_MS = 10_000;
const JSON_RPC_THREAD_START_TIMEOUT_MS = 30_000;

// How long cancel waits for `turn/interrupt` to be acknowledged before
// killing the app-server child. Killing loses the live child (the thread is
// resumed on the next turn), so give a real interrupt time to land — this
// matches the Claude runner's interrupt window.
const JSON_RPC_INTERRUPT_TIMEOUT_MS = 1_000;

// Idle persistent children are reaped so N open AgentRoom threads do not pin
// N resident codex processes; the recorded thread id lets the next turn
// resume the conversation. Matches the terminal service's idle window.
const IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

const STDERR_TAIL_LIMIT_CHARS = 2_048;

// Names this runner's child in the shared line client's two errors, so a
// rejected request says which process went away rather than "the client".
const CODEX_CLIENT_LABEL = "Codex app-server";

export class CodexAppServerRunner implements AgentRunner {
  private readonly processes = new Map<string, ReturnType<typeof spawn>>();
  private readonly activeJsonRpcTurns = new Map<string, { session: JsonRpcRunnerSession; turn: JsonRpcActiveTurn }>();
  // Persistent per-session app-server children, their idle reaping, and the
  // native thread ids that outlive them: a session whose app-server died, was
  // killed by a slow cancel, or was idle-reaped resumes its conversation on the
  // next turn (`thread/resume`) instead of silently starting a fresh thread
  // with no memory.
  private readonly sessions: PersistentRunnerSessionHost<JsonRpcRunnerSession>;
  private readonly startupTimeouts: { initializeMs: number; threadStartMs: number };
  private readonly interruptTimeoutMs: number;
  // Clarifying-question batches held open for a human answer, keyed by the
  // AgentRoom session. The app-server's `item/tool/requestUserInput` request
  // reaches `decideUserInput` through the JSON-RPC request dispatcher and
  // waits here; the answer route settles it. Released with the turn, the
  // child, and the session.
  private readonly questions: PendingQuestionRequests;

  constructor(
    private readonly config: ServiceConfig,
    deps: {
      startupTimeouts?: { initializeMs: number; threadStartMs: number };
      interruptTimeoutMs?: number;
      idleSessionTimeoutMs?: number;
      questionTimeoutMs?: number;
    } = {}
  ) {
    this.startupTimeouts = deps.startupTimeouts ?? {
      initializeMs: JSON_RPC_INITIALIZE_TIMEOUT_MS,
      threadStartMs: JSON_RPC_THREAD_START_TIMEOUT_MS
    };
    this.interruptTimeoutMs = deps.interruptTimeoutMs ?? JSON_RPC_INTERRUPT_TIMEOUT_MS;
    this.questions = new PendingQuestionRequests(
      deps.questionTimeoutMs !== undefined ? { timeoutMs: deps.questionTimeoutMs } : {}
    );
    this.sessions = new PersistentRunnerSessionHost({
      runnerKind: "codex",
      // The registry owns this: the host arms an idle timer only for a runner it
      // can restore, so the value is a declared capability, not a local constant.
      restoreStrategy: runnerDescriptor("codex").restoreStrategy,
      idleSessionTimeoutMs: deps.idleSessionTimeoutMs ?? IDLE_SESSION_TIMEOUT_MS,
      teardown: (session) => {
        this.questions.releaseSession(session.key);
        session.client.dispose();
        if (!session.child.killed && session.child.exitCode === null) {
          session.child.kill("SIGTERM");
        }
      },
      isBusy: (session) => session.activeTurn !== undefined,
      isReusable: (session) => session.child.exitCode === null && !session.child.killed,
      describe: (session) => ({ threadId: session.threadId })
    });
  }

  async getCapabilities(): Promise<CodingAgentCapabilities> {
    const fallback = fallbackCapabilities(this.config);
    if (!this.config.codexExecutable) {
      return { ...fallback, error: "Codex runner requires CODEX_EXECUTABLE" };
    }

    const child = spawn(this.config.codexExecutable, jsonRpcArgs(this.config.codexArgs), {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: codexChildEnv()
    });
    const stderrTail = collectStderrTail(child);
    const client = new JsonRpcLineClient(child, CODEX_CLIENT_LABEL);

    try {
      await withTimeout(client.request("initialize", {
        clientInfo: {
          name: "agentroom",
          title: "AgentRoom",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      }), 2_000, "Timed out initializing Codex app-server capabilities");
      const response = await withTimeout(
        client.request("model/list", { includeHidden: false }),
        2_500,
        "Timed out reading Codex model list"
      );
      return capabilitiesFromModelList(response, this.config);
    } catch (error) {
      return {
        ...fallback,
        error: appendStderrTail(error instanceof Error ? error.message : String(error), stderrTail())
      };
    } finally {
      client.dispose();
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    }
  }

  async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
    if ((this.config.codexRunnerProtocol ?? "jsonrpc") === "jsonrpc") {
      yield* this.runJsonRpc(input);
      return;
    }
    yield* this.runExec(input);
  }

  validateInputParts(inputParts: AgentRunnerInputPart[] | undefined): void {
    if (!inputParts?.length) return;
    if ((this.config.codexRunnerProtocol ?? "jsonrpc") !== "jsonrpc") {
      throw new AgentRunnerInputError("Image attachments require CODEX_RUNNER_PROTOCOL=jsonrpc");
    }
  }

  async cancel(runId: string): Promise<void> {
    const activeJsonRpcTurn = this.activeJsonRpcTurns.get(runId);
    if (activeJsonRpcTurn && !activeJsonRpcTurn.turn.turnId) {
      activeJsonRpcTurn.turn.finalEvent = { type: "run_failed", error: "Codex app-server turn interrupted" };
      this.sessions.destroy(activeJsonRpcTurn.session);
      this.activeJsonRpcTurns.delete(runId);
      return;
    }

    if (activeJsonRpcTurn?.turn.turnId) {
      // A question belongs to the turn being stopped; settle it as cancelled
      // so the child gets its (empty) answer and nothing waits on a person.
      this.questions.releaseSession(activeJsonRpcTurn.session.key);
      let interrupted = false;
      const interrupt = activeJsonRpcTurn.session.client.request("turn/interrupt", {
        threadId: activeJsonRpcTurn.session.threadId,
        turnId: activeJsonRpcTurn.turn.turnId
      }).then(() => {
        interrupted = true;
      }).catch(() => undefined);
      await Promise.race([interrupt, delay(this.interruptTimeoutMs)]);
      if (!interrupted) {
        // The child is unresponsive; kill it. The thread id stays recorded in
        // the session host, so the steering follow-up resumes the same
        // conversation in a fresh child instead of silently losing history.
        this.sessions.destroy(activeJsonRpcTurn.session);
      } else {
        // Mark protocol-complete before closing so a trailing turn/completed
        // for the interrupted turn cannot overwrite the cancel outcome.
        activeJsonRpcTurn.turn.completedByProtocol = true;
        activeJsonRpcTurn.turn.finalEvent = { type: "run_failed", error: "Codex app-server turn interrupted" };
        activeJsonRpcTurn.turn.queue.close();
        if (activeJsonRpcTurn.session.activeTurn === activeJsonRpcTurn.turn) {
          activeJsonRpcTurn.session.activeTurn = undefined;
        }
      }
      this.activeJsonRpcTurns.delete(runId);
      return;
    }

    const child = this.processes.get(runId);
    if (child) {
      child.kill("SIGTERM");
      this.processes.delete(runId);
    }
    this.activeJsonRpcTurns.delete(runId);
  }

  // Evict the per-session app-server child process when the AgentRoom session
  // is deleted; otherwise each deleted thread pins a live codex process until
  // backend shutdown. Deletion also forgets the resumable thread id — an
  // explicitly deleted session must never be silently resumed.
  async closeSession(sessionId: string): Promise<void> {
    this.sessions.close(sessionId);
  }

  answerQuestionRequest(input: { sessionId: string; requestId: string; answers: CanonicalQuestionAnswer[] }): QuestionAnswerResult {
    return this.questions.answer(input.sessionId, input.requestId, input.answers);
  }

  async dispose(): Promise<void> {
    this.questions.releaseAll();
    for (const child of this.processes.values()) {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
      }
    }
    this.processes.clear();
    this.sessions.disposeAll();
    this.activeJsonRpcTurns.clear();
  }

  private async *runExec(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
    if (!this.config.codexExecutable) {
      throw new Error("Codex runner requires CODEX_EXECUTABLE");
    }

    const startedAtMs = Date.now();
    const timing = createRunnerStreamTiming();
    const codexArgs = withSettingsOverrides(this.config.codexArgs, effectiveSettings(this.config, input.settings));
    const command = commandAudit(this.config.codexExecutable, codexArgs);
    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      protocol: "exec",
      inputPartCount: input.inputParts?.length ?? 0,
      promptBytes: Buffer.byteLength(input.prompt, "utf8")
    }, "Codex runner turn started");
    yield {
      type: "runner_audit",
      audit: {
        phase: "started",
        runnerKind: "codex",
        runId: input.runId,
        command
      }
    };

    const child = spawn(this.config.codexExecutable, codexArgs, {
      cwd: input.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexChildEnv()
    });
    this.processes.set(input.runId, child);
    // A child that dies before draining the prompt surfaces EPIPE as a stdin
    // stream error; without a listener that is an uncaught exception that
    // takes down the backend. The close/error handlers below already report
    // the failure, so the stream error only needs to be absorbed.
    child.stdin.on("error", () => undefined);
    child.stdin.write(input.prompt);
    child.stdin.end();

    const queue = new AsyncEventQueue<AgentRunnerEvent>();
    const jsonOutput = codexExecJsonOutput(codexArgs);
    const textOutput = codexTextOutputFilter(this.config.codexExecutable, codexArgs);
    let stdoutBuffer = "";
    let emittedJsonAssistantContent = false;
    let error: string | undefined;
    let exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let failureCategory: "process_error" | "process_exit" | "process_signal" | undefined;

    child.stdout.on("data", (chunk: Buffer) => {
      if (!jsonOutput) {
        for (const message of textOutput.append(chunk.toString("utf8"))) {
          queue.push({ type: "agent_update", message });
        }
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      let start = 0;
      let index = stdoutBuffer.indexOf("\n", start);
      while (index >= 0) {
        emitCodexExecJsonLine(stdoutBuffer.slice(start, index));
        start = index + 1;
        index = stdoutBuffer.indexOf("\n", start);
      }
      if (start > 0) stdoutBuffer = stdoutBuffer.slice(start);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (jsonOutput || !textOutput.enabled) {
        queue.push({ type: "agent_update", message: chunk.toString("utf8") });
        return;
      }
      for (const message of textOutput.append(chunk.toString("utf8"))) {
        queue.push({ type: "agent_update", message });
      }
    });
    child.on("error", (err) => {
      error = err.message;
      failureCategory = "process_error";
      queue.close();
    });
    child.on("close", (code, signal) => {
      if (jsonOutput && stdoutBuffer.length > 0) {
        emitCodexExecJsonLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      if (!jsonOutput) {
        for (const message of textOutput.flush()) {
          queue.push({ type: "agent_update", message });
        }
      }
      exitStatus = { code, signal };
      if (signal) {
        error = `Codex process terminated by signal ${signal}`;
        failureCategory = "process_signal";
      } else if (code && code !== 0) {
        error = `Codex process exited with code ${code}`;
        failureCategory = "process_exit";
      }
      queue.close();
    });

    function emitCodexExecJsonLine(line: string): void {
      const message = assistantTextFromCodexExecJsonLine(line, emittedJsonAssistantContent);
      if (!message) return;
      emittedJsonAssistantContent = true;
      queue.push({ type: "agent_update", message });
    }

    // Wake-based drain like the JSON-RPC path; the queue keeps yielding events
    // pushed before close, so the terminal flush in `close` is not lost.
    for await (const event of queue) {
      observeRunnerStreamEvent(timing, event);
      yield event;
    }

    this.processes.delete(input.runId);
    const durationMs = Date.now() - startedAtMs;
    const streamTiming = runnerStreamTimingAudit(timing, startedAtMs);
    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      protocol: "exec",
      status: error ? "failed" : "succeeded",
      durationMs,
      ...streamTiming
    }, "Codex runner turn completed");
    yield {
      type: "runner_audit",
      audit: {
        phase: "completed",
        runnerKind: "codex",
        runId: input.runId,
        command,
        status: error ? "failed" : "succeeded",
        exitStatus,
        durationMs,
        ...streamTiming,
        failureCategory
      }
    };
    if (error) {
      yield { type: "run_failed", error };
    } else {
      yield { type: "run_succeeded", message: "Codex process exited successfully" };
    }
  }

  private async *runJsonRpc(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
    if (!this.config.codexExecutable) {
      throw new Error("Codex runner requires CODEX_EXECUTABLE");
    }

    const startedAtMs = Date.now();
    const timing = createRunnerStreamTiming();
    const codexArgs = jsonRpcArgs(this.config.codexArgs);
    const command = commandAudit(this.config.codexExecutable, codexArgs);
    const activeTurn: JsonRpcActiveTurn = {
      runId: input.runId,
      queue: new AsyncEventQueue<AgentRunnerEvent>(),
      completedByProtocol: false
    };
    let session: JsonRpcRunnerSession | undefined;

    logger.info({
      runId: input.runId,
      sessionId: input.sessionId,
      protocol: "jsonrpc",
      inputPartCount: input.inputParts?.length ?? 0,
      promptBytes: Buffer.byteLength(input.prompt, "utf8")
    }, "Codex runner turn started");
    yield {
      type: "runner_audit",
      audit: {
        phase: "started",
        runnerKind: "codex",
        runId: input.runId,
        command
      }
    };

    try {
      const settings = effectiveSettings(this.config, input.settings);
      session = await this.getOrCreateJsonRpcSession(input, activeTurn, settings);
      this.activeJsonRpcTurns.set(input.runId, { session, turn: activeTurn });

      this.startJsonRpcTurn(session, activeTurn, {
        threadId: session.threadId,
        input: jsonRpcTurnInput(input),
        ...jsonRpcTurnSettings(settings)
      });

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
      this.activeJsonRpcTurns.delete(input.runId);
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
      protocol: "jsonrpc",
      status: failed ? "failed" : "succeeded",
      durationMs,
      ...streamTiming
    }, "Codex runner turn completed");
    yield {
      type: "runner_audit",
      audit: {
        phase: "completed",
        runnerKind: "codex",
        runId: input.runId,
        command,
        status: failed ? "failed" : "succeeded",
        exitStatus: activeTurn.exitStatus,
        durationMs,
        ...streamTiming,
        failureCategory: activeTurn.failureCategory
      }
    };
    yield finalEvent ?? { type: "run_failed", error: "Codex app-server turn ended without a completion event" };
  }

  private async getOrCreateJsonRpcSession(
    input: AgentRunnerInput,
    activeTurn: JsonRpcActiveTurn,
    settings: CodingAgentTurnSettings
  ): Promise<JsonRpcRunnerSession> {
    const key = input.sessionId ?? input.runId;
    const existing = this.sessions.acquire(key);
    if (existing) {
      existing.activeTurn = activeTurn;
      this.activeJsonRpcTurns.set(input.runId, { session: existing, turn: activeTurn });
      return existing;
    }

    const codexArgs = jsonRpcArgs(this.config.codexArgs);
    const child = spawn(this.config.codexExecutable as string, codexArgs, {
      cwd: input.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: codexChildEnv()
    });
    const stderrTail = collectStderrTail(child);
    const client = new JsonRpcLineClient(child, CODEX_CLIENT_LABEL);
    const session: JsonRpcRunnerSession = {
      key,
      client,
      child,
      threadId: "",
      activeTurn
    };

    client.onNotification((notification) => this.handleJsonRpcNotification(session, notification));
    client.onRequest((request) => this.handleJsonRpcRequest(session, request));
    child.on("close", (code, signal) => {
      this.sessions.release(session);
      this.questions.releaseSession(session.key);
      const active = session.activeTurn;
      if (!active) return;
      active.exitStatus = { code, signal };
      if (active.completedByProtocol) return;
      active.failureCategory = signal ? "process_signal" : code && code !== 0 ? "process_exit" : undefined;
      active.finalEvent = {
        type: "run_failed",
        error: appendStderrTail(
          signal ? `Codex app-server terminated by signal ${signal}` : `Codex app-server exited with code ${code ?? 0}`,
          stderrTail()
        )
      };
      active.queue.close();
    });
    child.on("error", (error) => {
      this.sessions.release(session);
      this.questions.releaseSession(session.key);
      const active = session.activeTurn;
      if (!active) return;
      active.failureCategory = "process_error";
      active.finalEvent = { type: "run_failed", error: error.message };
      active.queue.close();
    });

    this.sessions.register(session);
    this.activeJsonRpcTurns.set(input.runId, { session, turn: activeTurn });

    try {
      await withTimeout(client.request("initialize", {
        clientInfo: {
          name: "agentroom",
          title: "AgentRoom",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      }), this.startupTimeouts.initializeMs, "Timed out initializing Codex app-server");

      // The shared thread params carry the operator's explicit runtime
      // settings — approval policy, sandbox mode, and the pinned
      // sandbox_workspace_write.network_access — on thread/resume exactly as
      // on thread/start, so a resumed thread cannot relax the documented
      // posture (verified against codex-cli 0.146: resume applies explicit
      // overrides and echoes the effective sandbox).
      const threadParams = {
        ...jsonRpcThreadSettings(settings),
        cwd: input.workspacePath,
        ...jsonRpcRuntimeSettings(this.config)
      };

      const resumeThreadId = this.sessions.resumableId(key);
      let threadResponse: Record<string, unknown> | undefined;
      if (resumeThreadId) {
        try {
          threadResponse = objectValue(await withTimeout(client.request("thread/resume", {
            threadId: resumeThreadId,
            ...threadParams
          }), this.startupTimeouts.threadStartMs, "Timed out resuming Codex app-server thread"));
        } catch (error) {
          // A hung child is a startup failure, not a resume miss.
          if (error instanceof TimeoutError) throw error;
          // A thread with no recorded turn has no rollout to resume, and a
          // rollout can be pruned externally; fall back to a fresh thread
          // rather than failing the turn.
          this.sessions.forgetResumableId(key);
          logger.warn({
            sessionKey: key,
            threadId: resumeThreadId,
            error: error instanceof Error ? error.message : String(error)
          }, "Codex thread resume was rejected; starting a fresh thread");
        }
      }
      if (!threadResponse) {
        threadResponse = objectValue(await withTimeout(client.request("thread/start", {
          ...threadParams,
          serviceName: "AgentRoom",
          ephemeral: false,
          experimentalRawEvents: false,
          persistExtendedHistory: false
        }), this.startupTimeouts.threadStartMs, "Timed out starting Codex app-server thread"));
      }
      const threadId = stringValue(objectValue(threadResponse?.thread)?.id);

      if (!threadId) {
        throw new Error("Codex app-server thread response did not include a thread id");
      }

      session.threadId = threadId;
      this.sessions.rememberResumableId(key, threadId);
      return session;
    } catch (error) {
      this.sessions.destroy(session);
      this.activeJsonRpcTurns.delete(input.runId);
      throw new Error(appendStderrTail(error instanceof Error ? error.message : String(error), stderrTail()));
    }
  }

  private startJsonRpcTurn(
    session: JsonRpcRunnerSession,
    activeTurn: JsonRpcActiveTurn,
    params: Record<string, unknown>
  ): void {
    session.client.request("turn/start", params)
      .then((response) => {
        const turnStartResponse = objectValue(response);
        const turnId = stringValue(objectValue(turnStartResponse?.turn)?.id);
        if (turnId) {
          activeTurn.turnId ??= turnId;
          return;
        }
        if (!activeTurn.turnId && !activeTurn.completedByProtocol) {
          activeTurn.finalEvent = {
            type: "run_failed",
            error: "Codex app-server turn/start response did not include a turn id"
          };
          activeTurn.queue.close();
        }
      })
      .catch((error) => {
        if (activeTurn.completedByProtocol) return;
        activeTurn.finalEvent = {
          type: "run_failed",
          error: error instanceof Error ? error.message : String(error)
        };
        activeTurn.queue.close();
      });
  }

  /**
   * The app-server's own requests. `item/tool/requestUserInput` is the one
   * served: the agent's `request_user_input` tool pausing the turn for the
   * person driving the session. Anything else — the approval family under a
   * prompting `approvalPolicy`, a method a newer app-server invents — is
   * refused with `-32601` rather than left unanswered, which is what hung a
   * turn before the dispatcher existed.
   */
  private async handleJsonRpcRequest(session: JsonRpcRunnerSession, request: JsonRpcRequest): Promise<unknown> {
    if (request.method === CODEX_REQUEST_USER_INPUT_METHOD) {
      // Defense in depth for a Codex process whose global config or version
      // still exposes the tool despite the per-thread false pins.
      if (this.config.clarifyingQuestionsEnabled === false) return { answers: {} };
      return this.decideUserInput(session, request.params);
    }
    throw new JsonRpcMethodNotFoundError(request.method);
  }

  /**
   * Hold a `request_user_input` batch open for a human answer.
   *
   * The questions become a canonical batch announced on the turn's event
   * stream, the wait sits in the shared store until the answer route settles
   * it (or the clock, or the turn's cancellation), and the answers go back as
   * the request's response keyed by the agent's own question ids. A batch the
   * backend cannot hold open — no live turn, a full session, a request outside
   * the bounds — is announced as a record and answered empty, which the agent
   * reads as "nobody answered": the channel never picks for the person.
   */
  private async decideUserInput(session: JsonRpcRunnerSession, params: unknown): Promise<unknown> {
    const parsed = codexUserInputRequestSchema.safeParse(params);
    if (!parsed.success) {
      logger.warn({ runnerKind: "codex", threadId: session.threadId }, "Codex request_user_input params failed validation");
      return { answers: {} };
    }
    const batch = codexUserInputBatch(parsed.data);
    if ("error" in batch) {
      logger.warn({ runnerKind: "codex", threadId: session.threadId, reason: batch.error }, "Codex request_user_input batch refused");
      return { answers: {} };
    }
    this.sessions.touch(session);
    const turn = session.activeTurn;
    const requestId = `question-${randomUUID()}`;
    const wait = turn && !turn.finalEvent
      ? this.questions.wait({ sessionKey: session.key, requestId, sets: batch.sets })
      : undefined;
    const runner = {
      nativeSessionId: session.threadId,
      ...(parsed.data.turnId ? { nativeTurnId: parsed.data.turnId } : {}),
      ...(parsed.data.itemId ? { nativeItemId: parsed.data.itemId } : {}),
      native: { method: CODEX_REQUEST_USER_INPUT_METHOD }
    };
    const pushActivity = (activity: AgentRunnerActivity): void => {
      const target = session.activeTurn;
      if (target && !target.finalEvent) target.queue.push({ type: "agent_activity", activity });
    };
    pushActivity({
      kind: "codex_question_requested",
      title: "Questions for you",
      content: { questionCount: batch.sets.length, ...(parsed.data.itemId ? { itemId: parsed.data.itemId } : {}) },
      canonical: { kind: "question_requested", ...(wait ? { requestId } : {}), questionSets: batch.sets },
      runner
    });
    if (!wait) {
      pushActivity({
        kind: "codex_question_resolved",
        title: "Questions not presented",
        content: { status: "cancelled" },
        canonical: { kind: "question_resolved", status: "cancelled" },
        runner
      });
      return codexUserInputResponse(batch, { status: "unavailable" });
    }
    const outcome: QuestionWaitOutcome = await wait;
    pushActivity({
      kind: "codex_question_resolved",
      title: outcome.status === "answered" ? "Questions answered" : outcome.status === "timeout" ? "Questions timed out" : "Questions cancelled",
      content: { status: outcome.status, ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}) },
      canonical: {
        kind: "question_resolved",
        requestId,
        status: outcome.status,
        ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
        ...(outcome.status === "answered"
          ? {
              // A sensitive set's text reaches the agent and nowhere else.
              questionAnswers: outcome.answers.map((answer) =>
                batch.sets.find((set) => set.setId === answer.setId)?.sensitive
                  ? { setId: answer.setId, selectedOptionIds: answer.selectedOptionIds }
                  : answer
              )
            }
          : {})
      },
      runner
    });
    return codexUserInputResponse(batch, outcome);
  }

  private handleJsonRpcNotification(session: JsonRpcRunnerSession, notification: JsonRpcNotification): void {
    const active = session.activeTurn;
    if (!active) return;
    this.sessions.touch(session);

    active.turnId ??= runnerMetadataFromNotification(notification).nativeTurnId;
    const mapped = mapCodexNotification(notification);
    for (const event of mapped) active.queue.push(event);

    const turnCompletion = completionFromNotification(notification);
    if (turnCompletion) {
      active.completedByProtocol = true;
      active.finalEvent = turnCompletion;
      active.queue.close();
    }
  }
}

// The app-server writes diagnostics to stderr, and that pipe must always be
// drained: left unconsumed, the OS pipe buffer fills and blocks the child
// mid-write, silently wedging the session. Draining also keeps a bounded tail
// so startup and crash failures can carry the child's own explanation.
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

// The tail is the child's own text, not ours: it can quote a config line or an
// MCP server's diagnostics, so it is redacted before being appended to an error
// that reaches `/api/coding-agent/capabilities`, turn-failure events, and
// `/api/logs`.
function appendStderrTail(message: string, stderrTail: string | undefined): string {
  return stderrTail ? `${message} (stderr: ${redactSecrets(stderrTail)})` : message;
}

// Codex inherits the operator's environment so it can find its own credentials
// and tooling, minus AgentRoom's bearer token: `AUTH_TOKEN` is our transport
// secret, nothing the app-server or the MCP servers it starts needs, and it
// would otherwise propagate into every process the turn spawns. Mirrors the
// scrubs in terminal/TerminalSessionService.ts and runner/claudeCode/settings.ts.
function codexChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AUTH_TOKEN;
  return env;
}
