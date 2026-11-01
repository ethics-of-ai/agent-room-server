import type { FastifyReply } from "fastify";
import type { ServiceConfig } from "../../domain/models";
import type { EventBus } from "../../events/EventBus";
import { LocalWorkspaceRegistry, LocalWorkspaceRegistryError } from "../../workspace/LocalWorkspaceRegistry";
import { WorkspaceExplorer, WorkspaceExplorerError } from "../../workspace/WorkspaceExplorer";
import { WorkspaceGitServiceError } from "../../workspace/WorkspaceGitService";
import type { ChildThreadService } from "../../children/ChildThreadService";
import { ChildThreadError } from "../../children/ChildThreadError";
import { sendRefusal } from "../refusals";

/** What every workspace route group needs; assembled once in `server.ts`. */
export interface WorkspaceRouteDeps {
  registry: LocalWorkspaceRegistry;
  explorer: WorkspaceExplorer;
  eventBus: EventBus;
  config: ServiceConfig;
  /**
   * Refuses unregistering a workspace an open child needs, and switching an open
   * child's worktree off its branch; absent runs both unguarded.
   */
  children?: Pick<ChildThreadService, "guardWorkspaceRemoval" | "guardWorkspaceBranchChange">;
}

/**
 * The three workspace error types and a child-thread refusal all carry the
 * status their refusal means (a Git or child refusal adds its `code`), so a
 * route maps them in one place instead of restating the `instanceof` ladder
 * at every catch. Anything else is a real fault and keeps propagating to
 * Fastify's 500 handler.
 */
export function replyWorkspaceError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof WorkspaceExplorerError ||
    error instanceof LocalWorkspaceRegistryError ||
    error instanceof WorkspaceGitServiceError ||
    error instanceof ChildThreadError
  ) {
    return sendRefusal(reply, error);
  }
  throw error;
}
