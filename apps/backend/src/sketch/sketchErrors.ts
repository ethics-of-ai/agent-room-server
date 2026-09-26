// The one service-level error type for the sketch feature. Services throw it
// so the routes can answer with its status, code, and details.

export class SketchServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}
