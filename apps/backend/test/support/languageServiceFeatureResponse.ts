import type { LanguageServiceServerFrame } from "../../src/domain/languageService";
import type { LanguageServiceHost } from "../../src/editor/languageServices/LanguageServiceHost";

export type FeatureRequest = Parameters<LanguageServiceHost["startFeatureRequest"]>[1];

/** Starts a feature request and waits for its response frame, as the route does. */
export async function featureResponse(
  host: LanguageServiceHost,
  connectionId: string,
  input: FeatureRequest
): Promise<LanguageServiceServerFrame | undefined> {
  return (await host.startFeatureRequest(connectionId, input)).response;
}
