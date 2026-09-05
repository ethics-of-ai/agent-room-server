import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAttachmentStore } from "../src/agent/AgentAttachmentStore";
import { AgentSessionService } from "../src/agent/AgentSessionService";
import { AgentTurnContextAssembler } from "../src/agent/AgentTurnContextAssembler";
import type { AgentSession, ServiceConfig } from "../src/domain/models";
import { EventBus } from "../src/events/EventBus";
import { AgentRunnerInputError, type AgentRunner, type AgentRunnerInput } from "../src/runner/AgentRunner";
import { LocalWorkspaceRegistry } from "../src/workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "../src/workspace/WorkspaceExplorer";

const config = async (): Promise<ServiceConfig> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-turn-context-"));
  return {
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: join(root, "workspaces"),
    stateDir: join(root, "state"),
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    codexRunnerProtocol: "exec"
  };
};

describe("agent turn context assembler", () => {
  it("returns the original prompt and no input parts when no context is supplied", async () => {
    const { assembler, session } = await createAssemblerFixture();

    const assembled = await assembler.assemble({
      session,
      message: "Inspect this workspace."
    });

    expect(assembled).toEqual({
      prompt: "Inspect this workspace.",
      inputParts: []
    });
  });

  it("prepends artifact and diagram contracts for Codex turns", async () => {
    const { assembler, session } = await createAssemblerFixture({
      artifactInstruction: "artifact contract",
      diagramInstruction: "diagram contract"
    });

    const assembled = await assembler.assemble({
      session,
      message: "Design the checkout flow."
    });

    expect(assembled.prompt).toBe(
      "artifact contract\n\ndiagram contract\n\nDesign the checkout flow."
    );
  });

  it("leaves the diagram contract to Claude Code's system prompt", async () => {
    const { assembler, session } = await createAssemblerFixture({
      artifactInstruction: "artifact contract",
      diagramInstruction: "diagram contract"
    });
    session.runnerKind = "claude_code";

    const assembled = await assembler.assemble({
      session,
      message: "Design the checkout flow."
    });

    expect(assembled.prompt).toBe("artifact contract\n\nDesign the checkout flow.");
  });

  it("delivers the prompt-contract question instruction only to DeepSeek", async () => {
    const fixture = await createAssemblerFixture();

    fixture.session.runnerKind = "deepseek";
    const deepseek = await fixture.assembler.assemble({ session: fixture.session, message: "Plan this work." });
    fixture.session.runnerKind = "codex";
    const codex = await fixture.assembler.assemble({ session: fixture.session, message: "Plan this work." });
    fixture.session.runnerKind = "claude_code";
    const claudeCode = await fixture.assembler.assemble({ session: fixture.session, message: "Plan this work." });

    expect(deepseek.prompt).toContain("<agentroom-question>");
    expect(deepseek.prompt).toContain("\n\nPlan this work.");
    expect(codex.prompt).toBe("Plan this work.");
    expect(claudeCode.prompt).toBe("Plan this work.");
  });

  it("omits the prompt-contract question instruction when the channel is disabled", async () => {
    const fixture = await createAssemblerFixture({ clarifyingQuestionsEnabled: false });
    fixture.session.runnerKind = "deepseek";

    const assembled = await fixture.assembler.assemble({ session: fixture.session, message: "Plan this work." });

    expect(assembled.prompt).toBe("Plan this work.");
  });

  it("appends the human-edit summary after the standing diagram contract", async () => {
    const { assembler, session } = await createAssemblerFixture({
      diagramInstruction: "diagram contract",
      diagramHumanEdits: { async prepareSummaryForTurn() { return preparedSummary("human moved orders"); } }
    });

    const assembled = await assembler.assemble({ session, message: "Update the diagram." });

    expect(assembled.prompt).toBe(
      "diagram contract\n\nhuman moved orders\n\nUpdate the diagram."
    );
  });

  it("delivers the human-edit summary per turn to Claude Code, whose contract is a system prompt", async () => {
    const { assembler, session } = await createAssemblerFixture({
      diagramInstruction: "diagram contract",
      diagramHumanEdits: { async prepareSummaryForTurn() { return preparedSummary("human moved orders"); } }
    });
    session.runnerKind = "claude_code";

    const assembled = await assembler.assemble({ session, message: "Update the diagram." });

    // The stable contract stays in the SDK system prompt; the volatile summary
    // cannot live there, so it arrives with the next accepted turn.
    expect(assembled.prompt).toBe("human moved orders\n\nUpdate the diagram.");
  });

  it("orders render feedback after the contract and before the human-edit summary", async () => {
    const { assembler, session } = await createAssemblerFixture({
      diagramInstruction: "diagram contract",
      diagramRenderFeedback: { async prepareSummaryForTurn() { return preparedSummary("your diagram rendered with warnings"); } },
      diagramHumanEdits: { async prepareSummaryForTurn() { return preparedSummary("human moved orders"); } }
    });

    const assembled = await assembler.assemble({ session, message: "Update the diagram." });

    expect(assembled.prompt).toBe(
      "diagram contract\n\nyour diagram rendered with warnings\n\nhuman moved orders\n\nUpdate the diagram."
    );
  });

  it("delivers render feedback per turn to Claude Code, whose contract is a system prompt", async () => {
    const { assembler, session } = await createAssemblerFixture({
      diagramInstruction: "diagram contract",
      diagramRenderFeedback: { async prepareSummaryForTurn() { return preparedSummary("your diagram rendered with warnings"); } }
    });
    session.runnerKind = "claude_code";

    const assembled = await assembler.assemble({ session, message: "Update the diagram." });

    expect(assembled.prompt).toBe("your diagram rendered with warnings\n\nUpdate the diagram.");
  });

  it("acknowledges both volatile summaries through one acknowledgePromptContext", async () => {
    let humanAcknowledged = false;
    let feedbackAcknowledged = false;
    const { assembler, session } = await createAssemblerFixture({
      diagramRenderFeedback: {
        async prepareSummaryForTurn() {
          return { summary: "your diagram rendered with warnings", acknowledge() { feedbackAcknowledged = true; } };
        }
      },
      diagramHumanEdits: {
        async prepareSummaryForTurn() {
          return { summary: "human moved orders", acknowledge() { humanAcknowledged = true; } };
        }
      }
    });

    const assembled = await assembler.assemble({ session, message: "Update the diagram." });

    // Assembly alone consumes nothing: only an accepted turn acknowledges.
    expect(humanAcknowledged).toBe(false);
    expect(feedbackAcknowledged).toBe(false);
    assembled.acknowledgePromptContext?.();
    expect(humanAcknowledged).toBe(true);
    expect(feedbackAcknowledged).toBe(true);
  });

  it("adds nothing when the human has adjusted nothing since the last turn", async () => {
    const { assembler, session } = await createAssemblerFixture({
      diagramHumanEdits: { async prepareSummaryForTurn() { return undefined; } }
    });

    const assembled = await assembler.assemble({ session, message: "Update the diagram." });

    expect(assembled.prompt).toBe("Update the diagram.");
  });

  it("does not acknowledge a human-edit summary when runner input validation rejects the turn", async () => {
    let acknowledged = false;
    const { assembler, registry } = await createAssemblerFixture({
      diagramHumanEdits: {
        async prepareSummaryForTurn() {
          return {
            summary: "human moved orders",
            acknowledge() { acknowledged = true; }
          };
        }
      }
    });
    const service = new AgentSessionService({
      registry,
      runners: {
        codex: {
          async getCapabilities() {
            return { runnerKind: "codex", settings: { models: [], defaultSettings: {} } };
          },
          validateInputParts() {
            throw new AgentRunnerInputError("Image attachments are unavailable", 400);
          },
          async *run() {
            yield { type: "run_succeeded" as const };
          },
          async cancel() {}
        }
      },
      eventBus: new EventBus(),
      contextAssembler: assembler
    });
    const workspaceId = (await registry.list()).workspaces[0]!.id;
    const session = await service.createSession({ workspaceId });

    await expect(service.startTurn({ sessionId: session.id, message: "Retry this turn." })).rejects.toMatchObject({
      statusCode: 400,
      message: "Image attachments are unavailable"
    });

    expect(acknowledged).toBe(false);
  });

  it("injects bounded workspace previews for selected context paths", async () => {
    const { assembler, selectedDirectory, session } = await createAssemblerFixture();
    await writeFile(join(selectedDirectory, "README.md"), `${"A".repeat(25 * 1024)}\nDo not include this tail.\n`);

    const assembled = await assembler.assemble({
      session,
      message: "Use the selected file.",
      context: { paths: ["README.md"] }
    });

    expect(assembled.inputParts).toEqual([]);
    expect(assembled.prompt).toContain("User selected workspace context:");
    expect(assembled.prompt).toContain("File: README.md");
    expect(assembled.prompt).toContain("User message:\n\nUse the selected file.");
    expect(assembled.prompt).toContain("[File preview truncated]");
    expect(assembled.prompt).not.toContain("Do not include this tail.");
  });

  it("resolves image attachment ids to local image input parts", async () => {
    const { assembler, attachments, serviceConfig, session } = await createAssemblerFixture();
    const imageBytes = pngBytes();
    const attachment = await attachments.storeImage({
      sessionId: session.id,
      sourceName: "clipboard.png",
      contentType: "image/png",
      data: imageBytes
    });

    const assembled = await assembler.assemble({
      session,
      message: "Use this image.",
      context: { attachments: [attachment.id] }
    });

    expect(assembled.prompt).toBe("Use this image.");
    expect(assembled.inputParts).toEqual([
      {
        type: "localImage",
        path: join(serviceConfig.stateDir, "attachments", session.workspaceId, session.id, attachment.id, "source"),
        contentType: "image/png"
      }
    ]);
  });

  it("fails with a 404-style domain error when an attachment id is missing", async () => {
    const { assembler, session } = await createAssemblerFixture();

    await expect(assembler.assemble({
      session,
      message: "Use missing image.",
      context: { attachments: ["attachment-00000000-0000-0000-0000-000000000001"] }
    })).rejects.toMatchObject({
      statusCode: 404,
      message: "Attachment was not found"
    });
  });

  it("keeps the original user message unchanged in session messages", async () => {
    const { assembler, registry, selectedDirectory } = await createAssemblerFixture();
    await writeFile(join(selectedDirectory, "README.md"), "# AgentRoom\n");
    const runnerInputs: AgentRunnerInput[] = [];
    const service = new AgentSessionService({
      registry,
      runners: { codex: captureRunner(runnerInputs) },
      eventBus: new EventBus(),
      contextAssembler: assembler
    });
    const snapshot = await registry.list();
    const session = await service.createSession({ workspaceId: snapshot.workspaces[0].id });

    await service.startTurn({
      sessionId: session.id,
      message: "Use the selected file.",
      context: { paths: ["README.md"] }
    });
    await waitForSession(service, session.id, "idle");

    expect(runnerInputs[0].prompt).toContain("User selected workspace context:");
    expect(runnerInputs[0].prompt).toContain("# AgentRoom");
    expect(service.listSessionMessages(session.id)?.[0]).toMatchObject({
      role: "user",
      content: "Use the selected file."
    });
  });
});

async function createAssemblerFixture(instructions: {
  artifactInstruction?: string;
  clarifyingQuestionsEnabled?: boolean;
  diagramInstruction?: string;
  diagramHumanEdits?: {
    prepareSummaryForTurn(session: AgentSession): Promise<{ summary?: string; acknowledge(): void } | undefined>;
  };
  diagramRenderFeedback?: {
    prepareSummaryForTurn(session: AgentSession): Promise<{ summary?: string; acknowledge(): void } | undefined>;
  };
} = {}): Promise<{
  assembler: AgentTurnContextAssembler;
  attachments: AgentAttachmentStore;
  registry: LocalWorkspaceRegistry;
  selectedDirectory: string;
  serviceConfig: ServiceConfig;
  session: AgentSession;
}> {
  const serviceConfig = await config();
  const selectedDirectory = await mkdtemp(join(tmpdir(), "agentroom-turn-context-workspace-"));
  await mkdir(join(selectedDirectory, "src"), { recursive: true });
  const registry = new LocalWorkspaceRegistry(serviceConfig);
  const registered = await registry.register({ path: selectedDirectory });
  const now = new Date().toISOString();
  const session: AgentSession = {
    id: "agent-session-test",
    workspaceId: registered.workspace.id,
    workspacePath: registered.workspace.path,
    runnerKind: "codex",
    status: "idle",
    turnCount: 0,
    createdAt: now,
    updatedAt: now
  };
  const sessions = new Map([[session.id, session]]);
  const attachments = new AgentAttachmentStore({
    config: serviceConfig,
    sessionLookup: {
      getSession: (sessionId) => sessions.get(sessionId)
    }
  });
  await attachments.initialize();
  const assembler = new AgentTurnContextAssembler({
    workspaceExplorer: new WorkspaceExplorer(registry),
    attachments,
    ...instructions
  });
  return {
    assembler,
    attachments,
    registry,
    selectedDirectory,
    serviceConfig,
    session
  };
}

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d
  ]);
}

function preparedSummary(summary: string): { summary: string; acknowledge(): void } {
  return { summary, acknowledge() {} };
}

function captureRunner(inputs: AgentRunnerInput[]): AgentRunner {
  return {
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
    async *run(input) {
      inputs.push(input);
      yield {
        type: "run_succeeded",
        message: "done"
      };
    },
    async cancel() {}
  };
}

async function waitForSession(
  service: AgentSessionService,
  sessionId: string,
  status: AgentSession["status"]
): Promise<AgentSession> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const session = service.getSession(sessionId);
    if (session?.status === status) return session;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for session ${sessionId} to become ${status}`);
}
