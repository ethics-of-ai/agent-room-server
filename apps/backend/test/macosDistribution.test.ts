import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = resolve(__dirname, "../../..");

describe("macOS distribution packaging", () => {
  it("builds the macOS product as AgentRoom.app", async () => {
    const project = parseYaml(await readFile(resolve(repoRoot, "apps/macos/project.yml"), "utf8")) as {
      targets?: Record<string, { settings?: Record<string, string> }>;
    };

    expect(project.targets?.AgentRoomMac?.settings?.PRODUCT_NAME).toBe("AgentRoom");
  });

  it("configures the macOS app icon asset catalog", async () => {
    const project = parseYaml(await readFile(resolve(repoRoot, "apps/macos/project.yml"), "utf8")) as {
      targets?: Record<string, { settings?: Record<string, string> }>;
    };
    const contents = parseYaml(
      await readFile(resolve(repoRoot, "apps/macos/AgentRoomMac/Assets.xcassets/AppIcon.appiconset/Contents.json"), "utf8")
    ) as {
      images?: Array<{ filename?: string; idiom?: string; size?: string; scale?: string }>;
    };
    const generatorSource = await readFile(resolve(repoRoot, "scripts/generate-app-icons.swift"), "utf8");
    const macIconSource = generatorSource.split("// macOS icon")[1];

    expect(project.targets?.AgentRoomMac?.settings?.ASSETCATALOG_COMPILER_APPICON_NAME).toBe("AppIcon");
    expect(contents.images).toContainEqual({
      filename: "AgentRoomIcon-1024.png",
      idiom: "mac",
      size: "512x512",
      scale: "2x"
    });
    expect(
      await readFile(
        resolve(repoRoot, "apps/macos/AgentRoomMac/Assets.xcassets/AppIcon.appiconset/AgentRoomIcon-1024.png")
      )
    ).not.toHaveLength(0);
    expect(macIconSource).toContain("drawPNG(portalBack, in: iconRect, on: ctx)");
    expect(macIconSource).toContain("drawPNG(portalFront, in: macPortalFrontRect, on: ctx)");
    expect(macIconSource).not.toContain("drawGlyph(");
  });

  it("packages resources where the macOS runtime locator expects them", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);

    expect(distribution.bundledResourcePaths("/Applications/AgentRoom.app")).toEqual({
      nodeExecutable: "/Applications/AgentRoom.app/Contents/Resources/node/bin/node",
      backendEntrypoint: "/Applications/AgentRoom.app/Contents/Resources/backend/dist/index.js",
      backendPublic: "/Applications/AgentRoom.app/Contents/Resources/backend/public",
      backendCatalogAssets: "/Applications/AgentRoom.app/Contents/Resources/backend/catalog-assets"
    });
  });

  it("passes version overrides to xcodebuild only when the release workflow sets them", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);

    expect(distribution.xcodebuildVersionOverrides({})).toEqual([]);
    expect(
      distribution.xcodebuildVersionOverrides({ AGENTROOM_MARKETING_VERSION: "0.2.0", AGENTROOM_BUILD_NUMBER: "41" })
    ).toEqual(["MARKETING_VERSION=0.2.0", "CURRENT_PROJECT_VERSION=41"]);
    expect(() => distribution.xcodebuildVersionOverrides({ AGENTROOM_MARKETING_VERSION: "0.2.0-rc.1" })).toThrow(
      /X\.Y\.Z/
    );
    expect(() => distribution.xcodebuildVersionOverrides({ AGENTROOM_BUILD_NUMBER: "7a" })).toThrow(/integer/);
  });

  it("recognises the binaries the signing pass must sign and the one it must leave alone", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);

    expect(distribution.isMachOHeader(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(distribution.isMachOHeader(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(true);
    expect(distribution.isMachOHeader(Buffer.from("#!/u"))).toBe(false);
    expect(distribution.isMachOHeader(Buffer.from([0x7f]))).toBe(false);
    expect(
      distribution.isPublisherSignedBinary(
        "/x/AgentRoom.app/Contents/Resources/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.172/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
      )
    ).toBe(true);
    expect(
      distribution.isPublisherSignedBinary(
        "/x/AgentRoom.app/Contents/Resources/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/prebuilds/darwin-arm64/pty.node"
      )
    ).toBe(false);
    expect(distribution.nodeRuntimeEntitlementsPath).toBe(resolve(repoRoot, "scripts/codesign/node-runtime.entitlements"));
  });

  it("builds notarization commands without exposing app-specific passwords in log text", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    const command = distribution.notarySubmitCommand("/tmp/AgentRoom.dmg", {
      AGENTROOM_NOTARY_APPLE_ID: "developer@example.com",
      AGENTROOM_NOTARY_TEAM_ID: "TEAM123456",
      AGENTROOM_NOTARY_PASSWORD: "app-specific-password"
    });

    expect(command.args).toEqual([
      "notarytool",
      "submit",
      "/tmp/AgentRoom.dmg",
      "--apple-id",
      "developer@example.com",
      "--team-id",
      "TEAM123456",
      "--password",
      "app-specific-password",
      "--wait",
      "--output-format",
      "json"
    ]);
    expect(command.display).not.toContain("app-specific-password");
    expect(command.display).toContain("<redacted>");

    const logCommand = distribution.notaryLogCommand("sub-123", {
      AGENTROOM_NOTARY_APPLE_ID: "developer@example.com",
      AGENTROOM_NOTARY_TEAM_ID: "TEAM123456",
      AGENTROOM_NOTARY_PASSWORD: "app-specific-password"
    });

    expect(logCommand.args).toEqual([
      "notarytool",
      "log",
      "sub-123",
      "--apple-id",
      "developer@example.com",
      "--team-id",
      "TEAM123456",
      "--password",
      "app-specific-password"
    ]);
    expect(logCommand.display).not.toContain("app-specific-password");

    expect(distribution.notarySubmitCommand("/tmp/AgentRoom.dmg", {})).toBeNull();
    expect(distribution.notaryLogCommand("sub-123", {})).toBeNull();
  });

  it("stages the DMG without rewriting the signed bundle's relative symlinks", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    const root = await mkdtemp(join(tmpdir(), "agentroom-dmg-staging-"));

    try {
      // The shape that matters: a relative link from the bundled backend's
      // node_modules into the bundled pnpm store, exactly what
      // rewriteBundledDependencySymlinks produces before signing.
      const appPath = join(root, "AgentRoom.app");
      const store = join(appPath, "Contents/Resources/node_modules/.pnpm/fastify@5.8.5/node_modules/fastify");
      const linkDir = join(appPath, "Contents/Resources/backend/node_modules");
      await mkdir(store, { recursive: true });
      await mkdir(linkDir, { recursive: true });
      await writeFile(join(store, "index.js"), "module.exports = {};\n");
      const relativeTarget = "../../node_modules/.pnpm/fastify@5.8.5/node_modules/fastify";
      await symlink(relativeTarget, join(linkDir, "fastify"));

      const stagingPath = join(root, "dmg-staging");
      await distribution.createDmgStaging(stagingPath, appPath);

      // fs.cp resolves symlink targets unless told not to, which would point
      // this at an absolute build path and break the signature seal on the copy
      // that ships. See scripts/package-macos.mjs.
      const staged = join(stagingPath, "AgentRoom.app/Contents/Resources/backend/node_modules/fastify");
      expect(await readlink(staged)).toBe(relativeTarget);
      expect(await readlink(join(stagingPath, "Applications"))).toBe("/Applications");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the notarization verdict rather than trusting notarytool's exit code", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);

    // `submit --wait` exits 0 for a completed-but-rejected submission, so the
    // status is what decides whether the build may be stapled.
    expect(distribution.parseNotarySubmission('{"id":"abc","status":"Accepted"}')).toEqual({
      id: "abc",
      status: "Accepted"
    });
    expect(distribution.parseNotarySubmission('{"id":"abc","status":"Invalid"}')).toEqual({
      id: "abc",
      status: "Invalid"
    });
    expect(distribution.parseNotarySubmission("not json")).toEqual({ id: null, status: "unreadable" });
    expect(distribution.parseNotarySubmission("{}")).toEqual({ id: null, status: "unknown" });
  });

  it("rewrites copied pnpm package symlinks to stay inside the app resources", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);

    expect(distribution.relocatedPnpmSymlinkTarget({
      linkPath: "/Applications/AgentRoom.app/Contents/Resources/backend/node_modules/fastify",
      originalTarget: "/repo/node_modules/.pnpm/fastify@5.8.5/node_modules/fastify",
      sourceVirtualStore: "/repo/node_modules/.pnpm",
      bundledVirtualStore: "/Applications/AgentRoom.app/Contents/Resources/node_modules/.pnpm"
    })).toBe("../../node_modules/.pnpm/fastify@5.8.5/node_modules/fastify");

    expect(distribution.relocatedPnpmSymlinkTarget({
      linkPath: "/Applications/AgentRoom.app/Contents/Resources/backend/node_modules/@fastify/static",
      originalTarget: "/repo/node_modules/.pnpm/@fastify+static@9.1.3/node_modules/@fastify/static",
      sourceVirtualStore: "/repo/node_modules/.pnpm",
      bundledVirtualStore: "/Applications/AgentRoom.app/Contents/Resources/node_modules/.pnpm"
    })).toBe("../../../node_modules/.pnpm/@fastify+static@9.1.3/node_modules/@fastify/static");

    expect(distribution.relocatedPnpmSymlinkTarget({
      linkPath: "/Applications/AgentRoom.app/Contents/Resources/node_modules/.pnpm/@fastify+ajv-compiler@4.0.5/node_modules/ajv",
      originalTarget: "/repo/node_modules/.pnpm/ajv@8.20.0/node_modules/ajv",
      sourceVirtualStore: "/repo/node_modules/.pnpm",
      bundledVirtualStore: "/Applications/AgentRoom.app/Contents/Resources/node_modules/.pnpm"
    })).toBe("../../ajv@8.20.0/node_modules/ajv");
  });

  it("rewrites copied workspace symlinks to bundled resources", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);

    expect(distribution.relocatedWorkspaceSymlinkTarget({
      linkPath: "/Applications/AgentRoom.app/Contents/Resources/node_modules/.pnpm/node_modules/@agentroom/backend",
      originalTarget: "/repo/apps/backend",
      sourceWorkspace: "/repo/apps/backend",
      bundledWorkspace: "/Applications/AgentRoom.app/Contents/Resources/backend"
    })).toBe("../../../../backend");
  });
});
