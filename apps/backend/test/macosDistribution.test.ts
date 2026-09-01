import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = resolve(__dirname, "../../..");
// These publication-policy inputs intentionally exist only in the private
// repository. Keep their checks active there without making the public mirror
// depend on private workflows, credentials tooling, or mirror configuration.
const privateReleasePolicyPresent = existsSync(resolve(repoRoot, "mirror/manifest.json"));
const privateReleasePolicyTest = it.skipIf(!privateReleasePolicyPresent);

describe("macOS distribution packaging", () => {
  it("builds the macOS product as AgentRoom.app", async () => {
    const project = parseYaml(await readFile(resolve(repoRoot, "apps/macos/project.yml"), "utf8")) as {
      packages?: Record<string, { url?: string; exactVersion?: string }>;
      targets?: Record<string, {
        settings?: Record<string, string>;
        dependencies?: Array<{ package?: string }>;
      }>;
    };

    expect(project.targets?.AgentRoomMac?.settings?.PRODUCT_NAME).toBe("AgentRoom");
    expect(project.packages?.Sparkle).toEqual({
      url: "https://github.com/sparkle-project/Sparkle",
      exactVersion: "2.9.6"
    });
    expect(project.targets?.AgentRoomMac?.dependencies).toContainEqual({ package: "Sparkle" });
  });

  it("defaults Sparkle to an updater-disabled build", async () => {
    const project = parseYaml(await readFile(resolve(repoRoot, "apps/macos/project.yml"), "utf8")) as {
      targets?: Record<string, { settings?: Record<string, string> }>;
    };
    const plist = await readFile(resolve(repoRoot, "apps/macos/AgentRoomMac/Info.plist"), "utf8");

    expect(project.targets?.AgentRoomMac?.settings?.AGENTROOM_SPARKLE_FEED_URL).toBe("");
    expect(plist).toMatch(
      /<key>SUFeedURL<\/key>\s*<string>\$\(AGENTROOM_SPARKLE_FEED_URL\)<\/string>/
    );
    expect(plist).toMatch(/<key>SUEnableAutomaticChecks<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>SUAllowsAutomaticUpdates<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>SUVerifyUpdateBeforeExtraction<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>SUPublicEDKey<\/key>\s*<string>\$\(AGENTROOM_SPARKLE_PUBLIC_ED_KEY\)<\/string>/);
    // Sparkle's default is already off, but the scheduled check is an outbound
    // request from every installed app, so the posture is pinned rather than
    // inherited.
    expect(plist).toMatch(/<key>SUSendProfileInfo<\/key>\s*<false\/>/);
  });

  privateReleasePolicyTest("publishes a checksum-pinned, EdDSA-signed appcast only for enabled update channels", async () => {
    const workflow = await readFile(resolve(repoRoot, "mirror/overlay/.github/workflows/release.yml"), "utf8");
    const credentialWizard = await readFile(resolve(repoRoot, "scripts/setup-release-credentials.sh"), "utf8");
    const parsedWorkflow = parseYaml(workflow) as {
      jobs?: { dmg?: { steps?: Array<{ name?: string; run?: string }> } };
    };

    expect(parsedWorkflow.jobs?.dmg?.steps).toBeDefined();
    for (const source of [workflow, credentialWizard]) {
      expect(source).toContain('SPARKLE_VERSION="2.9.6"');
      expect(source).toContain("52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192");
    }
    expect(workflow).toContain("SPARKLE_PRIVATE_ED_KEY: ${{ secrets.SPARKLE_PRIVATE_ED_KEY }}");
    expect(workflow).toContain("SPARKLE_PUBLIC_ED_KEY: ${{ vars.SPARKLE_PUBLIC_ED_KEY }}");
    expect(workflow).toContain("verify-sparkle-key-pair.mjs");
    expect(workflow).toContain("generate_appcast");
    expect(workflow).toContain("sparkle:edSignature=");
    expect(workflow).toContain('SUMMED_FILES+=(appcast.xml)');
    expect(workflow).toContain('gh release create "$TAG"');
    expect(workflow).toContain("STABLE_SPARKLE_UPDATE_CHANNEL: stable");
    expect(workflow).toContain('UPDATE_CHANNEL="$STABLE_SPARKLE_UPDATE_CHANNEL"');
    expect(workflow).toContain('echo "update_channel=$UPDATE_CHANNEL" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("prerelease tag must look like vX.Y.Z-rc.N");
    expect(workflow).toContain(
      "AGENTROOM_SPARKLE_UPDATE_CHANNEL: ${{ inputs.unsigned && 'disabled' || steps.version.outputs.update_channel }}"
    );
    expect(workflow).toContain(
      'if [ "$UNSIGNED" != "true" ] && [ "$UPDATE_CHANNEL" != "disabled" ]; then'
    );
    expect(workflow).toMatch(/concurrency:\s+[^]*group: release\s/);
    expect(workflow).toContain('gh release delete-asset "$TAG" appcast.xml --yes');
    expect(workflow).toContain('gh release upload "$TAG" --clobber "$DMG" "$MANIFEST" "$SUMS"');
    expect(workflow).toContain('gh release upload rc --clobber "$APPCAST"');
    expect(workflow).toContain('gh release create rc --target "$GITHUB_SHA"');
    expect(workflow).toContain(
      'https://github.com/ethics-of-ai/agent-room-server/releases/download/$TAG/$DMG'
    );
    expect(workflow).toContain(
      "https://github.com/ethics-of-ai/agent-room-server/releases/latest/download/appcast.xml"
    );
    expect(workflow).toContain('cmp -s "$APPCAST" "$RUNNER_TEMP/latest-stable-appcast.xml"');
    expect(workflow).toContain('if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then');
    expect(workflow).toContain("refusing to replace immutable assets");
    expect(workflow).toMatch(
      /if gh release view "\$TAG"[^]*if \[ "\$PRERELEASE" = "true" \]; then[^]*exit 1[^]*gh release upload "\$TAG" --clobber/
    );
    expect(credentialWizard).toContain("gh workflow run release-candidate.yml");
    expect(credentialWizard).not.toContain("push a RC tag");

    const runnableSteps = parsedWorkflow.jobs?.dmg?.steps?.filter((step) => step.run) ?? [];
    for (const step of runnableSteps) {
      const syntaxCheck = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
      expect(syntaxCheck.stderr, step.name).toBe("");
      expect(syntaxCheck.status, step.name).toBe(0);
    }

    const resolveScript = runnableSteps.find((step) => step.name === "Resolve the version from the tag")?.run;
    expect(resolveScript).toBeDefined();
    for (const testCase of [
      { tag: "v0.4.0", stableChannel: "stable", status: 0, output: "update_channel=stable" },
      { tag: "v0.4.0-rc.1", stableChannel: "stable", status: 0, output: "update_channel=rc" },
      { tag: "v0.4.0", stableChannel: "disabled", status: 0, output: "update_channel=disabled" },
      { tag: "v0.4.0-beta.1", stableChannel: "stable", status: 1, output: "prerelease tag must look like" }
    ]) {
      const result = spawnSync("bash", ["-c", resolveScript!], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: "/dev/stdout",
          STABLE_SPARKLE_UPDATE_CHANNEL: testCase.stableChannel,
          TAG: testCase.tag
        }
      });
      expect(result.status, testCase.tag).toBe(testCase.status);
      expect(`${result.stdout}${result.stderr}`, testCase.tag).toContain(testCase.output);
    }
  });

  privateReleasePolicyTest("publishes RC tags only from the open Release Please candidate and leaves public main alone", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/release-candidate.yml"), "utf8");
    const parsedWorkflow = parseYaml(workflow) as {
      on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean; type?: string }> } };
      permissions?: Record<string, string>;
      concurrency?: { group?: string; "cancel-in-progress"?: boolean };
      jobs?: {
        publish?: {
          if?: string;
          steps?: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
        };
      };
    };

    expect(Object.keys(parsedWorkflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(parsedWorkflow.on?.workflow_dispatch?.inputs).toMatchObject({
      version: { required: true, type: "string" },
      rc_number: { required: true, type: "string" }
    });
    expect(parsedWorkflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(parsedWorkflow.concurrency).toEqual({ group: "mirror", "cancel-in-progress": false });
    expect(parsedWorkflow.jobs?.publish?.if).toBe(
      "github.ref == 'refs/heads/main' && vars.MIRROR_ENABLED == 'true'"
    );

    const steps = parsedWorkflow.jobs?.publish?.steps ?? [];
    const checkout = steps.find((step) => step.with?.ref === "main");
    expect(checkout?.with).toMatchObject({ ref: "main", "fetch-depth": 0 });
    expect(workflow).toContain("release-please--branches--main--components--agentroom");
    expect(workflow).toContain('pull/$PR_NUMBER/merge:refs/remotes/origin/release-candidate');
    expect(workflow).toContain('expected one open Release Please PR to main');
    expect(workflow).toContain('Release Please PR changed files outside its generated release set');
    expect(workflow).toContain("jq -S 'del(.version)'");
    expect(workflow).toContain("sed -E '/x-release-please-version/s/");
    expect(workflow).toContain('candidate does not contain the RC release channel');
    expect(workflow).toContain('deploy-key: ${{ secrets.MIRROR_DEPLOY_KEY }}');
    expect(workflow).toContain("ghcr.io/gitleaks/gitleaks:latest");
    expect(workflow).toContain('git -C "$RUNNER_TEMP/public" push origin "refs/tags/$TAG"');
    expect(workflow).not.toContain("push origin HEAD:refs/heads/main");

    const runnableSteps = steps.filter((step) => step.run);
    for (const step of runnableSteps) {
      const syntaxCheck = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
      expect(syntaxCheck.stderr, step.name).toBe("");
      expect(syntaxCheck.status, step.name).toBe(0);
    }

    const requestedScript = runnableSteps.find((step) => step.name === "Validate the requested RC")?.run;
    expect(requestedScript).toBeDefined();
    for (const testCase of [
      { version: "0.5.0", rcNumber: "1", status: 0, output: "tag=v0.5.0-rc.1" },
      { version: "v0.5.0", rcNumber: "1", status: 1, output: "version must look like" },
      { version: "0.5.0", rcNumber: "0", status: 1, output: "rc_number must be a positive integer" }
    ]) {
      const result = spawnSync("bash", ["-c", requestedScript!], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: "/dev/stdout",
          GITHUB_REF: "refs/heads/main",
          RC_NUMBER: testCase.rcNumber,
          VERSION: testCase.version
        }
      });
      expect(result.status, `${testCase.version}-rc.${testCase.rcNumber}`).toBe(testCase.status);
      expect(`${result.stdout}${result.stderr}`, `${testCase.version}-rc.${testCase.rcNumber}`).toContain(
        testCase.output
      );
    }
  });

  privateReleasePolicyTest("keeps the ordinary mirror main-only and leaves release tags to the release workflows", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/mirror.yml"), "utf8");
    const parsedWorkflow = parseYaml(workflow) as {
      on?: { push?: { branches?: string[]; tags?: string[] }; workflow_dispatch?: unknown };
      jobs?: { sync?: { if?: string; steps?: Array<{ name?: string; run?: string }> } };
    };

    expect(Object.keys(parsedWorkflow.on ?? {})).toEqual(["push", "workflow_dispatch"]);
    expect(parsedWorkflow.on?.push).toEqual({ branches: ["main"] });
    expect(parsedWorkflow.jobs?.sync?.if).toBe(
      "github.ref == 'refs/heads/main' && vars.MIRROR_ENABLED == 'true'"
    );
    expect(workflow).not.toContain("refs/tags/");
    expect(workflow).not.toContain("--tag");

    const push = parsedWorkflow.jobs?.sync?.steps?.find((step) => step.name === "Push")?.run;
    expect(push).toBe('git -C "$RUNNER_TEMP/public" push origin HEAD:refs/heads/main');
  });

  privateReleasePolicyTest("loads the public mirror deploy key through one private composite action", async () => {
    const actionPath = ".github/actions/load-mirror-deploy-key";
    const action = await readFile(resolve(repoRoot, actionPath, "action.yml"), "utf8");
    const parsedAction = parseYaml(action) as {
      runs?: { using?: string; steps?: Array<{ run?: string }> };
    };

    expect(parsedAction.runs?.using).toBe("composite");
    expect(action).toContain('[ -n "$MIRROR_DEPLOY_KEY" ]');
    expect(action).toContain("chmod 600 ~/.ssh/mirror_deploy_key");
    expect(action).toContain("ssh-keyscan -t ed25519 github.com");
    const syntaxCheck = spawnSync("bash", ["-n"], {
      input: parsedAction.runs?.steps?.[0]?.run,
      encoding: "utf8"
    });
    expect(syntaxCheck.stderr).toBe("");
    expect(syntaxCheck.status).toBe(0);
    for (const workflowPath of ["mirror.yml", "release-candidate.yml", "release-please.yml"]) {
      const workflow = await readFile(resolve(repoRoot, ".github/workflows", workflowPath), "utf8");
      expect(() => parseYaml(workflow), workflowPath).not.toThrow();
      expect(workflow, workflowPath).toContain(`uses: ./${actionPath}`);
      expect(workflow, workflowPath).not.toContain("ssh-keyscan -t ed25519 github.com");
    }
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

  it("maps explicit Sparkle update channels to fail-closed build overrides", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    const publicKey = Buffer.alloc(32, 7).toString("base64");
    const rcFeed = "https://github.com/ethics-of-ai/agent-room-server/releases/download/rc/appcast.xml";
    const stableFeed = "https://github.com/ethics-of-ai/agent-room-server/releases/latest/download/appcast.xml";

    expect(distribution.xcodebuildSparkleOverrides({})).toEqual([]);
    expect(distribution.xcodebuildSparkleOverrides({ AGENTROOM_SPARKLE_UPDATE_CHANNEL: "disabled" })).toEqual([]);
    expect(
      distribution.xcodebuildSparkleOverrides({
        AGENTROOM_SPARKLE_PUBLIC_ED_KEY: publicKey,
        AGENTROOM_SPARKLE_UPDATE_CHANNEL: "rc"
      })
    ).toEqual([`AGENTROOM_SPARKLE_PUBLIC_ED_KEY=${publicKey}`, `AGENTROOM_SPARKLE_FEED_URL=${rcFeed}`]);
    expect(
      distribution.xcodebuildSparkleOverrides({
        AGENTROOM_SPARKLE_PUBLIC_ED_KEY: publicKey,
        AGENTROOM_SPARKLE_UPDATE_CHANNEL: "stable"
      })
    ).toEqual([`AGENTROOM_SPARKLE_PUBLIC_ED_KEY=${publicKey}`, `AGENTROOM_SPARKLE_FEED_URL=${stableFeed}`]);
    expect(() =>
      distribution.xcodebuildSparkleOverrides({
        AGENTROOM_SPARKLE_PUBLIC_ED_KEY: publicKey,
        AGENTROOM_SPARKLE_UPDATE_CHANNEL: "disabled"
      })
    ).toThrow(/disabled channel must not receive/);
    expect(() =>
      distribution.xcodebuildSparkleOverrides({ AGENTROOM_SPARKLE_UPDATE_CHANNEL: "rc" })
    ).toThrow(/rc channel requires/);
    expect(() =>
      distribution.xcodebuildSparkleOverrides({
        AGENTROOM_SPARKLE_PUBLIC_ED_KEY: "not-a-key",
        AGENTROOM_SPARKLE_UPDATE_CHANNEL: "rc"
      })
    ).toThrow(
      /32-byte Ed25519/
    );
    expect(() =>
      distribution.xcodebuildSparkleOverrides({ AGENTROOM_SPARKLE_UPDATE_CHANNEL: "nightly" })
    ).toThrow(/disabled, rc, or stable/);
    expect(() =>
      distribution.xcodebuildSparkleOverrides({
        AGENTROOM_SPARKLE_FEED_URL: rcFeed,
        AGENTROOM_SPARKLE_PUBLIC_ED_KEY: publicKey,
        AGENTROOM_SPARKLE_UPDATE_CHANNEL: "rc"
      })
    ).toThrow(/derived from AGENTROOM_SPARKLE_UPDATE_CHANNEL/);
    expect(() => distribution.assertSparklePackagingMode("disabled", undefined)).not.toThrow();
    expect(() => distribution.assertSparklePackagingMode("rc", undefined)).toThrow(
      /requires AGENTROOM_CODESIGN_IDENTITY/
    );
    expect(() =>
      distribution.assertSparklePackagingMode("stable", "Developer ID Application: AgentRoom")
    ).not.toThrow();
  });

  it("validates the assembled app before the optional signing branch", async () => {
    const source = await readFile(resolve(repoRoot, "scripts/package-macos.mjs"), "utf8");
    const validation = source.indexOf("await assertEmbeddedSparkleConfiguration(appPath, sparkleChannel);");
    const signingBranch = source.indexOf("if (signingIdentity) {");

    expect(validation).toBeGreaterThan(-1);
    expect(signingBranch).toBeGreaterThan(validation);
    expect(source.match(/assertEmbeddedSparkleConfiguration\(appPath, sparkleChannel\)/g)).toHaveLength(1);
    expect(source).toContain("assertSparklePackagingMode(sparkleChannel, signingIdentity);");
  });

  it("proves the Sparkle public key belongs to the configured private seed", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    // RFC 8032, section 7.1, test vector 1.
    const privateSeed = Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex"
    ).toString("base64");
    const publicKey = Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex"
    ).toString("base64");

    expect(distribution.sparklePublicKeyFromPrivateSecret(privateSeed)).toBe(publicKey);
    expect(() => distribution.assertSparkleKeyPair(privateSeed, publicKey)).not.toThrow();
    expect(() => distribution.assertSparkleKeyPair(privateSeed, Buffer.alloc(32, 9).toString("base64"))).toThrow(
      /do not match/
    );
    expect(() => distribution.sparklePublicKeyFromPrivateSecret("not-a-key")).toThrow(/private key/);
  });

  it("verifies a Sparkle key pair through the release CLI's stdin contract", () => {
    // RFC 8032, section 7.1, test vector 1.
    const privateSeed = Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex"
    ).toString("base64");
    const publicKey = Buffer.from(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "hex"
    ).toString("base64");
    const result = spawnSync(
      process.execPath,
      [resolve(repoRoot, "scripts/verify-sparkle-key-pair.mjs"), publicKey],
      { encoding: "utf8", input: `${privateSeed}\n` }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("Sparkle private and public keys match.\n");
  });

  it("validates the embedded Sparkle configuration against the selected update channel", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    const root = await mkdtemp(join(tmpdir(), "agentroom-sparkle-key-"));
    const publicKey = "NsAF3JGCeJ2gRr4bo0oBiwqLpUgnj1sQoBQnLVSlgHU=";
    const rcFeed = "https://github.com/ethics-of-ai/agent-room-server/releases/download/rc/appcast.xml";
    const stableFeed = "https://github.com/ethics-of-ai/agent-room-server/releases/latest/download/appcast.xml";

    const writeBundle = async (name: string, publicKeyElement: string, feedURL: string) => {
      const appPath = resolve(root, `${name}.app`);
      await mkdir(resolve(appPath, "Contents"), { recursive: true });
      await writeFile(
        resolve(appPath, "Contents/Info.plist"),
        `<plist version="1.0"><dict>\n\t<key>SUPublicEDKey</key>\n\t${publicKeyElement}\n\t<key>SUFeedURL</key>\n\t<string>${feedURL}</string>\n</dict></plist>`
      );
      return appPath;
    };

    try {
      const disabled = await writeBundle("disabled", "<string></string>", "");
      await expect(distribution.assertEmbeddedSparkleConfiguration(disabled, "disabled")).resolves.toEqual({
        channel: "disabled",
        feedURL: "",
        publicKey: ""
      });

      const rc = await writeBundle("rc", `<string>${publicKey}</string>`, rcFeed);
      await expect(distribution.assertEmbeddedSparkleConfiguration(rc, "rc")).resolves.toEqual({
        channel: "rc",
        feedURL: rcFeed,
        publicKey
      });

      const stable = await writeBundle("stable", `<string>${publicKey}</string>`, stableFeed);
      await expect(distribution.assertEmbeddedSparkleConfiguration(stable, "stable")).resolves.toEqual({
        channel: "stable",
        feedURL: stableFeed,
        publicKey
      });

      const disabledWithKey = await writeBundle("disabled-with-key", `<string>${publicKey}</string>`, rcFeed);
      await expect(
        distribution.assertEmbeddedSparkleConfiguration(disabledWithKey, "disabled")
      ).rejects.toThrow(/disabled build must not embed/);

      const rcWithoutKey = await writeBundle("rc-without-key", "<string></string>", rcFeed);
      await expect(distribution.assertEmbeddedSparkleConfiguration(rcWithoutKey, "rc")).rejects.toThrow(
        /rc build must embed/
      );

      const rcWithStableFeed = await writeBundle("rc-stable-feed", `<string>${publicKey}</string>`, stableFeed);
      await expect(distribution.assertEmbeddedSparkleConfiguration(rcWithStableFeed, "rc")).rejects.toThrow(
        /must embed the rc Sparkle feed/
      );

      const absent = resolve(root, "absent.app");
      await mkdir(resolve(absent, "Contents"), { recursive: true });
      await writeFile(resolve(absent, "Contents/Info.plist"), "<plist version=\"1.0\"><dict></dict></plist>");
      await expect(distribution.assertEmbeddedSparkleConfiguration(absent, "rc")).rejects.toThrow(/must embed/);

      await expect(
        distribution.assertEmbeddedSparkleConfiguration(resolve(root, "missing.app"), "disabled")
      ).rejects.toThrow(/Missing/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    // Cursor's SDK ships Anysphere-signed binaries (cursorsandbox, rg,
    // tree-sitter) in its platform package; the signing pass must leave them
    // alone the same way it leaves Claude Code's. See docs/engineering/CURSOR_SDK_RUNNER.md.
    expect(
      distribution.isPublisherSignedBinary(
        "/x/AgentRoom.app/Contents/Resources/node_modules/.pnpm/@cursor+sdk-darwin-arm64@1.0.28/node_modules/@cursor/sdk-darwin-arm64/bin/cursorsandbox"
      )
    ).toBe(true);
    expect(distribution.nodeRuntimeEntitlementsPath).toBe(resolve(repoRoot, "scripts/codesign/node-runtime.entitlements"));
    expect(distribution.sparkleBundlePaths("/Applications/AgentRoom.app")).toEqual({
      framework: "/Applications/AgentRoom.app/Contents/Frameworks/Sparkle.framework",
      installer: "/Applications/AgentRoom.app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc",
      downloader: "/Applications/AgentRoom.app/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc",
      autoupdate: "/Applications/AgentRoom.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate",
      updater: "/Applications/AgentRoom.app/Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app"
    });
  });

  it("preserves relative framework symlinks when copying Xcode's app product", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    const root = await mkdtemp(join(tmpdir(), "agentroom-app-copy-"));
    const source = resolve(root, "Build/Products/Release/AgentRoom.app");
    const destination = resolve(root, "dist/AgentRoom.app");
    const framework = resolve(source, "Contents/Frameworks/Sparkle.framework");

    try {
      await mkdir(resolve(framework, "Versions/B"), { recursive: true });
      await writeFile(resolve(framework, "Versions/B/Sparkle"), "binary");
      await symlink("B", resolve(framework, "Versions/Current"));
      await symlink("Versions/Current/Sparkle", resolve(framework, "Sparkle"));

      await distribution.copyBuiltAppBundle(source, destination);

      expect(await readlink(resolve(destination, "Contents/Frameworks/Sparkle.framework/Versions/Current"))).toBe("B");
      expect(await readlink(resolve(destination, "Contents/Frameworks/Sparkle.framework/Sparkle"))).toBe(
        "Versions/Current/Sparkle"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("holds the bundled Node runtime to the floor the Cursor SDK's node:sqlite needs", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);

    expect(distribution.CURSOR_SDK_NODE_FLOOR).toBe("22.13.0");
    expect(distribution.meetsNodeFloor("v22.13.0")).toBe(true);
    expect(distribution.meetsNodeFloor("22.13.1")).toBe(true);
    expect(distribution.meetsNodeFloor("v24.2.0")).toBe(true);
    expect(distribution.meetsNodeFloor("v22.12.0")).toBe(false);
    expect(distribution.meetsNodeFloor("v20.19.0")).toBe(false);
  });

  it("pins the macOS Cursor sandbox helpers to the SDK version", async () => {
    const backendPackage = JSON.parse(await readFile(resolve(repoRoot, "apps/backend/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const sdkVersion = backendPackage.dependencies?.["@cursor/sdk"];

    expect(sdkVersion).toBe("1.0.28");
    expect(backendPackage.optionalDependencies).toMatchObject({
      "@cursor/sdk-darwin-arm64": sdkVersion,
      "@cursor/sdk-darwin-x64": sdkVersion
    });
  });

  it("accepts a packaged Cursor sandbox helper only when its link resolves inside the bundle", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    const root = await mkdtemp(join(tmpdir(), "agentroom-cursor-sandbox-package-"));
    const bundleRoot = resolve(root, "bundle");
    const backendNodeModules = resolve(bundleRoot, "backend/node_modules");
    const packageName = "@cursor/sdk-darwin-arm64";
    const platformPackage = resolve(
      bundleRoot,
      "node_modules/.pnpm/@cursor+sdk-darwin-arm64@1.0.28/node_modules",
      packageName
    );
    const helperPath = resolve(platformPackage, "bin/cursorsandbox");
    const packageLink = resolve(backendNodeModules, packageName);

    try {
      await mkdir(resolve(platformPackage, "bin"), { recursive: true });
      await mkdir(resolve(backendNodeModules, "@cursor"), { recursive: true });
      await writeFile(helperPath, "#!/bin/sh\nexit 0\n");
      await chmod(helperPath, 0o755);
      await symlink(platformPackage, packageLink);

      await expect(
        distribution.assertPackagedCursorSandboxHelper({
          backendNodeModules,
          bundleRoot,
          platform: "darwin",
          arch: "arm64"
        })
      ).resolves.toEqual({
        helperPath: resolve(packageLink, "bin/cursorsandbox"),
        resolvedPath: await realpath(helperPath)
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a Cursor sandbox helper link that escapes the packaged bundle", async () => {
    const distribution = await import(pathToFileURL(resolve(repoRoot, "scripts/package-macos.mjs")).href);
    const root = await mkdtemp(join(tmpdir(), "agentroom-cursor-sandbox-escape-"));
    const bundleRoot = resolve(root, "bundle");
    const backendNodeModules = resolve(bundleRoot, "backend/node_modules");
    const outsidePackage = resolve(root, "outside/@cursor/sdk-darwin-arm64");
    const helperPath = resolve(outsidePackage, "bin/cursorsandbox");
    const packageLink = resolve(backendNodeModules, "@cursor/sdk-darwin-arm64");

    try {
      await mkdir(resolve(outsidePackage, "bin"), { recursive: true });
      await mkdir(resolve(backendNodeModules, "@cursor"), { recursive: true });
      await writeFile(helperPath, "#!/bin/sh\nexit 0\n");
      await chmod(helperPath, 0o755);
      await symlink(outsidePackage, packageLink);

      await expect(
        distribution.assertPackagedCursorSandboxHelper({
          backendNodeModules,
          bundleRoot,
          platform: "darwin",
          arch: "arm64"
        })
      ).rejects.toThrow(/resolves outside the app bundle/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
