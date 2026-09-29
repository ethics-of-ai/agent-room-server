import { z } from "zod";
import { agentToolInputSpec, unboundAgentToolResult, type AgentToolAdvertisement } from "../../agentTools/dispatch";
import type { CodexRunnerSession } from "./types";

/**
 * AgentRoom tools over the app-server's experimental dynamic tools: the
 * definitions go on `thread/start.dynamicTools`, and each model call arrives
 * as an `item/tool/call` request answered with the tool's text. Verified
 * model-free against codex-cli 0.158.0-alpha.2.1
 * (test/codexDynamicToolsTransport.test.ts). The field exists only under the `experimentalApi` capability the
 * runner already negotiates, and `thread/resume` has no counterpart.
 */

export const CODEX_DYNAMIC_TOOL_CALL_METHOD = "item/tool/call";

const dynamicToolCallParamsSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  namespace: z.string().nullable().optional(),
  tool: z.string(),
  arguments: z.unknown()
});

/** Codex `DynamicToolSpec` entries, derived from the shared advertisements without copying schemas. */
export function codexDynamicToolSpecs(catalog: readonly AgentToolAdvertisement[]): Array<Record<string, unknown>> {
  return catalog.map((entry) => ({ type: "function", ...agentToolInputSpec(entry) }));
}

/**
 * Serve one `item/tool/call`. The call is dispatched only when its own thread
 * and turn ids name the session's live turn; the relay never falls back to
 * "whichever turn is current". A late call from an ended turn, a foreign
 * thread, or a turn whose id is not yet known gets the tool's unavailable
 * text with `success: false`.
 */
export async function serveCodexDynamicToolCall(session: CodexRunnerSession, params: unknown): Promise<unknown> {
  const parsed = dynamicToolCallParamsSchema.safeParse(params);
  if (!parsed.success) return toolText("AgentRoom could not read this tool call.", false);
  const call = parsed.data;
  const turn = session.activeTurn;
  const tools = turn && !turn.finalEvent && call.threadId === session.threadId && turn.turnId === call.turnId
    ? turn.tools
    : undefined;
  if (!turn || !tools) return toolText(unboundAgentToolResult(call.tool), false);
  const text = await tools.binding.invoke({
    callId: call.callId,
    name: call.tool,
    arguments: call.arguments,
    signal: turn.toolCalls.signal
  });
  return toolText(text, true);
}

function toolText(text: string, success: boolean): { success: boolean; contentItems: Array<{ type: "inputText"; text: string }> } {
  return { success, contentItems: [{ type: "inputText", text }] };
}
