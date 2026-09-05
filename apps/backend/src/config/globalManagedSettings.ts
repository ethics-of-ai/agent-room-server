import { z } from "zod";
import type { ManagedSettingDefinition } from "../domain/managedSettings";
import { agentRunnerKindSchema, serviceConfigSchema } from "../domain/schemas";

/**
 * Backend-owned managed settings, in canonical file and client-mirror order.
 *
 * Runner-owned settings live on their descriptors. Keeping this table out of
 * settingsStore.ts lets that persistence module remain about one thing: how a
 * declared setting is resolved, migrated, validated, and written.
 */
export const globalSettingDefinitions: readonly ManagedSettingDefinition[] = [
  {
    field: "runnerKind",
    schema: agentRunnerKindSchema.optional(),
    tier: 1,
    env: "RUNNER_KIND",
    valueKind: "string",
    defaultValue: "codex"
  },
  {
    field: "artifactsEnabled",
    schema: z.boolean().optional(),
    tier: 1,
    env: "ARTIFACTS_ENABLED",
    valueKind: "boolean",
    defaultValue: true
  },
  {
    field: "languageCatalogEnabled",
    schema: z.boolean().optional(),
    tier: 1,
    env: "LANGUAGE_CATALOG_ENABLED",
    valueKind: "boolean",
    defaultValue: true
  },
  {
    field: "sceneEngineEnabled",
    schema: z.boolean().optional(),
    tier: 1,
    env: "SCENE_ENGINE_ENABLED",
    valueKind: "boolean",
    defaultValue: true
  },
  {
    field: "clarifyingQuestionsEnabled",
    schema: z.boolean().optional(),
    tier: 1,
    env: "CLARIFYING_QUESTIONS_ENABLED",
    valueKind: "boolean",
    defaultValue: true
  },
  {
    field: "gitCommandTimeoutMs",
    schema: serviceConfigSchema.shape.gitCommandTimeoutMs.optional(),
    tier: 1,
    env: "GIT_COMMAND_TIMEOUT_MS",
    valueKind: "number",
    defaultValue: 30_000
  },
  {
    field: "gitNetworkTimeoutMs",
    schema: serviceConfigSchema.shape.gitNetworkTimeoutMs,
    tier: 1,
    env: "GIT_NETWORK_TIMEOUT_MS",
    valueKind: "number",
    defaultValue: 120_000
  },
  {
    field: "languageServicesEnabled",
    schema: z.boolean().optional(),
    tier: 2,
    env: "LANGUAGE_SERVICES_ENABLED",
    valueKind: "boolean",
    defaultValue: false
  },
  {
    field: "terminalEnabled",
    schema: z.boolean().optional(),
    tier: 2,
    env: "TERMINAL_ENABLED",
    valueKind: "boolean",
    defaultValue: false
  },
  {
    field: "terminalMaxSessions",
    schema: serviceConfigSchema.shape.terminalMaxSessions.removeDefault().optional(),
    tier: 2,
    env: "TERMINAL_MAX_SESSIONS",
    valueKind: "number",
    defaultValue: 8
  }
];
