import type { LanguageServiceErrorCode } from "../../domain/languageService";

export class LanguageServiceError extends Error {
  constructor(
    readonly code: LanguageServiceErrorCode,
    message: string
  ) {
    super(message);
  }
}
