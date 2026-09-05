import type { LanguageServiceFeatureKind } from "../../domain/languageService";
import type { LanguageServiceServerFrame } from "../../domain/languageService";
import type { ResolvedLanguageServiceProject } from "./projectRoot";
import type { EditorLanguageService, LanguageServiceDescriptor } from "./types";

export interface LanguageServiceConnectionPort {
  readonly id: string;
  readonly workspaceId: string;
  send(frame: LanguageServiceServerFrame): void;
}

export interface DocumentShadow {
  connection: LanguageServiceConnectionPort;
  relativePath: string;
  uri: string;
  languageId: string;
  text: string;
  clientVersion: number;
  mappedClientVersion: number;
  lspVersion: number;
  closed: boolean;
  changeTimer?: NodeJS.Timeout;
  flushInProgress?: Promise<void>;
}

export interface OutstandingRequest {
  connectionId: string;
  requestId: string;
  clientVersion: number;
  lspId: number;
  cancelled: boolean;
}

export interface ServiceInstance {
  key: string;
  workspaceId: string;
  project: ResolvedLanguageServiceProject;
  descriptor: LanguageServiceDescriptor;
  service?: EditorLanguageService;
  startingService?: EditorLanguageService;
  startPromise?: Promise<void>;
  replayPromise?: Promise<void>;
  replayRequired: boolean;
  documents: Map<string, DocumentShadow>;
  pendingDocuments: number;
  outstanding: Map<string, OutstandingRequest>;
  restartTimes: number[];
  healthySince?: number;
  terminalFailure: boolean;
  idleTimer?: NodeJS.Timeout;
  semanticTokenLegend?: { tokenTypes: string[]; tokenModifiers: string[] };
}

export interface StartFeatureRequestInput {
  requestId: string;
  clientVersion: number;
  kind: LanguageServiceFeatureKind;
  position?: { line: number; character: number };
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}
