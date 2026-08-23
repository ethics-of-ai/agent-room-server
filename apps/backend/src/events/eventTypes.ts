import type { ManagedSettingKey } from "../config/settingsStore";
import type { AgentSession, LocalWorkspaceGitOperation, StatusSnapshot } from "../domain/models";
import type { CodingAgentEventType } from "../protocol/coding/events";

export type AgentRoomEventType =
  | "status_snapshot"
  | "runner_audit"
  | "agent_session_created"
  | "agent_session_deleted"
  | "agent_turn_started"
  | "agent_turn_token_usage_updated"
  | "agent_turn_update"
  | "agent_turn_activity"
  | "agent_turn_succeeded"
  | "agent_turn_failed"
  | "agent_turn_cancelled"
  | "agent_permission_resolved"
  | "workspace_registered"
  | "workspace_removed"
  | "workspace_branch_changed"
  | "workspace_file_written"
  | "workspace_git_operation"
  | "config_reloaded"
  | "editor_catalog_changed"
  | "terminal_session_started"
  | "terminal_session_closed"
  | CodingAgentEventType;

export interface AgentRoomEvent<TPayload = unknown> {
  id: string;
  type: AgentRoomEventType;
  at: string;
  payload: TPayload;
}

export interface StatusSnapshotPayload {
  snapshot: StatusSnapshot;
}

// Emitted when an operator reload changes the served editor language catalog
// (Phase C.5). Carries only the new aggregate version + language count — never
// asset content. visionOS clients re-hydrate the catalog on receipt and verify
// every fetched blob's sha256 before use.
export interface EditorCatalogChangedPayload {
  version: string;
  languageCount: number;
}

// Emitted when `PATCH /api/config` changes the backend-owned managed settings
// file. Sanitized like the terminal and Git
// payloads: it carries changed key **names** only, never values — a value here
// would put the operator's trust posture on the wire for every WS subscriber,
// and `GET /api/config` is the one place that reports values, with tier 3 kept
// out of it by construction. Everything managed applies on backend restart, so
// `requiresRestart` is a constant the clients render rather than a computation.
//
// `audit` duplicates the names deliberately: `FileAuditLogStore` keeps only
// `payload.audit` verbatim, and a durable entry that recorded nothing but
// "config changed at T" would lose the point of persisting this event at all —
// a remote flip of `terminalEnabled` should still be traceable tomorrow.
export interface ConfigReloadedPayload {
  /** Canonical version-2 addresses (`global.terminalEnabled`), names only. */
  changedKeys: ManagedSettingKey[];
  requiresRestart: true;
  audit: { changedKeys: ManagedSettingKey[] };
}

export interface AgentSessionPayload {
  session: AgentSession;
}

// Emitted when a permission request a runner raised mid-turn is answered — by a
// person through the answer route, by the runner's configured policy, or by the
// bounded wait running out. It is the durable half of that decision, and it is
// sanitized in the direction that matters: what was *decided* is recorded (which
// option, on whose authority), never what was being asked for. The tool call an
// agent was about to run can carry anything at all, and a durable log is the
// wrong place for it; the live `coding_permission_requested` event is where a
// client gets what it needs to show the operator a choice.
export interface AgentPermissionResolvedPayload {
  sessionId: string;
  turnId: string;
  workspaceId: string;
  workspacePath: string;
  runnerKind: string;
  audit: {
    requestId?: string;
    optionId?: string;
    /** `human`, `policy`, or `timeout`. */
    decidedBy?: string;
    status?: string;
  };
}

// Emitted for each fixed mutating Git operation on a registered workspace.
// Sanitized like the terminal payloads: identifiers, the operation, the branch
// and commit it produced, and counts — never file content, never a path list,
// and never a remote URL (an HTTPS one can carry credentials in its userinfo).
export interface WorkspaceGitOperationPayload {
  workspaceId: string;
  workspacePath: string;
  operation: LocalWorkspaceGitOperation;
  branch?: string;
  previousBranch?: string;
  commit?: string;
  remote?: string;
  /** Paths the operation acted on. */
  fileCount: number;
  /** Changed paths remaining after it ran. */
  changedFileCount: number;
}

// Terminal (PTY) lifecycle. Sanitized: carries identifiers and, on close, the
// exit code and duration only. Shell input/output bytes are NEVER emitted or
// persisted (they can contain secrets), so these payloads never include them.
export interface TerminalSessionStartedPayload {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
}

export interface TerminalSessionClosedPayload {
  sessionId: string;
  workspaceId: string;
  workspacePath: string;
  audit: {
    exitCode?: number;
    durationMs: number;
  };
}
