import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceConfig } from "../../domain/models";
import { csharpLsDescriptor } from "./csharpLs";
import { eclipseJdtLsDescriptor } from "./eclipseJdtLs";
import {
  baseLanguageServiceEnvironmentKeys,
  isGrantableLanguageServiceEnvironmentName
} from "./environment";
import { LanguageServiceError } from "./errors";
import { admittedLanguageServiceExecutable } from "./executable";
import {
  externalLanguageServiceDescriptors,
  readExternalLanguageServiceAdapterConfigs
} from "./externalAdapters";
import { goplsDescriptor } from "./gopls";
import { kotlinLspDescriptor } from "./kotlinLsp";
import { pyrightLanguageServerDescriptor } from "./pyrightLanguageServer";
import { rustAnalyzerDescriptor } from "./rustAnalyzer";
import { typeScriptLanguageServerDescriptor } from "./typescriptLanguageServer";
import type {
  LanguageServiceDescriptor,
  LanguageServiceRegistryProjection,
  ResolvedLanguageServiceExecutable
} from "./types";

const execFileAsync = promisify(execFile);

const sourceKitEnvironmentKeys = [
  ...baseLanguageServiceEnvironmentKeys,
  "DEVELOPER_DIR",
  "SDKROOT",
  "TOOLCHAINS"
] as const;

async function resolveSourceKit(config: ServiceConfig): Promise<ResolvedLanguageServiceExecutable> {
  if (config.sourcekitLspExecutable) {
    return {
      command: await admittedLanguageServiceExecutable(config.sourcekitLspExecutable, "SourceKit-LSP"),
      args: []
    };
  }
  try {
    const { stdout } = await execFileAsync("xcrun", ["--find", "sourcekit-lsp"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024
    });
    const command = stdout.trim();
    if (!command.startsWith("/")) throw new Error("xcrun returned no absolute path");
    return { command: await admittedLanguageServiceExecutable(command, "SourceKit-LSP"), args: [] };
  } catch {
    throw new LanguageServiceError("service_unavailable", "SourceKit-LSP is unavailable");
  }
}

export const sourceKitLspDescriptor: LanguageServiceDescriptor = {
  id: "sourcekit_lsp",
  displayName: "SourceKit-LSP",
  testedVersion: "Xcode 26.6; Apple Swift 6.3.3",
  positionEncoding: "utf-16",
  languageIds: ["swift", "c", "cpp", "objective-c"],
  featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"],
  projectMarkers: [
    { kind: "suffix", value: ".xcworkspace", priority: 120, entryType: "directory" },
    { kind: "suffix", value: ".xcodeproj", priority: 110, entryType: "directory" },
    { kind: "exact", value: "Package.swift", priority: 100, entryType: "file" }
  ],
  standaloneWorkspaceRoot: true,
  projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: true },
  serverRequests: { workDoneProgressCreate: "null" },
  environmentKeys: sourceKitEnvironmentKeys,
  configured: (config) => Boolean(config.sourcekitLspExecutable) || process.platform === "darwin",
  resolveExecutable: resolveSourceKit
};

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
    private readonly descriptors: readonly LanguageServiceDescriptor[] = builtInLanguageServiceDescriptors
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

export { pyrightLanguageServerDescriptor } from "./pyrightLanguageServer";
export { typeScriptLanguageServerDescriptor } from "./typescriptLanguageServer";
export { rustAnalyzerDescriptor } from "./rustAnalyzer";
export { goplsDescriptor } from "./gopls";
export { eclipseJdtLsDescriptor } from "./eclipseJdtLs";
export { kotlinLspDescriptor } from "./kotlinLsp";
export { csharpLsDescriptor } from "./csharpLs";

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
