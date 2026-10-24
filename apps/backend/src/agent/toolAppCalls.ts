import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifact/ArtifactStore";
import type { AgentRunnerKind, AgentSession } from "../domain/models";
import type { AgentToolAppCalledPayload } from "../events/eventTypes";
import type { EventBus } from "../events/EventBus";
import type { AgentRunner } from "../runner/AgentRunner";
import { AgentSessionError } from "./agentSessionTypes";

/** A result larger than this, serialized, is answered as a failed call. */
export const MAX_TOOL_APP_CALL_RESULT_BYTES = 2 * 1024 * 1024;

/**
 * Tool calls from MCP tool views (SEP-1865 `tools/call`). The view names a tool
 * and its arguments; the server is always the one its artifact was rendered
 * from, so a view can reach no other server. The runner makes the call on the
 * server its agent dialed and applies the server's app visibility.
 *
 * Every call to a known session's tool view publishes `agent_tool_app_called`,
 * whether the runner made it or refused it. Its audit holds a digest of the
 * arguments, never the arguments or the result. An unknown session or
 * artifact publishes nothing, since there is no workspace to attribute it to.
 */
export class ToolAppCallService {
  constructor(
    private readonly deps: {
      getSession(sessionId: string): AgentSession | undefined;
      artifacts?: ArtifactStore;
      runners: Partial<Record<AgentRunnerKind, AgentRunner>>;
      eventBus: EventBus;
    }
  ) {}

  /** The tool's `CallToolResult`, or an `AgentSessionError` carrying the route's status. */
  async call(input: {
    sessionId: string;
    artifactId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const session = this.deps.getSession(input.sessionId);
    if (!session) throw new AgentSessionError("Agent session was not found", 404);
    const toolApp = this.deps.artifacts?.toolApp(input.sessionId, input.artifactId);
    if (!toolApp) throw new AgentSessionError("Tool view was not found", 404);

    const startedAtMs = Date.now();
    const runner = this.deps.runners[session.runnerKind];
    const answer = runner?.callToolAppTool
      ? await runner.callToolAppTool({
        sessionId: session.id,
        serverName: toolApp.serverName,
        toolName: input.name,
        arguments: input.arguments
      })
      : { kind: "unavailable" as const };
    const tooLarge = answer.kind === "called"
      && Buffer.byteLength(JSON.stringify(answer.result), "utf8") > MAX_TOOL_APP_CALL_RESULT_BYTES;
    const outcome: AgentToolAppCalledPayload["outcome"] = tooLarge ? "result_too_large" : answer.kind;

    const audit = {
      artifactId: input.artifactId,
      serverName: toolApp.serverName,
      toolName: input.name,
      outcome,
      durationMs: Date.now() - startedAtMs,
      argumentsSha256: createHash("sha256").update(JSON.stringify(input.arguments)).digest("hex")
    };
    this.deps.eventBus.publish<AgentToolAppCalledPayload>("agent_tool_app_called", {
      sessionId: session.id,
      workspaceId: session.workspaceId,
      ...audit,
      audit
    });

    switch (answer.kind) {
      case "called":
        if (tooLarge) throw new AgentSessionError("The tool's result is too large for a tool view", 502);
        return answer.result;
      case "unknown_tool":
        throw new AgentSessionError("This tool view cannot call that tool", 404);
      case "unavailable":
        throw new AgentSessionError("This session has no running agent that can call tools for its views", 409);
      case "failed":
        throw new AgentSessionError(`The tool call failed: ${answer.message}`, 502);
    }
  }
}
