import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceConfig } from "../../domain/models";
import { baseLanguageServiceEnvironmentKeys } from "./environment";
import { LanguageServiceError } from "./errors";
import { admittedLanguageServiceExecutable } from "./executable";
import type { LanguageServiceDescriptor, ResolvedLanguageServiceExecutable } from "./types";

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
