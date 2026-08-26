import { describe, expect, it } from "vitest";
import { releaseCompatibility } from "../src/releaseInfo";
import { buildReleaseManifest, releaseManifestSchema } from "../src/releaseManifest";

describe("release compatibility manifest", () => {
  const version = releaseCompatibility.backendVersion;

  it("derives compatibility from the same value exposed by health", () => {
    const manifest = buildReleaseManifest({
      releaseTag: `v${version}`,
      dmgName: `AgentRoom-${version}-arm64.dmg`,
      architecture: "arm64"
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      ...releaseCompatibility,
      macArtifact: {
        name: `AgentRoom-${version}-arm64.dmg`,
        architecture: "arm64"
      }
    });
    expect(releaseManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("refuses a tag that disagrees with the backend version", () => {
    expect(() => buildReleaseManifest({
      releaseTag: "v99.0.0",
      dmgName: `AgentRoom-${version}-arm64.dmg`,
      architecture: "arm64"
    })).toThrow(/does not match backend/);
  });

  it("accepts a prerelease suffix over the matching backend marketing version", () => {
    const prereleaseVersion = `${version}-rc.1`;
    const manifest = buildReleaseManifest({
      releaseTag: `v${prereleaseVersion}`,
      dmgName: `AgentRoom-${prereleaseVersion}-arm64.dmg`,
      architecture: "arm64"
    });

    expect(manifest.backendVersion).toBe(version);
    expect(manifest.macArtifact.name).toBe(`AgentRoom-${prereleaseVersion}-arm64.dmg`);
  });

  it("refuses a prerelease whose marketing base disagrees with the backend", () => {
    expect(() => buildReleaseManifest({
      releaseTag: "v99.0.0-rc.1",
      dmgName: "AgentRoom-99.0.0-rc.1-arm64.dmg",
      architecture: "arm64"
    })).toThrow(/does not match backend/);
  });

  it("refuses an artifact name that disagrees with the release", () => {
    expect(() => buildReleaseManifest({
      releaseTag: `v${version}`,
      dmgName: "AgentRoom-wrong-arm64.dmg",
      architecture: "arm64"
    })).toThrow(/does not match expected/);
  });

  it("keeps the checked schema closed and versioned", () => {
    const manifest = buildReleaseManifest({
      releaseTag: `v${version}`,
      dmgName: `AgentRoom-${version}-arm64.dmg`,
      architecture: "arm64"
    });

    expect(() => releaseManifestSchema.parse({ ...manifest, schemaVersion: 2 })).toThrow();
    expect(() => releaseManifestSchema.parse({ ...manifest, downloadURL: "https://example.test" })).toThrow();
  });
});
