import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const macOSRoot = resolve(repoRoot, "apps/macos/AgentRoomMac");
const visionOSRoot = resolve(repoRoot, "apps/visionos/AgentRoom");
const sharedClientRoot = resolve(repoRoot, "apps/shared/AgentRoomClient");
// The public mirror (docs/operations/OPEN_SOURCE_MIRROR.md) ships without
// apps/visionos; the visionOS half of this suite runs only where it is.
const visionOSTreePresent = existsSync(visionOSRoot);
const appRoots: ReadonlyArray<readonly [string, string]> = visionOSTreePresent
  ? [
      ["macOS", macOSRoot],
      ["visionOS", visionOSRoot]
    ]
  : [["macOS", macOSRoot]];

/**
 * Anchored at column 0, so only *top-level* declarations match: a nested
 * `enum Kind` inside another type is indented and is not a redeclaration of
 * anything. Extensions are deliberately not matched — extending a shared
 * contract is the supported way for an app to add app-only behavior.
 */
const topLevelTypeDeclaration = /^(?:@\w+\s+)*(?:public\s+|package\s+)?(?:final\s+)?(?:struct|enum|class|actor|protocol)\s+(\w+)/gm;
const publicTypeDeclaration = /^public\s+(?:final\s+)?(?:struct|enum|class|actor|protocol)\s+(\w+)/gm;

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function swiftSources(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      // Asset catalogs and bundled web resources hold no Swift sources.
      if (entry.name.endsWith(".xcassets") || entry.name === "Resources") continue;
      found.push(...(await swiftSources(path)));
    } else if (entry.name.endsWith(".swift")) {
      found.push(path);
    }
  }
  return found;
}

/** Every top-level type name declared under `root`, mapped to the files declaring it. */
async function declaredTypes(root: string): Promise<Map<string, string[]>> {
  const declarations = new Map<string, string[]>();
  for (const path of await swiftSources(root)) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(topLevelTypeDeclaration)) {
      const files = declarations.get(match[1]) ?? [];
      files.push(path);
      declarations.set(match[1], files);
    }
  }
  return declarations;
}

describe("Swift model structure", () => {
  test("centralizes shared Apple API contracts in AgentRoomClient", async () => {
    const packageManifest = await readOptional(resolve(sharedClientRoot, "Package.swift"));
    const contracts = await readOptional(resolve(sharedClientRoot, "Sources/AgentRoomClient/AgentRoomContracts.swift"));
    const apiClient = await readOptional(resolve(sharedClientRoot, "Sources/AgentRoomClient/APIClient.swift"));
    const macOSProject = await readFile(resolve(repoRoot, "apps/macos/project.yml"), "utf8");
    const visionOSProject = visionOSTreePresent
      ? await readFile(resolve(repoRoot, "apps/visionos/project.yml"), "utf8")
      : null;

    expect(packageManifest).toContain('name: "AgentRoomClient"');
    expect(contracts).toContain("public struct LocalWorkspace");
    expect(contracts).toContain("public struct AgentSession");
    expect(contracts).toContain("public struct StatusSnapshot");
    expect(apiClient).toContain("public struct APIClient");
    expect(apiClient).toContain("Authorization");

    for (const project of [macOSProject, visionOSProject].filter((source): source is string => source !== null)) {
      expect(project).toContain("path: ../shared/AgentRoomClient/Sources/AgentRoomClient");
      expect(project).toContain("group: Shared/AgentRoomClient");
      expect(project).not.toContain("package: AgentRoomClient");
      expect(project).not.toContain("product: AgentRoomClient");
    }
  });

  /**
   * The shared sources are compiled *into* both app modules rather than imported
   * as a package, so an app-local `struct LocalWorkspace` does not collide at the
   * module boundary — it shadows the contract in the files that see it, silently.
   * That is the failure this whole package exists to prevent, so the guard covers
   * every public contract type rather than a hand-listed sample of them.
   */
  test("no app target redeclares a shared AgentRoomClient contract type", async () => {
    const sharedNames = new Set<string>();
    for (const path of await swiftSources(resolve(sharedClientRoot, "Sources/AgentRoomClient"))) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(publicTypeDeclaration)) {
        sharedNames.add(match[1]);
      }
    }
    expect(sharedNames.size).toBeGreaterThan(50);
    expect(sharedNames).toContain("LocalWorkspace");
    expect(sharedNames).toContain("JSONValue");
    expect(sharedNames).toContain("CodingAgentTurnSettings");

    for (const [label, root] of appRoots) {
      const redeclared: string[] = [];
      for (const [name, files] of await declaredTypes(root)) {
        if (!sharedNames.has(name)) continue;
        redeclared.push(...files.map((file) => `${name} in ${file.slice(repoRoot.length + 1)}`));
      }
      expect(redeclared, `${label} redeclares shared AgentRoomClient contracts`).toEqual([]);
    }
  });

  /**
   * The flat `Models/` folders were the home of the typealias shims and the
   * god-files below; SWIFTUI_STANDARDS now says not to recreate them. Assert the
   * *directory* is gone rather than sampling a filename, or a brand-new
   * `Models/SomeNewDTO.swift` compiles into the target unnoticed — the per-file
   * `excludes:` that used to catch it is gone from both project.ymls.
   */
  test("keeps the retired top-level Models directory retired", async () => {
    for (const [label, root] of appRoots) {
      await expect(stat(resolve(root, "Models")), `${label} recreated a top-level Models/`).rejects.toThrow();
    }
  });

  /**
   * `Models/BackendModels.swift` and `Models/BackendSecrets.swift` were multi-type
   * dumps. Asserting only that each extracted type still exists would stay green if
   * someone re-collected them into one file, so assert each is declared exactly
   * once per app and lives in the file named after it.
   */
  test("keeps one owning file per extracted app type", async () => {
    const extracted = [
      "BackendConnectionState",
      "BackendSecretStore",
      "BackendSecretStoreError",
      "BackendSecretValues",
      "BackendServerState",
      "CodingQuestionDeckFooter",
      "CodingQuestionDeckPresentation",
      "CodingQuestionDeckView",
      "CodingQuestionDiscussionField",
      "CodingQuestionDraft",
      "CodingQuestionDraftStore",
      "CodingQuestionOptionCard",
      "CodingQuestionRequestState",
      "CodingQuestionRequestView",
      "CodingQuestionSetView",
      "DiagnosticsBundle",
      "DiagnosticsTextRedactor",
      "KeychainBackendSecretStore",
      "ManagedBackendSettingKey",
      "ManagedBackendSettings",
      "ChatMarkdownCodeLanguage",
      "ChatMarkdownCodeLanguageProfile",
      "ChatMarkdownCodeScanner",
      "ChatMarkdownCodeToken",
      "ChatMarkdownCodeTokenKind",
      "MonacoEditorCoordinator",
      "MonacoFindGoTo",
      "MonacoFindRequest",
      "MonacoFindResult",
      "MonacoLoadPhase",
      "MonacoRevealTarget",
      "MonacoTextMateConfig",
      "MonacoWebView",
      "MonacoWebViewRepresentable",
      "RenderOnlyTerminalView",
      "SpatialSceneArrivalPlayer",
      "SpatialSceneConnectionRow",
      "SpatialSceneConnectController",
      "SpatialSceneChangeFlashPlayer",
      "SpatialSceneDeleteConfirmation",
      "SpatialSceneDetailActions",
      "SpatialSceneDetailInteractionState",
      "SpatialSceneDragController",
      "SpatialSceneFitController",
      "SpatialSceneFlowPlayback",
      "SpatialSceneFocusPresenter",
      "SpatialSceneGroupMenu",
      "SpatialSceneGatherScatterPlayer",
      "SpatialSceneGraph",
      "SpatialSceneFocusPolicy",
      "SpatialSceneLoadState",
      "SpatialSceneOverrideEditor",
      "SpatialScenePaletteDropController",
      "SpatialSceneReflowPlayer",
      "SpatialSceneRuntime",
      "SpatialSceneStructureActions",
      "SpatialSceneUndoHistory",
      "TerminalClearSequenceDetector",
      "TerminalContainerView",
      "TerminalInputCaptureView",
      "TerminalInputMapper",
      "TerminalScrollInvariant",
      "TerminalSurface",
      "WorkspaceBranchSummary",
      "WorkspaceChatColumn",
      "WorkspaceContextColumn",
      "WorkspaceFilesHeader",
      "WorkspaceFilesView",
      "WorkspaceFileTreeActions",
      "WorkspaceInspectorHeader",
      "WorkspaceInspectorMode",
      "WorkspaceInspectorView",
      "WorkspaceSceneConversationLayoutStyle",
      "ThreadMessageRole",
      "WorkspaceScenePromptDeck",
      "WorkspaceSceneTurnActions",
      "WorkspaceSceneTurnContainer",
      "WorkspaceSceneTurnControlButton",
      "WorkspaceSceneTurnRow",
      "WorkspaceTreeEntryRow",
      "WorkspaceThreadColumn",
      "WorkspaceWindow",
      "WorkspaceWindowContent",
      "WorkspaceWindowDirectoryHeader",
      "WorkspaceWindowModel"
    ];

    for (const [label, root] of appRoots) {
      const declarations = await declaredTypes(root);
      for (const name of extracted) {
        const files = declarations.get(name) ?? [];
        if (files.length === 0) continue; // Not every type exists on both platforms.
        expect(files, `${label} declares ${name} in more than one file`).toHaveLength(1);
        expect(basename(files[0]), `${label} should declare ${name} in ${name}.swift`).toBe(`${name}.swift`);
      }
    }
  });

  test("keeps macOS app types with their owning feature or service", async () => {
    const serverState = await readFile(resolve(macOSRoot, "Supervision/State/BackendServerState.swift"), "utf8");
    const settings = await readFile(resolve(macOSRoot, "Features/Settings/ManagedBackendSettings.swift"), "utf8");
    const diagnostics = await readFile(resolve(macOSRoot, "Features/Diagnostics/DiagnosticsBundle.swift"), "utf8");
    const redactor = await readFile(resolve(macOSRoot, "Features/Diagnostics/DiagnosticsTextRedactor.swift"), "utf8");
    const secretValues = await readFile(resolve(macOSRoot, "Supervision/Secrets/BackendSecretValues.swift"), "utf8");
    const keychainStore = await readFile(resolve(macOSRoot, "Supervision/Secrets/KeychainBackendSecretStore.swift"), "utf8");

    expect(serverState).toContain("enum BackendServerState");
    expect(settings).toContain("struct ManagedBackendSettings");
    expect(diagnostics).toContain("struct DiagnosticsBundle");
    expect(redactor).toContain("struct DiagnosticsTextRedactor");
    expect(secretValues).toContain("struct BackendSecretValues");
    expect(keychainStore).toContain("struct KeychainBackendSecretStore");
  });

  test.skipIf(!visionOSTreePresent)("keeps visionOS state and presentation types with their owning features", async () => {
    const rendererState = await readFile(resolve(visionOSRoot, "State/Coding/CodingAgentRendererState.swift"), "utf8");
    const appStore = await readFile(resolve(visionOSRoot, "State/AppStore/AppStore.swift"), "utf8");
    const transcriptMessage = await readFile(resolve(visionOSRoot, "State/Coding/CodingTranscriptMessage.swift"), "utf8");
    const appAction = await readFile(resolve(visionOSRoot, "State/AppStore/AppAction.swift"), "utf8");
    const settingsSelection = await readFile(resolve(visionOSRoot, "State/Coding/CodingAgentSettingsSelection.swift"), "utf8");
    const backendSetting = await readFile(resolve(visionOSRoot, "State/BackendSettings/ManagedBackendSettingDescriptor.swift"), "utf8");
    const editorDiff = await readFile(resolve(visionOSRoot, "State/Editor/GitLineDiff.swift"), "utf8");
    const questionRequestState = await readFile(resolve(visionOSRoot, "State/Coding/CodingQuestionRequestState.swift"), "utf8");

    expect(transcriptMessage).toContain("struct CodingTranscriptMessage");
    // The clarifying-question record sits beside the permission record in the
    // coding state taxonomy, not inside the reducer.
    expect(questionRequestState).toContain("struct CodingQuestionRequestState");
    expect(rendererState).not.toContain("struct CodingQuestionRequestState");
    expect(appAction).toContain("enum AppAction");
    expect(settingsSelection).toContain("struct CodingAgentSettingsSelection");
    expect(backendSetting).toContain("struct ManagedBackendSettingDescriptor");
    expect(editorDiff).toContain("enum GitLineDiff");
    expect(rendererState).not.toContain("struct CodingTranscriptMessage");
    expect(appStore).not.toContain("enum AppAction");
  });

  /**
   * `GitLineDiffRange` (gutter decorations) and `GitDiffHunk` (side-by-side
   * alignment) are built in one traversal by `GitLineDiff.compute`, so a change
   * kind added to only one of them would compile and emit an inconsistent pair.
   */
  test.skipIf(!visionOSTreePresent)("shares one change-kind enum between both editor diff payloads", async () => {
    const editorRoot = resolve(visionOSRoot, "State/Editor");
    const changeKind = await readFile(resolve(editorRoot, "GitDiffChangeKind.swift"), "utf8");
    const range = await readFile(resolve(editorRoot, "GitLineDiffRange.swift"), "utf8");
    const hunk = await readFile(resolve(editorRoot, "GitDiffHunk.swift"), "utf8");

    expect(changeKind).toContain("enum GitDiffChangeKind: String, Codable, Sendable");
    for (const source of [range, hunk]) {
      expect(source).toContain("typealias Kind = GitDiffChangeKind");
      expect(source).not.toMatch(/enum Kind\s*:/);
    }
  });
});
