import { jvmLanguageServiceEnvironmentKeys } from "./environment";
import { configuredExecutableDescriptorFields } from "./executable";
import type { LanguageServiceDescriptor } from "./types";

export const kotlinLspDescriptor: LanguageServiceDescriptor = {
  id: "kotlin_lsp",
  displayName: "Kotlin Language Server",
  testedVersion: "Kotlin LSP 262.9593.0 (alpha)",
  positionEncoding: "utf-16",
  languageIds: ["kotlin"],
  featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"],
  projectMarkers: [
    { kind: "exact", value: "settings.gradle.kts", priority: 150, entryType: "file" },
    { kind: "exact", value: "settings.gradle", priority: 140, entryType: "file" },
    { kind: "exact", value: "build.gradle.kts", priority: 130, entryType: "file" },
    { kind: "exact", value: "build.gradle", priority: 120, entryType: "file" },
    { kind: "exact", value: "pom.xml", priority: 110, entryType: "file" }
  ],
  standaloneWorkspaceRoot: true,
  projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: true },
  serverRequests: {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  },
  environmentKeys: jvmLanguageServiceEnvironmentKeys,
  ...configuredExecutableDescriptorFields(
    (config) => config.kotlinLspExecutable,
    "Kotlin LSP",
    ["--stdio"]
  )
};
