import type { AgentToolCapability } from "../../agentTools/catalog";
import { unboundAgentToolResult, type AgentToolAdvertisement } from "../../agentTools/dispatch";
import type { ServiceConfig } from "../../domain/models";
import type { AgentRunnerToolSet } from "../AgentRunner";
import { runnerDescriptor, type RegisteredRunnerKind } from "../registry";

/**
 * Transport-neutral handling of the tool set a session supplies to a turn.
 * Every adapter uses these rules, so none of them decides per tool what a
 * missing registration means or how adapter-owned tools join the session's.
 */

/**
 * The tool capabilities a runner's descriptor offers under this configuration.
 * None without a transport. Fails closed when the transport is gated on
 * configuration and none was supplied.
 */
export function runnerAgentToolCapabilities(
  runnerKind: string,
  config: ServiceConfig | undefined
): readonly AgentToolCapability[] {
  const policy = runnerDescriptor(runnerKind).agentTools;
  if (policy.mode === "none") return [];
  if (policy.availableWhen && !(config && policy.availableWhen(config))) return [];
  return policy.capabilities;
}

/**
 * Join the session's tools with tools the adapter owns itself (a native
 * question channel). Adapter names win on a clash. Readiness and standing
 * instructions stay the session's: the adapter's own tools keep the readiness
 * they had before the session supplied anything.
 */
export function combineRunnerToolSets(
  session: AgentRunnerToolSet | undefined,
  adapter: AgentRunnerToolSet
): AgentRunnerToolSet {
  const adapterNames = new Set(adapter.catalog.map((entry) => entry.name));
  const sessionNames = new Set(session?.binding.allowedNames ?? []);
  return {
    required: session?.required ?? false,
    ...(session?.instructions ? { instructions: session.instructions } : {}),
    catalog: combinedToolCatalog(session?.catalog, adapter.catalog),
    binding: {
      runId: adapter.binding.runId,
      allowedNames: [
        ...(session?.binding.allowedNames ?? []).filter((name) => !adapterNames.has(name)),
        ...adapter.binding.allowedNames
      ],
      invoke: (call) =>
        adapterNames.has(call.name)
          ? adapter.binding.invoke(call)
          : session && sessionNames.has(call.name)
            ? session.binding.invoke(call)
            : Promise.resolve(unboundAgentToolResult(call.name))
    }
  };
}

/** The catalog a transport registers: the session's definitions, then the adapter's own. */
export function combinedToolCatalog(
  session: readonly AgentToolAdvertisement[] | undefined,
  adapter: readonly AgentToolAdvertisement[]
): AgentToolAdvertisement[] {
  const adapterNames = new Set(adapter.map((entry) => entry.name));
  return [...(session ?? []).filter((entry) => !adapterNames.has(entry.name)), ...adapter];
}

/**
 * The prompt a turn sends, after comparing its allowed tools with what the
 * native transport actually registered. `registered` undefined means the
 * transport cannot say (a restored native thread keeps a catalog the adapter
 * never saw).
 *
 * A turn that requires its tools fails when any are missing or unknown. An
 * optional turn proceeds; a notice in front of the prompt tells the model
 * which tools are missing, or that none of them could be confirmed.
 */
export function promptWithRegisteredTools(
  input: { prompt: string; tools?: AgentRunnerToolSet },
  registered: ReadonlySet<string> | undefined,
  runnerKind: RegisteredRunnerKind
): string {
  const allowed = input.tools?.binding.allowedNames ?? [];
  if (allowed.length === 0) return input.prompt;
  const runnerName = runnerDescriptor(runnerKind).displayName;
  if (!registered) {
    if (input.tools?.required) {
      throw new Error(`${runnerName} cannot confirm that this conversation registered AgentRoom tools, which this turn requires. Start a new AgentRoom session to use them.`);
    }
    return withNotice(unconfirmedToolsNotice(allowed), input.prompt);
  }
  const missing = allowed.filter((name) => !registered.has(name));
  if (missing.length === 0) return input.prompt;
  if (input.tools?.required) {
    throw new Error(`${runnerName} did not register the AgentRoom tools this turn requires: ${missing.join(", ")}. Start a new AgentRoom session to use them.`);
  }
  return withNotice(unregisteredToolsNotice(missing), input.prompt);
}

/** What the model reads when offered tools did not reach its tool list. */
export function unregisteredToolsNotice(names: readonly string[]): string {
  return (
    `AgentRoom could not register these tools with your tool list for this turn: ${names.join(", ")}. ` +
    "They are unavailable even where other context offers them. Do not claim to have used them or their effects; " +
    "if the request needs them, tell the person they are unavailable."
  );
}

/** What the model reads when the transport cannot say whether offered tools were registered. */
export function unconfirmedToolsNotice(names: readonly string[]): string {
  return (
    `AgentRoom could not confirm that these tools are in your tool list for this turn: ${names.join(", ")}. ` +
    "If one is missing or a call to it fails, treat it as unavailable. Do not claim to have used it or its effects; " +
    "if the request needs it, tell the person it is unavailable."
  );
}

function withNotice(notice: string, prompt: string): string {
  return `${notice}\n\n${prompt}`;
}
