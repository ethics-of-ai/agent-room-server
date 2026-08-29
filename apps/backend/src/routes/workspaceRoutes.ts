import type { FastifyInstance } from "fastify";
import type { ServiceConfig } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type { LocalWorkspaceRegistry } from "../workspace/LocalWorkspaceRegistry";
import type { WorkspaceExplorer } from "../workspace/WorkspaceExplorer";
import { registerWorkspaceFileMutationRoutes } from "./workspace/fileMutationRoutes";
import { registerWorkspaceGitRoutes } from "./workspace/gitRoutes";
import { registerWorkspaceReadRoutes } from "./workspace/readRoutes";
import { registerWorkspaceRegistrationRoutes } from "./workspace/registrationRoutes";
import type { WorkspaceRouteDeps } from "./workspace/deps";

/**
 * The workspace API, in four groups that differ by what they are allowed to do
 * rather than by URL shape: registration metadata, bounded reads, the seven
 * fixed entry mutations, and the fixed Git operations. Request validation for all of
 * them lives in `../domain/workspaceSchemas.ts`.
 */
export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  registry: LocalWorkspaceRegistry,
  deps: { eventBus: EventBus; config: ServiceConfig; explorer: WorkspaceExplorer }
): Promise<void> {
  const routeDeps: WorkspaceRouteDeps = {
    registry,
    explorer: deps.explorer,
    eventBus: deps.eventBus,
    config: deps.config
  };

  await registerWorkspaceRegistrationRoutes(app, routeDeps);
  await registerWorkspaceReadRoutes(app, routeDeps);
  await registerWorkspaceFileMutationRoutes(app, routeDeps);
  await registerWorkspaceGitRoutes(app, routeDeps);
}
