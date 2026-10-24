import type { ArtifactStore } from "../artifact/ArtifactStore";
import { logger } from "../logging/logger";
import type { ArtifactStreamOp } from "../artifact/ArtifactStreamParser";
import type { AgentSession, AgentSessionTurn } from "../domain/models";
import {
  codingArtifactCompletedEvent,
  codingArtifactDeltaEvent,
  codingArtifactStartedEvent,
  type CodingAgentEventCandidate
} from "../protocol/coding/events";
import type { AgentRunnerToolApp, RunnerMetadata } from "../runner/AgentRunner";

// The artifact half of turn event application: each function writes the store
// and returns the `coding_artifact_*` events to publish, in order, so the live
// stream says exactly what the store kept.

/** Apply parsed sketch-region ops from the assistant stream. */
export function artifactOpEvents(
  store: ArtifactStore,
  session: AgentSession,
  turn: AgentSessionTurn,
  ops: ArtifactStreamOp[],
  runner: RunnerMetadata | undefined
): Array<CodingAgentEventCandidate | undefined> {
  const now = new Date().toISOString();
  const base = { sessionId: session.id, turnId: turn.id, runnerKind: session.runnerKind, runner };
  return ops.flatMap((op) => {
    if (op.type === "start") {
      const artifact = store.start({
        sessionId: session.id,
        turnId: turn.id,
        artifactId: op.artifactId,
        kind: op.kind,
        ...(op.title ? { title: op.title } : {}),
        at: now
      });
      if (!artifact) return []; // per-session artifact cap reached
      return [codingArtifactStartedEvent({
        ...base,
        artifactId: op.artifactId,
        kind: op.kind,
        ...(op.title ? { title: op.title } : {})
      })];
    }
    if (op.type === "delta") {
      const result = store.append({ sessionId: session.id, artifactId: op.artifactId, delta: op.delta, at: now });
      // Skip when the artifact is missing/closed, or nothing fit under the cap:
      // publish only what the store actually retained so the live stream and the
      // reconnect snapshot stay in agreement.
      if (!result || !result.appended) return [];
      return [codingArtifactDeltaEvent({ ...base, artifactId: op.artifactId, delta: result.appended })];
    }
    const result = store.complete({ sessionId: session.id, artifactId: op.artifactId, at: now });
    if (!result) return []; // never started (e.g. cap-rejected); no orphan completed event
    return [codingArtifactCompletedEvent({
      ...base,
      artifactId: op.artifactId,
      bytes: result.byteLength,
      truncated: result.truncated
    })];
  });
}

/**
 * A tool's own view becomes a closed `mcp_app` artifact. The live stream
 * carries only its start and completion: the HTML and the tool's result reach
 * clients through the bearer-checked artifacts read, never the
 * unauthenticated event socket. A refused view is logged and publishes
 * nothing.
 */
export function toolAppEvents(
  store: ArtifactStore,
  session: AgentSession,
  turn: AgentSessionTurn,
  app: AgentRunnerToolApp,
  runner: RunnerMetadata | undefined
): Array<CodingAgentEventCandidate | undefined> {
  const artifactId = `${turn.id}:tool-app-${app.toolId}`;
  const stored = store.putToolApp({
    sessionId: session.id,
    turnId: turn.id,
    artifactId,
    title: app.title,
    html: app.html,
    toolApp: {
      serverName: app.serverName,
      toolName: app.toolName,
      resourceUri: app.resourceUri,
      tool: app.tool,
      ...(app.resourceMeta ? { resourceMeta: app.resourceMeta } : {}),
      toolInput: app.toolInput,
      toolResult: app.toolResult,
      ...(app.supportsToolCalls ? { supportsToolCalls: true } : {})
    },
    at: new Date().toISOString()
  });
  if ("refused" in stored) {
    logger.warn({
      sessionId: session.id,
      turnId: turn.id,
      artifactId,
      tool: `${app.serverName}/${app.toolName}`,
      ...stored
    }, "Refused an MCP tool view; the call shows as a plain tool activity");
    return [];
  }
  const { artifact } = stored;
  const base = { sessionId: session.id, turnId: turn.id, runnerKind: session.runnerKind, runner, artifactId };
  return [
    codingArtifactStartedEvent({ ...base, kind: "mcp_app", title: app.title }),
    codingArtifactCompletedEvent({ ...base, bytes: Buffer.byteLength(artifact.content, "utf8") })
  ];
}
