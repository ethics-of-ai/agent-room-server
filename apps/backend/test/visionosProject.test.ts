import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Every Swift source in the shared package, joined. The contract assertions
 * below read this rather than a single file, and the three `not.toContain`
 * checks are why: `trackerKind`, `retryQueue`, and `issueId` are the retired
 * Linear tracker vocabulary `AGENTS.md` still forbids, and against one file out
 * of ten they would pass while checking nothing.
 */
async function sharedContractSources(root: string): Promise<string> {
  const sources: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".swift")) continue;
    sources.push(await readFile(join(entry.parentPath, entry.name), "utf8"));
  }
  return sources.join("\n");
}

// The public mirror (docs/operations/OPEN_SOURCE_MIRROR.md) ships without
// apps/visionos. These assertions are about that tree, so they run only where
// it is; the private repository still enforces them on every change.
const visionOSTreePresent = existsSync(resolve(process.cwd(), "../../apps/visionos/project.yml"));

describe.skipIf(!visionOSTreePresent)("visionOS XcodeGen project", () => {
  const visionOSRoot = resolve(process.cwd(), "../../apps/visionos");
  const sharedClientRoot = resolve(process.cwd(), "../../apps/shared/AgentRoomClient");

  test("defines the target Info.plist through XcodeGen", async () => {
    const projectYaml = await readFile(resolve(visionOSRoot, "project.yml"), "utf8");
    const project = parse(projectYaml) as {
      targets?: {
        AgentRoom?: {
          deploymentTarget?: string;
          info?: {
            path?: string;
          };
          settings?: Record<string, unknown>;
        };
        AgentRoomTests?: {
          deploymentTarget?: string;
        };
      };
    };

    expect(project.targets?.AgentRoom?.info?.path).toBe("AgentRoom/Info.plist");
    expect(project.targets?.AgentRoom?.deploymentTarget).toBe("26.0");
    expect(project.targets?.AgentRoomTests?.deploymentTarget).toBe("26.0");
  });

  test("uses a layered visionOS app icon stack", async () => {
    const projectYaml = await readFile(resolve(visionOSRoot, "project.yml"), "utf8");
    const project = parse(projectYaml) as {
      targets?: {
        AgentRoom?: {
          settings?: {
            ASSETCATALOG_COMPILER_APPICON_NAME?: string;
          };
        };
      };
    };
    const iconRoot = resolve(visionOSRoot, "AgentRoom/Assets.xcassets/AppIcon.solidimagestack");
    const stackContents = parse(await readFile(resolve(iconRoot, "Contents.json"), "utf8")) as {
      layers?: Array<{ filename?: string }>;
    };

    expect(project.targets?.AgentRoom?.settings?.ASSETCATALOG_COMPILER_APPICON_NAME).toBe("AppIcon");
    expect(stackContents.layers).toEqual([
      { filename: "Front.solidimagestacklayer" },
      { filename: "Middle.solidimagestacklayer" },
      { filename: "Back.solidimagestacklayer" }
    ]);

    for (const [layer, filename] of [
      ["Back", "AgentRoomIconBack.png"],
      ["Middle", "AgentRoomIconMiddle.png"],
      ["Front", "AgentRoomIconFront.png"]
    ] as const) {
      const layerRoot = resolve(iconRoot, `${layer}.solidimagestacklayer`);
      const content = parse(await readFile(resolve(layerRoot, "Content.imageset/Contents.json"), "utf8")) as {
        images?: Array<{ filename?: string; idiom?: string; scale?: string }>;
      };

      expect(await readOptional(resolve(layerRoot, "Contents.json"))).toContain('"version" : 1');
      expect(content.images).toContainEqual({
        filename,
        idiom: "vision",
        scale: "2x"
      });
      expect(await readOptional(resolve(layerRoot, `Content.imageset/${filename}`))).not.toBe("");
    }
  });

  test("builds the layered visionOS icon from repo-owned Meshy portal artwork", async () => {
    const generatorSource = await readFile(
      resolve(process.cwd(), "../../scripts/generate-app-icons.swift"),
      "utf8"
    );
    const visionLayerSource = generatorSource.split("// macOS icon")[0];
    const brandingRoot = resolve(process.cwd(), "../../assets/branding");

    for (const filename of [
      "AgentRoomSpatialPortalBack.png",
      "AgentRoomSpatialPortalFront.png"
    ]) {
      expect((await readFile(resolve(brandingRoot, filename))).byteLength).toBeGreaterThan(0);
    }

    expect(generatorSource).toContain('let brandingRoot = repoRoot.appendingPathComponent("assets/branding")');
    expect(generatorSource).toContain('"AgentRoomSpatialPortalBack.png"');
    expect(generatorSource).toContain('"AgentRoomSpatialPortalFront.png"');
    expect(generatorSource).toContain("let portalFrontRect = CGRect(x: 262, y: 250, width: 500, height: 500)");
    expect(visionLayerSource).toContain("drawPNG(portalBack, in: fullRect, on: backCtx)");
    expect(visionLayerSource).toContain("drawPNG(portalFront, in: portalFrontRect, on: frontCtx)");
    expect(visionLayerSource).not.toContain("drawGlyph(frontCtx");
    expect(visionLayerSource).not.toContain("setShadow");
    expect(await readOptional(resolve(
      visionOSRoot,
      "AgentRoom/Resources/RealityAssets/AgentRoom Emblem Split.glb"
    ))).toBe("");
  });

  test("reveals the visionOS home mark once with a reduce-motion-safe path", async () => {
    const source = await readFile(
      resolve(visionOSRoot, "AgentRoom/Views/Home/HomeSpatialMarkView.swift"),
      "utf8"
    );
    const animationSource = await readFile(
      resolve(visionOSRoot, "AgentRoom/Views/Home/HomeSpatialMarkLightSweepView.swift"),
      "utf8"
    );

    expect(source).toContain("@Environment(\\.accessibilityReduceMotion) private var reduceMotion");
    expect(source).toContain("let cornerRadius = iconSize * 0.18");
    expect(source).toContain("@State private var hasArrived = false");
    expect(source).toContain("@State private var lightSweepProgress: CGFloat = 0");
    expect(source).toContain("ZStack");
    expect(source).toContain("HomeSpatialMarkLightSweepView(");
    expect(source).toContain("iconSize: iconSize");
    expect(source).toContain("reduceMotion: reduceMotion");
    expect(source).toContain(".scaleEffect(reduceMotion || hasArrived ? 1 : 0.96)");
    expect(source).toContain(".offset(z: reduceMotion ? 0 : (hasArrived ? iconSize * 0.045 : 0))");
    expect(source).toContain(".shadow(color: .black.opacity(0.18), radius: iconSize * 0.05, y: iconSize * 0.03)");
    expect(source).toContain(".task(id: reduceMotion)");
    expect(source).toContain("withAnimation(.smooth(duration: 0.45))");
    expect(source).toContain("} completion: {");
    expect(source).toContain("withAnimation(.easeOut(duration: 0.2))");
    expect(animationSource).toContain("struct HomeSpatialMarkLightSweepView: View");
    expect(animationSource).toContain("LinearGradient(");
    expect(animationSource).toContain(".white.opacity(0.28)");
    expect(animationSource).toContain("let sweepOpacity = reduceMotion");
    expect(animationSource).not.toContain("TimelineView");
    expect(animationSource).not.toContain(".repeatForever");
    expect(source).not.toContain("TimelineView");
    expect(source).not.toContain("RealityView");
  });

  test("compiles shared AgentRoomClient sources without loading a duplicate local package", async () => {
    const projectYaml = await readFile(resolve(visionOSRoot, "project.yml"), "utf8");
    const project = parse(projectYaml) as {
      targets?: {
        AgentRoom?: {
          sources?: Array<string | { path?: string; group?: string; excludes?: string[] }>;
          dependencies?: Array<Record<string, string>>;
        };
      };
    };

    expect(project.targets?.AgentRoom?.sources).toContainEqual({
      path: "../shared/AgentRoomClient/Sources/AgentRoomClient",
      group: "Shared/AgentRoomClient"
    });
    // `arrayContaining`, not an exact list: this test is about AgentRoomClient
    // packaging, so a second legitimate exclude (a new bundled web resource)
    // must not fail it with a message pointing at the wrong subject.
    expect(project.targets?.AgentRoom?.sources).toContainEqual(
      expect.objectContaining({
        path: "AgentRoom",
        excludes: expect.arrayContaining(["Resources/Monaco"])
      })
    );
    expect(project.targets?.AgentRoom?.dependencies ?? []).not.toContainEqual(
      expect.objectContaining({ package: "AgentRoomClient" })
    );
    expect(projectYaml).not.toContain("packages:\n  AgentRoomClient:");
  });

  test("declares local network and local HTTP access for physical Vision Pro connections", async () => {
    const infoPlist = await readFile(resolve(visionOSRoot, "AgentRoom/Info.plist"), "utf8");

    expect(infoPlist).toContain("<key>NSLocalNetworkUsageDescription</key>");
    expect(infoPlist).toContain("AgentRoom connects to the Mac-hosted AgentRoom backend");
    expect(infoPlist).toContain("<key>NSBonjourServices</key>");
    expect(infoPlist).toContain("<string>_http._tcp</string>");
    expect(infoPlist).toContain("<key>NSAppTransportSecurity</key>");
    expect(infoPlist).toContain("<key>NSAllowsLocalNetworking</key>");
  });

  test("defaults simulator connections to localhost and clears stale physical-device placeholders", async () => {
    const endpointPolicy = await readFile(resolve(visionOSRoot, "AgentRoom/State/Connection/ServerEndpointPolicy.swift"), "utf8");
    const appStore = await readFile(resolve(visionOSRoot, "AgentRoom/State/AppStore/AppStore.swift"), "utf8");

    expect(endpointPolicy).toContain('static let defaultServerURL = "http://localhost:8787"');
    expect(endpointPolicy).toContain('static let defaultServerURL = ""');
    expect(endpointPolicy).toContain("legacyPhysicalDeviceServerURLs");
    expect(endpointPolicy).toContain('"http://agentroom.local:8787"');
    expect(appStore).toContain("ServerEndpointPolicy.migratedServerURL(fromStored: serverBaseURL)");
  });

  test("shared contracts cover workspaces, sessions, status, and events", async () => {
    const contracts = await sharedContractSources(resolve(sharedClientRoot, "Sources/AgentRoomClient"));

    expect(contracts).toContain("public struct AgentSession");
    expect(contracts).toContain("public struct AgentSessionTurn");
    expect(contracts).toContain("public struct LocalWorkspace");
    expect(contracts).toContain("public struct AgentBridgeMetrics");
    expect(contracts).toContain("public var sessions: [AgentSession]");
    expect(contracts).toContain("public struct AgentRoomEvent");
    expect(contracts).not.toContain("trackerKind");
    expect(contracts).not.toContain("retryQueue");
    expect(contracts).not.toContain("issueId");
  });

  test("keeps the API client on bridge endpoints", async () => {
    const apiClient = await readOptional(resolve(sharedClientRoot, "Sources/AgentRoomClient/APIClient.swift"));
    const appStore = await readFile(resolve(visionOSRoot, "AgentRoom/State/AppStore/AppStore.swift"), "utf8");

    expect(apiClient).toContain("fetchWorkspaces");
    expect(apiClient).toContain("fetchAgentSessions");
    expect(apiClient).toContain("fetchAgentSessionMessages");
    expect(apiClient).toContain('["api", "agent-sessions", sessionId, "messages"]');
    expect(apiClient).toContain("createAgentSession");
    expect(apiClient).toContain("sendAgentTurn");
    expect(apiClient).toContain("cancelAgentSession");
    expect(appStore).toContain("threadMessagesBySessionId");
    expect(apiClient).not.toContain("fetchAudit");
    expect(apiClient).not.toContain("api/audit");
    expect(apiClient).not.toContain("api/issues");
    expect(apiClient).not.toContain("api/approvals");
    expect(apiClient).not.toContain("api/github");
    expect(apiClient).not.toContain("api/orchestrator");
  });

  test("renders windowed Apple-style dashboard and workspace windows", async () => {
    const app = await readFile(resolve(visionOSRoot, "AgentRoom/AgentRoomApp.swift"), "utf8");
    const dashboardView = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardView.swift"), "utf8");
    const infoPlist = await readFile(resolve(visionOSRoot, "AgentRoom/Info.plist"), "utf8");
    const projectYaml = await readFile(resolve(visionOSRoot, "project.yml"), "utf8");
    const workspaceThreads = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceThreadPanel.swift"), "utf8");
    const workspaceWindow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceWindowView.swift"), "utf8");
    const workspaceThreadColumn = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceThreadColumn.swift"), "utf8");
    const threadTranscript = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Transcript/ThreadTranscriptView.swift"), "utf8");
    const composerPanel = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Composer/WorkspaceComposerPanel.swift"), "utf8");
    const turnComposer = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Composer/TurnComposerView.swift"), "utf8");

    expect(app).toContain('WindowGroup("Dashboard"');
    expect(app).toContain('WindowGroup("Workspace"');
    expect(app).toContain("DashboardView()");
    expect(app).not.toContain("DashboardSceneWindow.defaultSize.depth");
    expect(app).not.toContain("RootView()");
    expect(app).not.toContain("OperationalWindow");
    expect(app).not.toContain('WindowGroup("Blender Scene"');
    expect(app).toContain(".windowStyle(.volumetric)");
    expect(dashboardView).toContain("TabView(selection: $selectedNavigationItem)");
    expect(dashboardView).toContain(".tabItem");
    expect(dashboardView).toContain("NavigationSplitView");
    expect(dashboardView).toContain(".navigationSplitViewStyle(.balanced)");
    expect(dashboardView).toContain("DashboardWorkspaceListView()");
    expect(dashboardView).toContain("DashboardWorkspaceDetailView(");
    expect(dashboardView).toContain(".toolbar");
    expect(dashboardView).toContain('Button("Refresh", systemImage: "arrow.clockwise"');
    expect(dashboardView).toContain("Label(DashboardNavigationItem.workspaces.title");
    expect(dashboardView).toContain("Label(DashboardNavigationItem.settings.title");
    expect(dashboardView).not.toContain("NavigationStack");
    expect(dashboardView).not.toContain("SpatialDashboardPanel");
    expect(dashboardView).not.toContain("RealityView");
    expect(dashboardView).not.toContain("Attachment(id:");
    expect(infoPlist).toContain("<string>UIWindowSceneSessionRoleApplication</string>");
    expect(infoPlist).not.toContain("UIWindowSceneSessionRoleVolumetricApplication");
    expect(projectYaml).toContain("UIApplicationPreferredDefaultSceneSessionRole: UIWindowSceneSessionRoleApplication");
    expect(projectYaml).not.toContain("UIApplicationPreferredDefaultSceneSessionRole: UIWindowSceneSessionRoleVolumetricApplication");
    expect(dashboardView).toContain("SettingsView()");
    expect(dashboardView).not.toContain(".sheet(isPresented: $showSettings)");
    expect(workspaceThreadColumn).toContain('Label("New Thread", systemImage: "plus.circle")');
    // Enumerated from the backend's own descriptor catalog rather than a Swift
    // enum, so a runner the backend registers is offered without shipping the
    // app again (docs/engineering/RUNNERS.md), and
    // through the one shared view that also renders a runner this backend
    // reports as unstartable as disabled rather than as ready.
    expect(workspaceThreadColumn).toContain("NewThreadMenuItems(runners: runners, createSession: createSession)");
    expect(workspaceWindow).toContain("store.createAgentSession(workspace: workspace, runnerKind: runnerKind)");
    expect(workspaceThreadColumn).toContain("if spatialSceneEnabled");
    // The spatial entry is a picker over the workspace's discovered documents,
    // not a button onto an assumed path: a diagram under `docs/` was
    // unreachable while the toolbar hardcoded the workspace-root scene file.
    expect(workspaceThreadColumn).toContain("SpatialDocumentMenu(");
    expect(workspaceWindow).toContain("id: SpatialSceneWindow.id");
    expect(workspaceWindow).not.toContain("SpatialSceneWindow.defaultScenePath");
    expect(workspaceThreads).toContain("WorkspaceThreadPanel");
    expect(threadTranscript).toContain("ThreadMessageRow(message: message)");
    expect(composerPanel).toContain("TurnComposerView");
    expect(turnComposer).toContain("Send Turn");
  });

  test("dashboard window uses a native sidebar list and selected workspace detail", async () => {
    const dashboardView = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardView.swift"), "utf8");
    const workspaceList = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardWorkspaceListView.swift"), "utf8");
    const workspaceDetail = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardWorkspaceDetailView.swift"), "utf8");
    const workspacePocket = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/WorkspacePocketView.swift"), "utf8");
    const pocketMetadataRow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardPocketMetadataRow.swift"), "utf8");
    const workspaceOpenButton = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/WorkspaceOpenButton.swift"), "utf8");

    expect(dashboardView).toContain("DashboardWorkspaceListView()");
    expect(dashboardView).toContain("DashboardWorkspaceDetailView(");
    expect(dashboardView).not.toContain("WorkspaceOpenButton(openWorkspace: openWorkspace)");
    expect(dashboardView).not.toContain("private func openWorkspace(_ mode: WorkspaceOpenMode)");
    expect(workspaceList).toContain("List(selection:");
    expect(workspaceList).toContain("PanelRefreshStatusLine");
    expect(workspaceList).not.toContain("SpatialDashboardPanel");
    expect(workspaceList).not.toContain("LazyVStack");
    expect(workspaceDetail).toContain("WorkspacePocketView(");
    expect(workspaceDetail).toContain("@Environment(\\.openWindow)");
    expect(workspaceDetail).toContain(".toolbar");
    expect(workspaceDetail).toContain("ToolbarItem(placement: .primaryAction)");
    expect(workspaceDetail).toContain("WorkspaceOpenButton(openWorkspace: openWorkspace)");
    expect(workspaceDetail).toContain("private func openWorkspace(_ mode: WorkspaceOpenMode)");
    expect(workspaceDetail).toContain("openWindow(id: WorkspaceWindow.id");
    expect(workspaceDetail).toContain("openWindow(id: WorkspaceSceneWindow.id");
    expect(workspaceDetail).not.toContain("SpatialSceneWindow.id");
    expect(workspacePocket).toContain("DashboardPocket {");
    expect(workspacePocket).toContain("DashboardPocketSection(title: \"Repository\")");
    expect(workspacePocket).toContain("DashboardPocketSection(title: \"Activity\")");
    expect(workspacePocket).toContain("DashboardPocketMetadataRow(");
    expect(pocketMetadataRow).toContain("LabeledContent");
    expect(workspacePocket).not.toContain("WorkspaceOpenButton");
    expect(workspacePocket).not.toContain("openWorkspace:");
    expect(workspaceOpenButton).toContain("struct WorkspaceOpenButton: View");
    expect(workspaceOpenButton).toContain("Label(\"Open\"");
    expect(workspaceOpenButton).toContain("DashboardDesign.workspaceOpenButtonWidth");
    expect(workspaceOpenButton).toContain("DashboardDesign.workspaceOpenButtonHeight");
    expect(workspaceOpenButton).toContain(".foregroundStyle(.white)");
    expect(workspaceOpenButton).toContain(".background(.white.opacity(0.15), in: Capsule())");
    expect(workspaceOpenButton).not.toContain("case spatialScene");
    expect(workspacePocket).not.toContain("WorkspacePocketMetric");
    expect(workspacePocket).not.toContain("WorkspaceDwellOpenControl");
    expect(workspacePocket).not.toContain(".font(.caption2)");
    expect(dashboardView).not.toContain("DashboardStatusSummaryView");
    expect(dashboardView).not.toContain("DashboardWindowSection");
    expect(dashboardView).not.toContain("DashboardWindowContentView");
    expect(dashboardView).not.toContain("DashboardWindowOverviewView");
    expect(dashboardView).not.toContain("DashboardWindowActivityView");
    expect(dashboardView).not.toContain("DashboardLayoutVariant");
    expect(dashboardView).not.toContain("DashboardVariantSelectorView");
  });

  test("dashboard does not render an aggregate status summary panel", async () => {
    const dashboardView = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardView.swift"), "utf8");
    const statusSummary = await readOptional(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardStatusSummaryView.swift"));

    expect(dashboardView).not.toContain("DashboardStatusSummaryView");
    expect(statusSummary).toBe("");
  });

  test("dashboard workspace rows use native sidebar labels with compact dirty badges", async () => {
    const workspaceList = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardWorkspaceListView.swift"), "utf8");
    const workspaceRow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/WorkspaceRow.swift"), "utf8");
    const sidebarRow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardSidebarRow.swift"), "utf8");

    expect(workspaceList).toContain("gitStatus: store.workspaceGitStatus(for: workspace)");
    expect(workspaceRow).toContain("title: workspace.name");
    expect(workspaceRow).toContain("dirtyBadgeText");
    expect(workspaceRow).toContain("Workspace has uncommitted changes");
    expect(sidebarRow).toContain("DashboardDesign.sidebarItemHeight");
    expect(sidebarRow).toContain(".listRowHoverEffect(.highlight)");
    expect(workspaceRow).toContain(".accessibilityLabel(Text(accessibilityLabel))");
    expect(workspaceRow).not.toContain("sessions: [AgentSession]");
    expect(workspaceRow).not.toContain("workspace.path");
    expect(workspaceRow).not.toContain("workspace.git.remote");
    expect(workspaceRow).not.toContain("activeSessionCount");
    expect(workspaceRow).not.toContain("failedOrCancelledSessionCount");
    expect(workspaceRow).not.toContain("Label(branch, systemImage: \"arrow.triangle.branch\")");
    expect(workspaceRow).not.toContain("Label(\"Uncommitted changes\", systemImage: \"exclamationmark.triangle\")");
    expect(workspaceRow).not.toContain("Label(activeSessionText, systemImage: \"dot.radiowaves.left.and.right\")");
    expect(workspaceRow).not.toContain("Label(\"Remote\", systemImage: \"network\")");
    expect(workspaceRow).not.toContain("openWindow");
    expect(workspaceRow).not.toContain("Open workspace scene");
    expect(workspaceRow).not.toContain("TurnComposerView");
    expect(workspaceRow).not.toContain("WorkspaceMentionPickerView");
    expect(workspaceRow).not.toContain("CodingAgentRendererView");
  });

  test("dashboard removes overview and activity presentation sources", async () => {
    const dashboardView = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardView.swift"), "utf8");

    const removedDashboardSources = [
      "AgentRoom/Views/Dashboard/DashboardClarityHeaderView.swift",
      "AgentRoom/Views/Dashboard/DashboardClarityOverviewView.swift",
      "AgentRoom/Views/Dashboard/DashboardEventRailRow.swift",
      "AgentRoom/Views/Dashboard/DashboardEventRailView.swift",
      "AgentRoom/Views/Dashboard/DashboardMetricStripView.swift",
      "AgentRoom/Views/Dashboard/DashboardMetricTileView.swift",
      "AgentRoom/Views/Dashboard/DashboardOverviewPanel.swift",
      "AgentRoom/Views/Dashboard/DashboardSectionHeaderView.swift",
      "AgentRoom/Views/Dashboard/DashboardSessionGridView.swift",
      "AgentRoom/Views/Dashboard/DashboardWindowActivityView.swift",
      "AgentRoom/Views/Dashboard/DashboardWindowContentView.swift",
      "AgentRoom/Views/Dashboard/DashboardWindowOverviewView.swift",
      "AgentRoom/Views/Dashboard/DashboardWindowSection.swift",
      "AgentRoom/Views/Dashboard/DashboardWindowWorkspacesView.swift"
    ];

    for (const source of removedDashboardSources) {
      await expect(readOptional(resolve(visionOSRoot, source))).resolves.toBe("");
    }
    expect(dashboardView).not.toContain("dashboardPresentation");
    expect(dashboardView).not.toContain("DashboardPresentationControlView");
  });

  test("does not keep unreachable dashboard source files", async () => {
    const deadDashboardSources = [
      "AgentRoom/Views/Dashboard/CodingAgentSettingControlRow.swift",
      "AgentRoom/Views/Dashboard/CodingAgentSettingsControlsView.swift",
      "AgentRoom/Views/Dashboard/DashboardCompactPanel.swift",
      "AgentRoom/Views/Dashboard/DashboardSelectedWorkspacePanelView.swift",
      "AgentRoom/Views/Dashboard/SessionSummaryView.swift",
      "AgentRoom/Views/Dashboard/WorkspacePillView.swift"
    ];

    for (const source of deadDashboardSources) {
      await expect(readOptional(resolve(visionOSRoot, source))).resolves.toBe("");
    }
  });

  test("dashboard surfaces share Apple spatial design primitives", async () => {
    const dashboardDesign = await readOptional(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardDesign.swift"));
    const dashboardView = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardView.swift"), "utf8");
    const workspaceList = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardWorkspaceListView.swift"), "utf8");
    const workspaceDetail = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardWorkspaceDetailView.swift"), "utf8");
    const sidebarRow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardSidebarRow.swift"), "utf8");

    expect(dashboardDesign).toContain("static let minimumSpatialTarget: CGFloat = 60");
    expect(dashboardDesign).toContain("static let sidebarItemHeight");
    expect(dashboardDesign).toContain("static let sidebarMinimumWidth");
    expect(dashboardDesign).toContain("static let hoverSpacing");
    expect(dashboardDesign).toContain("static let workspaceOpenButtonWidth: CGFloat = 152");
    expect(dashboardDesign).toContain("static let workspaceOpenButtonHeight: CGFloat = 52");
    expect(dashboardDesign).toContain("static let pocketRowMinimumHeight");
    expect(dashboardView).toContain("NavigationSplitView");
    expect(workspaceList).toContain("DashboardDesign.sidebarMinimumWidth");
    expect(workspaceDetail).toContain("DashboardDesign.contentPadding");
    expect(sidebarRow).toContain("DashboardDesign.sidebarItemHeight");
  });

  test("settings tab is built from the workspace browser's sidebar and pocket chrome", async () => {
    const settingsSidebar = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Settings/SettingsSidebar.swift"), "utf8");
    const settingsSidebarRow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Settings/SettingsSidebarRow.swift"), "utf8");
    const settingsDetail = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Settings/SettingsDetailView.swift"), "utf8");
    const connectionPane = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Settings/ConnectionSettingsView.swift"), "utf8");
    const backendPane = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Settings/BackendSettingsPane.swift"), "utf8");
    const workspaceList = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardWorkspaceListView.swift"), "utf8");
    const sidebarRow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardSidebarRow.swift"), "utf8");

    // One sidebar shape for both tabs of this window.
    expect(workspaceList).toContain(".dashboardSidebarList()");
    expect(settingsSidebar).toContain(".dashboardSidebarList()");
    expect(settingsSidebar).toContain(".dashboardSidebarRowInsets()");
    expect(settingsSidebarRow).toContain("DashboardSidebarRow(systemImage: pane.systemImage, title: pane.title)");

    // Sidebar rows name panes; they do not tint symbols with the accent colour.
    expect(sidebarRow).toContain(".foregroundStyle(.secondary)");
    expect(settingsSidebarRow).not.toContain("Label(pane.title");
    expect(settingsSidebar).not.toContain(".tint(");

    // One detail column shape, and panes that are pocket contents like the workspace pocket.
    expect(settingsDetail).toContain("DashboardDesign.pocketColumnWidth");
    expect(settingsDetail).toContain(".navigationTitle(pane.title)");
    expect(connectionPane).toContain("DashboardPocket {");
    expect(connectionPane).toContain("DashboardPocketMetadataRow(");
    expect(backendPane).toContain("DashboardPocket {");
    expect(backendPane).toContain("DashboardPocketSection {");
    expect(backendPane).toContain("ManagedSettingRow(descriptor: descriptor)");
  });

  test("keeps workspace window chat, context, composer run profile, and activity concerns separated", async () => {
    const workspaceWindow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceWindowView.swift"), "utf8");
    const workspaceThreadColumn = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceThreadColumn.swift"), "utf8");
    const workspaceChatColumn = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceChatColumn.swift"), "utf8");
    const workspaceContextColumn = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceContextColumn.swift"), "utf8");
    const workspaceFiles = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceFilesView.swift"), "utf8");
    const workspaceInspector = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceInspectorView.swift"), "utf8");
    const threadTranscript = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Transcript/ThreadTranscriptView.swift"), "utf8");
    const composerPanel = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Composer/WorkspaceComposerPanel.swift"), "utf8");
    const turnComposer = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Composer/TurnComposerView.swift"), "utf8");
    const composerRunProfile = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/WorkspaceRunProfileControls.swift"), "utf8");
    const contextPanel = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Composer/WorkspaceContextPanel.swift"), "utf8");

    expect(workspaceWindow).toContain("WorkspaceThreadColumn(");
    expect(workspaceWindow).toContain("WorkspaceChatColumn(");
    expect(workspaceWindow).toContain("WorkspaceContextColumn(");
    expect(workspaceThreadColumn).toContain("struct WorkspaceThreadColumn");
    expect(workspaceChatColumn).toContain("struct WorkspaceChatColumn");
    expect(workspaceContextColumn).toContain("struct WorkspaceContextColumn");
    expect(workspaceFiles).toContain("struct WorkspaceFilesView");
    expect(workspaceInspector).toContain("struct WorkspaceInspectorView");
    expect(threadTranscript).toContain("ThreadMessageRow(message: message)");
    expect(workspaceWindow).not.toContain("runProfileAttachmentID");
    expect(workspaceWindow).not.toContain("WorkspaceSceneRunProfilePanel");

    expect(composerPanel).toContain("TurnComposerView");
    expect(composerPanel).toContain("WorkspaceContextPanel");
    expect(composerPanel).toContain("isContextPanelPresented");
    expect(composerPanel).not.toContain("Thread Chat");
    expect(composerPanel).not.toContain("SessionDetailContent");
    expect(composerPanel).not.toContain("CodingAgentRendererView");

    expect(turnComposer).toContain("WorkspaceRunProfileControls");
    expect(turnComposer).toContain("Ask for follow-up changes");
    expect(turnComposer).toContain("Send Turn");
    expect(composerRunProfile).toContain("CodingAgentSettingsSelection");
    expect(composerRunProfile).toContain("select: store.selectCodingAgentSetting");
    expect(composerRunProfile).not.toContain("CodingAgentSettingsControlsView");

    expect(contextPanel).toContain("WorkspaceMentionPickerView");
    expect(contextPanel).toContain("SelectedContextList");
    expect(contextPanel).not.toContain("TurnComposerView");
    expect(contextPanel).not.toContain("CodingAgentRendererView");

    // The per-turn diff summary card — the turn-scoped change review entry —
    // mounts in the workspace window's chat column, not in the composer or
    // context panels.
    expect(workspaceChatColumn).toContain("CodingDiffView(diff: diff, startReview: { startDiffReview(diff) })");
    expect(composerPanel).not.toContain("CodingDiffView");
    expect(contextPanel).not.toContain("CodingDiffView");

    // The clarifying-question deck is a trailing scene ornament owned by the
    // chat column, beside the composer's bottom one; the record cards sit in
    // the same column. Neither reaches the composer, the context panel, or
    // the navigation-only window view.
    expect(workspaceChatColumn).toContain("CodingQuestionDeckView(presentation: questionDeck)");
    expect(workspaceChatColumn).toContain("attachmentAnchor: .scene(.trailing)");
    expect(workspaceChatColumn).toContain("CodingQuestionRequestView(");
    // Closing the deck hides it in this window only; the record card is the
    // way back while the batch can still be answered.
    expect(workspaceChatColumn).toContain("reopenQuestionDeck(request)");
    expect(workspaceWindow).toContain("model.questionDrafts.isDismissed(requestId)");
    expect(composerPanel).not.toContain("CodingQuestionDeckView");
    expect(contextPanel).not.toContain("CodingQuestionDeckView");
    expect(workspaceWindow).not.toContain("CodingQuestionDeckView(");
  });

  test("uses a native workspace window shell", async () => {
    const workspaceWindow = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceWindowView.swift"), "utf8");
    const workspaceThreadColumn = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceThreadColumn.swift"), "utf8");
    const workspaceChatColumn = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Workspace/WorkspaceChatColumn.swift"), "utf8");

    expect(workspaceWindow).toContain("NavigationSplitView");
    expect(workspaceWindow).toContain(".navigationSplitViewStyle(.balanced)");
    expect(workspaceThreadColumn).toContain("WorkspaceThreadPanel");
    expect(workspaceChatColumn).toContain("ThreadTranscriptView");
    expect(workspaceChatColumn).toContain("WorkspaceComposerPanel");
    expect(workspaceWindow).not.toContain("workspace-back-plane");
    expect(workspaceWindow).not.toContain("workspace-front-edge");
    expect(workspaceWindow).not.toContain("RealityView");
  });

  test("does not keep deleted legacy source names in the generated source tree", async () => {
    const dashboardView = await readFile(resolve(visionOSRoot, "AgentRoom/Views/Dashboard/DashboardView.swift"), "utf8");
    const appStore = await readFile(resolve(visionOSRoot, "AgentRoom/State/AppStore/AppStore.swift"), "utf8");
    const previewFixtures = await readFile(resolve(visionOSRoot, "AgentRoom/PreviewData/PreviewFixtures.swift"), "utf8");

    for (const source of [dashboardView, appStore, previewFixtures]) {
      expect(source).not.toContain("IssueRunDetailView");
      expect(source).not.toContain("ApprovalQueueView");
      expect(source).not.toContain("GitHub");
      expect(source).not.toContain("ReviewSession");
      expect(source).not.toContain("retryQueue");
    }
  });
});
