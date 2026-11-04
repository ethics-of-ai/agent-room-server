import type { ServiceConfig } from "../../domain/models";
import { csharpLsDescriptor } from "./csharpLs";
import { eclipseJdtLsDescriptor } from "./eclipseJdtLs";
import { isGrantableLanguageServiceEnvironmentName } from "./environment";
import {
  externalLanguageServiceDescriptors,
  readExternalLanguageServiceAdapterConfigs
} from "./externalAdapters";
import { goplsDescriptor } from "./gopls";
import { kotlinLspDescriptor } from "./kotlinLsp";
import { pyrightLanguageServerDescriptor } from "./pyrightLanguageServer";
import { rustAnalyzerDescriptor } from "./rustAnalyzer";
import { sourceKitLspDescriptor } from "./sourceKitLsp";
import { typeScriptLanguageServerDescriptor } from "./typescriptLanguageServer";
import type { LanguageServiceDescriptor, LanguageServiceRegistryProjection } from "./types";

export const builtInLanguageServiceDescriptors: readonly LanguageServiceDescriptor[] = [
  sourceKitLspDescriptor,
  typeScriptLanguageServerDescriptor,
  pyrightLanguageServerDescriptor,
  rustAnalyzerDescriptor,
  goplsDescriptor,
  eclipseJdtLsDescriptor,
  kotlinLspDescriptor,
  csharpLsDescriptor
];

export function configuredLanguageServiceDescriptors(): LanguageServiceDescriptor[] {
  const reservedLanguageIds = new Set(
    builtInLanguageServiceDescriptors.flatMap((descriptor) => descriptor.languageIds)
  );
  return [
    ...builtInLanguageServiceDescriptors,
    ...externalLanguageServiceDescriptors(readExternalLanguageServiceAdapterConfigs(), reservedLanguageIds)
  ];
}

/** Registry membership, safe projection, and observed readiness share one owner. */
export class LanguageServiceRegistry {
  private readonly readiness = new Map<string, boolean>();

  constructor(
    private readonly config: ServiceConfig,
    private readonly descriptors: readonly LanguageServiceDescriptor[]
  ) {
    const ids = new Set<string>();
    for (const descriptor of descriptors) {
      if (ids.has(descriptor.id)) throw new Error(`Duplicate language service id: ${descriptor.id}`);
      ids.add(descriptor.id);
    }
  }

  supporting(languageId: string): LanguageServiceDescriptor[] {
    return this.descriptors.filter((descriptor) => descriptor.languageIds.includes(languageId));
  }

  observe(descriptorId: string, ready: boolean): void {
    if (this.descriptors.some((descriptor) => descriptor.id === descriptorId)) {
      this.readiness.set(descriptorId, ready);
    }
  }

  projection(): LanguageServiceRegistryProjection[] {
    const enabled = this.config.languageServicesEnabled === true;
    return this.descriptors.map((descriptor) => {
      const ready = this.readiness.get(descriptor.id);
      return {
        id: descriptor.id,
        displayName: descriptor.displayName,
        configured: descriptor.configured(this.config),
        enabled,
        ...(ready === undefined ? {} : { ready }),
        languageIds: [...descriptor.languageIds],
        featureKinds: [...descriptor.featureKinds]
      };
    });
  }
}

export function languageServiceEnvironment(
  descriptor: LanguageServiceDescriptor,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    descriptor.environmentKeys.flatMap((key) => {
      if (!isGrantableLanguageServiceEnvironmentName(key)) return [];
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
}
