import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CodingAgentCapabilities, ServiceConfig } from "../../domain/models";
import { logger } from "../../logging/logger";
import { redactSecrets } from "../../util/redactSecrets";
import {
  AgentRunnerInputError,
  type AgentRunner,
  type AgentRunnerActivity,
  type AgentRunnerEvent,
  type AgentRunnerInput,
  type AgentRunnerInputPart,
  type CanonicalActivity,
  type RunnerMetadata
} from "../AgentRunner";
import { AsyncEventQueue } from "../shared/AsyncEventQueue";
import { commandAudit } from "../shared/commandAudit";
import {
  PendingPermissionRequests,
  type PermissionAnswerResult
} from "../shared/PendingPermissionRequests";
import { PersistentRunnerSessionHost } from "../shared/PersistentRunnerSessionHost";
import { admitExecutable, buildAcpChildEnv } from "./admission";
import { acpPermissionPolicy, type AcpAdapterConfig, type AcpPermissionPolicy } from "./config";
import { AcpStdioClient, DEFAULT_ACP_LIMITS, type AcpLimits } from "./AcpStdioClient";
import {
  ACP_PROTOCOL_VERSION,
  agentSupportsPromptImages,
  conservativePermissionOutcome,
  type AcpPermissionOption,
  type AcpPromptContentBlock,
  type AcpSessionSettings,
  type AcpSettingControl,
  EMPTY_ACP_SESSION_SETTINGS,
  initializeResponseSchema,
  newSessionResponseSchema,
  parseConfigOptionUpdate,
  parseSessionUpdate,
  permissionRequestSchema,
  promptResponseSchema,
  readSessionSettings,
  restoredSessionResponseSchema,
  sessionNotificationSchema,
  setConfigOptionResponseSchema,
  updateText
} from "./protocol";

/**
 * An `AgentRunner` over Agent Client Protocol v1 (Phase 7 of
 * docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md).
 *
 * One adapter makes every ACP-speaking agent *configurable* rather than coded,
 * which is the whole point of the phase: a second ACP agent is tier-3 operator
 * configuration, not another adapter.
 *
 * What this class owns is the protocol and nothing else — the boundary's
 * standing rule. The persistent-child lifecycle is the shared host's, the
 * canonical event shapes are the `AgentRunner` boundary's, admission and the
 * child environment are `admission.ts`'s, and the transport bounds are
 * `AcpStdioClient`'s. Generalize the dispatch, never the payload: ACP's own
 * detail stays reachable through each activity's native `kind` and the bounded
 * `native` blob rather than being flattened into the canonical reading.
 */

const IDLE_SESSION_TIMEOUT_MS = 30 * 60_000;
/** How long a successful capability probe is trusted before re-spawning. */
const CAPABILITY_CACHE_MS = 5 * 60_000;

interface AcpSession {
  readonly key: string;
  readonly client: AcpStdioClient;
  readonly child: ChildProcessWithoutNullStreams;
  /** What this specific child advertised at `initialize`. */
  supportsPromptImages: boolean;
  /** The agent's own session id — what a restore resumes. */
  acpSessionId?: string;
  /**
   * The session config selectors this child reported, and their live values.
   *
   * ACP's selectors are **session-scoped**, so this is the record of what the
   * session is currently set to — updated by our own `session/set_config_option`
   * and re-read whenever the agent hands back a fresh list. It is what makes
   * applying a turn's settings a no-op when nothing changed.
   */
  settings: AcpSessionSettings;
  activeTurn?: ActiveTurn;
  /**
   * True while a `session/load` replay is being consumed. The updates that
   * arrive during it are *reconstruction*, not new output: AgentRoom already
   * holds that transcript, so emitting them would duplicate every message the
   * conversation ever had.
   */
  suppressUpdates: boolean;
  /**
   * Whether this child's `session_started` has been emitted yet. The canonical
   * activity is what fills the session's runner-agnostic metadata block
   * (`nativeSessionId`, `cwd`, the runner's own posture), so without it a client
   * renders an ACP session with no native id and no posture at all. It is
   * per child, not per turn: a restored conversation announces its new native
   * session, a reused one does not repeat itself.
   */
  announced: boolean;
  dead: boolean;
}

interface ActiveTurn {
  readonly runId: string;
  readonly queue: AsyncEventQueue<AgentRunnerEvent>;
  cancelled: boolean;
  settled: boolean;
  outcome?: "succeeded" | "failed";
}

function toolOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  // Values arrived through JSON.parse, so they are acyclic JSON data. Keep the
  // guard because the mapper is still easiest to reason about as a total
  // function if a future test or adapter path supplies an unexpected value.
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export class AcpRunner implements AgentRunner {
  private readonly sessions: PersistentRunnerSessionHost<AcpSession>;
  private readonly activeTurns = new Map<string, AcpSession>();
  /**
   * Requests waiting for a human under the `ask` posture, keyed by the same
   * session key the host uses — so releasing a session releases its waits.
   */
  private readonly permissions: PendingPermissionRequests;
  private capabilityCache?: { at: number; capabilities: CodingAgentCapabilities };
  /**
   * The image-support answers completed handshakes have produced in this process.
   *
   * This is only a synchronous preflight hint. Delivery always consults the
   * selected child's own handshake result, because two concurrently retained
   * children need not advertise the same optional capability. A sole `false`
   * observation is enough for an early 400; no observations or mixed answers
   * defer the decision to the selected child in `run`.
   */
  private readonly promptImageSupportObservations = new Set<boolean>();

  constructor(
    private readonly config: ServiceConfig,
    private readonly adapter: AcpAdapterConfig,
    private readonly limits: AcpLimits = DEFAULT_ACP_LIMITS
  ) {
    this.permissions = new PendingPermissionRequests({ timeoutMs: limits.permissionTimeoutMs });
    this.sessions = new PersistentRunnerSessionHost<AcpSession>({
      runnerKind: adapter.id,
      // Enforced at the handshake rather than assumed: an agent advertising
      // neither restore path never gets a session, so a reaped child can always
      // be restored. See `handshake`.
      restoreStrategy: "native_resume",
      idleSessionTimeoutMs: IDLE_SESSION_TIMEOUT_MS,
      teardown: (session) => {
        session.dead = true;
        // Settle the waits before the child goes: a request nobody can answer
        // any more must not hold a timer for the rest of its timeout.
        this.permissions.releaseSession(session.key);
        session.client.dispose(`${adapter.id} session closed`);
      },
      isBusy: (session) => session.activeTurn !== undefined,
      isReusable: (session) => !session.dead,
      describe: (session) => ({ acpSessionId: session.acpSessionId })
    });
  }

  /**
   * The runtime-readiness probe, which is also ACP v1's discovery: spawn the
   * child, complete `initialize`, confirm a restore path, and read the session
   * config selectors `session/new` reports (Phase 4 of
   * docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md).
   *
   * v1 has no model-*list* method, which is what made the descriptor empty
   * before — but it does carry `configOptions`, whose `model` and
   * `thought_level` categories map without reinterpreting a generic selector.
   * The list rides the handshake response this probe already performs, so
   * discovery still spawns one child and asks no extra question. An agent that
   * offers no model selector still yields an empty descriptor, and `error` stays
   * the honest readiness signal
   * (`runner/runtimeReadiness.ts` reads exactly that).
   */
  async getCapabilities(): Promise<CodingAgentCapabilities> {
    const cached = this.capabilityCache;
    if (cached && Date.now() - cached.at < CAPABILITY_CACHE_MS) return cached.capabilities;

    const empty = { models: [], defaultSettings: {} };
    let session: AcpSession | undefined;
    try {
      // Probed in the backend's own working directory, never a registered
      // workspace: discovery must not load a workspace's configuration, the
      // same rule the Codex and Claude Code probes follow.
      session = await this.spawnSession(`probe:${this.adapter.id}`, process.cwd(), { probe: true });
      const capabilities: CodingAgentCapabilities = {
        runnerKind: this.adapter.id,
        settings: session.settings.descriptor
      };
      this.capabilityCache = { at: Date.now(), capabilities };
      return capabilities;
    } catch (error) {
      // Not cached: a failed probe must retry rather than pin a stale failure.
      return {
        runnerKind: this.adapter.id,
        settings: empty,
        error: redactSecrets(error instanceof Error ? error.message : String(error))
      };
    } finally {
      if (session) session.client.dispose("capability probe complete");
    }
  }

  /**
   * ACP v1 carries images as prompt content blocks only when the agent
   * advertises `promptCapabilities.image` (Phase 3 of
   * docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md), so an attachment is
   * negotiated per adapter rather than refused outright.
   *
   * This is the fast half of that negotiation: if every completed handshake in
   * this process agrees the adapter takes no images, the attachment gets an
   * explicit 400 before a turn exists. With no observation or conflicting
   * observations, the answer for the selected child is *unknown*, which is not
   * "no" — refusing there would be the same mistake `runner/runtimeReadiness.ts`
   * names about an unprobed runner. The turn proceeds instead and `run` checks
   * the selected child's own handshake, so one retained child's advertisement
   * can never authorize or refuse delivery to another.
   */
  validateInputParts(inputParts: AgentRunnerInputPart[] | undefined): void {
    if (!inputParts?.length) return;
    if (
      this.promptImageSupportObservations.size === 1
      && this.promptImageSupportObservations.has(false)
    ) {
      throw new AgentRunnerInputError(this.noImageSupportMessage);
    }
    for (const part of inputParts) {
      if (part.type !== "localImage") continue;
      // ACP requires a mime type on an image block, so an attachment without one
      // cannot be sent at all — the same check the Claude Code adapter makes for
      // the same reason.
      if (!part.contentType) throw new AgentRunnerInputError("Image attachment is missing a content type");
    }
  }

  private get noImageSupportMessage(): string {
    return `${this.adapter.displayName} does not support image attachments`;
  }

  async *run(input: AgentRunnerInput): AsyncIterable<AgentRunnerEvent> {
    const startedAtMs = Date.now();
    const admitted = admitExecutable(this.adapter.command);
    if (!admitted.ok) {
      throw new Error(`${this.adapter.displayName} is not runnable: ${admitted.reason}`);
    }

    yield {
      type: "runner_audit",
      audit: {
        phase: "started",
        runnerKind: this.adapter.id,
        runId: input.runId,
        command: commandAudit(admitted.executable, [...this.adapter.args])
      }
    };

    const sessionKey = input.sessionId ?? input.runId;
    let session: AcpSession;
    try {
      session = this.sessions.acquire(sessionKey)
        ?? (await this.spawnSession(sessionKey, input.workspacePath, { probe: false }));
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      yield { type: "run_failed", error: message };
      yield this.completedAudit(input, admitted.executable, startedAtMs, "failed");
      return;
    }

    // After the handshake above, because that is what makes the agent's image
    // advertisement known for a session whose first turn carried an attachment.
    let promptContent: AcpPromptContentBlock[];
    try {
      promptContent = await this.promptContent(session, input);
      await this.applyTurnSettings(session, input.settings);
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      yield { type: "run_failed", error: message };
      yield this.completedAudit(input, admitted.executable, startedAtMs, "failed");
      return;
    }

    const queue = new AsyncEventQueue<AgentRunnerEvent>();
    const turn: ActiveTurn = { runId: input.runId, queue, cancelled: false, settled: false };
    session.activeTurn = turn;
    this.activeTurns.set(input.runId, session);

    if (!session.announced) {
      session.announced = true;
      yield this.activity(
        session,
        "acp_session_started",
        this.adapter.displayName,
        { kind: "session_started" },
        { metadata: { cwd: input.workspacePath } }
      );
    }

    const prompt = session.client
      .request(
        "session/prompt",
        {
          sessionId: session.acpSessionId,
          prompt: promptContent
        },
        this.limits.turnTimeoutMs
      )
      .then((result) => {
        if (turn.settled) return;
        const parsed = promptResponseSchema.safeParse(result);
        turn.settled = true;
        if (!parsed.success) {
          turn.outcome = "failed";
          queue.push({
            type: "run_failed",
            error: `${this.adapter.displayName} returned an invalid session/prompt response`
          });
          return;
        }
        const stopReason = parsed.data.stopReason;
        if (stopReason === "cancelled" || turn.cancelled) {
          turn.outcome = "failed";
          queue.push({ type: "run_failed", error: `${this.adapter.displayName} turn cancelled` });
        } else if (stopReason === "refusal") {
          turn.outcome = "failed";
          queue.push({ type: "run_failed", error: `${this.adapter.displayName} refused the turn` });
        } else {
          turn.outcome = "succeeded";
          queue.push({ type: "run_succeeded" });
        }
      })
      .catch((error: unknown) => {
        if (turn.settled) return;
        turn.settled = true;
        turn.outcome = "failed";
        queue.push({
          type: "run_failed",
          error: this.failureMessage(session, error)
        });
      })
      .finally(() => {
        this.sessions.touch(session);
        if (session.activeTurn === turn) session.activeTurn = undefined;
        this.activeTurns.delete(input.runId);
        // A settled turn has nothing left to permit. An agent still waiting on
        // an answer keeps the prompt open, so nothing is released underneath a
        // live request — only one stranded by a turn that ended another way.
        this.permissions.releaseSession(session.key);
        queue.close();
      });

    try {
      for await (const event of queue) yield event;
    } finally {
      await prompt.catch(() => undefined);
    }
    yield this.completedAudit(input, admitted.executable, startedAtMs, turn.outcome ?? "failed");
  }

  /**
   * Cancel through the protocol first, kill only if that does not settle the
   * turn. The agent's own `session/cancel` settles the in-flight prompt with
   * `stopReason: "cancelled"`, so the ordinary path keeps the child — and its
   * conversation — alive for the steering follow-up.
   */
  async cancel(runId: string): Promise<void> {
    const session = this.activeTurns.get(runId);
    const turn = session?.activeTurn;
    if (!session || !turn || turn.runId !== runId) return;
    turn.cancelled = true;
    session.client.notify("session/cancel", { sessionId: session.acpSessionId });

    const settled = await Promise.race([
      new Promise<boolean>((resolve) => {
        const started = Date.now();
        const poll = setInterval(() => {
          if (turn.settled || Date.now() - started > this.limits.cancelTimeoutMs) {
            clearInterval(poll);
            resolve(turn.settled);
          }
        }, 50);
        poll.unref?.();
      }),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(turn.settled), this.limits.cancelTimeoutMs);
        timer.unref?.();
      })
    ]);

    if (!settled) {
      // Unresponsive to its own cancel. The child goes, but the host keeps the
      // agent session id, so the next turn resumes the conversation in a fresh
      // child rather than silently starting a new one.
      this.sessions.destroy(session);
    }
    this.activeTurns.delete(runId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.close(sessionId);
    // Also for a session the host held no child for: outstanding requests are
    // per-session state and are released with it, like every other kind.
    this.permissions.releaseSession(sessionId);
  }

  /**
   * The human answer to an outstanding permission request.
   *
   * Only an option the agent offered for *that* request is accepted; the store
   * checks it against what arrived with the request, so this cannot express a
   * choice the agent never supplied.
   */
  answerPermissionRequest(input: {
    sessionId: string;
    requestId: string;
    optionId: string;
  }): PermissionAnswerResult {
    return this.permissions.answer(input.sessionId, input.requestId, input.optionId);
  }

  async dispose(): Promise<void> {
    this.sessions.disposeAll();
    this.permissions.releaseAll();
    this.activeTurns.clear();
  }

  /**
   * The prompt's content blocks: the text, then one image block per attachment.
   *
   * The capability check here is the slow half of the negotiation — the
   * handshake `run` has completed is the authoritative answer for this child.
   * Refusing here costs a failed turn rather than a `400`, which is the price of
   * an unknown or mixed preflight answer. The observation it leaves behind lets
   * `validateInputParts` answer later attempts early when every successful
   * handshake agrees on non-support.
   */
  private async promptContent(
    session: AcpSession,
    input: AgentRunnerInput
  ): Promise<AcpPromptContentBlock[]> {
    const blocks: AcpPromptContentBlock[] = [{ type: "text", text: input.prompt }];
    const images = (input.inputParts ?? []).filter((part) => part.type === "localImage");
    if (images.length === 0) return blocks;
    if (!session.supportsPromptImages) throw new Error(this.noImageSupportMessage);

    let imageBytes = 0;
    for (const part of images) {
      // Read from STATE_DIR, where the attachment upload already validated the
      // type, the signature, and the per-file cap. What that cap does not bound
      // is the frame, which is why the running total is checked here.
      const data = await readFile(part.path);
      imageBytes += data.byteLength;
      if (imageBytes > this.limits.maxPromptImageBytes) {
        throw new Error(
          `${this.adapter.displayName} turns accept at most ${this.limits.maxPromptImageBytes} bytes of image attachments`
        );
      }
      blocks.push({
        type: "image",
        mimeType: part.contentType ?? "image/png",
        data: data.toString("base64")
      });
    }
    return blocks;
  }

  /**
   * Apply a turn's selected settings to the session before prompting.
   *
   * ACP has no per-turn model parameter — `session/prompt` takes content and
   * nothing else — so a selection is applied with `session/set_config_option`,
   * which is **session-scoped**. That is the honest reading of the protocol
   * rather than a limitation worked around: a value stays set until it is
   * changed, so a turn that selects nothing keeps what the session already has,
   * and each field is sent only when it actually differs from the live value.
   *
   * Only a value the agent listed for that selector is ever sent. A client
   * asking for something the agent does not offer is refused here rather than
   * forwarded, so a stale picker (a client holding a descriptor from before the
   * agent's own configuration changed) cannot make AgentRoom set a value the
   * agent never advertised.
   *
   * A refusal partway through leaves the earlier fields set, which is safe
   * because it happens *before* `session/prompt`: the turn fails and nothing
   * runs against a half-applied selection, and the next turn re-applies the
   * same desired settings from the top.
   */
  private async applyTurnSettings(
    session: AcpSession,
    settings: AgentRunnerInput["settings"]
  ): Promise<void> {
    if (!settings) return;
    const wanted: ReadonlyArray<[keyof AcpSessionSettings & string, string | undefined]> = [
      ["model", settings.model],
      ["reasoningEffort", settings.reasoningEffort],
      ["serviceTier", settings.serviceTier]
    ];

    for (const [field, value] of wanted) {
      if (value === undefined) continue;
      const control = session.settings[field] as AcpSettingControl | undefined;
      if (!control) {
        throw new Error(`${this.adapter.displayName} does not offer a ${field} selection`);
      }
      if (control.currentValue === value) continue;
      if (!this.offers(session.settings, field, value)) {
        throw new Error(`${this.adapter.displayName} does not offer the ${field} "${value}"`);
      }

      const response = setConfigOptionResponseSchema.parse(
        await session.client.request(
          "session/set_config_option",
          { sessionId: session.acpSessionId, configId: control.configId, value },
          this.limits.handshakeTimeoutMs
        )
      );
      // The agent answers with the whole refreshed list, which is authoritative:
      // setting one option can move another (a model can narrow its efforts), so
      // the reply replaces our record rather than patching the one field.
      const refreshed = readSessionSettings(response.configOptions);
      // Store the authoritative response even when it refuses the requested
      // value: the next turn must reason from what the agent actually reports,
      // not from the state before this request.
      session.settings = refreshed;
      const refreshedControl = refreshed[field] as AcpSettingControl | undefined;
      if (refreshedControl?.currentValue !== value || !this.offers(refreshed, field, value)) {
        throw new Error(
          `${this.adapter.displayName} did not apply the ${field} "${value}"`
        );
      }
    }
  }

  /** Whether the agent listed `value` for the selector behind `field`. */
  private offers(settings: AcpSessionSettings, field: string, value: string): boolean {
    const models = settings.descriptor.models;
    if (field === "model") return models.some((model) => model.id === value);
    const first = models[0];
    if (!first) return false;
    const values = field === "reasoningEffort" ? first.reasoningEfforts : first.serviceTiers;
    return values.some((entry) => entry.id === value);
  }

  private completedAudit(
    input: AgentRunnerInput,
    executable: string,
    startedAtMs: number,
    status: "succeeded" | "failed"
  ): AgentRunnerEvent {
    return {
      type: "runner_audit",
      audit: {
        phase: "completed",
        runnerKind: this.adapter.id,
        runId: input.runId,
        command: commandAudit(executable, [...this.adapter.args]),
        status,
        durationMs: Date.now() - startedAtMs
      }
    };
  }

  private failureMessage(session: AcpSession, error: unknown): string {
    const base = redactSecrets(error instanceof Error ? error.message : String(error));
    const tail = session.client.diagnosticTail;
    return tail ? `${base}: ${tail}` : base;
  }

  /**
   * Spawn a child, complete the handshake, and register the session.
   *
   * The order matters: nothing is registered with the host until the agent has
   * proved it can be restored, so the host's "arm an idle timer for a restorable
   * runner" rule is never applied to a session that could not survive a reap.
   */
  private async spawnSession(
    key: string,
    cwd: string,
    options: { probe: boolean }
  ): Promise<AcpSession> {
    const admitted = admitExecutable(this.adapter.command);
    if (!admitted.ok) throw new Error(`${this.adapter.displayName} is not runnable: ${admitted.reason}`);

    const child = spawn(admitted.executable, [...this.adapter.args], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Allowlisted, never inherited — see `admission.ts`.
      env: buildAcpChildEnv(this.adapter.envGrants)
    }) as ChildProcessWithoutNullStreams;

    const session: AcpSession = {
      key,
      child,
      client: undefined as unknown as AcpStdioClient,
      supportsPromptImages: false,
      settings: EMPTY_ACP_SESSION_SETTINGS,
      suppressUpdates: false,
      announced: false,
      dead: false
    };
    const client = new AcpStdioClient(child, this.limits, {
      onNotification: (method, params) => this.onNotification(session, method, params),
      onRequest: (method, params) => this.onRequest(session, method, params),
      onFatal: (error) => {
        session.dead = true;
        this.permissions.releaseSession(session.key);
        this.sessions.release(session);
        const turn = session.activeTurn;
        if (turn && !turn.settled) {
          turn.settled = true;
          turn.outcome = "failed";
          turn.queue.push({ type: "run_failed", error: redactSecrets(error.message) });
          turn.queue.close();
        }
      }
    });
    (session as { client: AcpStdioClient }).client = client;

    try {
      await this.handshake(session, cwd, options);
      // Record only a completed handshake. An initialize response followed by a
      // failed restore/session creation did not establish a usable child and
      // must not turn the next attachment into a stale early refusal.
      this.promptImageSupportObservations.add(session.supportsPromptImages);
    } catch (error) {
      client.dispose("handshake failed");
      throw error;
    }
    if (!options.probe) this.sessions.register(session);
    return session;
  }

  private async handshake(session: AcpSession, cwd: string, options: { probe: boolean }): Promise<void> {
    const initialized = initializeResponseSchema.parse(
      await session.client.request(
        "initialize",
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          // Declined, and the Phase 0b spike confirmed a conforming agent then
          // never calls them. AgentRoom's workspace writes go through the
          // bounded, optimistic-locked PUT; ACP's fs methods take absolute
          // paths, carry no conflict detection, and mandate create-on-write, so
          // re-advertising either is a separate safety decision, not a default.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false
          }
        },
        this.limits.handshakeTimeoutMs
      )
    );

    if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(
        `${this.adapter.displayName} speaks ACP v${initialized.protocolVersion}, which this backend does not`
      );
    }

    // Presence, not `=== true`: `loadSession` is a boolean while
    // `sessionCapabilities.resume` is an object whose presence is the claim.
    const capabilities = initialized.agentCapabilities;
    // Kept on the child whose initialize response carried it. The process-wide
    // observations used by synchronous preflight are updated only after this
    // handshake has completed successfully in `spawnSession`.
    session.supportsPromptImages = agentSupportsPromptImages(capabilities);
    const canResume = Boolean(capabilities?.sessionCapabilities?.resume);
    const canLoad = Boolean(capabilities?.loadSession);
    if (!canResume && !canLoad) {
      // Readiness and production admission answer the same question here: a
      // runner AgentRoom reaps and resumes must be restorable, or a reap
      // silently begins a fresh conversation under the same AgentRoom session
      // id. A probe may skip host registration, never this capability check.
      throw new Error(
        `${this.adapter.displayName} advertises no session restore capability and cannot be used`
      );
    }

    const resumableId = this.sessions.resumableId(session.key);
    if (!options.probe && resumableId) {
      if (canResume && (await this.tryResume(session, resumableId, cwd))) return;
      if (canLoad && (await this.tryLoad(session, resumableId, cwd))) return;
      // Neither restore worked — a thread the agent has forgotten. Fall through
      // to a fresh session rather than failing the turn, and forget the id so a
      // later turn does not retry it.
      this.sessions.forgetResumableId(session.key);
    }

    const created = newSessionResponseSchema.parse(
      await session.client.request(
        "session/new",
        { cwd, mcpServers: [] },
        this.limits.handshakeTimeoutMs
      )
    );
    session.acpSessionId = created.sessionId;
    session.settings = readSessionSettings(created.configOptions);
    if (!options.probe) this.sessions.rememberResumableId(session.key, created.sessionId);
  }

  private async tryResume(session: AcpSession, sessionId: string, cwd: string): Promise<boolean> {
    try {
      const restored = restoredSessionResponseSchema.parse(
        await session.client.request(
          "session/resume",
          { sessionId, cwd, mcpServers: [] },
          this.limits.handshakeTimeoutMs
        )
      );
      session.acpSessionId = sessionId;
      // A restored session carries its own current values, which need not be the
      // ones the conversation started with. Reading them back is what keeps the
      // "already set, send nothing" check below honest across a reap.
      session.settings = readSessionSettings(restored.configOptions);
      return true;
    } catch (error) {
      logger.info(
        { runnerKind: this.adapter.id, reason: redactSecrets(String(error)) },
        "ACP session resume rejected; falling back"
      );
      return false;
    }
  }

  /**
   * `session/load` replays the conversation through `session/update`. AgentRoom
   * already holds that transcript, so the replay is consumed with updates
   * suppressed — the adapter rebuilds its own state and emits nothing, which is
   * what keeps a restore from duplicating every past message.
   */
  private async tryLoad(session: AcpSession, sessionId: string, cwd: string): Promise<boolean> {
    session.suppressUpdates = true;
    try {
      const restored = restoredSessionResponseSchema.parse(
        await session.client.request(
          "session/load",
          { sessionId, cwd, mcpServers: [] },
          this.limits.handshakeTimeoutMs
        )
      );
      session.acpSessionId = sessionId;
      session.settings = readSessionSettings(restored.configOptions);
      return true;
    } catch (error) {
      logger.info(
        { runnerKind: this.adapter.id, reason: redactSecrets(String(error)) },
        "ACP session load rejected; falling back"
      );
      return false;
    } finally {
      session.suppressUpdates = false;
    }
  }

  private onNotification(session: AcpSession, method: string, params: unknown): void {
    if (method !== "session/update") return;
    const envelope = sessionNotificationSchema.safeParse(params);
    if (!envelope.success) return;
    // Config updates are state, not turn output. ACP permits an agent to replace
    // the complete list at any point (including while idle), so consume them
    // independently of whether there is an event queue to receive an activity.
    const configOptions = parseConfigOptionUpdate(envelope.data.update);
    if (configOptions) {
      session.settings = readSessionSettings(configOptions);
      return;
    }
    if (session.suppressUpdates) return;
    const turn = session.activeTurn;
    if (!turn || turn.settled) return;
    const update = parseSessionUpdate(envelope.data.update);
    // An update this adapter has no canonical reading for produces no event at
    // all — the boundary's documented way to keep something out of the stream.
    if (!update) return;
    for (const event of this.toEvents(session, update)) turn.queue.push(event);
  }

  private runnerMetadata(session: AcpSession, extra: Partial<RunnerMetadata> = {}): RunnerMetadata {
    return {
      nativeSessionId: session.acpSessionId,
      posture: { label: "permissionPolicy", value: acpPermissionPolicy(this.config, this.adapter) },
      ...extra
    };
  }

  private activity(
    session: AcpSession,
    kind: string,
    title: string,
    canonical: CanonicalActivity,
    extra: {
      description?: string;
      nativeItemId?: string;
      content?: Record<string, unknown>;
      metadata?: Partial<RunnerMetadata>;
    } = {}
  ): AgentRunnerEvent {
    const activity: AgentRunnerActivity = {
      kind,
      title,
      ...(extra.description ? { description: extra.description } : {}),
      content: extra.content ?? {},
      canonical,
      runner: this.runnerMetadata(session, {
        ...(extra.nativeItemId ? { nativeItemId: extra.nativeItemId } : {}),
        ...extra.metadata
      })
    };
    return { type: "agent_activity", activity };
  }

  private toEvents(
    session: AcpSession,
    update: NonNullable<ReturnType<typeof parseSessionUpdate>>
  ): AgentRunnerEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = updateText(update);
        return text
          ? [{ type: "agent_update", message: text, runner: this.runnerMetadata(session) }]
          : [];
      }
      case "agent_thought_chunk": {
        const delta = updateText(update);
        return delta
          ? [
              this.activity(session, "acp_thought", "Thinking", { kind: "reasoning", delta }, {
                ...(update.messageId ? { nativeItemId: update.messageId } : {})
              })
            ]
          : [];
      }
      case "tool_call":
        return [
          this.activity(
            session,
            "acp_tool_call",
            update.title ?? "Tool call",
            { kind: "tool_started", toolId: update.toolCallId },
            {
              nativeItemId: update.toolCallId,
              content: { kind: update.kind, status: update.status }
            }
          )
        ];
      case "tool_call_update": {
        const finished = update.status === "completed" || update.status === "failed";
        const output = toolOutputText(update.rawOutput);
        const outputEvent = this.activity(
          session,
          "acp_tool_call_update",
          update.title ?? "Tool call",
          {
            kind: "tool_output",
            toolId: update.toolCallId,
            ...(output === undefined ? {} : { delta: output })
          },
          {
            nativeItemId: update.toolCallId,
            content: {
              status: update.status,
              ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput })
            }
          }
        );
        if (!finished) return [outputEvent];

        const completedEvent = this.activity(
          session,
          "acp_tool_call_update",
          update.title ?? "Tool call",
          { kind: "tool_completed", toolId: update.toolCallId },
          {
            nativeItemId: update.toolCallId,
            content: { status: update.status }
          }
        );
        return update.rawOutput === undefined ? [completedEvent] : [outputEvent, completedEvent];
      }
      case "plan": {
        const steps = (update.entries ?? [])
          .map((entry) => ({ step: entry.content ?? "", status: entry.status ?? "pending" }))
          .filter((entry) => entry.step.length > 0);
        return steps.length > 0
          ? [this.activity(session, "acp_plan", "Plan", { kind: "plan_updated", steps })]
          : [];
      }
      case "usage_update":
        return [
          {
            type: "token_usage_updated",
            runner: this.runnerMetadata(session),
            ...(update.used === undefined ? {} : { contextWindowUsedTokens: update.used }),
            ...(update.size === undefined ? {} : { modelContextWindowTokens: update.size })
          }
        ];
    }
  }

  /**
   * Every agent→client request.
   *
   * `session/request_permission` gets the configured posture; everything else —
   * the `fs/*` and `terminal/*` methods AgentRoom declined at initialize, and
   * anything a newer agent invents — is refused. A conforming agent never calls
   * a capability the client did not advertise, so reaching here at all is worth
   * a log line.
   */
  private async onRequest(session: AcpSession, method: string, params: unknown): Promise<unknown> {
    if (method === "session/request_permission") {
      return { outcome: await this.decidePermission(session, params) };
    }

    logger.warn(
      { runnerKind: this.adapter.id, method },
      "ACP agent called a client capability that was not advertised"
    );
    throw new Error(`Method not available: ${method}`);
  }

  /**
   * Decide one `session/request_permission`, and say who decided it.
   *
   * The request is announced either way — a policy answer is still something
   * the transcript should show, since "the agent asked to run this and was
   * refused" is the operator's own posture taking effect. Under `ask` the
   * request is then held open for a person, bounded, with the same policy
   * answer waiting behind the clock.
   */
  private async decidePermission(
    session: AcpSession,
    params: unknown
  ): Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }> {
    const request = permissionRequestSchema.safeParse(params);
    const options = request.success ? request.data.options : [];
    // Non-empty, not merely present: an activity title is required downstream,
    // and an agent that sends `""` would otherwise drop its own request event.
    const agentTitle = request.success ? request.data.toolCall?.title : undefined;
    const title = agentTitle && agentTitle.length > 0 ? agentTitle : "Permission requested";
    // AgentRoom's own id, not the agent's: it is what the answer route
    // addresses, and an agent's id space is its own business.
    const requestId = `permission-${randomUUID()}`;
    const policy = acpPermissionPolicy(this.config, this.adapter);

    // Register before advertising. `wait` returns undefined for an empty
    // vocabulary or a session already at its pending-request cap; neither case
    // has an answer route a client could successfully call.
    const announced = Boolean(session.activeTurn && !session.activeTurn.settled);
    const wait = policy === "ask" && announced
      ? this.permissions.wait({ sessionKey: session.key, requestId, options })
      : undefined;

    this.push(session, this.activity(session, "acp_permission_request", title, {
      kind: "permission_requested",
      ...(wait ? {
        requestId,
        options: options.map((option) => ({
          optionId: option.optionId,
          ...(option.name ? { name: option.name } : {}),
          ...(option.kind ? { kind: option.kind } : {})
        }))
      } : {}),
      // What the human is being asked to allow. The agent's own tool-call
      // block, bounded by the canonical mapper like every other content it
      // carries — and deliberately not what the audit record keeps.
      request: request.success && request.data.toolCall ? { ...request.data.toolCall } : {}
    }, { nativeItemId: requestId }));

    const decision = wait
      ? await wait
      : ({ decidedBy: "policy" } as const);
    const resolved = decision.decidedBy === "human"
      ? { outcome: "selected" as const, optionId: decision.optionId }
      : this.policyOutcome(policy, options);

    this.push(session, this.activity(session, "acp_permission", title, {
      kind: "permission_resolved",
      requestId,
      status: resolved.outcome === "selected" ? "selected" : "cancelled",
      ...(resolved.outcome === "selected" ? { optionId: resolved.optionId } : {}),
      decidedBy: decision.decidedBy
    }, { nativeItemId: requestId }));

    return resolved;
  }

  /**
   * What the configured posture answers on its own: an allow option the agent
   * supplied under `auto_allow`, and otherwise the conservative response — a
   * rejection option the agent offered, else a cancel. `ask` lands here too when
   * nobody answered, which is why its fallback is the conservative one.
   */
  private policyOutcome(
    policy: AcpPermissionPolicy,
    options: readonly AcpPermissionOption[]
  ): { outcome: "selected"; optionId: string } | { outcome: "cancelled" } {
    const allow = policy === "auto_allow"
      ? options.find((option) => option.kind === "allow_once")
        ?? options.find((option) => option.kind === "allow_always")
      : undefined;
    return allow
      ? { outcome: "selected", optionId: allow.optionId }
      : conservativePermissionOutcome(options);
  }

  private push(session: AcpSession, event: AgentRunnerEvent): void {
    const turn = session.activeTurn;
    if (turn && !turn.settled) turn.queue.push(event);
  }
}
