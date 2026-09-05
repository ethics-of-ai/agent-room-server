import { bundledRegularFile } from "./bundledExecutable";
import { baseLanguageServiceEnvironmentKeys } from "./environment";
import type { LanguageServiceDescriptor, ResolvedLanguageServiceExecutable } from "./types";

async function resolveTypeScriptLanguageServer(): Promise<ResolvedLanguageServiceExecutable> {
  const [languageServer, tsserver] = await Promise.all([
    bundledRegularFile("typescript-language-server/lib/cli.mjs", "Bundled TypeScript language service"),
    bundledRegularFile("typescript/lib/tsserver.js", "Bundled TypeScript server")
  ]);
  return {
    command: process.execPath,
    args: [languageServer, "--stdio"],
    initializationOptions: {
      disableAutomaticTypingAcquisition: true,
      tsserver: { path: tsserver }
    }
  };
}

export const typeScriptLanguageServerDescriptor: LanguageServiceDescriptor = {
  id: "typescript_language_server",
  displayName: "TypeScript Language Server",
  testedVersion: "typescript-language-server 5.3.0; TypeScript 5.9.3",
  positionEncoding: "utf-16",
  languageIds: ["typescript", "typescriptreact", "javascript"],
  featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"],
  projectMarkers: [
    { kind: "exact", value: "tsconfig.json", priority: 120, entryType: "file" },
    { kind: "exact", value: "jsconfig.json", priority: 120, entryType: "file" },
    { kind: "exact", value: "package.json", priority: 100, entryType: "file" }
  ],
  standaloneWorkspaceRoot: true,
  projectLoading: { mayInvokeBuildTools: false, mayLoadPlugins: true },
  serverRequests: {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  },
  environmentKeys: baseLanguageServiceEnvironmentKeys,
  configured: () => true,
  resolveExecutable: resolveTypeScriptLanguageServer
};
