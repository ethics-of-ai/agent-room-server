import type { FastifyReply } from "fastify";
import type { ServiceConfig } from "../../domain/models";
import type { EventBus } from "../../events/EventBus";
import { LocalWorkspaceRegistry, LocalWorkspaceRegistryError } from "../../workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer, WorkspaceExplorerError } from "../../workspace/WorkspaceExplorer";
import { WorkspaceGitServiceError } from "../../workspace/WorkspaceGitService";

/** What every workspace route group needs; assembled once in `server.ts`. */
export interface WorkspaceRouteDeps {
  registry: LocalWorkspaceRegistry;
  explorer: WorkspaceExplorer;
  eventBus: EventBus;
  config: ServiceConfig;
}

/**
 * The three workspace error types all carry the status their refusal means, so
 * a route maps them in one place instead of restating the `instanceof` ladder
 * at every catch. Anything else is a real fault and keeps propagating to
 * Fastify's 500 handler.
 */
export function replyWorkspaceError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof WorkspaceExplorerError ||
    error instanceof LocalWorkspaceRegistryError ||
    error instanceof WorkspaceGitServiceError
  ) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  throw error;
}
