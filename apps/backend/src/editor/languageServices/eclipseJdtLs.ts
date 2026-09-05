import { jvmLanguageServiceEnvironmentKeys } from "./environment";
import { configuredExecutableDescriptorFields } from "./executable";
import type { LanguageServiceDescriptor } from "./types";

export const eclipseJdtLsDescriptor: LanguageServiceDescriptor = {
  id: "eclipse_jdt_ls",
  displayName: "Eclipse JDT Language Server",
  testedVersion: "Eclipse JDT LS 1.61.0",
  positionEncoding: "utf-16",
  languageIds: ["java"],
  featureKinds: ["completion", "hover", "definition", "document_symbols"],
  projectMarkers: [
    { kind: "exact", value: ".project", priority: 150, entryType: "file" },
    { kind: "exact", value: "pom.xml", priority: 140, entryType: "file" },
    { kind: "exact", value: "settings.gradle.kts", priority: 130, entryType: "file" },
    { kind: "exact", value: "settings.gradle", priority: 120, entryType: "file" },
    { kind: "exact", value: "build.gradle.kts", priority: 110, entryType: "file" },
    { kind: "exact", value: "build.gradle", priority: 100, entryType: "file" }
  ],
  standaloneWorkspaceRoot: true,
  projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: true },
  serverRequests: {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  },
  temporaryStorage: { argument: "-data", prefix: "agentroom-jdtls-" },
  environmentKeys: jvmLanguageServiceEnvironmentKeys,
  ...configuredExecutableDescriptorFields(
    (config) => config.jdtlsExecutable,
    "Eclipse JDT LS",
    []
  )
};
