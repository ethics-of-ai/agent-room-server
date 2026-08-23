import type { ServiceConfig } from "../domain/models";

// Shared bearer-auth gate for read routes that expose project structure or
// session content. The global preHandler only enforces auth on mutating methods,
// so reads that leak data (workspace tree/preview/git, session messages, session
// artifacts) opt in to this check. When AUTH_TOKEN is not configured
// (`requireAuth` false) the check is a no-op.
export function authorizedForRead(authorization: string | undefined, config: ServiceConfig): boolean {
  return !config.requireAuth || authorization === `Bearer ${config.authToken}`;
}
