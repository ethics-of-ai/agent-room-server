/**
 * The refusal type every fixed Git operation raises. It carries the status the
 * route replies with, so "this path is not eligible" and "git itself failed"
 * stay distinguishable without the route reading messages.
 */
export class WorkspaceGitServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}
