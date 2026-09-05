import { baseLanguageServiceEnvironmentKeys } from "./environment";
import { configuredExecutableDescriptorFields } from "./executable";
import type { LanguageServiceDescriptor } from "./types";

const environmentKeys = [
  ...baseLanguageServiceEnvironmentKeys,
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN"
] as const;

export const rustAnalyzerDescriptor: LanguageServiceDescriptor = {
  id: "rust_analyzer",
  displayName: "rust-analyzer",
  testedVersion: "rust-analyzer 2026-08-31",
  positionEncoding: "utf-16",
  languageIds: ["rust"],
  featureKinds: ["completion", "hover", "definition", "document_symbols", "semantic_tokens"],
  projectMarkers: [
    { kind: "exact", value: "rust-project.json", priority: 130, entryType: "file" },
    { kind: "exact", value: "Cargo.toml", priority: 120, entryType: "file" }
  ],
  standaloneWorkspaceRoot: true,
  projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: true },
  serverRequests: {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  },
  environmentKeys,
  ...configuredExecutableDescriptorFields(
    (config) => config.rustAnalyzerExecutable,
    "rust-analyzer",
    []
  )
};
