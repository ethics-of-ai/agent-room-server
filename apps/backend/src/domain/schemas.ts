import { z } from "zod";
import type { WorkspaceTreeEntry } from "./models";
import { agentRunnerKindSchema } from "../runner/registry";
import {
  defaultClaudeCodeLoadWorkspaceSkills,
  defaultClaudeCodePermissionMode
} from "./runnerDefaults";
import {
  claudeCodePermissionModeSchema,
  codexApprovalPolicySchema,
  codexSandboxModeSchema,
  codingAgentModelIdSchema,
  codingAgentReasoningEffortIdSchema,
  codingAgentReasoningEffortSchema,
  codingAgentServiceTierIdSchema,
  cursorReasoningEffortSchema,
  cursorServiceTierSchema,
  deepseekPermissionModeSchema,
  deepseekProviderSchema
} from "./settingValueSchemas";

// Which runner ids exist is the registry's answer (`runner/registry.ts`), so the
// schema is imported and re-exported rather than declared here — a second
// hand-maintained enum is the leak Phase 3 retires. Re-exported so every
// existing `domain/schemas` import site is unchanged.
export { agentRunnerKindSchema };

// The value vocabularies live in the import-free `domain/settingValueSchemas.ts`
// leaf and are re-exported here, so their existing import sites are unchanged.
// They moved because each `RunnerDescriptor` now declares the managed settings it
// owns *with* their schemas, and this module is downstream of that registry — see
// the header of `domain/settingValueSchemas.ts`.
export {
  codingAgentReasoningEffortIdSchema,
  codingAgentReasoningEffortSchema,
  codexApprovalPolicySchema,
  codexSandboxModeSchema,
  claudeCodePermissionModeSchema,
  cursorReasoningEffortSchema,
  cursorServiceTierSchema,
  deepseekPermissionModeSchema,
  deepseekProviderSchema,
  codingAgentModelIdSchema,
  codingAgentServiceTierIdSchema
};

// Both defaults now live in the import-free `domain/runnerDefaults.ts` leaf and
// are re-exported here, so their existing import sites are unchanged. They moved
// because this module is now downstream of the runner registry, which reaches
// into the Claude Code adapter — and that adapter needs these values. See the
// header of `domain/runnerDefaults.ts`.
export { defaultClaudeCodePermissionMode, defaultClaudeCodeLoadWorkspaceSkills };

export const codingAgentSettingValueSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional()
});

export const codingAgentModelOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  isDefault: z.boolean(),
  reasoningEfforts: z.array(codingAgentSettingValueSchema),
  defaultReasoningEffort: codingAgentReasoningEffortIdSchema.optional(),
  serviceTiers: z.array(codingAgentSettingValueSchema),
  defaultServiceTier: z.string().min(1).optional()
});

export const codingAgentTurnSettingsSchema = z.object({
  model: codingAgentModelIdSchema.optional(),
  reasoningEffort: codingAgentReasoningEffortIdSchema.optional(),
  serviceTier: codingAgentServiceTierIdSchema.optional()
});

export const codingAgentSettingsDescriptorSchema = z.object({
  models: z.array(codingAgentModelOptionSchema),
  defaultSettings: codingAgentTurnSettingsSchema
});

export const codingAgentCapabilitiesSchema = z.object({
  runnerKind: agentRunnerKindSchema,
  settings: codingAgentSettingsDescriptorSchema,
  error: z.string().optional()
});

export const serviceConfigSchema = z.object({
  runnerKind: agentRunnerKindSchema,
  agentRoomHome: z.string().optional(),
  host: z.string(),
  port: z.number().int().positive(),
  workspaceRoot: z.string().min(1),
  stateDir: z.string().min(1),
  editorCatalogDir: z.string().min(1),
  requireAuth: z.boolean(),
  authToken: z.string().optional(),
  gitCommandTimeoutMs: z.number().int().positive(),
  gitNetworkTimeoutMs: z.number().int().positive().optional(),
  codexExecutable: z.string().optional(),
  codexArgs: z.array(z.string()),
  codexModel: z.string().optional(),
  codexReasoningEffort: codingAgentReasoningEffortSchema.optional(),
  codexServiceTier: z.string().optional(),
  codexRunnerProtocol: z.enum(["exec", "jsonrpc"]).optional(),
  codexApprovalPolicy: codexApprovalPolicySchema,
  codexSandboxMode: codexSandboxModeSchema,
  codexWorkspaceNetworkAccess: z.boolean(),
  claudeCodeExecutable: z.string().optional(),
  claudeCodeModel: z.string().optional(),
  claudeCodeReasoningEffort: codingAgentReasoningEffortSchema.optional(),
  claudeCodePermissionMode: claudeCodePermissionModeSchema.default(defaultClaudeCodePermissionMode),
  claudeCodeInheritProviderAuth: z.boolean(),
  claudeCodeLoadWorkspaceSkills: z.boolean().default(defaultClaudeCodeLoadWorkspaceSkills),
  deepseekExecutable: z.string().optional(),
  deepseekCordisConfig: z.string().optional(),
  deepseekArgs: z.array(z.string()),
  deepseekModel: z.string().optional(),
  deepseekProvider: deepseekProviderSchema.optional(),
  deepseekMaxTokens: z.number().int().positive().optional(),
  deepseekPermissionMode: deepseekPermissionModeSchema.optional(),
  cursorModel: codingAgentModelIdSchema.optional(),
  cursorReasoningEffort: cursorReasoningEffortSchema.optional(),
  cursorServiceTier: cursorServiceTierSchema.optional(),
  cursorSandbox: z.boolean().optional(),
  cursorAutoReview: z.boolean().optional(),
  cursorLoadWorkspaceSettings: z.boolean().optional(),
  // Tier 3, environment-only: the optional explicit Cursor key that wins over
  // the SDK's stored web sign-in, and the optional backend URL. Neither is a
  // managed key, so neither has an entry in the settings file, the metadata,
  // or the PATCH schema. See docs/safety/TRUST_AND_SAFETY.md.
  cursorApiKey: z.string().min(1).optional(),
  cursorBackendUrl: z.string().min(1).optional(),
  artifactsEnabled: z.boolean().default(true),
  clarifyingQuestionsEnabled: z.boolean().default(true),
  languageCatalogEnabled: z.boolean().default(true),
  terminalEnabled: z.boolean().default(false),
  terminalMaxSessions: z.number().int().min(1).max(64).default(8),
  terminalShell: z.string().min(1).optional()
});

export const harnessProfileSchema = z.object({
  name: z.string().min(1),
  source: z.object({
    title: z.string().min(1),
    url: z.string().url(),
    publishedAt: z.string().min(1)
  }),
  summary: z.string().min(1),
  principles: z.array(z.string().min(1)).min(1),
  knowledgeMap: z.array(
    z.object({
      path: z.string().min(1),
      purpose: z.string().min(1)
    })
  ),
  visionOSDesignGrounding: z.object({
    requiredReferences: z.array(
      z.object({
        path: z.string().min(1),
        purpose: z.string().min(1)
      })
    ).min(1),
    preflightChecklist: z.array(z.string().min(1)).min(1)
  }),
  feedbackLoops: z.array(
    z.object({
      name: z.string().min(1),
      endpoint: z.string().optional(),
      artifact: z.string().optional(),
      purpose: z.string().min(1)
    })
  ),
  guardrails: z.array(z.string().min(1)).min(1),
  verificationCommands: z.array(z.string().min(1)).min(1),
  safetyPosture: z.object({
    runnerKind: agentRunnerKindSchema,
    arbitraryShellApi: z.literal(false),
    authRequiredForMutations: z.boolean()
  })
});

export const localWorkspaceKindSchema = z.enum(["managed_throwaway", "user_selected"]);

export const localWorkspaceGitBranchSchema = z.object({
  name: z.string().min(1),
  current: z.boolean(),
  upstream: z.string().min(1).optional(),
  upstreamGone: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional()
});

export const localWorkspaceGitFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "type_changed"
]);

export const localWorkspaceGitStatusCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
  unstaged: z.number().int().nonnegative(),
  untracked: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative()
});

export const localWorkspaceGitChangedFileSchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  status: localWorkspaceGitFileStatusSchema,
  staged: z.boolean(),
  unstaged: z.boolean(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional()
});

export const localWorkspaceGitStatusSchema = z.object({
  workspaceId: z.string().min(1),
  isRepository: z.boolean(),
  branch: z.string().optional(),
  clean: z.boolean(),
  counts: localWorkspaceGitStatusCountsSchema,
  files: z.array(localWorkspaceGitChangedFileSchema),
  truncated: z.boolean(),
  refreshedAt: z.string().min(1)
});

export const localWorkspaceGitSnapshotSchema = z.object({
  isRepository: z.boolean(),
  branch: z.string().optional(),
  remote: z.string().optional(),
  hasRemote: z.boolean().optional(),
  branches: z.array(localWorkspaceGitBranchSchema).optional(),
  hasUncommittedChanges: z.boolean().optional(),
  upstream: z.string().optional(),
  upstreamGone: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional()
});

export const localWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  kind: localWorkspaceKindSchema,
  trustedAt: z.string().min(1),
  lastOpenedAt: z.string().min(1),
  git: localWorkspaceGitSnapshotSchema
});

export const localWorkspaceRegistrySnapshotSchema = z.object({
  defaultWorkspaceRoot: z.string().min(1),
  workspaces: z.array(localWorkspaceSchema)
});

export const workspaceTreeEntrySchema: z.ZodType<WorkspaceTreeEntry> = z.lazy(() => z.object({
  type: z.enum(["directory", "file"]),
  name: z.string().min(1),
  path: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  modifiedAt: z.string().optional(),
  previewable: z.boolean().optional(),
  children: z.array(workspaceTreeEntrySchema).optional()
}));

export const workspaceTreeSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string(),
  entries: z.array(workspaceTreeEntrySchema)
});

export const workspaceFilePreviewSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().min(1),
  encoding: z.literal("utf8"),
  content: z.string(),
  truncated: z.boolean(),
  previewable: z.literal(true)
});

export const workspaceFileIndexEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  previewable: z.boolean()
});

export const workspaceFileIndexSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string(),
  files: z.array(workspaceFileIndexEntrySchema),
  truncated: z.boolean()
});

export const workspaceSearchMatchSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  length: z.number().int().positive(),
  preview: z.string(),
  previewColumn: z.number().int().positive()
});

export const workspaceSearchFileMatchesSchema = z.object({
  path: z.string().min(1),
  matches: z.array(workspaceSearchMatchSchema),
  truncated: z.boolean()
});

export const workspaceSearchSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1),
  files: z.array(workspaceSearchFileMatchesSchema),
  totalMatches: z.number().int().nonnegative(),
  filesScanned: z.number().int().nonnegative(),
  truncated: z.boolean()
});

export const agentTurnContextSchema = z.object({
  paths: z.array(z.string().min(1)).max(8).optional(),
  attachments: z.array(z.string().trim().min(1).regex(/^attachment-[0-9a-f-]{36}$/)).max(8).optional()
});

export const agentSessionAttachmentSchema = z.object({
  id: z.string().regex(/^attachment-[0-9a-f-]{36}$/),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.literal("image"),
  sourceName: z.string().min(1),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().min(1)
});

export const agentSessionMessageContextAttachmentSchema = z.object({
  id: z.string().regex(/^attachment-[0-9a-f-]{36}$/),
  kind: z.literal("image"),
  sourceName: z.string().min(1),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  sizeBytes: z.number().int().positive()
});

export const agentSessionMessageContextSchema = z.object({
  paths: z.array(z.string().min(1)).max(8).optional(),
  attachments: z.array(agentSessionMessageContextAttachmentSchema).max(8).optional(),
  // Set on the user message the backend records when a person answers a
  // clarifying-question batch, so a client can style it as that answer.
  questionRequestId: z.string().min(1).max(200).optional()
});

export const agentSessionStatusSchema = z.enum(["idle", "running", "failed", "cancelled"]);

export const agentSessionTurnStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);

export const agentSessionMessageRoleSchema = z.enum(["user", "assistant", "system"]);

export const agentSessionMessageStatusSchema = z.enum(["sent", "running", "succeeded", "failed", "cancelled"]);

export const codexSessionMetadataSchema = z.object({
  threadId: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  approvalPolicy: z.string().optional(),
  sandbox: z.unknown().optional()
});

export const claudeCodeSessionMetadataSchema = z.object({
  sessionId: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  permissionMode: z.string().optional()
});

export const runnerSessionMetadataSchema = z.object({
  nativeSessionId: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  posture: z.object({ label: z.string(), value: z.string() }).optional(),
  sandbox: z.unknown().optional()
});

export const agentSessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  workspacePath: z.string().min(1),
  gitBranch: z.string().optional(),
  runnerKind: agentRunnerKindSchema,
  settings: codingAgentTurnSettingsSchema.optional(),
  runner: runnerSessionMetadataSchema.optional(),
  codex: codexSessionMetadataSchema.optional(),
  claudeCode: claudeCodeSessionMetadataSchema.optional(),
  modelContextWindowTokens: z.number().int().positive().optional(),
  contextWindowUsedTokens: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
  status: agentSessionStatusSchema,
  activeTurnId: z.string().optional(),
  lastMessage: z.string().optional(),
  error: z.string().optional(),
  turnCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export const agentSessionTurnSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  status: agentSessionTurnStatusSchema,
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  lastMessage: z.string().optional(),
  error: z.string().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  modelContextWindowTokens: z.number().int().positive().optional()
});

export const agentSessionMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().optional(),
  role: agentSessionMessageRoleSchema,
  content: z.string(),
  context: agentSessionMessageContextSchema.optional(),
  status: agentSessionMessageStatusSchema,
  at: z.string().min(1)
});

export const agentBridgeMetricsSchema = z.object({
  totalSessions: z.number().int().nonnegative(),
  runningSessions: z.number().int().nonnegative(),
  completedTurns: z.number().int().nonnegative(),
  failedTurns: z.number().int().nonnegative(),
  cancelledTurns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
});

export const statusSnapshotSchema = z.object({
  runnerKind: agentRunnerKindSchema,
  uptimeSeconds: z.number(),
  sessions: z.array(agentSessionSchema),
  activeSessionIds: z.array(z.string()),
  recentEvents: z.array(z.unknown()),
  metrics: agentBridgeMetricsSchema
});
