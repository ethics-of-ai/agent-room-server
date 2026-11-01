import { hasSettings } from "../agent/agentSessionTypes";
import type {
  AgentRunnerKind,
  AgentSession,
  CodingAgentSettingsDescriptor,
  CodingAgentSettingValue,
  CodingAgentTurnSettings
} from "../domain/models";
import type { AgentRunner } from "../runner/AgentRunner";
import { ChildThreadError } from "./ChildThreadError";

/** Settings the create names win; otherwise a child on the parent's runner takes the parent's. */
export function childSettings(
  settings: CodingAgentTurnSettings | undefined,
  runnerKind: AgentRunnerKind,
  parent: AgentSession
): { settings?: CodingAgentTurnSettings } {
  if (hasSettings(settings)) return { settings };
  return runnerKind === parent.runnerKind && parent.settings ? { settings: parent.settings } : {};
}

/**
 * Refuses settings the runner's discovered models do not offer, before any
 * Git work, so a model meant for another runner leaves no worktree behind.
 * A runner whose discovery fails or lists no models is not checked; the
 * child's first turn then reports the runner's own error.
 */
export async function checkChildSettings(
  settings: CodingAgentTurnSettings | undefined,
  runner: Pick<AgentRunner, "getCapabilities">
): Promise<void> {
  if (!hasSettings(settings)) return;
  const capabilities = await runner.getCapabilities().catch(() => undefined);
  if (!capabilities || capabilities.error || capabilities.settings.models.length === 0) return;
  const problem = unsupportedSetting(settings, capabilities.settings);
  if (problem) throw new ChildThreadError(problem, 400, "unsupported_settings");
}

function unsupportedSetting(settings: CodingAgentTurnSettings, descriptor: CodingAgentSettingsDescriptor): string | undefined {
  const modelId = settings.model ?? descriptor.defaultSettings.model;
  const model = descriptor.models.find((option) => option.id === modelId);
  if (settings.model && !model) return `The runner has no model ${settings.model}`;
  if (!model) return undefined;
  if (!offers(model.reasoningEfforts, settings.reasoningEffort)) {
    return `Model ${model.id} has no reasoning effort ${settings.reasoningEffort}`;
  }
  if (!offers(model.serviceTiers, settings.serviceTier)) return `Model ${model.id} has no speed ${settings.serviceTier}`;
  return undefined;
}

/** A model that lists no values for a setting leaves it to the runner. */
function offers(values: CodingAgentSettingValue[], id: string | undefined): boolean {
  return !id || values.length === 0 || values.some((value) => value.id === id);
}
