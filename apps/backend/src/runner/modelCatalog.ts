import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { codingAgentModelIdSchema, codingAgentReasoningEffortIdSchema } from "../domain/settingValueSchemas";
import catalogDocument from "./modelCatalog.json";

/**
 * The static model data runners fall back to, read from `modelCatalog.json`.
 *
 * Live discovery wins wherever a runner has it (Codex `model/list`, Claude Code
 * `supportedModels()`, Cursor `models/list`). This file supplies what those
 * calls cannot: the offline fallback lists, Claude Code's effort vocabulary, and
 * DeepSeek's whole list, since its wire has no list method. Model ids stay open
 * bounded strings, so an operator-configured id the file does not list is still
 * honored by each runner.
 *
 * The file is data rather than code so it can be edited, reviewed, and later
 * published on its own. An operator's local copy at
 * `$AGENTROOM_HOME/config/models.json`, which the macOS Models pane writes, is
 * read once at startup. Each runner it lists replaces that runner's bundled
 * section; runners it omits keep the bundled data, so an app update still
 * refreshes them. `parseModelCatalog` and `parseModelCatalogOverride` are the
 * validators for any copy.
 */
export const MODEL_CATALOG_SCHEMA_VERSION = 1;

const labelSchema = z.string().trim().min(1).max(80);
const descriptionSchema = z.string().trim().min(1).max(200);

/** The levels `claudeCodeEffort()` accepts; a wider catalog would advertise efforts turns then refuse. */
const claudeCodeEffortIdSchema = z.enum(["low", "medium", "high", "xhigh"]);

const claudeCodeEffortSchema = z
  .object({ id: claudeCodeEffortIdSchema, label: labelSchema, description: descriptionSchema.optional() })
  .strict();

const claudeCodeModelSchema = z
  .object({
    id: codingAgentModelIdSchema,
    label: labelSchema,
    description: descriptionSchema.optional(),
    /** Effort ids from the runner vocabulary; absent means all of them, `[]` means none. */
    reasoningEfforts: z.array(claudeCodeEffortIdSchema).max(8).optional()
  })
  .strict();

const cursorModelSchema = z
  .object({
    id: codingAgentModelIdSchema,
    label: labelSchema,
    description: descriptionSchema.optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    depth: z
      .object({
        parameter: z.enum(["effort", "reasoning"]),
        values: z.array(codingAgentReasoningEffortIdSchema).min(1).max(12),
        defaultValue: codingAgentReasoningEffortIdSchema.optional()
      })
      .strict()
      .refine((depth) => depth.defaultValue === undefined || depth.values.includes(depth.defaultValue), {
        message: "defaultValue must be one of values"
      })
      .optional(),
    speed: z.object({ defaultFast: z.boolean() }).strict().optional(),
    isDefault: z.boolean().default(false)
  })
  .strict();

const deepseekModelSchema = z
  .object({ id: codingAgentModelIdSchema, label: labelSchema, description: descriptionSchema.optional() })
  .strict();

function uniqueIds<T extends { id: string }>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, max: number) {
  return z
    .array(schema)
    .min(1)
    .max(max)
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, {
      message: "ids must be unique"
    });
}

const runnersSchema = z
  .object({
    claude_code: z
      .object({
        reasoningEfforts: uniqueIds(claudeCodeEffortSchema, 8),
        fallbackModels: uniqueIds(claudeCodeModelSchema, 32)
      })
      .strict()
      .superRefine((runner, context) => {
        const known = new Set(runner.reasoningEfforts.map((effort) => effort.id));
        runner.fallbackModels.forEach((model, index) => {
          if (model.reasoningEfforts?.some((effort) => !known.has(effort))) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["fallbackModels", index, "reasoningEfforts"],
              message: "effort ids must come from reasoningEfforts"
            });
          }
        });
      }),
    cursor: z
      .object({ fallbackModels: uniqueIds(cursorModelSchema, 64) })
      .strict()
      .refine((runner) => runner.fallbackModels.filter((model) => model.isDefault).length <= 1, {
        message: "at most one model may be the default"
      }),
    deepseek: z.object({ models: uniqueIds(deepseekModelSchema, 32) }).strict()
  })
  .strict();

function documentSchema<T extends z.ZodTypeAny>(runners: T) {
  return z
    .object({
      $comment: z.string().max(1000).optional(),
      schemaVersion: z.literal(MODEL_CATALOG_SCHEMA_VERSION),
      runners
    })
    .strict();
}

const modelCatalogSchema = documentSchema(runnersSchema);
const modelCatalogOverrideSchema = documentSchema(runnersSchema.partial());

export type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export type ModelCatalogOverride = z.infer<typeof modelCatalogOverrideSchema>;

/** Validate a complete catalog document; throws a `ZodError` naming the bad field. */
export function parseModelCatalog(value: unknown): ModelCatalog {
  return modelCatalogSchema.parse(value);
}

/** Validate a local copy, which may list only some runners. */
export function parseModelCatalogOverride(value: unknown): ModelCatalogOverride {
  return modelCatalogOverrideSchema.parse(value);
}

/** Replace each bundled runner section the override lists, keeping the rest. */
export function mergeModelCatalog(bundled: ModelCatalog, override: ModelCatalogOverride): ModelCatalog {
  return { ...bundled, runners: { ...bundled.runners, ...override.runners } };
}

/** The bundled catalog. An invalid file fails the backend at load, not a later turn. */
export const bundledModelCatalog: ModelCatalog = parseModelCatalog(catalogDocument);

let activeModelCatalog = bundledModelCatalog;

/** The catalog runners read: bundled, or bundled merged with the local copy at startup. */
export function currentModelCatalog(): ModelCatalog {
  return activeModelCatalog;
}

export function installModelCatalog(catalog: ModelCatalog): void {
  activeModelCatalog = catalog;
}

/** Local copies larger than this are refused rather than parsed. */
export const MODEL_CATALOG_MAX_BYTES = 256 * 1024;

/** `$AGENTROOM_HOME/config/models.json`, beside `settings.json`, with the same dev fallback. */
export function resolveModelCatalogPath(agentRoomHome?: string, cwd = process.cwd()): string {
  const base = agentRoomHome ? resolve(agentRoomHome, "config") : resolve(cwd, ".agentroom", "config");
  return resolve(base, "models.json");
}

export interface LoadedModelCatalog {
  readonly catalog: ModelCatalog;
  readonly source: "bundled" | "local";
  /** Why a present local copy was ignored. */
  readonly error?: string;
}

/**
 * Read the local copy at `path` and merge it over the bundled catalog. A missing
 * file is the normal case. An unreadable, oversized, or invalid one is ignored
 * with a bounded reason, because a bad catalog must not stop the backend from
 * serving.
 */
export async function loadModelCatalog(path: string): Promise<LoadedModelCatalog> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return rejected("not a regular file");
    if (info.size > MODEL_CATALOG_MAX_BYTES) return rejected(`larger than ${MODEL_CATALOG_MAX_BYTES} bytes`);
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { catalog: bundledModelCatalog, source: "bundled" };
    return rejected("unreadable");
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return rejected("not valid JSON");
  }
  const parsed = modelCatalogOverrideSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return rejected(`${issue?.path.join(".") || "document"}: ${issue?.message ?? "invalid"}`.slice(0, 300));
  }
  return { catalog: mergeModelCatalog(bundledModelCatalog, parsed.data), source: "local" };
}

function rejected(error: string): LoadedModelCatalog {
  return { catalog: bundledModelCatalog, source: "bundled", error };
}
