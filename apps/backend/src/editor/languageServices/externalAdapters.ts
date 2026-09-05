import { isAbsolute } from "node:path";
import { z } from "zod";
import { booleanEnv, optionalEnv } from "../../config/env";
import type { LanguageServiceFeatureKind } from "../../domain/languageService";
import { logger } from "../../logging/logger";
import { admittedLanguageServiceExecutable } from "./executable";
import {
  baseLanguageServiceEnvironmentKeys,
  isGrantableLanguageServiceEnvironmentName
} from "./environment";
import type { LanguageServiceDescriptor } from "./types";

const MAX_DEFINITION_BYTES = 64 * 1_024;
const adapterIdPattern = /^external_lsp_[a-z][a-z0-9_]{0,24}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const boundedString = (label: string, maxBytes: number) => z.string().min(1).refine(
  (value) => utf8Bytes(value) <= maxBytes,
  `${label} exceeds ${maxBytes} UTF-8 bytes`
).refine((value) => !value.includes("\0"), `${label} contains NUL`);
const argumentSchema = z.string().max(256).refine((value) => !value.includes("\0"), "argument contains NUL");
const languageIdSchema = z.string().min(1)
  .regex(identifierPattern, "language id contains unsupported characters")
  .refine((value) => utf8Bytes(value) <= 64, "language id exceeds 64 UTF-8 bytes");
const markerValueSchema = boundedString("project marker", 255).refine(
  (value) => !value.includes("/") && !value.includes("\\") && !value.includes("\0")
    && value !== "." && value !== "..",
  "project marker must be a basename"
);
const projectMarkerSchema = z.object({
  kind: z.enum(["exact", "suffix"]),
  value: markerValueSchema,
  priority: z.number().int().min(0).max(1_000),
  entryType: z.enum(["file", "directory"])
}).strict().superRefine((marker, context) => {
  if (marker.kind === "suffix" && !marker.value.startsWith(".")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "suffix project marker must start with ."
    });
  }
});
const featureKindSchema = z.enum([
  "completion",
  "hover",
  "definition",
  "document_symbols",
  "semantic_tokens"
]);
const environmentGrantSchema = z.string().refine(
  isGrantableLanguageServiceEnvironmentName,
  "environment name is not grantable"
);

const adapterDefinitionSchema = z.object({
  id: z.string().regex(adapterIdPattern, "id must match external_lsp_[a-z][a-z0-9_]*"),
  displayName: boundedString("display name", 80),
  testedVersion: boundedString("tested version", 120),
  command: boundedString("command", 1_024).refine(isAbsolute, "command must be absolute"),
  args: z.array(argumentSchema).max(32).default([]),
  languageIds: z.array(languageIdSchema).min(1).max(16),
  projectMarkers: z.array(projectMarkerSchema).max(16).default([]),
  standaloneWorkspaceRoot: z.boolean(),
  featureKinds: z.array(featureKindSchema).min(1).max(5),
  envGrants: z.array(environmentGrantSchema).max(16).default([])
}).strict().superRefine((definition, context) => {
  requireUnique(definition.languageIds, "languageIds", context);
  requireUnique(definition.featureKinds, "featureKinds", context);
  requireUnique(definition.envGrants, "envGrants", context);
  requireUnique(
    definition.projectMarkers.map((marker) => `${marker.kind}\0${marker.value}\0${marker.entryType}`),
    "projectMarkers",
    context
  );
  if (!definition.standaloneWorkspaceRoot && definition.projectMarkers.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectMarkers"],
      message: "a project-only service requires at least one marker"
    });
  }
});

const adapterListSchema = z.array(adapterDefinitionSchema).max(8);
type ParsedAdapterDefinition = z.infer<typeof adapterDefinitionSchema>;

export interface ExternalLanguageServiceAdapterConfig extends ParsedAdapterDefinition {
  readonly featureKinds: LanguageServiceFeatureKind[];
}

export function externalLanguageServicesEnabled(): boolean {
  return booleanEnv("EXTERNAL_LANGUAGE_SERVICES_ENABLED", false);
}

/** Parse the environment-only adapter list; any issue drops the whole list. */
export function readExternalLanguageServiceAdapterConfigs(
  raw = optionalEnv("LANGUAGE_SERVICE_ADAPTERS")
): ExternalLanguageServiceAdapterConfig[] {
  if (!externalLanguageServicesEnabled() || !raw) return [];
  if (utf8Bytes(raw) > MAX_DEFINITION_BYTES) {
    logger.warn("LANGUAGE_SERVICE_ADAPTERS exceeds 64 KiB; no external language services registered");
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("LANGUAGE_SERVICE_ADAPTERS is not valid JSON; no external language services registered");
    return [];
  }
  const result = adapterListSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      { issues: result.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
      "LANGUAGE_SERVICE_ADAPTERS failed validation; no external language services registered"
    );
    return [];
  }
  const ids = new Set<string>();
  const languages = new Set<string>();
  for (const definition of result.data) {
    if (ids.has(definition.id)) {
      logger.warn({ id: definition.id }, "Duplicate external language service id; no adapters registered");
      return [];
    }
    const duplicateLanguage = definition.languageIds.find((languageId) => languages.has(languageId));
    if (duplicateLanguage) {
      logger.warn(
        { languageId: duplicateLanguage },
        "External language service language ids overlap; no adapters registered"
      );
      return [];
    }
    ids.add(definition.id);
    definition.languageIds.forEach((languageId) => languages.add(languageId));
  }
  return result.data;
}

/** Build descriptors only when no external language id can shadow a built-in service. */
export function externalLanguageServiceDescriptors(
  configs: readonly ExternalLanguageServiceAdapterConfig[],
  reservedLanguageIds: ReadonlySet<string>
): LanguageServiceDescriptor[] {
  const conflict = configs.flatMap((config) => config.languageIds).find((id) => reservedLanguageIds.has(id));
  if (conflict) {
    logger.warn(
      { languageId: conflict },
      "External language service overlaps a built-in language id; no adapters registered"
    );
    return [];
  }
  return configs.map(externalLanguageServiceDescriptor);
}

export function externalLanguageServiceDescriptor(
  adapter: ExternalLanguageServiceAdapterConfig
): LanguageServiceDescriptor {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    testedVersion: adapter.testedVersion,
    positionEncoding: "utf-16",
    languageIds: [...adapter.languageIds],
    featureKinds: [...adapter.featureKinds],
    projectMarkers: adapter.projectMarkers.map((marker) => ({ ...marker })),
    standaloneWorkspaceRoot: adapter.standaloneWorkspaceRoot,
    // An arbitrary external binary is treated conservatively. These are trust
    // declarations, not sandbox enforcement, so the adapter cannot claim a
    // weaker posture through configuration.
    projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: true },
    serverRequests: {
      workDoneProgressCreate: "null",
      workspaceConfiguration: "null_per_item"
    },
    environmentKeys: [...baseLanguageServiceEnvironmentKeys, ...adapter.envGrants],
    // The safe registry read reports that a complete definition exists. The
    // executable is admitted only on an authenticated open, so this projection
    // remains filesystem- and spawn-free like every built-in descriptor.
    configured: () => true,
    resolveExecutable: async () => ({
      command: await admittedLanguageServiceExecutable(adapter.command, adapter.displayName),
      args: [...adapter.args]
    })
  };
}

function requireUnique(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${path} must be unique` });
  }
}
