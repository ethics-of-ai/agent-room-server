import type { CodingAgentTurnSettings, ServiceConfig } from "../../domain/models";
import { logger } from "../../logging/logger";
import type { AgentRunnerInput } from "../AgentRunner";

const APP_SERVER_ARGS = ["app-server", "--listen", "stdio://"];

let warnedAboutIncompatibleArgs = false;

/**
 * The argv that starts a Codex **app-server** child.
 *
 * `CODEX_ARGS` is tier-3 configuration shared by both protocol modes, so an
 * operator (or an install configured before `jsonrpc` became the default) can be
 * holding the `exec` subcommand while the runner is in JSON-RPC mode. Spawning
 * `codex exec …` and then speaking JSON-RPC at it fails as an initialize
 * timeout rather than as the configuration problem it is, so the adapter drops
 * that one incompatible case onto its own default argv.
 *
 * This is the Codex half of Phase 6's tier-3 bootstrap rule
 * (docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md): the *adapter* decides what
 * launching its own protocol requires. The macOS app used to paper over it by
 * force-writing `CODEX_RUNNER_PROTOCOL` and `CODEX_ARGS` whenever the Codex
 * network toggle was on — a Codex-shaped reading of a managed setting performed
 * in generic Swift launch assembly, and one that silently overrode an operator
 * who had deliberately pinned `exec`.
 *
 * The rule is deliberately narrow: only the `exec` subcommand is refused. Every
 * other argument set is the operator's own app-server launch — a wrapper script,
 * a `--cd`, a `-c key=value` override — and is passed through verbatim, because
 * an adapter that only accepted arguments it recognized would be a worse
 * gatekeeper than the operator who wrote them.
 */
export function jsonRpcArgs(args: string[]): string[] {
  if (args.length === 0) return APP_SERVER_ARGS;
  // The stale argv the Mac used to write starts with the subcommand. Looking
  // for `exec` anywhere would also reject an unrelated option value such as a
  // workspace directory or profile named `exec`, despite the pass-through
  // contract above.
  if (args[0] !== "exec") return args;
  if (!warnedAboutIncompatibleArgs) {
    warnedAboutIncompatibleArgs = true;
    // The count only: CODEX_ARGS is operator configuration and can carry `-c
    // key=value` overrides, which have no business in a log line.
    logger.warn(
      { argsCount: args.length },
      "Ignoring exec-style CODEX_ARGS in JSON-RPC mode; using the default Codex app-server arguments"
    );
  }
  return APP_SERVER_ARGS;
}

export function effectiveSettings(config: ServiceConfig, settings: CodingAgentTurnSettings | undefined): CodingAgentTurnSettings {
  return {
    model: settings?.model ?? config.codexModel,
    reasoningEffort: settings?.reasoningEffort ?? config.codexReasoningEffort,
    serviceTier: settings?.serviceTier ?? config.codexServiceTier
  };
}

export function jsonRpcThreadSettings(settings: CodingAgentTurnSettings): Record<string, unknown> {
  const serviceTier = codexWireServiceTier(settings.serviceTier);
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(serviceTier ? { serviceTier } : {})
  };
}

export function jsonRpcRuntimeSettings(config: ServiceConfig): Record<string, unknown> {
  const sandbox = config.codexSandboxMode ?? "workspace-write";
  const runtimeConfig = jsonRpcRuntimeConfig(config);
  return {
    approvalPolicy: config.codexApprovalPolicy ?? "never",
    sandbox,
    ...(runtimeConfig ? { config: runtimeConfig } : {})
  };
}

export function jsonRpcTurnSettings(settings: CodingAgentTurnSettings): Record<string, unknown> {
  const serviceTier = codexWireServiceTier(settings.serviceTier);
  return {
    ...(settings.model ? { model: settings.model } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    effort: settings.reasoningEffort ?? null
  };
}

export function jsonRpcTurnInput(input: AgentRunnerInput): Array<Record<string, unknown>> {
  return [
    { type: "text", text: input.prompt, text_elements: [] },
    ...(input.inputParts ?? [])
  ];
}

export function withSettingsOverrides(args: string[], settings: CodingAgentTurnSettings): string[] {
  let next = [...args];
  if (settings.model && !hasConfigOverride(next, "model")) {
    next = [...next, "-c", `model=${settings.model}`];
  }
  const serviceTier = codexWireServiceTier(settings.serviceTier);
  if (serviceTier && !hasConfigOverride(next, "service_tier")) {
    next = [...next, "-c", `service_tier=${serviceTier}`];
  }
  if (settings.reasoningEffort && !hasConfigOverride(next, "model_reasoning_effort")) {
    next = [...next, "-c", `model_reasoning_effort=${settings.reasoningEffort}`];
  }
  return next;
}

export function codexDisplayServiceTier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "standard" || normalized === "default") return "standard";
  if (normalized === "fast" || normalized === "priority") return "fast";
  return value;
}

// The per-thread `config` overrides AgentRoom pins on `thread/start` and
// `thread/resume`. Two things live here.
//
// The workspace network pin: a registered workspace's committed
// `.codex/config.toml` merges into the thread's effective config as a Codex
// project layer, and per-key thread `config` overrides are the only shadowing
// mechanism the app-server offers, so `network_access` is pinned explicitly in
// both states — leaving the key unset when the operator has not enabled network
// access would let a workspace layer silently re-enable it inside the
// workspace-write sandbox, overriding the documented
// CODEX_WORKSPACE_NETWORK_ACCESS control.
//
// The flags that make the agent's `request_user_input` tool available outside
// plan mode — the clarifying-question channel. They ride the thread's own config
// so they follow the managed `clarifyingQuestionsEnabled` switch rather than
// the operator's global Codex config (verified against codex-cli 0.149: the
// tool is offered with these two keys set per thread and reported "unavailable
// in Default mode" without them).
function jsonRpcRuntimeConfig(config: ServiceConfig): Record<string, unknown> | undefined {
  const runtimeConfig: Record<string, unknown> = {};
  if ((config.codexSandboxMode ?? "workspace-write") === "workspace-write") {
    runtimeConfig.sandbox_workspace_write = {
      network_access: config.codexWorkspaceNetworkAccess ?? false
    };
  }
  const clarifyingQuestionsEnabled = config.clarifyingQuestionsEnabled !== false;
  // Pin both sides of Codex's gate in either state. Omitting them while the
  // AgentRoom kill switch is off would let a user-global Codex config turn the
  // tool back on inside this thread.
  runtimeConfig.tools = { experimental_request_user_input: { enabled: clarifyingQuestionsEnabled } };
  runtimeConfig.features = { default_mode_request_user_input: clarifyingQuestionsEnabled };
  return Object.keys(runtimeConfig).length > 0 ? runtimeConfig : undefined;
}

function codexWireServiceTier(value: string | undefined): string | undefined {
  const displayTier = codexDisplayServiceTier(value);
  if (!displayTier || displayTier === "standard") return undefined;
  return displayTier;
}

function hasConfigOverride(args: string[], key: string): boolean {
  return args.some((arg, index) =>
    arg === key ||
    arg.startsWith(`${key}=`) ||
    (args[index - 1] === "-c" && (arg === key || arg.startsWith(`${key}=`)))
  );
}
