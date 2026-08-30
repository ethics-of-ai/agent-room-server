import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { AgentSessionService } from "../../src/agent/AgentSessionService";
import { AgentTurnContextAssembler } from "../../src/agent/AgentTurnContextAssembler";
import type { EventBus } from "../../src/events/EventBus";
import type { AgentSession, ServiceConfig } from "../../src/domain/models";
import type { AgentRunner } from "../../src/runner/AgentRunner";
import { PendingQuestionRequests } from "../../src/runner/shared/PendingQuestionRequests";
import { LocalWorkspaceRegistry } from "../../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "../../src/workspace/WorkspaceExplorer";

/**
 * Shared fixtures for the four agent-session suites.
 *
 * All of this was inline in `agentSessions.test.ts` while that file was one
 * 2,240-line suite. Splitting it four ways put every stub within reach of
 * more than one file, so they live here rather than being copied. Nothing in
 * this module asserts. Each export is a config factory, a runner stub, or a
 * poll.
 *
 * The runner stubs are hand-written rather than mocked because each one
 * reproduces a specific ordering the session service has to survive, such as a
 * cancel that resolves before the generator drains its final event.
 */

const execFileAsync = promisify(execFile);

export const config = async (overrides: Partial<ServiceConfig> = {}): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-agent-sessions-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    editorCatalogDir: join(root, "catalog-assets"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexExecutable: process.execPath,
    codexArgs: ["-e", "process.stdin.on('data', chunk => process.stdout.write(`codex heard: ${chunk}`))"],
    codexRunnerProtocol: "exec",
    ...overrides
  };
};

export async function waitForSession(app: { inject: (input: { method: string; url: string }) => Promise<{ json: () => any }> }, id: string, status: string): Promise<any> {
  return waitForSessionWhere(app, id, (session) => session?.status === status, `session ${id} to become ${status}`);
}

export async function waitForSessionWhere(
  app: { inject: (input: { method: string; url: string }) => Promise<{ json: () => any }> },
  id: string,
  predicate: (session: any) => boolean,
  description: string
): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/agent-sessions/${id}` });
    const session = response.json().session;
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function waitForServiceSession(
  service: AgentSessionService,
  id: string,
  status: AgentSession["status"]
): Promise<AgentSession> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = service.getSession(id);
    if (session?.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for service session ${id} to become ${status}`);
}

export async function waitForEvent(
  eventBus: EventBus,
  type: string,
  timeoutMs = 5_000
): Promise<{ type: string; payload: any }> {
  const startedAt = Date.now();
  for (;;) {
    const event = eventBus.getRecentEvents(200).find((candidate) => candidate.type === type);
    if (event) return event;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${type}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function newAgentSessionService(
  registry: LocalWorkspaceRegistry,
  runners: Partial<Record<"codex" | "claude_code", AgentRunner>>,
  eventBus: EventBus
): AgentSessionService {
  return new AgentSessionService({
    registry,
    runners,
    eventBus,
    contextAssembler: new AgentTurnContextAssembler({
      workspaceExplorer: new WorkspaceExplorer(registry),
      attachments: {
        async inputPartsForTurn() {
          return [];
        },
        async contextAttachmentsForTurn() {
          return [];
        }
      }
    })
  });
}

export function lateTokenUsageAfterCancelRunner(): AgentRunner & { completed: Promise<void> } {
  let releaseCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    completed,
    async getCapabilities() {
      return {
        runnerKind: "codex",
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run() {
      await cancelled;
      try {
        yield {
          type: "token_usage_updated",
          inputTokens: 123,
          cachedInputTokens: 23,
          outputTokens: 7,
          reasoningOutputTokens: 3,
          totalTokens: 130,
          modelContextWindowTokens: 258400
        };
        yield {
          type: "run_succeeded",
          message: "done"
        };
      } finally {
        complete();
      }
    },
    async cancel() {
      releaseCancel();
    }
  };
}

/**
 * A runner reporting live occupancy, with or without the auto-compaction
 * threshold beside it. Only the runner can supply that threshold, and nothing
 * in the service reads which runner did.
 */
export function compactionThresholdRunner({ reportThreshold = true }: { reportThreshold?: boolean } = {}): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield {
        type: "token_usage_updated",
        contextWindowUsedTokens: 12_000,
        ...(reportThreshold ? { contextCompactionThresholdTokens: 160_000 } : {})
      };
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {}
  };
}

export function changingCompactionThresholdRunner(): AgentRunner {
  let runCount = 0;
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      runCount += 1;
      yield {
        type: "token_usage_updated",
        contextWindowUsedTokens: 12_000,
        contextCompactionThresholdTokens: runCount === 1 ? 160_000 : null
      };
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {}
  };
}

// Mirrors a runner whose cancel() resolves before the run() generator drains
// its final failure event, the ordering deleteSession must tolerate.
export function lateFailureAfterCancelRunner(): AgentRunner & { completed: Promise<void> } {
  let releaseCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    completed,
    async getCapabilities() {
      return {
        runnerKind: "codex",
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run() {
      await cancelled;
      try {
        yield {
          type: "run_failed",
          error: "turn interrupted"
        };
      } finally {
        complete();
      }
    },
    async cancel() {
      releaseCancel();
    }
  };
}

export const PERMISSION_REQUEST_ID = "permission-test-1";
export const PERMISSION_ALLOW_OPTION_ID = " allow-1 ";

/**
 * A runner that asks permission mid-turn and waits for the answer, the way an
 * ACP adapter under the `ask` posture does — without needing a child process.
 * The route and the audit record are what these tests are about; the adapter's
 * own wait is covered against the synthetic agent in `acpRunner.test.ts`.
 */
export function permissionAskingRunner(): AgentRunner {
  const options = [
    { optionId: PERMISSION_ALLOW_OPTION_ID, kind: "allow_once", name: "Allow" },
    { optionId: "reject-1", kind: "reject_once", name: "Reject" }
  ];
  let answer!: (optionId: string) => void;
  const answered = new Promise<string>((resolve) => {
    answer = resolve;
  });
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_permission_request",
          title: "Run rm -rf /tmp/everything",
          content: {},
          canonical: {
            kind: "permission_requested",
            requestId: PERMISSION_REQUEST_ID,
            options,
            request: { title: "Run rm -rf /tmp/everything", command: "rm -rf /tmp/everything" }
          }
        }
      };
      const optionId = await answered;
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_permission_resolved",
          title: "Run rm -rf /tmp/everything",
          content: {},
          canonical: {
            kind: "permission_resolved",
            requestId: PERMISSION_REQUEST_ID,
            status: "selected",
            optionId,
            decidedBy: "human"
          }
        }
      };
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {},
    answerPermissionRequest(input) {
      if (input.requestId !== PERMISSION_REQUEST_ID) return "unknown_request";
      if (!options.some((option) => option.optionId === input.optionId)) return "unknown_option";
      answer(input.optionId);
      return "answered";
    }
  };
}

export const QUESTION_REQUEST_ID = "question-test-1";
const QUESTION_SETS = [
  {
    setId: "set-1",
    header: "Platform",
    prompt: "Which platform first?",
    selection: "single" as const,
    options: [
      { optionId: "opt-1", label: "Web" },
      { optionId: "opt-2", label: "Mobile", description: "iOS and Android" }
    ],
    discussion: "optional" as const
  },
  {
    setId: "set-2",
    header: "Features",
    prompt: "Which features matter?",
    selection: "multiple" as const,
    options: [
      { optionId: "opt-1", label: "Reminders" },
      { optionId: "opt-2", label: "Tags" },
      { optionId: "opt-3", label: "Sharing" }
    ],
    discussion: "none" as const
  }
];

/**
 * A runner that pauses mid-turn to ask a clarifying-question batch and waits
 * for the answer, the way the Claude Code adapter does through the SDK
 * callback — without a child process. Validation is the shared store's rule,
 * reused so the route's refusals are the real ones.
 */
export function questionAskingRunner(): AgentRunner {
  const pending = new PendingQuestionRequests({ timeoutMs: 5_000 });
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run(input) {
      const sessionKey = input.sessionId ?? input.runId;
      const wait = pending.wait({ sessionKey, requestId: QUESTION_REQUEST_ID, sets: QUESTION_SETS })!;
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_question_requested",
          title: "Questions for you",
          content: {},
          canonical: { kind: "question_requested", requestId: QUESTION_REQUEST_ID, questionSets: QUESTION_SETS }
        }
      };
      const outcome = await wait;
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_question_resolved",
          title: "Questions answered",
          content: {},
          canonical: {
            kind: "question_resolved",
            requestId: QUESTION_REQUEST_ID,
            status: outcome.status,
            ...("decidedBy" in outcome ? { decidedBy: outcome.decidedBy } : {}),
            ...(outcome.status === "answered" ? { questionAnswers: outcome.answers } : {})
          }
        }
      };
      yield { type: "run_succeeded", message: "done" };
    },
    async cancel() {},
    answerQuestionRequest(input) {
      return pending.answer(input.sessionId, input.requestId, input.answers);
    }
  };
}

/** A child-loss shape: the request was published, but no resolution survived. */
export function abandonedQuestionRunner(): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_question_requested",
          title: "Questions for you",
          content: {},
          canonical: { kind: "question_requested", requestId: QUESTION_REQUEST_ID, questionSets: QUESTION_SETS }
        }
      };
      yield { type: "run_failed", error: "child exited" };
    },
    async cancel() {}
  };
}

export function fileWritingRunner(
  runnerKind: "codex" | "claude_code",
  write: (workspacePath: string) => Promise<void>
): AgentRunner {
  return {
    async getCapabilities() {
      return {
        runnerKind,
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run(input) {
      await write(input.workspacePath);
      yield {
        type: "run_succeeded",
        message: "done"
      };
    },
    async cancel() {}
  };
}

export function writeThenHangRunner(write: (workspacePath: string) => Promise<void>): AgentRunner & { wrote: Promise<void> } {
  let releaseCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  let markWrote!: () => void;
  const wrote = new Promise<void>((resolve) => {
    markWrote = resolve;
  });
  return {
    wrote,
    async getCapabilities() {
      return {
        runnerKind: "claude_code",
        settings: {
          models: [],
          defaultSettings: {}
        }
      };
    },
    validateInputParts() {},
    async *run(input) {
      await write(input.workspacePath);
      markWrote();
      await cancelled;
    },
    async cancel() {
      releaseCancel();
    }
  };
}

/**
 * A runner that reports a native session id at start and records the seeds the
 * service hands it, the way the four host-backed adapters do — without a child
 * process. Which id it reports is the test's choice, so a resume the runner
 * did not honor can be simulated by reporting a different one.
 */
export function nativeSessionRunner(
  nativeSessionId: string,
  options: { seeds?: Array<{ sessionId: string; nativeSessionId: string; interrupted: boolean }> } = {}
): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "claude_code", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      yield {
        type: "agent_activity",
        activity: {
          kind: "test_session_started",
          title: "Session started",
          content: {},
          canonical: { kind: "session_started" },
          runner: { nativeSessionId, model: "test-model", cwd: "/tmp/workspace" }
        }
      };
      yield { type: "run_succeeded", message: "noted" };
    },
    async cancel() {},
    ...(options.seeds
      ? {
          rememberResumableId(input: { sessionId: string; nativeSessionId: string; interrupted: boolean }) {
            options.seeds?.push({ ...input });
          }
        }
      : {})
  };
}

export function nativeSessionSequenceRunner(nativeSessionIds: Array<string | undefined>): AgentRunner {
  return {
    async getCapabilities() {
      return { runnerKind: "claude_code", settings: { models: [], defaultSettings: {} } };
    },
    validateInputParts() {},
    async *run() {
      for (const nativeSessionId of nativeSessionIds) {
        yield {
          type: "agent_activity" as const,
          activity: {
            kind: "test_session_started",
            title: "Session started",
            content: {},
            canonical: { kind: "session_started" as const },
            runner: {
              ...(nativeSessionId ? { nativeSessionId } : {}),
              model: "test-model",
              cwd: "/tmp/workspace"
            }
          }
        };
      }
      yield { type: "run_succeeded" as const, message: "noted" };
    },
    async cancel() {}
  };
}

export async function createGitWorkspace(): Promise<string> {
  const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-git-workspace-"));
  await git(selectedDirectory, "init", "-b", "main");
  await git(selectedDirectory, "config", "user.email", "agentroom@example.invalid");
  await git(selectedDirectory, "config", "user.name", "AgentRoom Tests");
  await writeFile(join(selectedDirectory, "README.md"), "# Workspace\n");
  await git(selectedDirectory, "add", "README.md");
  await git(selectedDirectory, "commit", "-m", "Initial commit");
  return selectedDirectory;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

export function multipartFilePayload(input: {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `agentroom-test-${Math.random().toString(16).slice(2)}`;
  const prefix = Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="${input.fieldName}"; filename="${input.filename}"`,
    `Content-Type: ${input.contentType}`,
    "",
    ""
  ].join("\r\n"));
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([prefix, input.data, suffix])
  };
}

export async function writeCompletingJsonRpcServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentroom-agent-sessions-jsonrpc-"));
  const path = join(root, "fake-completing-codex.cjs");
  await writeFile(path, `
const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function thread() {
  return {
    id: "codex-thread-agent-sessions",
    status: "running",
    cwd: "/tmp/workspace",
    turns: []
  };
}

function turn(status) {
  return {
    id: "codex-turn-agent-sessions",
    status,
    items: [],
    error: null
  };
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" } });
    return;
  }
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    send({ method: "thread/started", params: { thread: thread(), model: "gpt-test", cwd: "/tmp/workspace", approvalPolicy: "never", sandbox: "workspace-write" } });
    return;
  }
  if (message.method === "turn/start") {
    const currentTurn = turn("inProgress");
    send({ id: message.id, result: { turn: currentTurn } });
    send({ method: "turn/started", params: { threadId: "codex-thread-agent-sessions", turn: currentTurn } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-agent-sessions", turn: { ...currentTurn, status: "completed" } } });
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

/** Register a workspace through the registry alone, before any server is built. */
export async function registerWorkspaceOffline(serviceConfig: ServiceConfig): Promise<{ id: string; path: string }> {
  const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-agent-workspace-"));
  const registry = new LocalWorkspaceRegistry(serviceConfig);
  const registered = await registry.register({ path: selectedDirectory });
  return { id: registered.workspace.id, path: registered.workspace.path };
}

export async function writeSessionDocument(serviceConfig: ServiceConfig, document: Record<string, unknown>): Promise<void> {
  const directory = join(serviceConfig.stateDir, "sessions");
  await mkdir(directory, { recursive: true });
  const session = document.session as { id: string };
  await writeFile(join(directory, `${session.id}.json`), JSON.stringify(document));
}

/** A version-1 session document as the store writes it, with one settled turn. */
export function sessionDocument(
  sessionId: string,
  workspace: { id: string; path: string },
  options: { runnerKind: string; nativeSessionId?: string; running?: boolean }
): Record<string, unknown> {
  const turnId = `turn-${sessionId}`;
  return {
    schemaVersion: 1,
    session: {
      id: sessionId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      runnerKind: options.runnerKind,
      ...(options.nativeSessionId ? { runner: { nativeSessionId: options.nativeSessionId } } : {}),
      status: options.running ? "running" : "idle",
      ...(options.running ? { activeTurnId: turnId } : {}),
      turnCount: options.running ? 0 : 1,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:10.000Z"
    },
    turns: [
      {
        id: turnId,
        sessionId,
        status: options.running ? "running" : "succeeded",
        startedAt: "2026-08-26T00:00:00.000Z",
        ...(options.running ? {} : { completedAt: "2026-08-26T00:00:10.000Z" }),
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15
      }
    ],
    messages: [
      {
        id: `message-${sessionId}-user`,
        sessionId,
        turnId,
        role: "user",
        content: "hello",
        status: "sent",
        at: "2026-08-26T00:00:00.000Z"
      },
      {
        id: `message-${sessionId}-assistant`,
        sessionId,
        turnId,
        role: "assistant",
        content: options.running ? "partial" : "hi",
        status: options.running ? "running" : "succeeded",
        at: "2026-08-26T00:00:10.000Z"
      }
    ]
  };
}

