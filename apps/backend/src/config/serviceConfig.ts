import { resolve } from "node:path";
import type { PublicServiceConfig, ServiceConfig } from "../domain/models";
import { CODING_EVENT_CONTRACT_VERSION } from "../protocol/coding/eventSchemas";
import {
  defaultClaudeCodeLoadWorkspaceSkills,
  defaultClaudeCodePermissionMode,
  serviceConfigSchema
} from "../domain/schemas";
import { booleanEnv, listEnv, numberEnv, optionalEnv } from "./env";
import {
  SETTINGS_SCHEMA_VERSION,
  buildPublicManagedSettings,
  rebuildManagedSettings,
  readManagedSettingsFileSync,
  resolveManagedSettings,
  resolveManagedSettingsPath,
  type ManagedSettings
} from "./settingsStore";
import { logger } from "../logging/logger";
import { releaseCompatibility } from "../releaseInfo";
import { registerExternalRunnerDescriptors } from "../runner/registry";
import { acpRunnerDescriptor, readAcpAdapterConfigs } from "../runner/acp/config";

export function getServiceConfig(): ServiceConfig {
  // Stage 1 of the two-stage startup, and the first release where it has
  // something to read: externally configured (tier-3) ACP adapters are admitted
  // *before* managed settings are parsed, because validating the managed
  // `runnerKind` — and assembling the settings table each runner contributes to
  // — requires knowing which runners exist. A malformed definition list is
  // already dropped whole by the reader; a registration that cannot be applied
  // is warned about rather than fatal, for the same reason an unusable settings
  // file is: a bad definition must not stop the sidecar from starting.
  try {
    registerExternalRunnerDescriptors(readAcpAdapterConfigs().map(acpRunnerDescriptor));
  } catch (error) {
    logger.warn(
      { issue: error instanceof Error ? error.message : String(error) },
      "Ignoring external ACP adapters; registration failed"
    );
    registerExternalRunnerDescriptors([]);
  }
  // The settings table derives from the registry, so it has to be rebuilt now
  // that stage 1 has changed which runners exist — otherwise a configured
  // adapter's settings would be missing from the schema, the metadata, the patch
  // schema, and environment resolution.
  rebuildManagedSettings();

  const agentRoomHome = optionalEnv("AGENTROOM_HOME");
  const workspaceRoot = optionalEnv("WORKSPACE_ROOT")
    ?? (agentRoomHome ? resolve(agentRoomHome, "workspaces") : resolve(process.cwd(), ".agentroom", "workspaces"));
  const stateDir = optionalEnv("STATE_DIR")
    ?? (agentRoomHome ? resolve(agentRoomHome, "state") : resolve(process.cwd(), ".agentroom", "state"));
  // Operator-managed editor language catalog override dir. The macOS
  // app imports curated catalog data here; the backend prefers it over the bundled
  // catalog when it holds a manifest. AGENTROOM_HOME-relative default, like stateDir.
  const editorCatalogDir = optionalEnv("EDITOR_CATALOG_DIR")
    ?? (agentRoomHome ? resolve(agentRoomHome, "catalog-assets") : resolve(process.cwd(), ".agentroom", "catalog-assets"));
  const authToken = optionalEnv("AUTH_TOKEN");

  // Managed settings: env wins and locks the key, else the backend-owned
  // settings file, else the code default (see config/settingsStore.ts). A file
  // that cannot be used is dropped whole and reported once, never fatal — a bad
  // file must not stop the sidecar from starting.
  //
  // This is stage 2 of the two-stage startup the runner registry needs: the
  // managed `runnerKind` cannot be validated without knowing which runners
  // exist, so the registry (`runner/registry.ts`) is built first and
  // `serviceConfigSchema` validates against the id schema derived from it.
  // Stage 1 is the built-in descriptor table today; externally configured
  // (tier-3) adapters can join it only through an admitted executable path.
  // See docs/engineering/RUNNERS.md.
  const managedSettingsPath = resolveManagedSettingsPath(agentRoomHome);
  const settingsFile = readManagedSettingsFileSync(managedSettingsPath);
  if (settingsFile.issue) {
    logger.warn(
      {
        path: managedSettingsPath,
        issue: settingsFile.issue,
        // Present when the file is a schema this backend cannot apply rather
        // than a broken one. The operator's repair differs — update AgentRoom,
        // do not reset the file — so the log has to say which state this is.
        schemaVersion: settingsFile.unsupportedSchemaVersion
      },
      "Ignoring managed settings file; falling back to environment and defaults"
    );
  }
  const managed = resolveManagedSettings(settingsFile.settings);
  const settings = managed.values;

  const parsed: ServiceConfig = serviceConfigSchema.parse({
    // Every managed setting's version-1 flat key is the `ServiceConfig` field of
    // the same name, so the resolved values spread straight in. Listing them
    // again here would be a fourth place to remember a runner's settings, which
    // would leak ownership, and `serviceConfigSchema` drops what it does
    // not declare, so a runner registering a setting this schema has no field
    // for reaches its adapter through `settingsValues` below instead.
    ...settings,
    agentRoomHome,
    host: optionalEnv("HOST") ?? "0.0.0.0",
    port: numberEnv("PORT", 8787),
    workspaceRoot,
    stateDir,
    editorCatalogDir,
    requireAuth: Boolean(authToken),
    authToken,
    // Tier 3: bootstrap, secret, and execution settings, which are deliberately
    // not managed keys and therefore never in the settings file.
    codexExecutable: optionalEnv("CODEX_EXECUTABLE"),
    codexArgs: listEnv("CODEX_ARGS", []),
    codexRunnerProtocol: optionalEnv("CODEX_RUNNER_PROTOCOL") ?? "jsonrpc",
    claudeCodeExecutable: optionalEnv("CLAUDE_CODE_EXECUTABLE"),
    deepseekExecutable: optionalEnv("DEEPSEEK_EXECUTABLE"),
    // The SDK runtime takes its composition from `$DSH_CORDIS_CONFIG`, else an
    // argv positional, and exits nonzero when it has neither — there is no
    // working-directory search and no built-in default. AgentRoom therefore
    // carries the path as its own tier-3 key and injects it on the documented
    // env channel, which also keeps it independent of DEEPSEEK_ARGS (a
    // non-empty argv would otherwise occupy the positional slot).
    //
    // An operator who already exports DSH_CORDIS_CONFIG is honored rather than
    // told to rename it: the child inherits that value either way, so refusing
    // to see it would report an unconfigured runner that in fact works.
    deepseekCordisConfig: optionalEnv("DEEPSEEK_CORDIS_CONFIG") ?? optionalEnv("DSH_CORDIS_CONFIG"),
    // Extra fixed arguments for the runtime. Unlike CODEX_ARGS this selects
    // nothing by itself — the composition above is what decides which plugins,
    // and therefore which tools, the agent has.
    deepseekArgs: listEnv("DEEPSEEK_ARGS", []),
    // An explicit Cursor key wins over the SDK's stored web sign-in; without it
    // the host passes nothing and the SDK reads `~/.cursor/sdk/auth.json`. Both
    // are credentials-class and stay out of the settings file.
    cursorApiKey: optionalEnv("CURSOR_API_KEY"),
    cursorBackendUrl: optionalEnv("CURSOR_BACKEND_URL"),
    terminalShell: optionalEnv("TERMINAL_SHELL")
  });
  // These startup-only fields stay outside the schema parse, which strips keys
  // it does not know. Their contracts still live in domain/models.ts.
  return {
    ...parsed,
    sceneEngineEnabled: settings.sceneEngineEnabled as boolean | undefined,
    languageServicesEnabled: settings.languageServicesEnabled as boolean | undefined,
    sourcekitLspExecutable: optionalEnv("SOURCEKIT_LSP_EXECUTABLE"),
    rustAnalyzerExecutable: optionalEnv("RUST_ANALYZER_EXECUTABLE"),
    goplsExecutable: optionalEnv("GOPLS_EXECUTABLE"),
    jdtlsExecutable: optionalEnv("JDTLS_EXECUTABLE"),
    kotlinLspExecutable: optionalEnv("KOTLIN_LSP_EXECUTABLE"),
    csharpLsExecutable: optionalEnv("CSHARP_LS_EXECUTABLE"),
    settingsMeta: managed.sources,
    settingsValues: settings,
    managedSettingsPath,
    // Env-only, and deliberately not a managed key: a key in the file could be
    // granted by whoever holds the bearer token. See docs/safety/TRUST_AND_SAFETY.md.
    remoteSettingsAdmin: booleanEnv("REMOTE_SETTINGS_ADMIN", false)
  };
}

export function toPublicConfig(config: ServiceConfig, onDiskSettings?: ManagedSettings): PublicServiceConfig {
  return {
    release: releaseCompatibility,
    runnerKind: config.runnerKind,
    codingEventContractVersion: CODING_EVENT_CONTRACT_VERSION,
    agentRoomHome: config.agentRoomHome,
    host: config.host,
    port: config.port,
    workspaceRoot: config.workspaceRoot,
    stateDir: config.stateDir,
    requireAuth: config.requireAuth,
    codexRunnerProtocol: config.codexRunnerProtocol ?? "jsonrpc",
    codexApprovalPolicy: config.codexApprovalPolicy ?? "never",
    codexSandboxMode: config.codexSandboxMode ?? "workspace-write",
    codexWorkspaceNetworkAccess: config.codexWorkspaceNetworkAccess ?? false,
    claudeCodePermissionMode: config.claudeCodePermissionMode ?? defaultClaudeCodePermissionMode,
    claudeCodeInheritProviderAuth: config.claudeCodeInheritProviderAuth ?? false,
    claudeCodeLoadWorkspaceSkills:
      config.claudeCodeLoadWorkspaceSkills ?? defaultClaudeCodeLoadWorkspaceSkills,
    sceneEngineEnabled: config.sceneEngineEnabled ?? true,
    languageServicesEnabled: config.languageServicesEnabled ?? false,
    terminalEnabled: config.terminalEnabled ?? false,
    // Additive metadata: the flat fields above keep their meaning (the values
    // this process is *running* with), so existing clients are untouched.
    settings: buildPublicManagedSettings(config, onDiskSettings),
    remoteSettingsAdmin: config.remoteSettingsAdmin ?? false,
    // Which address set in `settings` is canonical, and which settings-file shape
    // this backend applies. A client reads canonical `global.*`/`runners.*` paths
    // at version 2 and the legacy flat keys below it; both are served during the
    // compatibility window, so neither side has to assume the other's release.
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION
  };
}
