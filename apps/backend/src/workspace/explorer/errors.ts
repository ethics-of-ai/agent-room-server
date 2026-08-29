/**
 * The one error type every bounded workspace read and write refuses through, so
 * a route maps a refusal to its status code without knowing which operation
 * produced it.
 */
export class WorkspaceExplorerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}
