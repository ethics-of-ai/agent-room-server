import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { LanguageServiceFeatureKind } from "../../domain/languageService";
import type { LanguageServiceReadiness } from "../../domain/languageService";
import type { ServiceConfig } from "../../domain/models";

export interface LanguageServiceProjectMarker {
  readonly kind: "exact" | "suffix";
  readonly value: string;
  readonly priority: number;
  readonly entryType?: "file" | "directory";
}

export interface LanguageServiceServerRequestPolicy {
  readonly workDoneProgressCreate?: "null";
  readonly workspaceConfiguration?: "null_per_item";
}

export interface ResolvedLanguageServiceExecutable {
  readonly command: string;
  readonly args: readonly string[];
  readonly initializationOptions?: unknown;
}

export interface LanguageServiceDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly testedVersion: string;
  readonly positionEncoding: "utf-16";
  readonly languageIds: readonly string[];
  readonly featureKinds: readonly LanguageServiceFeatureKind[];
  readonly projectMarkers: readonly LanguageServiceProjectMarker[];
  readonly standaloneWorkspaceRoot: boolean;
  readonly initializationOptions?: unknown;
  readonly projectLoading: {
    readonly mayInvokeBuildTools: boolean;
    readonly mayLoadPlugins: boolean;
  };
  readonly serverRequests?: LanguageServiceServerRequestPolicy;
  /** Private per-process storage appended to fixed argv and removed when the process closes. */
  readonly temporaryStorage?: {
    readonly argument: string;
    readonly prefix: string;
  };
  readonly environmentKeys: readonly string[];
  configured(config: ServiceConfig): boolean;
  resolveExecutable(config: ServiceConfig): Promise<ResolvedLanguageServiceExecutable>;
}

export interface LanguageServiceSpawner {
  spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv }
  ): ChildProcessWithoutNullStreams;
}

export interface LanguageServiceRegistryProjection {
  id: string;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  ready?: boolean;
  languageIds: string[];
  featureKinds: LanguageServiceFeatureKind[];
}

export interface OpenLanguageDocument {
  documentId: string;
  uri: string;
  languageId: string;
  lspVersion: number;
  text: string;
}

export interface ChangeLanguageDocument {
  uri: string;
  lspVersion: number;
  text: string;
}

export interface LanguageFeatureRequest {
  kind: LanguageServiceFeatureKind;
  uri: string;
  position?: { line: number; character: number };
  timeoutMs: number;
}

export interface LanguageFeatureRequestHandle {
  id: number;
  promise: Promise<unknown>;
}

/** The process adapter boundary. The host never speaks JSON-RPC directly. */
export interface EditorLanguageService {
  descriptor(): LanguageServiceDescriptor;
  probe(): Promise<LanguageServiceReadiness>;
  openDocument(input: OpenLanguageDocument): Promise<void>;
  changeDocument(input: ChangeLanguageDocument): Promise<void>;
  request(input: LanguageFeatureRequest): LanguageFeatureRequestHandle;
  cancel(requestId: number): void;
  closeDocument(documentId: string, uri: string): Promise<void>;
  close(options?: { force?: boolean }): Promise<void>;
  readonly semanticTokenLegend?: { tokenTypes: string[]; tokenModifiers: string[] };
}
