import { z } from "zod";
import type { AgentToolAdvertisement } from "../../../agentTools/dispatch";

export const AGENTROOM_TOOLS_PROTOCOL_VERSION = 1;
export const AGENTROOM_TOOLS_MAX_FRAME_BYTES = 512 * 1024;

const base = { version: z.literal(AGENTROOM_TOOLS_PROTOCOL_VERSION) };
const toolName = z.string().min(1).max(200);
const runId = z.string().min(1).max(200);
const callId = z.string().min(1).max(200);

export const childToolMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("hello") }).strict(),
  z.object({ ...base, type: z.literal("ready"), names: z.array(toolName).max(64) }).strict(),
  z.object({
    ...base,
    type: z.literal("invoke"),
    runId,
    callId,
    name: toolName,
    arguments: z.unknown()
  }).strict(),
  z.object({ ...base, type: z.literal("cancel"), runId, callId }).strict(),
  z.object({ ...base, type: z.literal("stopped"), requestId: z.number().int().nonnegative(), result: z.enum(["stopped", "unknown_task"]) }).strict()
]);

/**
 * Background work the plugin can stop inside the runtime: a job, as the
 * session that owns it, or a subagent, for the session that started it.
 */
export type BackgroundStopTarget =
  | { kind: "job"; jobId: string; owner: string }
  | { kind: "subagent"; childSessionId: string; parentSessionId: string };

export type ChildToolMessage = z.infer<typeof childToolMessageSchema>;

export type ParentToolMessage =
  | { version: 1; type: "catalog"; catalog: readonly AgentToolAdvertisement[] }
  | { version: 1; type: "bind"; runId: string; allowedNames: readonly string[] }
  | { version: 1; type: "result"; runId: string; callId: string; result: string }
  | { version: 1; type: "unbind"; runId: string }
  | { version: 1; type: "stop"; requestId: number; target: BackgroundStopTarget }
  | { version: 1; type: "subagents"; paused: boolean };

export function encodeToolMessage(message: ParentToolMessage | ChildToolMessage): string {
  return `${JSON.stringify(message)}\n`;
}
