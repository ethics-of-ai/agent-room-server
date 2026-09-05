import { baseLanguageServiceEnvironmentKeys } from "./environment";
import { configuredExecutableDescriptorFields } from "./executable";
import type { LanguageServiceDescriptor } from "./types";

const environmentKeys = [
  ...baseLanguageServiceEnvironmentKeys,
  "DOTNET_CLI_HOME",
  "DOTNET_CLI_TELEMETRY_OPTOUT",
  "DOTNET_CLI_UI_LANGUAGE",
  "DOTNET_NOLOGO",
  "DOTNET_ROOT",
  "NUGET_PACKAGES"
] as const;

export const csharpLsDescriptor: LanguageServiceDescriptor = {
  id: "csharp_ls",
  displayName: "csharp-ls",
  testedVersion: "csharp-ls 0.27.0",
  positionEncoding: "utf-16",
  languageIds: ["csharp"],
  featureKinds: ["completion", "hover", "definition", "document_symbols"],
  projectMarkers: [
    { kind: "suffix", value: ".slnx", priority: 140, entryType: "file" },
    { kind: "suffix", value: ".sln", priority: 130, entryType: "file" },
    { kind: "suffix", value: ".csproj", priority: 120, entryType: "file" }
  ],
  // csharp-ls loads projects; AgentRoom does not synthesize one for a loose file.
  standaloneWorkspaceRoot: false,
  projectLoading: { mayInvokeBuildTools: true, mayLoadPlugins: true },
  serverRequests: {
    workDoneProgressCreate: "null",
    workspaceConfiguration: "null_per_item"
  },
  environmentKeys,
  ...configuredExecutableDescriptorFields(
    (config) => config.csharpLsExecutable,
    "csharp-ls",
    ["--loglevel", "warning"]
  )
};
