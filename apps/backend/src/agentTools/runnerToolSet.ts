import type { AgentRunnerToolSet } from "../runner/AgentRunner";
import {
  advertisedAgentTools,
  bindAgentTools,
  type AgentToolCallTelemetry,
  type AgentToolHandler
} from "./dispatch";

export interface PreparedAgentRunnerToolSet {
  readonly tools: AgentRunnerToolSet;
  dispose(): void;
  isDisposed(): boolean;
}

/**
 * Build the runner-facing view of one turn's tools while retaining lifecycle
 * authority in the caller. Catalog definitions may be wider than this turn's
 * binding; the persistent child installs the former once and the latter is the
 * only path that can execute behavior.
 */
export function prepareAgentRunnerToolSet(input: {
  runId: string;
  sessionKey: string;
  catalog: readonly string[];
  allowed: readonly string[];
  handlers: Readonly<Record<string, AgentToolHandler>>;
  isLive(): boolean;
  onCall?: (telemetry: AgentToolCallTelemetry) => void;
}): PreparedAgentRunnerToolSet {
  const lifetime = new AbortController();
  const binding = bindAgentTools({
    allowed: input.allowed,
    handlers: input.handlers,
    turn: {
      sessionKey: input.sessionKey,
      runId: input.runId,
      isLive: () => !lifetime.signal.aborted && input.isLive()
    },
    ...(input.onCall ? { options: { onCall: input.onCall } } : {})
  });
  const advertisements = binding.advertisements();
  const tools: AgentRunnerToolSet = {
    required: input.allowed.length > 0,
    catalog: advertisedAgentTools(input.catalog),
    binding: {
      runId: input.runId,
      allowedNames: advertisements.map((entry) => entry.name),
      invoke: (invocation) => {
        const signal = AbortSignal.any([lifetime.signal, invocation.signal]);
        return binding.invoke(invocation.name, invocation.arguments, {
          callId: invocation.callId,
          signal
        });
      }
    }
  };

  return {
    tools,
    dispose: () => {
      lifetime.abort();
      binding.dispose();
    },
    isDisposed: () => binding.isDisposed()
  };
}
