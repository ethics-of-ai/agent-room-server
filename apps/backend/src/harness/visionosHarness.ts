import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import type { EventBus } from "../events/EventBus";
import { codingAgentEventPayloadSchema } from "../protocol/coding/events";
import type { LocalWorkspaceRegistry } from "../workspace/LocalWorkspaceRegistry";

const MAX_OUTPUT_LENGTH = 20_000;
const MAX_DIAGNOSTICS = 50;
const XCODEGEN_TIMEOUT_MS = 120_000;
const XCODEBUILD_TIMEOUT_MS = 300_000;

export class VisionOSHarnessError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface VisionOSHarnessContext {
  workspaceId: string;
  sessionId: string;
  turnId: string;
}

export interface VisionOSXcodebuildInput extends VisionOSHarnessContext {
  action: "build" | "test";
  onlyTesting?: string;
}

export interface HarnessCommandInvocation {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  onOutput: (chunk: HarnessCommandOutput) => void;
}

export interface HarnessCommandOutput {
  stream: "stdout" | "stderr";
  text: string;
}

export interface HarnessCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type HarnessCommandRunner = (invocation: HarnessCommandInvocation) => Promise<HarnessCommandResult>;

export interface VisionOSHarnessResult {
  action: "xcodegen" | "xcodebuild";
  workspaceId: string;
  cwd: string;
  command: {
    executableName: string;
    argsCount: number;
  };
  status: "succeeded" | "failed";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  diagnostics: string[];
}

export class VisionOSHarness {
  constructor(
    private readonly registry: LocalWorkspaceRegistry,
    private readonly eventBus: EventBus,
    private readonly options: {
      runCommand?: HarnessCommandRunner;
      xcodegenExecutable?: string;
      xcodebuildExecutable?: string;
      /**
       * Resolve the runner id the supplied session actually runs. The harness
       * snapshots it once per command so start, output, and completion keep one
       * attribution even if the session disappears while the child runs.
       * Required rather than defaulted, because the fixed `"codex"` this
       * replaced silently misreported every Claude Code session's activity — a
       * caller has to say what an unresolvable session falls back to.
       */
      resolveRunnerKind: (sessionId: string) => string | undefined;
      defaultRunnerKind: string;
    }
  ) {}

  async runXcodegen(input: VisionOSHarnessContext): Promise<VisionOSHarnessResult> {
    const cwd = await this.requireVisionOSProjectDirectory(input.workspaceId);
    return await this.runFixedCommand({
      context: input,
      action: "xcodegen",
      activityKind: "visionos_xcodegen",
      title: "visionOS XcodeGen",
      executable: this.options.xcodegenExecutable ?? "xcodegen",
      args: ["generate"],
      cwd,
      timeoutMs: XCODEGEN_TIMEOUT_MS
    });
  }

  async runXcodebuild(input: VisionOSXcodebuildInput): Promise<VisionOSHarnessResult> {
    const cwd = await this.requireVisionOSProjectDirectory(input.workspaceId);
    const args = [
      input.action,
      "-project",
      "AgentRoom.xcodeproj",
      "-scheme",
      "AgentRoom",
      "-destination",
      "platform=visionOS Simulator,name=Apple Vision Pro",
      "CODE_SIGNING_ALLOWED=NO",
      ...(input.onlyTesting ? [`-only-testing:${input.onlyTesting}`] : [])
    ];
    return await this.runFixedCommand({
      context: input,
      action: "xcodebuild",
      activityKind: "visionos_xcodebuild",
      title: input.action === "test" ? "visionOS xcodebuild test" : "visionOS xcodebuild build",
      executable: this.options.xcodebuildExecutable ?? "xcodebuild",
      args,
      cwd,
      timeoutMs: XCODEBUILD_TIMEOUT_MS
    });
  }

  private async runFixedCommand(input: {
    context: VisionOSHarnessContext;
    action: "xcodegen" | "xcodebuild";
    activityKind: string;
    title: string;
    executable: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }): Promise<VisionOSHarnessResult> {
    const startedAt = Date.now();
    const runnerKind = this.options.resolveRunnerKind(input.context.sessionId) ?? this.options.defaultRunnerKind;
    const command = {
      executableName: basename(input.executable),
      argsCount: input.args.length
    };
    this.publishActivity("coding_tool_activity_started", input.context, runnerKind, {
      kind: input.activityKind,
      title: input.title,
      content: {
        action: input.action,
        status: "running",
        cwd: input.cwd,
        command
      }
    });
    const runner = this.options.runCommand ?? runCommand;
    const result = await runner({
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      onOutput: (chunk) => {
        const text = clampOutput(chunk.text);
        this.publishActivity("coding_tool_activity_updated", input.context, runnerKind, {
          kind: input.activityKind,
          title: input.title,
          content: {
            action: input.action,
            status: "running",
            stream: chunk.stream,
            text
          }
        }, text);
      }
    });
    const durationMs = Date.now() - startedAt;
    const status = result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed";
    const diagnostics = collectDiagnostics(result.stdout, result.stderr);
    const response: VisionOSHarnessResult = {
      action: input.action,
      workspaceId: input.context.workspaceId,
      cwd: input.cwd,
      command,
      status,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs,
      stdout: clampOutput(result.stdout),
      stderr: clampOutput(result.stderr),
      diagnostics
    };
    this.publishActivity("coding_tool_activity_completed", input.context, runnerKind, {
      kind: input.activityKind,
      title: input.title,
      content: { ...response }
    });
    return response;
  }

  private async requireVisionOSProjectDirectory(workspaceId: string): Promise<string> {
    const workspace = await this.registry.findByIdWithoutGitRefresh(workspaceId);
    if (!workspace) {
      throw new VisionOSHarnessError("Workspace is not registered", 404);
    }
    const workspacePath = await realpath(workspace.path);
    const visionOSPath = await realpath(join(workspacePath, "apps", "visionos")).catch(() => undefined);
    if (!visionOSPath || !isInside(workspacePath, visionOSPath)) {
      throw new VisionOSHarnessError("visionOS project must stay inside the registered workspace");
    }
    const projectStat = await stat(join(visionOSPath, "project.yml")).catch(() => undefined);
    if (!projectStat?.isFile()) {
      throw new VisionOSHarnessError("apps/visionos/project.yml was not found", 404);
    }
    return visionOSPath;
  }

  private publishActivity(
    type: "coding_tool_activity_started" | "coding_tool_activity_updated" | "coding_tool_activity_completed",
    context: VisionOSHarnessContext,
    runnerKind: string,
    activity: {
      kind: string;
      title: string;
      content: Record<string, unknown>;
    },
    delta?: string
  ): void {
    const parsed = codingAgentEventPayloadSchema.safeParse({
      type,
      version: 1,
      sessionId: context.sessionId,
      turnId: context.turnId,
      runnerKind,
      ...(delta ? { delta } : {}),
      activity
    });
    if (parsed.success) {
      this.eventBus.publish(parsed.data.type, parsed.data);
    }
  }
}

async function runCommand(invocation: HarnessCommandInvocation): Promise<HarnessCommandResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKill: NodeJS.Timeout | undefined;
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, invocation.timeoutMs);

    const clearTimers = (): void => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = clampOutput(stdout + text);
      invocation.onOutput({ stream: "stdout", text });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = clampOutput(stderr + text);
      invocation.onOutput({ stream: "stderr", text });
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        exitCode: null,
        stdout,
        stderr: clampOutput(`${stderr}${error.message}`),
        timedOut
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut
      });
    });
  });
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function clampOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_LENGTH) return value;
  return value.slice(value.length - MAX_OUTPUT_LENGTH);
}

function collectDiagnostics(stdout: string, stderr: string): string[] {
  return [...stdout.split(/\r?\n/u), ...stderr.split(/\r?\n/u)]
    .map((line) => line.trim())
    .filter((line) => /\b(error|warning):/iu.test(line) || /\*\* (TEST|BUILD) FAILED \*\*/u.test(line))
    .slice(0, MAX_DIAGNOSTICS);
}
