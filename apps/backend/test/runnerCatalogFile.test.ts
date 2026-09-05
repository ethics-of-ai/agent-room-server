import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import {
  RUNNER_CATALOG_SCHEMA_VERSION,
  resolveRunnerCatalogPath,
  serializeRunnerCatalog,
  writeRunnerCatalogFile
} from "../src/config/runnerCatalogFile";
import { registeredRunnerKinds } from "../src/runner/registry";

const config = (overrides: Partial<ServiceConfig> = {}): ServiceConfig =>
  ({
    runnerKind: "codex",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: "/tmp/workspaces",
    stateDir: "/tmp/state",
    editorCatalogDir: "/tmp/catalog-assets",
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    ...overrides
  }) as ServiceConfig;

/**
 * The offline floor in docs/engineering/RUNNERS.md
 * requires: the Mac's settings panes work with the backend stopped, and
 * `runnerKind` is a picker over runners only the backend knows.
 */
describe("offline runner catalog file", () => {
  it("carries the same safe/public projection the route serves", () => {
    const document = JSON.parse(serializeRunnerCatalog(config({ codexExecutable: "/usr/local/bin/codex" })));

    expect(document).toEqual({
      schemaVersion: RUNNER_CATALOG_SCHEMA_VERSION,
      runners: [
        { runnerKind: "codex", displayName: "Codex", registered: true, configured: true, enabled: true },
        { runnerKind: "claude_code", displayName: "Claude Code", registered: true, configured: true, enabled: true },
        { runnerKind: "deepseek", displayName: "DeepSeek Harness", registered: true, configured: false, enabled: true },
        { runnerKind: "cursor", displayName: "Cursor", registered: true, configured: true, enabled: true }
      ]
    });
  });

  it("projects no policy field and no tier-3 value", () => {
    // A file beside `settings.json` is only safe to write because it is the same
    // non-secret posture the ungated route already serves: no executable path,
    // no environment name, no Keychain slot, and nothing the backend decides
    // behavior from.
    const serialized = serializeRunnerCatalog(config({ codexExecutable: "/usr/local/bin/codex", authToken: "secret" }));

    for (const field of [
      "promptDelivery",
      "turnDiffSource",
      "workspaceSkills",
      "restoreStrategy",
      "skillSourceDirs",
      "settingsKeyPrefix",
      "settings",
      "isConfigured",
      "/usr/local/bin/codex",
      "secret",
      "CODEX_EXECUTABLE"
    ]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("reports no runtime readiness, because a stopped backend has probed nothing", () => {
    // The fourth state is what a capability discovery *proved* in a
    // running process. This file is written at startup, before anything has been
    // spawned, and is read when the backend is not running at all — so a `ready`
    // field here could only ever be a stale claim. Absent is the honest answer,
    // and it is absent by construction: the serializer passes no readiness
    // lookup, so the projection omits the field rather than defaulting it.
    expect(serializeRunnerCatalog(config())).not.toContain("ready");
  });

  it("publishes atomically beside the settings file and leaves no temp file behind", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentroom-home-"));

    await writeRunnerCatalogFile(config({ agentRoomHome: home }));

    const path = resolveRunnerCatalogPath(home);
    expect(JSON.parse(await readFile(path, "utf8")).runners).toHaveLength(registeredRunnerKinds.length);
    expect(await readdir(dirname(path))).toEqual(["runners.json"]);
  });

  it("shrugs off a write it cannot perform rather than failing startup", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentroom-home-"));
    // A file where the config *directory* belongs: the write cannot succeed, and
    // a backend that is already listening must not fall over for a cache.
    await writeFile(dirname(resolveRunnerCatalogPath(home)), "not a directory", "utf8");

    await expect(writeRunnerCatalogFile(config({ agentRoomHome: home }))).resolves.toBeUndefined();
  });
});
