import { randomUUID } from "node:crypto";
import { redactSecrets } from "../util/redactSecrets";
import { agentToolByLogicalId, agentToolByName } from "./catalog";

/**
 * Bound dispatch for AgentRoom tools: the small external interface a runner
 * adapter uses to make catalog tools callable from its native transport.
 *
 * A binding is created per turn. It resolves the turn's allowed logical ids
 * against the catalog at bind time, so the set is closed before any call
 * arrives, and it carries the turn handle whose liveness is revalidated before
 * a handler runs. A handler that settles after its turn ended is discarded:
 * its result never reaches whichever turn is active now — the waiting
 * transport is answered with the tool's own unavailable text.
 *
 * What the dispatcher owns: allowlist resolution, lifecycle refusal, call
 * correlation ids for telemetry, bounded string results, and safe handling of a
 * misbehaving handler. What it deliberately does not own: input validation and
 * behavior (the injected handler's), waiting and timeouts (a question handler's
 * human-wait clock must not be shortened by any generic bound), and activity
 * emission — the native transport already reports the call, and the question
 * pair reports its own resolution, so emitting a generic lifecycle activity
 * here would double it.
 *
 * Telemetry is metadata only: logical id, name, correlation id, outcome, and
 * duration. Arguments and results never reach it, and a handler error arrives
 * redacted. The correlation id is observability, not a durable mutation id —
 * retry semantics belong to the handler's owning module.
 */

/** Bound identity of the turn a binding serves. Opaque to the dispatcher. */
export interface AgentToolTurnHandle {
  readonly sessionKey: string;
  readonly runId: string;
  /**
   * Whether the originating turn is still the live turn of its session.
   * Revalidated before every handler call; a dead binding refuses.
   */
  isLive(): boolean;
}

export interface AgentToolInvocationContext extends AgentToolTurnHandle {
  readonly callId: string;
  readonly signal: AbortSignal;
}

/** An injected async handler. Returns the model-facing text result. */
export type AgentToolHandler = (input: unknown, turn: AgentToolInvocationContext) => Promise<string>;

/** What a runner host receives: serializable definition data, nothing else. */
export interface AgentToolAdvertisement {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
}

/** The input-only view a native tool list registers: name, description, and input schema. */
export function agentToolInputSpec(
  entry: AgentToolAdvertisement
): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return { name: entry.name, description: entry.description, inputSchema: entry.inputSchema };
}

export type AgentToolCallOutcome =
  | "completed"
  | "truncated"
  | "unavailable"
  | "unknown_tool"
  | "malformed_result"
  | "handler_error";

export interface AgentToolCallTelemetry {
  readonly logicalId: string;
  readonly name: string;
  readonly callId: string;
  readonly outcome: AgentToolCallOutcome;
  readonly durationMs: number;
  /** Present only for a handler error, already redacted. */
  readonly error?: string;
  /** True when the binding was disposed while the handler ran. */
  readonly late?: boolean;
}

/** The result-length bound every tool text crosses, questions included. */
export const MAX_AGENT_TOOL_RESULT_CHARS = 64 * 1024;

const TRUNCATION_SUFFIX = "\n…(result truncated)";

const unknownToolResult = (name: string): string =>
  `The tool "${name.slice(0, 200)}" is not available in this session. ` +
  "Proceed with your best judgment and state the assumptions you made.";

const HANDLER_ERROR_RESULT =
  "This tool could not complete its work. Proceed with your best judgment and state the assumptions you made.";

const MALFORMED_RESULT =
  "This tool returned a result it could not present. Proceed with your best judgment and state the assumptions you made.";

export interface AgentToolBinding {
  /** Serializable definitions for the turn's allowed tools, in allow order. */
  advertisements(): readonly AgentToolAdvertisement[];
  /**
   * Invoke one allowed tool by its model-facing name (or logical id). Always
   * settles with model-facing text — an unknown tool, a dead binding, a thrown
   * handler, a malformed result, or a handler that settled after its turn
   * ended each become a bounded refusal the model can act on rather than a
   * transport error.
   */
  invoke(
    toolName: string,
    input: unknown,
    options?: { readonly callId?: string; readonly signal?: AbortSignal }
  ): Promise<string>;
  /**
   * End the binding: further calls are refused and an in-flight call that
   * settles afterwards has its result discarded, both answered with the
   * tool's unavailable text instead of a result.
   */
  dispose(): void;
  isDisposed(): boolean;
}

export function bindAgentTools(input: {
  /** Logical ids resolved against the catalog at bind time. */
  allowed: readonly string[];
  /** Handlers keyed by logical id, injected by the adapter per turn. */
  handlers: Readonly<Record<string, AgentToolHandler>>;
  turn: AgentToolTurnHandle;
  options?: {
    maxResultChars?: number;
    /** Safe-metadata telemetry; never receives arguments or results. */
    onCall?: (telemetry: AgentToolCallTelemetry) => void;
  };
}): AgentToolBinding {
  const maxResultChars = input.options?.maxResultChars ?? MAX_AGENT_TOOL_RESULT_CHARS;
  const entries = input.allowed.map((logicalId) => {
    const definition = agentToolByLogicalId(logicalId);
    if (!definition) throw new Error(`Cannot bind unregistered AgentRoom tool "${logicalId}"`);
    if (!input.handlers[logicalId]) {
      throw new Error(`No handler injected for AgentRoom tool "${logicalId}"`);
    }
    return { definition, handler: input.handlers[logicalId] };
  });
  const byName = new Map<string, { definition: (typeof entries)[number]["definition"]; handler: AgentToolHandler }>();
  for (const entry of entries) {
    byName.set(entry.definition.name, entry);
    byName.set(entry.definition.logicalId, entry);
  }

  let disposed = false;

  const report = (
    definitionLogicalId: string,
    name: string,
    callId: string,
    startedAtMs: number,
    outcome: AgentToolCallOutcome,
    extra?: { error?: string; late?: boolean }
  ): void => {
    input.options?.onCall?.({
      logicalId: definitionLogicalId,
      name,
      callId,
      outcome,
      durationMs: Date.now() - startedAtMs,
      ...extra
    });
  };

  return {
    advertisements: () =>
      entries.map((entry) => ({
        name: entry.definition.name,
        description: entry.definition.description,
        inputSchema: entry.definition.inputSchema,
        outputSchema: entry.definition.outputSchema
      })),
    invoke: async (toolName, callInput, invokeOptions) => {
      const callId = invokeOptions?.callId ?? `tool-call-${randomUUID()}`;
      const startedAtMs = Date.now();
      const entry = byName.get(toolName);
      if (!entry) {
        report(toolName.slice(0, 200), toolName, callId, startedAtMs, "unknown_tool");
        return unknownToolResult(toolName);
      }
      const { definition, handler } = entry;
      if (disposed || !input.turn.isLive() || invokeOptions?.signal?.aborted) {
        report(definition.logicalId, definition.name, callId, startedAtMs, "unavailable");
        return definition.unavailableResult;
      }

      let result: string;
      try {
        result = await handler(callInput, {
          ...input.turn,
          callId,
          signal: invokeOptions?.signal ?? new AbortController().signal
        });
      } catch (error) {
        report(definition.logicalId, definition.name, callId, startedAtMs, "handler_error", {
          error: redactSecrets(error instanceof Error ? error.message : String(error))
        });
        return HANDLER_ERROR_RESULT;
      }
      // A handler that settled after its turn ended is discarded, never
      // delivered into whichever turn is active now: the waiting transport
      // still needs an answer, and the tool's unavailable text is the one
      // that stays true for that turn.
      if (disposed || !input.turn.isLive() || invokeOptions?.signal?.aborted) {
        report(definition.logicalId, definition.name, callId, startedAtMs, "unavailable", { late: true });
        return definition.unavailableResult;
      }
      if (typeof result !== "string") {
        report(definition.logicalId, definition.name, callId, startedAtMs, "malformed_result");
        return MALFORMED_RESULT;
      }
      if (result.length > maxResultChars) {
        report(definition.logicalId, definition.name, callId, startedAtMs, "truncated");
        return result.slice(0, maxResultChars) + TRUNCATION_SUFFIX;
      }
      report(definition.logicalId, definition.name, callId, startedAtMs, "completed");
      return result;
    },
    dispose: () => {
      disposed = true;
    },
    isDisposed: () => disposed
  };
}

/** Resolve a relayed name against the catalog without binding it. */
export function advertisedAgentTools(logicalIds: readonly string[]): readonly AgentToolAdvertisement[] {
  return logicalIds.map((logicalId) => {
    const definition = agentToolByLogicalId(logicalId);
    if (!definition) throw new Error(`Cannot advertise unregistered AgentRoom tool "${logicalId}"`);
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema
    };
  });
}

/**
 * The refusal text for a relayed call that arrived with no live binding at all:
 * the tool's own unavailable text when the catalog knows the name, else the
 * unknown-tool refusal.
 */
export function unboundAgentToolResult(toolName: string): string {
  return agentToolByName(toolName)?.unavailableResult ?? unknownToolResult(toolName);
}
