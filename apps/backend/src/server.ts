import Fastify, { type FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import type { AgentRunnerKind, ServiceConfig } from "./domain/models";
import type { AgentRunner } from "./runner/AgentRunner";
import { ClaudeCodeRunner } from "./runner/claudeCode/ClaudeCodeRunner";
import { DeepSeekHarnessRunner } from "./runner/deepseek/DeepSeekHarnessRunner";
import { CodexAppServerRunner } from "./runner/codex/CodexAppServerRunner";
import { AcpRunner } from "./runner/acp/AcpRunner";
import { readAcpAdapterConfigs } from "./runner/acp/config";
import { RunnerRuntimeReadiness } from "./runner/runtimeReadiness";
import { FileAuditLogStore } from "./state/FileAuditLogStore";
import { EventBus } from "./events/EventBus";
import { loggerOptions } from "./logging/logger";
import { registerHealthRoutes } from "./routes/healthRoutes";
import { registerStatusRoutes } from "./routes/statusRoutes";
import { registerConfigRoutes } from "./routes/configRoutes";
import { registerRunnerRoutes } from "./routes/runnerRoutes";
import { registerWebsocketRoutes } from "./routes/websocketRoutes";
import { registerHarnessRoutes } from "./routes/harnessRoutes";
import { registerAuthRoutes } from "./routes/authRoutes";
import { registerWorkspaceRoutes } from "./routes/workspaceRoutes";
import { registerAgentSessionRoutes } from "./routes/agentSessionRoutes";
import { registerCodingAgentRoutes } from "./routes/codingAgentRoutes";
import { registerEditorCatalogRoutes } from "./routes/editorCatalogRoutes";
import { EditorCatalogManager } from "./editor/EditorCatalogStore";
import type { AuditLogStore } from "./state/AuditLogStore";
import { initializeServiceStorage } from "./config/serviceStorage";
import { LocalWorkspaceRegistry } from "./workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer } from "./workspace/WorkspaceExplorer";
import { AgentSessionService } from "./agent/AgentSessionService";
import { AgentAttachmentStore } from "./agent/AgentAttachmentStore";
import { AgentTurnContextAssembler } from "./agent/AgentTurnContextAssembler";
import { ArtifactStore } from "./artifact/ArtifactStore";
import { ARTIFACT_PROMPT_INSTRUCTION } from "./artifact/artifactPrompt";
import { SpatialSceneService } from "./scene/SpatialSceneService";
import { registerSpatialSceneRoutes } from "./routes/spatialSceneRoutes";
import { DIAGRAM_PROMPT_INSTRUCTION } from "./scene/diagram/prompt";
import { DiagramHumanEditTracker } from "./scene/diagram/humanEdits";
import { DiagramRenderFeedbackTracker } from "./scene/diagram/renderFeedback";

export interface BuildServerInput {
  config: ServiceConfig;
  runners?: Partial<Record<AgentRunnerKind, AgentRunner>>;
}

export interface BuiltServer {
  app: FastifyInstance;
  eventBus: EventBus;
  auditLogStore: AuditLogStore;
  agentSessions: AgentSessionService;
}

export async function buildServer(input: BuildServerInput): Promise<BuiltServer> {
  await initializeServiceStorage(input.config);
  const app = Fastify({ logger: loggerOptions });
  const eventBus = new EventBus();
  const auditLogStore = new FileAuditLogStore(input.config);
  await auditLogStore.initialize();
  auditLogStore.attach(eventBus);
  const runners: Partial<Record<AgentRunnerKind, AgentRunner>> = {
    codex: new CodexAppServerRunner(input.config),
    claude_code: new ClaudeCodeRunner(input.config),
    deepseek: new DeepSeekHarnessRunner(input.config),
    // Externally configured (tier-3) ACP adapters, admitted by stage 1 of
    // startup. The definition list is already parsed and validated by then, so
    // this only instantiates what the registry accepted — and when the channel
    // is off, which is the default, the list is empty and nothing is added.
    ...Object.fromEntries(
      readAcpAdapterConfigs().map((adapter) => [adapter.id, new AcpRunner(input.config, adapter)])
    ),
    ...input.runners
  };
  app.addHook("onClose", async () => {
    for (const runner of Object.values(runners)) {
      await runner?.dispose?.();
    }
  });
  // Runtime readiness starts empty and is never populated at startup. Readiness
  // records what capability discovery proved, so
  // N registered runners must not mean N probe children before the first
  // request. It is per process because a restarted backend has spawned nothing.
  const runnerReadiness = new RunnerRuntimeReadiness();
  const localWorkspaceRegistry = new LocalWorkspaceRegistry(input.config);
  const workspaceExplorer = new WorkspaceExplorer(localWorkspaceRegistry);
  let agentSessions: AgentSessionService;
  const agentAttachments = new AgentAttachmentStore({
    config: input.config,
    sessionLookup: {
      getSession: (sessionId) => agentSessions.getSession(sessionId)
    }
  });
  await agentAttachments.initialize();
  // Artifacts default on; only an explicit `artifactsEnabled: false` disables the
  // in-band sketch channel (store + parser + prompt instruction).
  const artifactsEnabled = input.config.artifactsEnabled !== false;
  const artifactStore = artifactsEnabled ? new ArtifactStore() : undefined;
  // All three parts of the diagram prompt seam are gated together: the
  // standing contract, the per-turn human-edit summary that gives it salience,
  // and the per-turn render feedback that reports composition problems.
  const sceneEngineEnabled = input.config.sceneEngineEnabled !== false;
  const diagramHumanEdits = sceneEngineEnabled
    ? new DiagramHumanEditTracker({ eventBus, explorer: workspaceExplorer })
    : undefined;
  const diagramRenderFeedback = sceneEngineEnabled
    ? new DiagramRenderFeedbackTracker({ eventBus, explorer: workspaceExplorer })
    : undefined;
  if (diagramHumanEdits || diagramRenderFeedback) {
    app.addHook("onClose", async () => {
      diagramHumanEdits?.dispose();
      diagramRenderFeedback?.dispose();
    });
  }
  const contextAssembler = new AgentTurnContextAssembler({
    workspaceExplorer,
    attachments: agentAttachments,
    ...(artifactsEnabled ? { artifactInstruction: ARTIFACT_PROMPT_INSTRUCTION } : {}),
    clarifyingQuestionsEnabled: input.config.clarifyingQuestionsEnabled !== false,
    ...(sceneEngineEnabled ? { diagramInstruction: DIAGRAM_PROMPT_INSTRUCTION } : {}),
    ...(diagramHumanEdits ? { diagramHumanEdits } : {}),
    ...(diagramRenderFeedback ? { diagramRenderFeedback } : {})
  });
  agentSessions = new AgentSessionService({
    registry: localWorkspaceRegistry,
    runners,
    defaultRunnerKind: input.config.runnerKind,
    eventBus,
    contextAssembler,
    ...(artifactStore ? { artifacts: artifactStore } : {}),
    attachments: agentAttachments
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!input.config.requireAuth || !isMutatingMethod(request.method)) return;
    const header = request.headers.authorization;
    if (header !== `Bearer ${input.config.authToken}`) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  const publicDir = resolve(__dirname, "..", "public");
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" });
  await app.register(fastifyMultipart);
  await registerWebsocketRoutes(app, { eventBus, agentSessions });
  await registerHealthRoutes(app, input.config);
  await registerAuthRoutes(app, input.config);
  await registerStatusRoutes(app, { agentSessions, eventBus, auditLogStore });
  await registerConfigRoutes(app, { config: input.config, eventBus });
  await registerRunnerRoutes(app, { config: input.config, readiness: runnerReadiness });
  await registerCodingAgentRoutes(app, {
    runners,
    defaultRunnerKind: input.config.runnerKind,
    readiness: runnerReadiness
  });
  await registerHarnessRoutes(app, input.config, {
    registry: localWorkspaceRegistry,
    eventBus,
    resolveSessionRunnerKind: (sessionId) => agentSessions.getSession(sessionId)?.runnerKind
  });
  await registerWorkspaceRoutes(app, localWorkspaceRegistry, {
    eventBus,
    config: input.config,
    explorer: workspaceExplorer
  });
  await registerAgentSessionRoutes(app, agentSessions, agentAttachments, input.config);

  // The spatial render engine defaults on. An
  // explicit `sceneEngineEnabled: false` leaves the read route unregistered
  // entirely, like the terminal when disabled. The service is deliberately
  // thin — it composes a scene/diagram base plus its human layer on every read through the
  // explorer's bounded preview path and keeps no watcher, tracker, or event
  // machinery. Scene files stay ordinary workspace
  // files either way.
  if (sceneEngineEnabled) {
    const spatialScenes = new SpatialSceneService({ explorer: workspaceExplorer });
    await registerSpatialSceneRoutes(app, { scenes: spatialScenes, config: input.config });
  }

  // The editor language catalog defaults on. Only an explicit
  // `languageCatalogEnabled: false` skips the routes. The catalog is
  // operator-managed and reloadable. The override dir (`EDITOR_CATALOG_DIR`,
  // default AGENTROOM_HOME-relative) is preferred when it holds a manifest, else
  // the bundled `catalog-assets` is served, else the routes 404 and clients fall
  // back to their bundled editor assets.
  if (input.config.languageCatalogEnabled !== false) {
    const bundledCatalogDir = resolve(__dirname, "..", "catalog-assets");
    const editorCatalog = await EditorCatalogManager.create({
      overrideDir: input.config.editorCatalogDir,
      bundledDir: bundledCatalogDir,
      logger: app.log
    });
    if (!editorCatalog.hasManifest()) {
      app.log.warn(
        { overrideDir: input.config.editorCatalogDir, bundledCatalogDir },
        "language catalog enabled but no catalog assets found; clients will use bundled editor assets"
      );
    } else {
      app.log.info(
        { source: editorCatalog.source(), overrideDir: input.config.editorCatalogDir },
        "editor language catalog ready"
      );
    }
    await registerEditorCatalogRoutes(app, editorCatalog, input.config, eventBus);
  }

  // Interactive terminal (PTY). OFF by default and registered only when the
  // operator opts in via `terminalEnabled`, so the channel — a real unsandboxed
  // shell in a registered workspace — is entirely absent otherwise. The module is
  // imported lazily here so node-pty's native binding only loads on opt-in; a
  // missing/mismatched `pty.node` then cannot crash a terminal-disabled backend at
  // boot. See docs/safety/TRUST_AND_SAFETY.md.
  if (input.config.terminalEnabled === true) {
    const { TerminalSessionService } = await import("./terminal/TerminalSessionService");
    const { registerTerminalRoutes } = await import("./routes/terminalRoutes");
    const terminalSessions = new TerminalSessionService(localWorkspaceRegistry, {
      ...(input.config.terminalMaxSessions !== undefined
        ? { maxSessions: input.config.terminalMaxSessions }
        : {}),
      ...(input.config.terminalShell ? { shell: input.config.terminalShell } : {})
    });
    app.addHook("onClose", async () => {
      terminalSessions.disposeAll();
    });
    await registerTerminalRoutes(app, { terminalSessions, eventBus, config: input.config });
    app.log.warn(
      "interactive terminal enabled: clients can run an unsandboxed shell in registered workspaces"
    );
  }

  return { app, eventBus, auditLogStore, agentSessions };
}

function isMutatingMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}
