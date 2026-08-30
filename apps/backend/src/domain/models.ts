import type { RegisteredRunnerKind } from "../runner/registry";

export interface ServiceConfig {
  runnerKind: AgentRunnerKind;
  agentRoomHome?: string;
  host: string;
  port: number;
  workspaceRoot: string;
  stateDir: string;
  // Operator-managed editor language catalog override directory (Phase C.5). The
  // backend serves this directory's data assets when it holds a manifest, else
  // falls back to the bundled `catalog-assets`. Always resolved (AGENTROOM_HOME-
  // relative default), like workspaceRoot/stateDir.
  editorCatalogDir: string;
  requireAuth: boolean;
  authToken?: string;
  gitCommandTimeoutMs: number;
  // Timeout for the three git operations that talk to a remote (fetch, pull,
  // push). Separate from `gitCommandTimeoutMs` because a slow clone-sized fetch
  // is not a hung local command; it also bounds a credential helper that stalls.
  gitNetworkTimeoutMs?: number;
  codexExecutable?: string;
  codexArgs: string[];
  codexModel?: string;
  codexReasoningEffort?: CodingAgentReasoningEffort;
  codexServiceTier?: string;
  codexRunnerProtocol?: "exec" | "jsonrpc";
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexSandboxMode?: CodexSandboxMode;
  codexWorkspaceNetworkAccess?: boolean;
  claudeCodeExecutable?: string;
  claudeCodeModel?: string;
  claudeCodeReasoningEffort?: CodingAgentReasoningEffort;
  claudeCodePermissionMode?: ClaudeCodePermissionMode;
  claudeCodeInheritProviderAuth?: boolean;
  // When true (default), Claude Code sessions load the registered workspace's
  // `project` settings source (SDK `settingSources: ['project']`, `skills: 'all'`)
  // so its `.claude/skills`, `CLAUDE.md`, subagents, and `.claude/settings.json`
  // (hooks, MCP servers, `permissions.*`, `env`/`apiKeyHelper`) take effect — the
  // full scope, not just skills. Honored only under the `bypassPermissions`
  // posture, which already trusts the workspace; stricter permission modes force
  // isolation so workspace settings cannot widen them. When false, sessions run
  // with full SDK settings isolation (`settingSources: []`) regardless of mode.
  // See docs/safety/TRUST_AND_SAFETY.md.
  claudeCodeLoadWorkspaceSkills?: boolean;
  // Tier 3: the DeepSeek Harness SDK runtime executable, the Cordis composition
  // it must be handed, and any fixed extra arguments. Deliberately not managed
  // keys — an executable path is "run this binary", and the composition decides
  // which tools the agent has, which is a deployment decision, not a preference.
  //
  // The executable is `dsh-jsonrpc-agent` (or the packaged single-file runtime),
  // never the `dsh` launcher: `dsh` boots profiles (`--profile`, `web`,
  // `headless`) and has no entry mode that serves this protocol.
  deepseekExecutable?: string;
  // The runtime demands an explicit composition and exits nonzero without one,
  // so this is required rather than optional. Resolved from
  // DEEPSEEK_CORDIS_CONFIG, else an operator-exported DSH_CORDIS_CONFIG, and
  // handed to the child as DSH_CORDIS_CONFIG.
  deepseekCordisConfig?: string;
  deepseekArgs: string[];
  deepseekModel?: string;
  deepseekProvider?: string;
  // Optional positive output-token cap the runtime applies to each request from
  // an SDK-created agent and its in-process descendants.
  deepseekMaxTokens?: number;
  // The harness's own approval posture, injected as `DSH_PERMISSION_MODE`. The
  // vocabulary belongs to the composed profile's approval plugin, not to
  // AgentRoom, so it is bounded by shape rather than by an enum this backend
  // would have to keep in step with a developer preview. Tier 2: it widens what
  // the agent may do. See docs/safety/TRUST_AND_SAFETY.md.
  deepseekPermissionMode?: string;
  // Cursor SDK runner (docs/engineering/CURSOR_SDK_RUNNER.md). The six managed
  // settings are declared on the `cursor` descriptor in `runner/registry.ts`
  // and resolve into these fields by name; the tier-2 defaults live in
  // domain/runnerDefaults.ts so the adapter and the declaration read one value.
  cursorModel?: string;
  // Tier 1, open id: each Cursor model declares its own depth parameter
  // (`effort` or `reasoning`) and vocabulary, so the operator's default is
  // applied only to a model that offers the value. A turn's own selection is
  // refused when the model does not.
  cursorReasoningEffort?: string;
  // Tier 1: `standard` or `fast`, the model's `fast` parameter.
  cursorServiceTier?: string;
  // Tier 2: `local.sandboxOptions.enabled`. Default true; the bound is writes
  // and network, not reads (fact 7). See docs/safety/TRUST_AND_SAFETY.md.
  cursorSandbox?: boolean;
  // Tier 2: `local.autoReview`, a server-side classifier. Default false.
  cursorAutoReview?: boolean;
  // Tier 2: `settingSources: ['project']` when true, else `[]`. Default true;
  // gate for the descriptor's workspaceSkills. Same class of trust decision as
  // Claude Code's `project` source.
  cursorLoadWorkspaceSettings?: boolean;
  // Tier 3, environment-only, never a managed key: an operator-supplied Cursor
  // key that wins over the stored web sign-in, and an optional backend URL.
  // Never logged, returned, or placed in a commandAudit row.
  cursorApiKey?: string;
  cursorBackendUrl?: string;
  // When false, the in-band artifact channel is disabled: assistant text is not
  // parsed for <artifact> regions and no artifact prompt instruction is injected.
  artifactsEnabled?: boolean;
  // When false, the clarifying-question channel is off: no runner is given a
  // way to pause a turn and ask the person driving the session, so each behaves
  // exactly as before the channel existed. Tier 1: answering a question
  // authorizes nothing. See docs/safety/TRUST_AND_SAFETY.md.
  clarifyingQuestionsEnabled?: boolean;
  // When false, the backend-served editor language catalog (Phase C) is disabled:
  // the catalog routes are not registered and clients fall back to bundled assets.
  languageCatalogEnabled?: boolean;
  // Interactive terminal (PTY) channel. OFF by default: it is the one deliberate
  // relaxation of the "no arbitrary shell execution" posture — a real login shell
  // spawned in a registered workspace, unsandboxed, behind bearer auth. See
  // docs/safety/TRUST_AND_SAFETY.md. Operators opt in explicitly.
  terminalEnabled?: boolean;
  // Global concurrent PTY cap across every workspace. Operator-tunable but kept
  // out of PublicServiceConfig; clients learn only whether their own attempt was
  // accepted. Schema-bounded to 1...64 and defaults to 8.
  terminalMaxSessions?: number;
  // Optional shell override for the terminal PTY. Defaults to the backend user's
  // $SHELL, else /bin/zsh. The resolved path is never returned by /api/config.
  terminalShell?: string;
}

export interface ClientCompatibility {
  minimumVersion: string;
}

export interface ReleaseCompatibility {
  backendVersion: string;
  apiVersion: string;
  minimumSupportedClientApiVersion: string;
  compatibleClients: {
    macos: ClientCompatibility;
    visionos: ClientCompatibility;
  };
}

export interface PublicServiceConfig {
  release: ReleaseCompatibility;
  runnerKind: ServiceConfig["runnerKind"];
  /**
   * Which `coding_*` event contract this backend speaks. A client compares it
   * against the minimum it accepts, so an independently upgraded headset and an
   * older backend can each tell what the other carries instead of assuming the
   * apps shipped together. Non-secret: it is a shape, not a posture.
   */
  codingEventContractVersion: number;
  agentRoomHome?: string;
  host: string;
  port: number;
  workspaceRoot: string;
  stateDir: string;
  requireAuth: boolean;
  codexRunnerProtocol: "exec" | "jsonrpc";
  codexApprovalPolicy: CodexApprovalPolicy;
  codexSandboxMode: CodexSandboxMode;
  codexWorkspaceNetworkAccess: boolean;
  claudeCodePermissionMode: ClaudeCodePermissionMode;
  claudeCodeInheritProviderAuth: boolean;
  claudeCodeLoadWorkspaceSkills: boolean;
  terminalEnabled: boolean;
}

export interface HarnessSource {
  title: string;
  url: string;
  publishedAt: string;
}

export interface HarnessKnowledgeEntry {
  path: string;
  purpose: string;
}

export interface HarnessFeedbackLoop {
  name: string;
  endpoint?: string;
  artifact?: string;
  purpose: string;
}

export interface HarnessDesignReference {
  path: string;
  purpose: string;
}

export interface VisionOSDesignGrounding {
  requiredReferences: HarnessDesignReference[];
  preflightChecklist: string[];
}

export interface HarnessSafetyPosture {
  runnerKind: ServiceConfig["runnerKind"];
  arbitraryShellApi: false;
  authRequiredForMutations: boolean;
}

export interface HarnessProfile {
  name: string;
  source: HarnessSource;
  summary: string;
  principles: string[];
  knowledgeMap: HarnessKnowledgeEntry[];
  visionOSDesignGrounding: VisionOSDesignGrounding;
  feedbackLoops: HarnessFeedbackLoop[];
  guardrails: string[];
  verificationCommands: string[];
  safetyPosture: HarnessSafetyPosture;
}

export type LocalWorkspaceKind = "managed_throwaway" | "user_selected";

export interface LocalWorkspaceGitSnapshot {
  isRepository: boolean;
  branch?: string;
  remote?: string;
  /** True when any Git remote is configured, even when it is not named `origin`. */
  hasRemote?: boolean;
  branches?: LocalWorkspaceGitBranch[];
  hasUncommittedChanges?: boolean;
  /** The current branch's upstream, e.g. `origin/main`, when it tracks one. */
  upstream?: string;
  /** True when the branch tracks an upstream that no longer exists on the remote. */
  upstreamGone?: boolean;
  /** Commits the current branch has that its upstream does not, as of the last fetch. */
  ahead?: number;
  /** Commits the upstream has that the current branch does not, as of the last fetch. */
  behind?: number;
}

export interface LocalWorkspaceGitBranch {
  name: string;
  current: boolean;
  upstream?: string;
  upstreamGone?: boolean;
  ahead?: number;
  behind?: number;
}

/** The fixed set of git operations the workspace routes expose. */
export type LocalWorkspaceGitOperation =
  | "stage"
  | "unstage"
  | "discard"
  | "commit"
  | "fetch"
  | "pull"
  | "push"
  | "create_branch"
  | "switch_branch";

export interface LocalWorkspaceGitOperationResult {
  workspaceId: string;
  operation: LocalWorkspaceGitOperation;
  workspace: LocalWorkspace;
  status: LocalWorkspaceGitStatus;
  /** Paths the operation actually acted on, after filtering. */
  paths?: string[];
  /**
   * Paths the caller named (or a stage-all enumerated) that were refused because
   * a segment is secret-named or generated. Reported so a client can say what it
   * skipped rather than silently dropping them.
   */
  skippedPaths?: string[];
  commit?: string;
  commitSubject?: string;
  branch?: string;
  previousBranch?: string;
  remote?: string;
}

export type LocalWorkspaceGitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "type_changed";

export interface LocalWorkspaceGitStatusCounts {
  total: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}

export interface LocalWorkspaceGitChangedFile {
  path: string;
  oldPath?: string;
  status: LocalWorkspaceGitFileStatus;
  staged: boolean;
  unstaged: boolean;
  additions?: number;
  deletions?: number;
}

export interface LocalWorkspaceGitStatus {
  workspaceId: string;
  isRepository: boolean;
  branch?: string;
  clean: boolean;
  counts: LocalWorkspaceGitStatusCounts;
  files: LocalWorkspaceGitChangedFile[];
  truncated: boolean;
  refreshedAt: string;
}

export interface LocalWorkspace {
  id: string;
  name: string;
  path: string;
  kind: LocalWorkspaceKind;
  trustedAt: string;
  lastOpenedAt: string;
  git: LocalWorkspaceGitSnapshot;
}

export interface LocalWorkspaceRegistrySnapshot {
  defaultWorkspaceRoot: string;
  workspaces: LocalWorkspace[];
}

export type WorkspaceTreeEntryType = "directory" | "file";

export interface WorkspaceTreeEntry {
  type: WorkspaceTreeEntryType;
  name: string;
  path: string;
  sizeBytes?: number;
  modifiedAt?: string;
  previewable?: boolean;
  children?: WorkspaceTreeEntry[];
}

export interface WorkspaceTreeSnapshot {
  workspaceId: string;
  path: string;
  entries: WorkspaceTreeEntry[];
}

export interface WorkspaceFilePreview {
  workspaceId: string;
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  encoding: "utf8";
  content: string;
  truncated: boolean;
  previewable: true;
}

// The git HEAD version of a workspace file, served so an editor can render
// working-tree change decorations against the committed baseline. A file not
// yet in HEAD (added/untracked) and a non-repository workspace are ordinary
// data states, not errors; `content` is present only for an in-cap UTF-8 blob.
export interface WorkspaceGitFileBaseline {
  workspaceId: string;
  path: string;
  ref: "HEAD";
  isRepository: boolean;
  existsInHead: boolean;
  sizeBytes?: number;
  encoding?: "utf8";
  content?: string;
  truncated?: boolean;
}

// One file in the bounded workspace file index (quick-open / `@` mention
// picker). Carries only path metadata — never content.
export interface WorkspaceFileIndexEntry {
  /** Workspace-relative, forward-slash path. */
  path: string;
  /** Basename of `path`. */
  name: string;
  /**
   * Same contract as the tree read's `previewable`: a non-secret text-openable
   * file within the 256 KB write cap, so a client knows whether the editor can
   * open and save it.
   */
  previewable: boolean;
}

export interface WorkspaceFileIndexSnapshot {
  workspaceId: string;
  /** Echo of the (trimmed) query the ranking used; empty means "unfiltered". */
  query: string;
  files: WorkspaceFileIndexEntry[];
  /** True when the enumeration hit its path cap or more ranked matches existed than `limit`. */
  truncated: boolean;
}

// One literal-substring hit inside a workspace file. Line and column are both
// 1-indexed (Monaco convention); `column` and `length` are UTF-16 code-unit
// offsets into the matched line.
export interface WorkspaceSearchMatch {
  line: number;
  column: number;
  length: number;
  /** The matched line, bounded to 200 characters centred on the match. */
  preview: string;
  /** 1-indexed column of the match within `preview`, for client-side highlighting. */
  previewColumn: number;
}

export interface WorkspaceSearchFileMatches {
  path: string;
  matches: WorkspaceSearchMatch[];
  /** True when this file had more matches than were returned (per-file cap, total cap, or byte cap). */
  truncated: boolean;
}

export interface WorkspaceSearchSnapshot {
  workspaceId: string;
  query: string;
  files: WorkspaceSearchFileMatches[];
  totalMatches: number;
  /** Number of candidate files actually opened and read (binary files skipped after reading count here). */
  filesScanned: number;
  /** True when any bound cut the search short: index cap, file-scan cap, total-match cap, or time budget. */
  truncated: boolean;
}

// One user-invocable skill discovered in a registered workspace's committed
// skill directories (`.claude/skills` for claude_code; `.codex/skills` and
// `.agents/skills` for codex). Carries only display/invocation metadata parsed
// from SKILL.md frontmatter — never skill body content.
export interface WorkspaceSkill {
  name: string;
  description?: string;
  // The runner-appropriate composer token: `/name` for claude_code slash
  // commands, `$name` for codex skill mentions. Computed backend-side so
  // clients do not hardcode per-runner invocation syntax.
  invocation: string;
  // Workspace-relative skills directory the skill was found in.
  source: string;
}

export interface WorkspaceSkillsSnapshot {
  workspaceId: string;
  runnerKind: AgentRunnerKind;
  // Whether sessions of this runner kind actually load the listed skills — the
  // registry's `workspaceSkills` policy (`runner/registry.ts`): a `native`
  // loader always does, a `gated` one defers to the adapter's own trust rule.
  // The list is empty when false so clients never offer an invocation the
  // session cannot honor.
  available: boolean;
  skills: WorkspaceSkill[];
}

export interface AgentTurnContext {
  paths?: string[];
  attachments?: string[];
}

/**
 * A registered runner id. Which runners exist is the runner registry's answer
 * (`runner/registry.ts`), not a second hand-maintained union here — adding a
 * built-in runner is adding a row there.
 *
 * It is a `string` rather than the built-in union because Phase 7 admits
 * externally configured (tier-3) adapters, whose ids exist only once an operator
 * has named them: a compile-time union cannot describe a set that startup
 * decides. Admission is therefore a *runtime* check —
 * `agentRunnerKindSchema`, which resolves against the live registry — and the
 * type here deliberately does not pretend otherwise. {@link RegisteredRunnerKind}
 * remains the narrow type for the two ids this build ships, which is what the
 * per-runner presentation and the descriptor table still key off.
 */
export type AgentRunnerKind = string;

export type CodingAgentReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ClaudeCodePermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions";

export interface CodingAgentSettingValue {
  id: string;
  label: string;
  description?: string;
}

export interface CodingAgentModelOption {
  id: string;
  label: string;
  description?: string;
  contextWindowTokens?: number;
  isDefault: boolean;
  reasoningEfforts: CodingAgentSettingValue[];
  defaultReasoningEffort?: string;
  serviceTiers: CodingAgentSettingValue[];
  defaultServiceTier?: string;
}

/**
 * What one turn selects from what its runner advertised.
 *
 * All three are open ids rather than closed unions: the vocabulary belongs to
 * the runner that advertised it through `GET /api/coding-agent/capabilities`, and
 * a registered runner brings its own. `CodingAgentReasoningEffort` remains the
 * closed vocabulary of the two runners AgentRoom ships, which is what the
 * managed settings for those runners are bounded to.
 */
export interface CodingAgentTurnSettings {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
}

export interface CodingAgentSettingsDescriptor {
  models: CodingAgentModelOption[];
  defaultSettings: CodingAgentTurnSettings;
}

export interface CodingAgentCapabilities {
  runnerKind: AgentRunnerKind;
  settings: CodingAgentSettingsDescriptor;
  error?: string;
}

export type AgentSessionStatus = "idle" | "running" | "failed" | "cancelled";

export type AgentSessionTurnStatus = "running" | "succeeded" | "failed" | "cancelled";

export type AgentSessionMessageRole = "user" | "assistant" | "system";

export type AgentSessionMessageStatus = "sent" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * The runner-agnostic session block: what the adapter reported when its native
 * session started. `posture` is the runner's own label/value pair (a Codex
 * approval policy, a Claude Code permission mode), deliberately not reconciled
 * into a universal enum.
 *
 * The `codex`/`claudeCode` blocks below are the pre-canonical projection of
 * this, kept while the advertised coding-event contract floor is below 2.
 */
export interface RunnerSessionMetadata {
  nativeSessionId?: string;
  model?: string;
  cwd?: string;
  posture?: { label: string; value: string };
  sandbox?: unknown;
}

export interface CodexSessionMetadata {
  threadId?: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: unknown;
}

export interface ClaudeCodeSessionMetadata {
  sessionId?: string;
  model?: string;
  cwd?: string;
  permissionMode?: string;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  workspacePath: string;
  gitBranch?: string;
  runnerKind: AgentRunnerKind;
  settings?: CodingAgentTurnSettings;
  runner?: RunnerSessionMetadata;
  codex?: CodexSessionMetadata;
  claudeCode?: ClaudeCodeSessionMetadata;
  modelContextWindowTokens?: number;
  contextWindowUsedTokens?: number;
  /**
   * Where the session's runner auto-compacts, when it reports a threshold.
   * Absent means unknown. It is persisted with the record, so a restored
   * thread shows the value its last turn read until a new turn refreshes it.
   */
  contextCompactionThresholdTokens?: number;
  title?: string;
  status: AgentSessionStatus;
  activeTurnId?: string;
  lastMessage?: string;
  error?: string;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionTurn {
  id: string;
  sessionId: string;
  status: AgentSessionTurnStatus;
  startedAt: string;
  completedAt?: string;
  lastMessage?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelContextWindowTokens?: number;
  contextCompactionThresholdTokens?: number;
}

export interface AgentSessionMessage {
  id: string;
  sessionId: string;
  turnId?: string;
  role: AgentSessionMessageRole;
  content: string;
  context?: AgentSessionMessageContext;
  status: AgentSessionMessageStatus;
  at: string;
}

export type AgentSessionAttachmentKind = "image";

export interface AgentSessionAttachment {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: AgentSessionAttachmentKind;
  sourceName: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface AgentSessionMessageContextAttachment {
  id: string;
  kind: AgentSessionAttachmentKind;
  sourceName: string;
  contentType: AgentSessionAttachment["contentType"];
  sizeBytes: number;
}

export interface AgentSessionMessageContext {
  paths?: string[];
  attachments?: AgentSessionMessageContextAttachment[];
  // The clarifying-question batch this user message answers, when it is the
  // backend's record of a human answer rather than a turn message.
  questionRequestId?: string;
}

/**
 * One agent session as written to `$STATE_DIR/sessions/<sessionId>.json`: the
 * record `GET /api/agent-sessions/:id` serves, its turns, and its message
 * history. The file boundary validates `session.runnerKind` as a string rather
 * than against the live registry, so a thread from a runner this process does
 * not register (an ACP adapter since removed from the environment) stays
 * readable as history; whether it can take a turn is decided at turn time.
 */
export interface DurableAgentSessionDocument {
  schemaVersion: 1;
  session: AgentSession;
  turns: AgentSessionTurn[];
  messages: AgentSessionMessage[];
}

export interface AgentBridgeMetrics {
  totalSessions: number;
  runningSessions: number;
  completedTurns: number;
  failedTurns: number;
  cancelledTurns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface StatusSnapshot {
  runnerKind: ServiceConfig["runnerKind"];
  uptimeSeconds: number;
  sessions: AgentSession[];
  activeSessionIds: string[];
  recentEvents: unknown[];
  metrics: AgentBridgeMetrics;
}
