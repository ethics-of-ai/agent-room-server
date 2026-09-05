import {
  LANGUAGE_SERVICE_PROTOCOL_VERSION,
  type LanguageServiceStatusFrame
} from "../../domain/languageService";
import type { LanguageServiceRegistry } from "./registry";
import type { ServiceInstance } from "./hostTypes";

export function failureStatusFrame(
  registry: LanguageServiceRegistry,
  languageId: string,
  readiness: "ambiguous_project" | "project_not_found" | "unavailable" | "failed",
  clientVersion: number
): LanguageServiceStatusFrame | undefined {
  const descriptor = registry.supporting(languageId)[0];
  if (!descriptor) return undefined;
  return {
    type: "status",
    protocolVersion: LANGUAGE_SERVICE_PROTOCOL_VERSION,
    clientVersion,
    service: { id: descriptor.id, displayName: descriptor.displayName },
    readiness,
    featureKinds: [...descriptor.featureKinds]
  };
}

export function instanceStatusFrame(
  instance: ServiceInstance,
  readiness: LanguageServiceStatusFrame["readiness"],
  clientVersion: number
): LanguageServiceStatusFrame {
  return {
    type: "status",
    protocolVersion: LANGUAGE_SERVICE_PROTOCOL_VERSION,
    clientVersion,
    service: { id: instance.descriptor.id, displayName: instance.descriptor.displayName },
    readiness,
    featureKinds: [...instance.descriptor.featureKinds],
    project: {
      root: instance.project.relativeProjectRoot || ".",
      ...(instance.project.marker ? { marker: instance.project.marker } : {})
    },
    ...(instance.semanticTokenLegend ? { semanticTokenLegend: instance.semanticTokenLegend } : {})
  };
}
