import { baseLanguageServiceEnvironmentKeys } from "./environment";
import { configuredExecutableDescriptorFields } from "./executable";
import type { LanguageServiceDescriptor } from "./types";

const environmentKeys = [
  ...baseLanguageServiceEnvironmentKeys,
  "GOENV",
  "GOMODCACHE",
  "GONOPROXY",
  "GONOSUMDB",
  "GOPATH",
  "GOPRIVATE",
  "GOPROXY",
  "GOROOT",
  "GOWORK"
] as const;

export const goplsDescriptor: LanguageServiceDescriptor = {
  id: "gopls",
  displayName: "gopls",
  testedVersion: "gopls 0.23.0",
  positionEncoding: "utf-16",
  languageIds: ["go"],
  featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"],
  projectMarkers: [
    { kind: "exact", value: "go.work", priority: 130, entryType: "file" },
    { kind: "exact", value: "go.mod", priority: 120, entryType: "file" }
  ],
  standaloneWorkspaceRoot: true,
  initializationOptions: { semanticTokens: true },
  projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: false },
  serverRequests: {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  },
  environmentKeys,
  ...configuredExecutableDescriptorFields(
    (config) => config.goplsExecutable,
    "gopls",
    ["serve"]
  )
};
