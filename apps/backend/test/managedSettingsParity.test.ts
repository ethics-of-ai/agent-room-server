import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { managedSettingEnvNames, managedSettingKeys, managedSettingPath } from "../src/config/settingsStore";

const repoRoot = resolve(__dirname, "../../..");
const macOSRoot = resolve(repoRoot, "apps/macos/AgentRoomMac");
const visionOSRoot = resolve(repoRoot, "apps/visionos/AgentRoom");
// The public mirror (docs/operations/OPEN_SOURCE_MIRROR.md) ships without
// apps/visionos; the visionOS half of this parity suite runs only where it is.
const visionOSTreePresent = existsSync(visionOSRoot);
const appRoots: Array<[string, string]> = [["macOS", macOSRoot]];
if (visionOSTreePresent) appRoots.push(["visionOS", visionOSRoot]);

/**
 * Resolved by basename rather than by path. The two apps have different folder
 * taxonomies (macOS groups feature-owned logic under `Features/`, visionOS under
 * `State/`), so the mirrors legitimately sit at different paths, and hard-coding
 * both means a routine client-side file move breaks this backend suite at one of
 * two unrelated locations. Uniqueness is asserted, so a second copy is still a
 * failure — of parity, which is what this suite is about.
 */
async function readSwiftSource(root: string, fileName: string): Promise<string> {
  const matches = (await swiftSources(root)).filter((path) => path.endsWith(`/${fileName}`));

  expect(matches, `expected exactly one ${fileName} under ${root.slice(repoRoot.length + 1)}`).toHaveLength(1);
  return readFile(matches[0], "utf8");
}

async function swiftSources(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".xcassets") || entry.name === "Resources") continue;
      found.push(...(await swiftSources(path)));
    } else if (entry.name.endsWith(".swift")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The macOS app writes `$AGENTROOM_HOME/config/settings.json` directly — it has
 * to keep working while the backend is stopped — so its Swift mirror is a second
 * copy of the managed key set. A key that exists on only one side fails silently
 * in the worst way: the pane writes something the backend's strict schema then
 * rejects, dropping the *whole* file back to defaults. These assertions turn that
 * into a build failure.
 *
 * The visionOS client holds a third copy for the same reason in a different
 * shape: it edits through `PATCH /api/config`, whose body schema is `.strict()`,
 * so a key only it knows is a `400` on a control that looked editable.
 */
describe("managed settings parity", () => {
  test("the Swift key enum lists exactly the backend's managed keys", async () => {
    const source = await readSwiftSource(macOSRoot, "ManagedBackendSettingKey.swift");
    const swiftKeys = [...source.matchAll(/^\s*case\s+(\w+)\s*$/gm)].map((match) => match[1]);

    expect(swiftKeys).toEqual(managedSettingKeys);
  });

  test.skipIf(!visionOSTreePresent)("the visionOS key enum lists exactly the backend's managed keys", async () => {
    const source = await readSwiftSource(visionOSRoot, "ManagedBackendSettingKey.swift");
    const swiftKeys = [...source.matchAll(/^\s*case\s+(\w+)\s*$/gm)].map((match) => match[1]);

    expect(swiftKeys).toEqual(managedSettingKeys);
  });

  /**
   * Every managed setting has a canonical version-2 address, and both
   * apps have to know it: the Mac writes the settings file directly (its panes
   * must work while the backend is stopped, which is exactly when it cannot ask)
   * and the headset patches with it. A wrong address is a `400` on a control
   * that looked editable, or — on the Mac — a settings file the backend drops
   * whole, so the mirrors are held to the backend's own addressing.
   */
  test.each(appRoots)("the %s key enum addresses every setting where the backend does", async (_name, root) => {
    const source = await readSwiftSource(root, "ManagedBackendSettingKey.swift");
    const namespaces = [...source.matchAll(/\("(\w+)",\s*"(\w+)"\)/g)].map((match) => [match[1], match[2]]);

    expect(namespaces.length).toBeGreaterThan(0);
    for (const key of managedSettingKeys) {
      const namespace = namespaces.find(
        ([prefix]) => key.startsWith(prefix) && /^[A-Z]/.test(key.slice(prefix.length))
      );
      const field = namespace ? key.slice(namespace[0].length) : key;
      const swiftPath = namespace
        ? `runners.${namespace[1]}.${field[0].toLowerCase()}${field.slice(1)}`
        : `global.${key}`;

      expect(swiftPath, `${key} is addressed differently in ${_name}`).toBe(managedSettingPath(key));
    }
  });

  test("the Swift settings mirror declares every managed key", async () => {
    const source = await readSwiftSource(macOSRoot, "ManagedBackendSettings.swift");
    const declared = [...source.matchAll(/^\s*var\s+(\w+):\s*(?:String|Bool|Int)\?$/gm)].map((match) => match[1]);

    expect(declared).toEqual(managedSettingKeys);
  });

  test("no tier-3 key reaches the Swift mirror", async () => {
    const source = await readSwiftSource(macOSRoot, "ManagedBackendSettings.swift");

    // Secrets, executable paths, and the bind/storage class must never become a
    // settings-file field: a file cannot configure the process that has not
    // started, and `/api/config` stays non-secret only because they are absent.
    for (const key of ["authToken", "codexExecutable", "claudeCodeExecutable", "terminalShell", "port", "host", "stateDir"]) {
      expect(source).not.toMatch(new RegExp(`var\\s+${key}\\b`));
    }
  });

  /**
   * docs/engineering/RUNNERS.md moves "which runners
   * exist" off a compiled-in Swift enum and onto `GET /api/runners`. The enum
   * survives for bespoke presentation and deliberately drops `CaseIterable`, so
   * the compiler already refuses `allCases` — this scan is what catches someone
   * adding the conformance back and re-closing the list in the same change.
   */
  test("no Swift source enumerates the runner kinds", async () => {
    const offenders: string[] = [];
    for (const root of [...appRoots.map(([, path]) => path), resolve(repoRoot, "apps/shared/AgentRoomClient")]) {
      for (const path of await swiftSources(root)) {
        const source = await readFile(path, "utf8");
        if (/AgentRunnerKind\s*:\s*[^\n]*CaseIterable/.test(source) || source.includes("AgentRunnerKind.allCases")) {
          offenders.push(path.slice(repoRoot.length + 1));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the copied env example does not lock managed settings by default", async () => {
    const source = await readFile(resolve(repoRoot, ".env.example"), "utf8");
    const assignments = new Map(
      source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => [match[1], match[2]])
    );

    for (const envName of Object.values(managedSettingEnvNames)) {
      expect(assignments.get(envName), `${envName} should remain blank in .env.example`).toBe("");
    }
  });
});
