import type {
  ClaudeCodePermissionMode,
  ClientCompatibility,
  CodexApprovalPolicy,
  CodexSandboxMode,
  ReleaseCompatibility,
  ServiceConfig
} from "./models";

// The safe client-renderable projection of the backend's configuration, split
// from `models.ts` when the file outgrew its size-budget exception. It stays a
// domain contract: `toPublicConfig` builds it and the shared Apple client
// mirrors its fields.

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
  sceneEngineEnabled?: boolean;
  repositorySketches: true;
  languageServicesEnabled?: boolean;
  terminalEnabled: boolean;
}

export type { ClientCompatibility };
