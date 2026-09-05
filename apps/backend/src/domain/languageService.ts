export const LANGUAGE_SERVICE_PROTOCOL_VERSION = 1 as const;

/** Tier-3 executable selections that never enter managed or public configuration. */
export interface LanguageServiceExecutableConfig {
  sourcekitLspExecutable?: string;
  rustAnalyzerExecutable?: string;
  goplsExecutable?: string;
  jdtlsExecutable?: string;
  kotlinLspExecutable?: string;
  csharpLsExecutable?: string;
}

export type LanguageServiceFeatureKind =
  | "completion"
  | "hover"
  | "definition"
  | "document_symbols"
  | "semantic_tokens";

export interface LanguageServicePosition {
  line: number;
  character: number;
}

export interface LanguageServiceRange {
  start: LanguageServicePosition;
  end: LanguageServicePosition;
}

export interface LanguageServiceDiagnostic {
  range: LanguageServiceRange;
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  source?: string;
  code?: string;
}

export type LanguageServiceCompletionKind =
  | "text" | "method" | "function" | "constructor" | "field" | "variable"
  | "class" | "interface" | "module" | "property" | "value" | "enum"
  | "keyword" | "file" | "reference" | "folder" | "enum_member" | "constant"
  | "struct" | "event" | "operator" | "type_parameter" | "other";

export interface LanguageServiceCompletion {
  label: string;
  kind: LanguageServiceCompletionKind;
  detail?: string;
  documentation?: string;
  insertText?: string;
  textEdit?: { range: LanguageServiceRange; newText: string };
}

export interface LanguageServiceHover {
  contents: string;
  range?: LanguageServiceRange;
}

export interface LanguageServiceDefinition {
  path: string;
  range: LanguageServiceRange;
}

export interface LanguageServiceDocumentSymbol {
  name: string;
  kind: LanguageServiceCompletionKind;
  range: LanguageServiceRange;
  selectionRange: LanguageServiceRange;
  children: LanguageServiceDocumentSymbol[];
}

export type LanguageServiceFeatureResult =
  | { kind: "completion"; items: LanguageServiceCompletion[]; truncated: boolean }
  | { kind: "hover"; hover: LanguageServiceHover | null; truncated: boolean }
  | { kind: "definition"; locations: LanguageServiceDefinition[]; truncated: boolean }
  | { kind: "document_symbols"; symbols: LanguageServiceDocumentSymbol[]; truncated: boolean }
  | { kind: "semantic_tokens"; tokens: { data: number[] }; truncated: boolean };

export type LanguageServiceReadiness =
  | "ready"
  | "unavailable"
  | "ambiguous_project"
  | "project_not_found"
  | "restarting"
  | "failed";

export interface LanguageServiceStatusFrame {
  type: "status";
  protocolVersion: typeof LANGUAGE_SERVICE_PROTOCOL_VERSION;
  clientVersion: number;
  service: { id: string; displayName: string };
  readiness: LanguageServiceReadiness;
  featureKinds: LanguageServiceFeatureKind[];
  project?: { root: string; marker?: string };
  semanticTokenLegend?: { tokenTypes: string[]; tokenModifiers: string[] };
}

export type LanguageServiceErrorCode =
  | "unauthorized" | "invalid_frame" | "frame_too_large" | "workspace_not_found" | "invalid_path"
  | "unsupported_language" | "project_not_found" | "ambiguous_project"
  | "service_unavailable" | "process_limit" | "document_limit" | "document_too_large"
  | "global_document_limit" | "document_busy" | "resync_required" | "request_limit"
  | "stale_document" | "invalid_position" | "timeout" | "cancelled"
  | "server_failed" | "unsupported_response" | "outbound_limit";

export type LanguageServiceServerFrame =
  | LanguageServiceStatusFrame
  | { type: "diagnostics"; clientVersion: number; diagnostics: LanguageServiceDiagnostic[]; truncated: boolean }
  | { type: "response"; requestId: string; clientVersion: number; result: LanguageServiceFeatureResult }
  | { type: "error"; code: LanguageServiceErrorCode; message: string; requestId?: string };
