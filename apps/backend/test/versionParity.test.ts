import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * One release version covers the backend, the macOS app, and the shared client,
 * because they ship as one DMG. It is written in four places, and the release
 * workflow refuses a tag that disagrees with three of them, so a build that
 * gets as far as notarizing and then fails on a version check is the failure
 * this suite exists to prevent.
 *
 * release-please keeps the four in step: two through a JSON updater, two
 * through `x-release-please-version` annotations. An annotation that is edited
 * away stops that file bumping without any other complaint, so the markers are
 * asserted here beside the values.
 */

const repoRoot = resolve(__dirname, "../../..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function read(path: string): Promise<string> {
  return readFile(resolve(repoRoot, path), "utf8");
}

describe("release version parity", () => {
  it("declares the same version in every place the release checks", async () => {
    const [rootPackage, backendPackage, projectYaml, releaseInfo] = await Promise.all([
      read("package.json"),
      read("apps/backend/package.json"),
      read("apps/macos/project.yml"),
      read("apps/backend/src/releaseInfo.ts")
    ]);

    const project = parseYaml(projectYaml) as { settings?: Record<string, string> };
    const backendVersion = /backendVersion:\s*"([^"]+)"/.exec(releaseInfo)?.[1];

    const versions = {
      "package.json": (JSON.parse(rootPackage) as { version: string }).version,
      "apps/backend/package.json": (JSON.parse(backendPackage) as { version: string }).version,
      "apps/macos/project.yml": String(project.settings?.MARKETING_VERSION),
      "apps/backend/src/releaseInfo.ts": backendVersion
    };

    for (const [file, version] of Object.entries(versions)) {
      expect(version, `${file} declares no version`).toBeTruthy();
      expect(version, `${file} declares ${version}, which is not a semantic version`).toMatch(SEMVER);
    }
    expect(new Set(Object.values(versions)), `versions disagree: ${JSON.stringify(versions)}`).toHaveProperty("size", 1);
  });

  it("keeps the release-please annotation on the two lines it updates by comment", async () => {
    const [projectYaml, releaseInfo] = await Promise.all([
      read("apps/macos/project.yml"),
      read("apps/backend/src/releaseInfo.ts")
    ]);

    expect(projectYaml).toMatch(/^\s*MARKETING_VERSION:.*#\s*x-release-please-version\s*$/m);
    expect(releaseInfo).toMatch(/^\s*backendVersion:.*\/\/\s*x-release-please-version\s*$/m);
  });

  it("leaves the client compatibility floors off the release version", async () => {
    // `minimumVersion` answers which client this backend still talks to. It is
    // a compatibility decision, not the release number, so an annotation there
    // would quietly cut off older clients on every release.
    const releaseInfo = await read("apps/backend/src/releaseInfo.ts");
    const annotated = releaseInfo
      .split("\n")
      .filter((line) => line.includes("x-release-please"))
      .map((line) => line.trim());

    expect(annotated).toHaveLength(1);
    expect(annotated[0]).toContain("backendVersion");
  });
});
