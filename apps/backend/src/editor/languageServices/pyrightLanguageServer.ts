import { bundledRegularFile } from "./bundledExecutable";
import { baseLanguageServiceEnvironmentKeys } from "./environment";
import type { LanguageServiceDescriptor, ResolvedLanguageServiceExecutable } from "./types";

async function resolvePyrightLanguageServer(): Promise<ResolvedLanguageServiceExecutable> {
  const languageServer = await bundledRegularFile(
    "pyright/langserver.index.js",
    "Bundled Pyright language service"
  );
  return { command: process.execPath, args: [languageServer, "--stdio"] };
}

export const pyrightLanguageServerDescriptor: LanguageServiceDescriptor = {
  id: "pyright_language_server",
  displayName: "Pyright Language Server",
  testedVersion: "Pyright 1.1.413",
  positionEncoding: "utf-16",
  languageIds: ["python"],
  featureKinds: ["completion", "hover", "definition", "document_symbols"],
  projectMarkers: [
    { kind: "exact", value: "pyrightconfig.json", priority: 130, entryType: "file" },
    { kind: "exact", value: "pyproject.toml", priority: 120, entryType: "file" },
    { kind: "exact", value: "manage.py", priority: 100, entryType: "file" }
  ],
  standaloneWorkspaceRoot: true,
  projectLoading: { mayInvokeBuildTools: false, mayLoadPlugins: false },
  serverRequests: {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  },
  environmentKeys: baseLanguageServiceEnvironmentKeys,
  configured: () => true,
  resolveExecutable: resolvePyrightLanguageServer
};
