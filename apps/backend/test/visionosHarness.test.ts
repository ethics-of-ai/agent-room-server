import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceConfig } from "../src/domain/models";
import { EventBus } from "../src/events/EventBus";
import { VisionOSHarness, VisionOSHarnessError, type HarnessCommandInvocation } from "../src/harness/visionosHarness";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";

const config = async (): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-visionos-harness-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: root,
    stateDir: join(root, ".state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: []
  };
};

describe("VisionOS harness", () => {
  // Harness activity used to be stamped `runnerKind: "codex"` regardless of the
  // session that asked for it, so a Claude Code session's XcodeGen run was
  // misattributed. Cover both current runner kinds.
  for (const sessionRunnerKind of ["codex", "claude_code"] as const) {
    it(`runs XcodeGen only inside a registered AgentRoom workspace and attributes activity to its ${sessionRunnerKind} session`, async () => {
    const serviceConfig = await config();
    const workspacePath = await makeVisionOSWorkspace(serviceConfig.workspaceRoot);
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: fakeGit });
    const { workspace } = await registry.register({ path: workspacePath, name: "AgentRoom" });
    const eventBus = new EventBus();
    const events: Array<{ type: string; payload: unknown }> = [];
    eventBus.subscribe((event) => events.push({ type: event.type, payload: event.payload }));
    const invocations: HarnessCommandInvocation[] = [];
    const harness = new VisionOSHarness(registry, eventBus, {
      resolveRunnerKind: () => sessionRunnerKind,
      defaultRunnerKind: "codex",
      runCommand: async (invocation) => {
        invocations.push(invocation);
        invocation.onOutput({ stream: "stdout", text: "Created project\n" });
        return {
          exitCode: 0,
          stdout: "Created project\n",
          stderr: "",
          timedOut: false
        };
      }
    });

    const result = await harness.runXcodegen({
      workspaceId: workspace.id,
      sessionId: "agent-session-1",
      turnId: "agent-turn-1"
    });

    const visionOSPath = await realpath(join(workspacePath, "apps", "visionos"));
    expect(result.status).toBe("succeeded");
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      executable: "xcodegen",
      args: ["generate"],
      cwd: visionOSPath
    });
    expect(events.map((event) => event.type)).toEqual([
      "coding_tool_activity_started",
      "coding_tool_activity_updated",
      "coding_tool_activity_completed"
    ]);
    expect(events.map((event) => (event.payload as { runnerKind: string }).runnerKind)).toEqual([
      sessionRunnerKind,
      sessionRunnerKind,
      sessionRunnerKind
    ]);
    expect(events[2]?.payload).toMatchObject({
      type: "coding_tool_activity_completed",
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      runnerKind: sessionRunnerKind,
      activity: {
        kind: "visionos_xcodegen",
        content: {
          status: "succeeded",
          stdout: "Created project\n"
        }
      }
    });
    });
  }

  it("keeps one runner attribution when the session disappears during a command", async () => {
    const serviceConfig = await config();
    const workspacePath = await makeVisionOSWorkspace(serviceConfig.workspaceRoot);
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: fakeGit });
    const { workspace } = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const events: Array<{ type: string; payload: unknown }> = [];
    eventBus.subscribe((event) => events.push({ type: event.type, payload: event.payload }));
    let resolutionCount = 0;
    const harness = new VisionOSHarness(registry, eventBus, {
      resolveRunnerKind: () => resolutionCount++ === 0 ? "claude_code" : undefined,
      defaultRunnerKind: "codex",
      runCommand: async (invocation) => {
        invocation.onOutput({ stream: "stdout", text: "Still running\n" });
        return {
          exitCode: 0,
          stdout: "Still running\n",
          stderr: "",
          timedOut: false
        };
      }
    });

    await harness.runXcodegen({
      workspaceId: workspace.id,
      sessionId: "agent-session-1",
      turnId: "agent-turn-1"
    });

    expect(resolutionCount).toBe(1);
    expect(events.map((event) => (event.payload as { runnerKind: string }).runnerKind)).toEqual([
      "claude_code",
      "claude_code",
      "claude_code"
    ]);
  });

  it("uses fixed xcodebuild arguments for targeted visionOS checks", async () => {
    const serviceConfig = await config();
    const workspacePath = await makeVisionOSWorkspace(serviceConfig.workspaceRoot);
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: fakeGit });
    const { workspace } = await registry.register({ path: workspacePath });
    const invocations: HarnessCommandInvocation[] = [];
    const harness = new VisionOSHarness(registry, new EventBus(), {
      resolveRunnerKind: () => "codex",
      defaultRunnerKind: "codex",
      runCommand: async (invocation) => {
        invocations.push(invocation);
        return {
          exitCode: 0,
          stdout: "Test Suite passed\n",
          stderr: "",
          timedOut: false
        };
      }
    });

    await harness.runXcodebuild({
      workspaceId: workspace.id,
      sessionId: "agent-session-1",
      turnId: "agent-turn-1",
      action: "test",
      onlyTesting: "AgentRoomTests/CodingAgentRendererStateTests"
    });

    const visionOSPath = await realpath(join(workspacePath, "apps", "visionos"));
    expect(invocations[0]?.executable).toBe("xcodebuild");
    expect(invocations[0]?.cwd).toBe(visionOSPath);
    expect(invocations[0]?.args).toEqual([
      "test",
      "-project",
      "AgentRoom.xcodeproj",
      "-scheme",
      "AgentRoom",
      "-destination",
      "platform=visionOS Simulator,name=Apple Vision Pro",
      "CODE_SIGNING_ALLOWED=NO",
      "-only-testing:AgentRoomTests/CodingAgentRendererStateTests"
    ]);
  });

  it("bounds live output in coding activity update events", async () => {
    const serviceConfig = await config();
    const workspacePath = await makeVisionOSWorkspace(serviceConfig.workspaceRoot);
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: fakeGit });
    const { workspace } = await registry.register({ path: workspacePath });
    const eventBus = new EventBus();
    const events: Array<{ type: string; payload: unknown }> = [];
    eventBus.subscribe((event) => events.push({ type: event.type, payload: event.payload }));
    const longOutput = `prefix-${"x".repeat(25_000)}`;
    const harness = new VisionOSHarness(registry, eventBus, {
      resolveRunnerKind: () => "codex",
      defaultRunnerKind: "codex",
      runCommand: async (invocation) => {
        invocation.onOutput({ stream: "stdout", text: longOutput });
        return {
          exitCode: 0,
          stdout: longOutput,
          stderr: "",
          timedOut: false
        };
      }
    });

    await harness.runXcodegen({
      workspaceId: workspace.id,
      sessionId: "agent-session-1",
      turnId: "agent-turn-1"
    });

    const updatePayload = events.find((event) => event.type === "coding_tool_activity_updated")?.payload as {
      delta?: string;
      activity?: {
        content?: {
          text?: string;
        };
      };
    };
    expect(updatePayload.delta?.length).toBeLessThanOrEqual(20_000);
    expect(updatePayload.activity?.content?.text?.length).toBeLessThanOrEqual(20_000);
    expect(updatePayload.delta).not.toContain("prefix-");
  });

  it("rejects a visionOS project path that resolves outside the registered workspace", async () => {
    const serviceConfig = await config();
    const workspacePath = join(serviceConfig.workspaceRoot, "workspace");
    const externalVisionOSPath = join(serviceConfig.workspaceRoot, "external-visionos");
    await mkdir(join(workspacePath, "apps"), { recursive: true });
    await mkdir(externalVisionOSPath, { recursive: true });
    await writeFile(join(externalVisionOSPath, "project.yml"), "name: AgentRoom\n");
    await symlink(externalVisionOSPath, join(workspacePath, "apps", "visionos"), "dir");
    const registry = new LocalWorkspaceRegistry(serviceConfig, { runGit: fakeGit });
    const { workspace } = await registry.register({ path: workspacePath });
    const harness = new VisionOSHarness(registry, new EventBus(), {
      resolveRunnerKind: () => "codex",
      defaultRunnerKind: "codex",
      runCommand: async () => {
        throw new Error("command should not run");
      }
    });

    await expect(harness.runXcodegen({
      workspaceId: workspace.id,
      sessionId: "agent-session-1",
      turnId: "agent-turn-1"
    })).rejects.toBeInstanceOf(VisionOSHarnessError);
  });
});

async function makeVisionOSWorkspace(root: string): Promise<string> {
  const workspacePath = join(root, "workspace");
  const visionOSPath = join(workspacePath, "apps", "visionos");
  await mkdir(visionOSPath, { recursive: true });
  await writeFile(join(visionOSPath, "project.yml"), "name: AgentRoom\n");
  return workspacePath;
}

async function fakeGit(): Promise<{ stdout: string; stderr: string }> {
  return { stdout: "false\n", stderr: "" };
}
