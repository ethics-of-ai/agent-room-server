/**
 * The AgentRoom tool catalog: the code-owned registry of tools a runner's model
 * can call through AgentRoom rather than through the provider's own surface.
 *
 * A definition is pure data — logical id, model-facing name, description, a
 * JSON-Schema input contract, the text a model reads when the tool cannot run,
 * and the feature gate that composes it into a turn. Handlers are never
 * registered here: they are injected per turn binding, because a handler closes
 * over the session, the turn, and the pending stores that own its behavior.
 * That split is what keeps this module free of provider protocols while the
 * tool handlers stay with their owning modules.
 *
 * The first catalog is static and code-owned; definitions register at module
 * load. There is no runtime plugin loader, and `unregisterAgentTool` exists so
 * a test can prove the add-a-tool recipe without leaving state behind.
 */

/** The feature gates that can compose a tool into a turn's allowed set. */
export type AgentToolGate = "clarifyingQuestions";

/** Descriptor-owned runner capabilities used to filter the shared catalog. */
export type AgentToolCapability = "questions";

export interface AgentToolDefinition {
  /**
   * The stable AgentRoom identity of the tool (`questions.ask`). Adapters,
   * telemetry, and future catalogs key on this, never on the display name.
   */
  readonly logicalId: string;
  /**
   * The model-facing entry name. `ask_user_question` preserves the native name
   * of the first transport (Cursor's custom tool); a second transport maps its
   * own alias to the same logical id rather than registering a duplicate.
   */
  readonly name: string;
  readonly description: string;
  /**
   * The JSON Schema advertised to the runner host as the tool's input schema.
   * Serializable data only — validators and handlers never cross the host
   * boundary. Kept in the shared vocabulary's bounds so the model cannot offer
   * more than the handler accepts; a parity test holds it against the
   * canonical validator.
   */
  readonly inputSchema: Record<string, unknown>;
  /** Canonical JSON value returned by the native transport. */
  readonly outputSchema: Record<string, unknown>;
  /** What the model reads when the tool cannot run at all on this call. */
  readonly unavailableResult: string;
  /** The runner capability required before this definition can be advertised. */
  readonly requiredCapability: AgentToolCapability;
  /**
   * The managed feature gate that composes this tool into a turn. Absent means
   * the tool rides any turn whose runner transport supports tools; the adapter
   * interprets the key against its own configuration.
   */
  readonly gate?: AgentToolGate;
}

const byLogicalId = new Map<string, AgentToolDefinition>();
const byName = new Map<string, AgentToolDefinition>();

/**
 * Register a definition. Idempotent for the identical definition; a conflicting
 * logical id or model-facing name is refused, because two tools answering one
 * name is exactly the ambiguity the dispatcher must not have to resolve.
 */
export function registerAgentTool(definition: AgentToolDefinition): void {
  if (!definition.logicalId || !definition.name) {
    throw new Error("An AgentRoom tool definition needs a logical id and a name");
  }
  const existing = byLogicalId.get(definition.logicalId);
  if (existing) {
    if (existing === definition) return;
    throw new Error(`AgentRoom tool logical id "${definition.logicalId}" is already registered`);
  }
  const named = byName.get(definition.name);
  if (named) {
    throw new Error(
      `AgentRoom tool name "${definition.name}" is already registered by "${named.logicalId}"`
    );
  }
  byLogicalId.set(definition.logicalId, definition);
  byName.set(definition.name, definition);
}

/** Remove a registration. For tests proving the registration recipe. */
export function unregisterAgentTool(logicalId: string): void {
  const definition = byLogicalId.get(logicalId);
  if (!definition) return;
  byLogicalId.delete(logicalId);
  byName.delete(definition.name);
}

export function agentToolByLogicalId(logicalId: string): AgentToolDefinition | undefined {
  return byLogicalId.get(logicalId);
}

/** Resolve a relayed call's tool by its model-facing name, then by logical id. */
export function agentToolByName(name: string): AgentToolDefinition | undefined {
  return byName.get(name) ?? byLogicalId.get(name);
}

/** Every registered definition, in registration order. */
export function allAgentTools(): readonly AgentToolDefinition[] {
  return [...byLogicalId.values()];
}

/**
 * Compose a turn's allowed logical ids: every definition whose gate is
 * satisfied, or that declares none. The adapter interprets its configuration
 * into the gates record; the catalog never reads configuration itself, so the
 * composition rule stays here while its inputs stay adapter-owned.
 */
export function allowedAgentToolLogicalIds(
  input: {
    gates: Readonly<Partial<Record<AgentToolGate, boolean>>>;
    capabilities: readonly AgentToolCapability[];
  }
): string[] {
  const capabilities = new Set(input.capabilities);
  return allAgentTools()
    .filter((definition) => capabilities.has(definition.requiredCapability))
    .filter((definition) => !definition.gate || input.gates[definition.gate] === true)
    .map((definition) => definition.logicalId);
}
