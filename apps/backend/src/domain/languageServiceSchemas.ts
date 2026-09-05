import { z } from "zod";
import type {
  LanguageServiceDocumentSymbol,
  LanguageServiceServerFrame
} from "./languageService";

const boundedUtf8 = (maxBytes: number) => z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= maxBytes,
  `Must be at most ${maxBytes} UTF-8 bytes`
);

export const languageServiceFeatureKindSchema = z.enum([
  "completion",
  "hover",
  "definition",
  "document_symbols",
  "semantic_tokens"
]);

export const languageServicePositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative()
}).strict();

export const languageServiceRangeSchema = z.object({
  start: languageServicePositionSchema,
  end: languageServicePositionSchema
}).strict();

const pathSchema = boundedUtf8(1024).refine((value) => value.length > 0, "Path is required");
const clientVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const requestIdSchema = z.string().min(1).max(128);

export const languageServiceClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("open"),
    path: pathSchema,
    languageId: z.string().min(1).max(80),
    clientVersion: clientVersionSchema,
    text: boundedUtf8(256 * 1024)
  }).strict(),
  z.object({
    type: z.literal("change"),
    clientVersion: clientVersionSchema,
    text: boundedUtf8(256 * 1024)
  }).strict(),
  z.object({
    type: z.literal("request"),
    requestId: requestIdSchema,
    clientVersion: clientVersionSchema,
    kind: languageServiceFeatureKindSchema,
    position: languageServicePositionSchema.optional(),
    range: languageServiceRangeSchema.optional()
  }).strict(),
  z.object({ type: z.literal("cancel"), requestId: requestIdSchema }).strict(),
  z.object({ type: z.literal("close") }).strict()
]);

export type LanguageServiceClientFrame = z.infer<typeof languageServiceClientFrameSchema>;

export const languageServiceCompletionKindSchema = z.enum([
  "text", "method", "function", "constructor", "field", "variable", "class", "interface",
  "module", "property", "value", "enum", "keyword", "file", "reference", "folder",
  "enum_member", "constant", "struct", "event", "operator", "type_parameter", "other"
]);

export const languageServiceDiagnosticSchema = z.object({
  range: languageServiceRangeSchema,
  message: boundedUtf8(4 * 1024),
  severity: z.enum(["error", "warning", "information", "hint"]),
  source: boundedUtf8(128).optional(),
  code: boundedUtf8(128).optional()
}).strict();

const languageServiceCompletionSchema = z.object({
  label: boundedUtf8(256),
  kind: languageServiceCompletionKindSchema,
  detail: boundedUtf8(4 * 1024).optional(),
  documentation: boundedUtf8(16 * 1024).optional(),
  insertText: boundedUtf8(256 * 1024).optional(),
  textEdit: z.object({
    range: languageServiceRangeSchema,
    newText: boundedUtf8(256 * 1024)
  }).strict().optional()
}).strict();

const languageServiceHoverSchema = z.object({
  contents: boundedUtf8(16 * 1024),
  range: languageServiceRangeSchema.optional()
}).strict();

const languageServiceDefinitionSchema = z.object({
  path: boundedUtf8(1024),
  range: languageServiceRangeSchema
}).strict();

const languageServiceDocumentSymbolSchema: z.ZodType<LanguageServiceDocumentSymbol> = z.lazy(() => z.object({
  name: boundedUtf8(256),
  kind: languageServiceCompletionKindSchema,
  range: languageServiceRangeSchema,
  selectionRange: languageServiceRangeSchema,
  children: z.array(languageServiceDocumentSymbolSchema).max(1_000)
}).strict());

export const languageServiceFeatureResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completion"),
    items: z.array(languageServiceCompletionSchema).max(200),
    truncated: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("hover"),
    hover: languageServiceHoverSchema.nullable(),
    truncated: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("definition"),
    locations: z.array(languageServiceDefinitionSchema).max(20),
    truncated: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("document_symbols"),
    symbols: z.array(languageServiceDocumentSymbolSchema).max(1_000),
    truncated: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("semantic_tokens"),
    tokens: z.object({
      data: z.array(z.number().int().nonnegative()).max(100_000)
        .refine((data) => data.length % 5 === 0, "Semantic tokens use five-integer groups")
    }).strict(),
    truncated: z.boolean()
  }).strict()
]);

export const languageServiceErrorCodeSchema = z.enum([
  "unauthorized", "invalid_frame", "frame_too_large", "workspace_not_found", "invalid_path",
  "unsupported_language", "project_not_found", "ambiguous_project", "service_unavailable",
  "process_limit", "document_limit", "document_too_large", "global_document_limit",
  "document_busy", "resync_required", "request_limit", "stale_document", "invalid_position",
  "timeout", "cancelled", "server_failed", "unsupported_response", "outbound_limit"
]);

export const languageServiceServerFrameSchema: z.ZodType<LanguageServiceServerFrame> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    protocolVersion: z.literal(1),
    clientVersion: clientVersionSchema,
    service: z.object({ id: boundedUtf8(64), displayName: boundedUtf8(128) }).strict(),
    readiness: z.enum(["ready", "unavailable", "ambiguous_project", "project_not_found", "restarting", "failed"]),
    featureKinds: z.array(languageServiceFeatureKindSchema).max(5),
    project: z.object({ root: boundedUtf8(1024), marker: boundedUtf8(255).optional() }).strict().optional(),
    semanticTokenLegend: z.object({
      tokenTypes: z.array(boundedUtf8(64)).max(128),
      tokenModifiers: z.array(boundedUtf8(64)).max(64)
    }).strict().optional()
  }).strict(),
  z.object({
    type: z.literal("diagnostics"),
    clientVersion: clientVersionSchema,
    diagnostics: z.array(languageServiceDiagnosticSchema).max(500),
    truncated: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("response"),
    requestId: requestIdSchema,
    clientVersion: clientVersionSchema,
    result: languageServiceFeatureResultSchema
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: languageServiceErrorCodeSchema,
    message: boundedUtf8(4 * 1024),
    requestId: requestIdSchema.optional()
  }).strict()
]);
