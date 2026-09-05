import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildServer } from "../src/server";
import { getServiceConfig, toPublicConfig } from "../src/config/serviceConfig";
import {
  LEGACY_SETTINGS_SCHEMA_VERSION,
  ManagedSettingsFileError,
  SETTINGS_SCHEMA_VERSION,
  managedSettingEntry,
  managedSettingKeys,
  readManagedSettingsFile,
  resolveManagedSettingsPath,
  serializeManagedSettingsDocument,
  updateManagedSettings,
  writeManagedSettings,
  type ManagedSettingValue,
  type ManagedSettings
} from "../src/config/settingsStore";

const GLOBAL_KEY = "global";
const RUNNERS_KEY = "runners";

// Env vars the managed settings layer resolves, plus the home that locates the
// file. Cleared per test so a developer `.env` (loaded once at import time by
// config/env.ts) cannot decide the outcome.
const MANAGED_ENV_NAMES = [
  "RUNNER_KIND",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "CODEX_SERVICE_TIER",
  "CLAUDE_CODE_MODEL",
  "CLAUDE_CODE_REASONING_EFFORT",
  "ARTIFACTS_ENABLED",
  "LANGUAGE_CATALOG_ENABLED",
  "SCENE_ENGINE_ENABLED",
  "GIT_COMMAND_TIMEOUT_MS",
  "GIT_NETWORK_TIMEOUT_MS",
  "TERMINAL_ENABLED",
  "TERMINAL_MAX_SESSIONS",
  "CLAUDE_CODE_PERMISSION_MODE",
  "CLAUDE_CODE_LOAD_WORKSPACE_SKILLS",
  "CLAUDE_CODE_INHERIT_PROVIDER_AUTH",
  "CODEX_APPROVAL_POLICY",
  "CODEX_SANDBOX_MODE",
  "CODEX_WORKSPACE_NETWORK_ACCESS",
  "REMOTE_SETTINGS_ADMIN",
  "AGENTROOM_HOME",
  "WORKSPACE_ROOT",
  "STATE_DIR",
  "EDITOR_CATALOG_DIR",
  "AUTH_TOKEN"
];

describe("managed settings precedence", () => {
  it("uses the settings file when the environment does not lock the key", async () => {
    await withSettingsHome({ runnerKind: "claude_code", terminalEnabled: true }, async () => {
      const config = getServiceConfig();

      expect(config.runnerKind).toBe("claude_code");
      expect(config.terminalEnabled).toBe(true);
      expect(config.settingsMeta?.runnerKind).toBe("file");
      expect(config.settingsMeta?.terminalEnabled).toBe("file");
    });
  });

  it("lets the environment win and lock a key the file also sets", async () => {
    await withSettingsHome({ runnerKind: "claude_code", terminalEnabled: true }, async () => {
      process.env.RUNNER_KIND = "codex";
      process.env.TERMINAL_ENABLED = "false";

      const config = getServiceConfig();

      expect(config.runnerKind).toBe("codex");
      expect(config.terminalEnabled).toBe(false);
      expect(config.settingsMeta?.runnerKind).toBe("env");

      const settings = toPublicConfig(config).settings;
      expect(settings?.runnerKind).toMatchObject({ source: "env", editable: false, value: "codex" });
      expect(settings?.terminalEnabled).toMatchObject({ source: "env", editable: false, value: false });
    });
  });

  it("falls back to code defaults when neither environment nor file supplies a key", async () => {
    await withSettingsHome(undefined, async () => {
      const config = getServiceConfig();

      expect(config.runnerKind).toBe("codex");
      expect(config.terminalEnabled).toBe(false);
      expect(config.terminalMaxSessions).toBe(8);
      expect(config.codexSandboxMode).toBe("workspace-write");
      expect(config.codexWorkspaceNetworkAccess).toBe(false);
      expect(config.claudeCodePermissionMode).toBe("bypassPermissions");
      expect(config.sceneEngineEnabled).toBe(true);
      expect(config.gitCommandTimeoutMs).toBe(30_000);
      expect(config.gitNetworkTimeoutMs).toBe(120_000);
      for (const key of managedSettingKeys) {
        expect(config.settingsMeta?.[key]).toBe("default");
      }
    });
  });

  it("keeps tier-2 keys uneditable remotely until REMOTE_SETTINGS_ADMIN is on", async () => {
    await withSettingsHome(undefined, async () => {
      const locked = toPublicConfig(getServiceConfig()).settings;
      expect(locked?.runnerKind.editable).toBe(true);
      expect(locked?.terminalEnabled).toMatchObject({ tier: 2, editable: false });
      expect(locked?.claudeCodePermissionMode).toMatchObject({ tier: 2, editable: false });

      process.env.REMOTE_SETTINGS_ADMIN = "true";
      const unlocked = toPublicConfig(getServiceConfig()).settings;
      expect(unlocked?.terminalEnabled.editable).toBe(true);
      expect(unlocked?.claudeCodePermissionMode.editable).toBe(true);
      expect(toPublicConfig(getServiceConfig()).remoteSettingsAdmin).toBe(true);
    });
  });

  it("newly exposes the managed operator flags that were previously config-internal", async () => {
    await withSettingsHome(undefined, async () => {
      const publicConfig = toPublicConfig(getServiceConfig());

      // Deliberate, and the point of the change: a client cannot render or edit a
      // setting it cannot read. These three were kept out of the flat projection
      // (see serviceConfig.test.ts and README's TERMINAL_MAX_SESSIONS note) because
      // nothing needed them; they are non-secret operator preferences, and the flat
      // fields still omit them. `/api/config` remains an ungated GET, so anything
      // added here is LAN-readable — which is why tier 3 stays out by construction.
      expect(publicConfig.settings?.terminalMaxSessions.value).toBe(8);
      expect(publicConfig.settings?.artifactsEnabled.value).toBe(true);
      expect(publicConfig.settings?.languageCatalogEnabled.value).toBe(true);
      expect(publicConfig).not.toHaveProperty("terminalMaxSessions");
    });
  });

  it("never exposes a bootstrap, secret, or execution setting in the metadata", async () => {
    await withSettingsHome(undefined, async () => {
      process.env.AUTH_TOKEN = "top-secret-token";
      process.env.CODEX_EXECUTABLE = "/usr/local/bin/codex";

      const publicConfig = toPublicConfig(getServiceConfig());
      const keys = Object.keys(publicConfig.settings ?? {});

      for (const forbidden of [
        "authToken",
        "codexExecutable",
        "codexArgs",
        "codexRunnerProtocol",
        "claudeCodeExecutable",
        "terminalShell",
        "host",
        "port",
        "stateDir",
        "workspaceRoot",
        "agentRoomHome",
        "editorCatalogDir",
        "requireAuth"
      ]) {
        expect(keys).not.toContain(forbidden);
      }
      expect(JSON.stringify(publicConfig)).not.toContain("top-secret-token");
      expect(JSON.stringify(publicConfig)).not.toContain("/usr/local/bin/codex");
    });
  });
});

describe("managed settings file tolerance", () => {
  it("treats a missing file as no managed settings", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "agentroom-settings-")), "settings.json");

    const read = await readManagedSettingsFile(path);

    expect(read.settings).toEqual({});
    expect(read.issue).toBeUndefined();
  });

  it("drops a malformed or invalid file whole and reports it, without throwing", async () => {
    for (const contents of [
      "{ not json",
      JSON.stringify({ runnerKind: "copilot" }),
      JSON.stringify({ terminalMaxSessions: 100 }),
      JSON.stringify({ terminalEnabled: true, unknownKey: 1 })
    ]) {
      const path = await writeSettingsText(contents);
      const read = await readManagedSettingsFile(path);

      expect(read.settings).toEqual({});
      expect(read.issue).toBeTruthy();
    }
  });

  it("starts on code defaults when the settings file cannot be used", async () => {
    await withSettingsHome(undefined, async () => {
      const path = resolveManagedSettingsPath(process.env.AGENTROOM_HOME);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{ broken", "utf8");

      const config = getServiceConfig();

      // Fail-safe direction: every trust-posture default is the conservative one.
      expect(config.runnerKind).toBe("codex");
      expect(config.terminalEnabled).toBe(false);
      expect(config.codexWorkspaceNetworkAccess).toBe(false);
      expect(config.settingsMeta?.terminalEnabled).toBe("default");
    });
  });

  it("refuses to merge into a file it could not parse", async () => {
    const path = await writeSettingsText("{ broken");

    await expect(updateManagedSettings(path, { runnerKind: "claude_code" })).rejects.toBeInstanceOf(
      ManagedSettingsFileError
    );
    expect(await readFile(path, "utf8")).toBe("{ broken");
  });
});

/**
 * docs/engineering/RUNNERS.md: the version-2
 * document is now the one this backend applies and writes. Version 1 is still
 * read — and migrated whole by the next write that changes anything — and is
 * still what the reverse serializer emits for the deliberate rollback path,
 * because a genuinely older AgentRoom cannot be taught to read the nested shape.
 */
describe("version-2 settings document", () => {
  const versionTwoFixture = {
    schemaVersion: 2,
    global: { runnerKind: "codex", artifactsEnabled: true, terminalEnabled: false },
    runners: {
      codex: { model: "gpt-example", approvalPolicy: "never", sandboxMode: "workspace-write" },
      claude_code: { model: "claude-example", permissionMode: "bypassPermissions", loadWorkspaceSkills: true }
    }
  };

  it("applies a version-2 document, addressing each setting by its owner", async () => {
    const read = await readManagedSettingsFile(await writeSettingsText(JSON.stringify(versionTwoFixture)));

    expect(read.issue).toBeUndefined();
    expect(read.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    expect(read.settings).toEqual({
      runnerKind: "codex",
      artifactsEnabled: true,
      terminalEnabled: false,
      codexModel: "gpt-example",
      codexApprovalPolicy: "never",
      codexSandboxMode: "workspace-write",
      claudeCodeModel: "claude-example",
      claudeCodePermissionMode: "bypassPermissions",
      claudeCodeLoadWorkspaceSkills: true
    });
  });

  it("starts from a version-2 file, so the settings a runner owns still reach it", async () => {
    await withSettingsHome(undefined, async () => {
      const path = resolveManagedSettingsPath(process.env.AGENTROOM_HOME);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(versionTwoFixture), "utf8");

      const config = getServiceConfig();

      expect(config.codexModel).toBe("gpt-example");
      expect(config.claudeCodePermissionMode).toBe("bypassPermissions");
      expect(config.settingsMeta?.codexModel).toBe("file");
    });
  });

  it("migrates a version-1 file whole on the first write that changes something", async () => {
    const path = await writeSettingsText(
      JSON.stringify({ runnerKind: "claude_code", codexSandboxMode: "workspace-write", terminalEnabled: true })
    );

    const update = await updateManagedSettings(path, { codexWorkspaceNetworkAccess: true });

    // Whole-file, in one atomic write, with no prolonged dual-shape state: two
    // addresses for one setting is a precedence question nobody should have to
    // answer, so a partial migration is worse than either shape.
    expect(update.migrated).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 2,
      global: { runnerKind: "claude_code", terminalEnabled: true },
      runners: { codex: { sandboxMode: "workspace-write", workspaceNetworkAccess: true } }
    });
  });

  it("leaves a version-1 file exactly as it is when nothing changed", async () => {
    const text = `${JSON.stringify({ runnerKind: "codex" }, null, 2)}\n`;
    const path = await writeSettingsText(text);

    const update = await updateManagedSettings(path, { runnerKind: "codex" });

    // Reading settings must never rewrite the operator's file underneath them,
    // so the migration rides a real change rather than a request.
    expect(update.changedKeys).toEqual([]);
    expect(update.migrated).toBe(false);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("preserves an unregistered runner's namespace and unknown fields without applying them", async () => {
    const path = await writeSettingsText(
      JSON.stringify({
        schemaVersion: 2,
        global: { runnerKind: "codex", unknownFutureFlag: 1 },
        runners: { codex: { model: "gpt-example", futureField: 1 }, acp_demo: { executableSlot: "acp" } }
      })
    );

    const read = await readManagedSettingsFile(path);
    expect(read.issue).toBeUndefined();
    expect(read.settings.unknownFutureFlag).toBeUndefined();
    expect(read.preserved).toEqual({
      global: { unknownFutureFlag: 1 },
      runners: { codex: { futureField: 1 }, acp_demo: { executableSlot: "acp" } }
    });

    await updateManagedSettings(path, { terminalEnabled: true });

    // Forward compatibility: carried back out verbatim, never applied, and never
    // the reason an update drops what a newer release put there.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 2,
      global: { runnerKind: "codex", terminalEnabled: true, unknownFutureFlag: 1 },
      runners: { codex: { model: "gpt-example", futureField: 1 }, acp_demo: { executableSlot: "acp" } }
    });
  });

  it("preserves unknown JSON keys that collide with Object.prototype", async () => {
    const path = await writeSettingsText(
      '{"schemaVersion":2,"global":{"constructor":"future","__proto__":{"enabled":true}},'
        + '"runners":{"toString":{"model":"x"},"__proto__":{"mode":"future"}}}'
    );

    const read = await readManagedSettingsFile(path);
    expect(read.issue).toBeUndefined();
    expect(read.preserved?.global).toHaveProperty("constructor", "future");
    expect(read.preserved?.global).toHaveProperty("__proto__", { enabled: true });
    expect(read.preserved?.runners).toHaveProperty("toString", { model: "x" });
    expect(read.preserved?.runners).toHaveProperty("__proto__", { mode: "future" });

    await updateManagedSettings(path, { terminalEnabled: true });

    // Unknown namespaces and fields are JSON data, even when their names are
    // inherited by a normal JavaScript object. A known-key edit must not make
    // one disappear or mutate an object prototype.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(JSON.parse(
      '{"schemaVersion":2,"global":{"constructor":"future","__proto__":{"enabled":true},'
        + '"terminalEnabled":true},"runners":{"toString":{"model":"x"},'
        + '"__proto__":{"mode":"future"}}}'
    ));
  });

  it("does not let a version-1 file's inert section become live through the migration", async () => {
    const path = await writeSettingsText(
      JSON.stringify({
        runnerKind: "codex",
        // A version-1 document's `runners` section was never applied — the flat
        // key is what this backend resolved. Carrying a *known* address across
        // the migration would silently activate a trust value the running
        // backend had been ignoring, so only the unknown entries survive.
        runners: { codex: { sandboxMode: "danger-full-access", futureField: 1 } }
      })
    );

    expect((await readManagedSettingsFile(path)).settings.codexSandboxMode).toBeUndefined();

    await updateManagedSettings(path, { terminalEnabled: true });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 2,
      global: { runnerKind: "codex", terminalEnabled: true },
      runners: { codex: { futureField: 1 } }
    });
  });

  it("rejects a document that mixes the version-2 shape with a legacy key", async () => {
    const read = await readManagedSettingsFile(
      await writeSettingsText(JSON.stringify({ schemaVersion: 2, terminalEnabled: true, global: {} }))
    );

    // One file, exactly one schema. Assigning precedence between the two would
    // be a silent answer to a question the operator did not know they asked.
    expect(read.issue).toContain("terminalEnabled");
    expect(read.unsupportedSchemaVersion).toBeUndefined();
  });

  it("validates the version-2 paths it knows and drops the file whole on a bad one", async () => {
    for (const [document, expected] of [
      [{ schemaVersion: 2, runners: { codex: { sandboxMode: "wide-open" } } }, "runners.codex.sandboxMode"],
      [{ schemaVersion: 2, global: { runnerKind: "copilot" } }, "global.runnerKind"],
      [{ schemaVersion: 2, runners: { codex: "workspace-write" } }, "runners.codex"],
      [{ schemaVersion: 2, global: [] }, "global"],
      [{ schemaVersion: 2, unexpected: {} }, "unexpected"],
      [{ schemaVersion: "2" }, "schemaVersion"]
    ] as const) {
      const read = await readManagedSettingsFile(await writeSettingsText(JSON.stringify(document)));

      // A malformed *known* trust value is the rule that outranks forward
      // compatibility: it is a broken file, not a newer one.
      expect(read.settings).toEqual({});
      expect(read.issue).toContain(expected);
      expect(read.unsupportedSchemaVersion).toBeUndefined();
    }
  });

  it("reports a genuinely newer schema version as unsupported rather than malformed", async () => {
    const newer = await readManagedSettingsFile(await writeSettingsText(JSON.stringify({ schemaVersion: 7 })));
    const broken = await readManagedSettingsFile(await writeSettingsText("{ not json"));

    // Both are dropped whole onto the conservative defaults. What differs is the
    // repair: update AgentRoom, versus reset the file. Resetting a newer file
    // would destroy a posture the operator did author, so the two cannot be one.
    expect(newer.unsupportedSchemaVersion).toBe(7);
    expect(newer.issue).toContain("7");
    expect(broken.unsupportedSchemaVersion).toBeUndefined();
    expect(broken.issue).toBeTruthy();
  });

  it("refuses to write a schema version it cannot itself apply", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "agentroom-settings-")), "settings.json");

    await expect(
      writeManagedSettings(path, { runnerKind: "codex" }, undefined, { schemaVersion: 3 })
    ).rejects.toBeInstanceOf(ManagedSettingsFileError);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("refuses to merge into a file written for a newer schema, byte for byte", async () => {
    const text = `${JSON.stringify({ schemaVersion: 7, global: {} }, null, 2)}\n`;
    const path = await writeSettingsText(text);

    const error = await updateManagedSettings(path, { terminalEnabled: true }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ManagedSettingsFileError);
    expect((error as ManagedSettingsFileError).unsupportedSchemaVersion).toBe(7);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  describe("legacy rollback serializer", () => {
    it("converts back to the flat document a version-1 backend reads", async () => {
      const path = await writeSettingsText(JSON.stringify(versionTwoFixture));
      const read = await readManagedSettingsFile(path);

      const legacy = serializeManagedSettingsDocument(read.settings, read.preserved, {
        schemaVersion: LEGACY_SETTINGS_SCHEMA_VERSION
      });

      const document = JSON.parse(legacy);
      // No `schemaVersion` field: an absent version *is* version 1, and stamping
      // it would produce a file the older reader calls malformed — the opposite
      // of a rollback.
      expect(document).not.toHaveProperty("schemaVersion");
      expect(document).toEqual({
        runnerKind: "codex",
        artifactsEnabled: true,
        terminalEnabled: false,
        codexModel: "gpt-example",
        codexApprovalPolicy: "never",
        codexSandboxMode: "workspace-write",
        claudeCodeModel: "claude-example",
        claudeCodePermissionMode: "bypassPermissions",
        claudeCodeLoadWorkspaceSkills: true
      });
      expect(legacy.endsWith("\n")).toBe(true);
    });

    it("round-trips every setting through both shapes", async () => {
      const settings: ManagedSettings = {};
      for (const key of managedSettingKeys) {
        settings[key] = sampleValueFor(key);
      }

      const forward = await readManagedSettingsFile(
        await writeSettingsText(serializeManagedSettingsDocument(settings))
      );
      const back = await readManagedSettingsFile(
        await writeSettingsText(
          serializeManagedSettingsDocument(forward.settings, forward.preserved, {
            schemaVersion: LEGACY_SETTINGS_SCHEMA_VERSION
          })
        )
      );

      expect(forward.settings).toEqual(settings);
      expect(back.settings).toEqual(settings);
    });

    it("carries a section it cannot address through the downgrade", async () => {
      const preserved = { runners: { acp_demo: { executableSlot: "acp" } } };

      const legacy = JSON.parse(
        serializeManagedSettingsDocument({ runnerKind: "codex" }, preserved, {
          schemaVersion: LEGACY_SETTINGS_SCHEMA_VERSION
        })
      );

      // A version-1 document cannot *address* a runner namespace, but the
      // version-1 reader tolerates and preserves one, which is exactly what
      // the compatibility contract requires, making the downgrade reversible.
      expect(legacy).toEqual({ runnerKind: "codex", runners: { acp_demo: { executableSlot: "acp" } } });
    });
  });
});

describe("managed settings writes", () => {
  it("publishes atomically in a stable key order and leaves no temp file behind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentroom-settings-"));
    const path = join(directory, "nested", "settings.json");

    await writeManagedSettings(path, { terminalEnabled: true, runnerKind: "claude_code", codexSandboxMode: "read-only" });

    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 2,
      global: { runnerKind: "claude_code", terminalEnabled: true },
      runners: { codex: { sandboxMode: "read-only" } }
    });
    // Canonical: key-sorted at every level, so the same settings produce the
    // same bytes from this writer and from the macOS app's, whose encoder can
    // only promise sorted keys — and a rewrite diffs as the operator's edit.
    expect(text.indexOf("runnerKind")).toBeLessThan(text.indexOf("terminalEnabled"));
    expect(text.indexOf(`"${GLOBAL_KEY}"`)).toBeLessThan(text.indexOf(`"${RUNNERS_KEY}"`));
    expect(text.endsWith("\n")).toBe(true);
    expect(await readdir(dirname(path))).toEqual(["settings.json"]);
  });

  it("merges a patch, reports canonical key names only, and clears a key with null", async () => {
    const path = await writeSettingsText(JSON.stringify({ runnerKind: "claude_code", terminalEnabled: true }));

    const merged = await updateManagedSettings(path, { codexSandboxMode: "danger-full-access" });
    // Canonical version-2 addresses: names, never values, and the address a
    // client can act on rather than the one this backend happens to store.
    expect(merged.changedKeys).toEqual(["runners.codex.sandboxMode"]);
    expect(merged.settings).toEqual({
      runnerKind: "claude_code",
      terminalEnabled: true,
      codexSandboxMode: "danger-full-access"
    });

    const unchanged = await updateManagedSettings(path, { terminalEnabled: true });
    expect(unchanged.changedKeys).toEqual([]);

    const cleared = await updateManagedSettings(path, { terminalEnabled: null });
    expect(cleared.changedKeys).toEqual(["global.terminalEnabled"]);
    expect(cleared.settings).not.toHaveProperty("terminalEnabled");
    expect(JSON.parse(await readFile(path, "utf8")).global).not.toHaveProperty("terminalEnabled");
  });

  it("serializes concurrent updates so neither loses the other's key", async () => {
    const path = await writeSettingsText(JSON.stringify({}));

    await Promise.all([
      updateManagedSettings(path, { runnerKind: "claude_code" }),
      updateManagedSettings(path, { terminalEnabled: true }),
      updateManagedSettings(path, { terminalMaxSessions: 16 })
    ]);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      schemaVersion: 2,
      global: { runnerKind: "claude_code", terminalEnabled: true, terminalMaxSessions: 16 }
    });
  });
});

describe("managed settings pending state", () => {
  it("reports the value a restart would produce when the file has moved on", async () => {
    await withSettingsHome({ runnerKind: "codex" }, async () => {
      const config = getServiceConfig();
      const path = config.managedSettingsPath!;

      await updateManagedSettings(path, { runnerKind: "claude_code", terminalEnabled: true });
      const onDisk = (await readManagedSettingsFile(path)).settings;
      const settings = toPublicConfig(config, onDisk).settings;

      expect(settings?.runnerKind).toMatchObject({ value: "codex", pendingValue: "claude_code" });
      expect(settings?.terminalEnabled).toMatchObject({ value: false, pendingValue: true });
      // Untouched keys are not pending.
      expect(settings?.codexSandboxMode.pendingValue).toBeUndefined();
    });
  });

  it("reports a cleared key as pending back to its default, and null when it has none", async () => {
    await withSettingsHome({ terminalEnabled: true, codexModel: "gpt-5-codex" }, async () => {
      const config = getServiceConfig();
      const path = config.managedSettingsPath!;

      await updateManagedSettings(path, { terminalEnabled: null, codexModel: null });
      const onDisk = (await readManagedSettingsFile(path)).settings;
      const settings = toPublicConfig(config, onDisk).settings;

      expect(settings?.terminalEnabled).toMatchObject({ value: true, pendingValue: false });
      // No code default, so a restart leaves it unset — reported as an explicit null.
      expect(settings?.codexModel.value).toBe("gpt-5-codex");
      expect(settings?.codexModel.pendingValue).toBeNull();
    });
  });

  it("never reports pending state for an environment-locked key", async () => {
    await withSettingsHome(undefined, async () => {
      process.env.TERMINAL_ENABLED = "false";
      const config = getServiceConfig();

      const settings = toPublicConfig(config, { terminalEnabled: true }).settings;

      // The file value is inert while the environment locks the key: not pending, dead.
      expect(settings?.terminalEnabled).toMatchObject({ source: "env", value: false });
      expect(settings?.terminalEnabled.pendingValue).toBeUndefined();
    });
  });

  it("serves the metadata from GET /api/config and re-reads the file per request", async () => {
    await withSettingsHome({ runnerKind: "codex" }, async () => {
      const config = getServiceConfig();
      const { app } = await buildServer({ config });
      try {
        const before = await app.inject({ method: "GET", url: "/api/config" });
        expect(before.statusCode).toBe(200);
        const beforeBody = before.json();
        expect(beforeBody.runnerKind).toBe("codex");
        expect(beforeBody.remoteSettingsAdmin).toBe(false);
        expect(beforeBody.settings.runnerKind).toMatchObject({
          value: "codex",
          source: "file",
          tier: 1,
          editable: true,
          requiresRestart: true
        });
        expect(beforeBody.settings.runnerKind.pendingValue).toBeUndefined();

        await updateManagedSettings(config.managedSettingsPath!, { runnerKind: "claude_code" });

        const after = await app.inject({ method: "GET", url: "/api/config" });
        expect(after.json().runnerKind).toBe("codex");
        expect(after.json().settings.runnerKind.pendingValue).toBe("claude_code");
      } finally {
        await app.close();
      }
    });
  });

  it("omits pending state entirely when the file on disk cannot be read", async () => {
    await withSettingsHome({ runnerKind: "claude_code" }, async () => {
      const config = getServiceConfig();
      const { app } = await buildServer({ config });
      try {
        await writeFile(config.managedSettingsPath!, "{ broken", "utf8");

        const response = await app.inject({ method: "GET", url: "/api/config" });
        const settings = response.json().settings;

        expect(response.json().runnerKind).toBe("claude_code");
        for (const key of managedSettingKeys) {
          expect(settings[key].pendingValue).toBeUndefined();
        }
      } finally {
        await app.close();
      }
    });
  });
});

async function writeSettingsText(contents: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "agentroom-settings-")), "settings.json");
  await writeFile(path, contents, "utf8");
  return path;
}

async function withSettingsHome(settings: ManagedSettings | undefined, run: () => Promise<void>): Promise<void> {
  const previous = new Map(MANAGED_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_ENV_NAMES) {
    delete process.env[name];
  }
  const home = await mkdtemp(join(tmpdir(), "agentroom-home-"));
  process.env.AGENTROOM_HOME = home;
  if (settings) {
    await writeManagedSettings(resolveManagedSettingsPath(home), settings);
  }
  try {
    await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/**
 * The first value a setting's own schema accepts, so a round-trip covers every
 * declared setting — including one a runner registers later — without a table in
 * this file that would have to be remembered.
 */
function sampleValueFor(key: string): ManagedSettingValue {
  const definition = managedSettingEntry(key)?.definition;
  const candidates: ManagedSettingValue[] = [
    true,
    42,
    "claude_code",
    "high",
    "never",
    "danger-full-access",
    "acceptEdits",
    "gpt-example",
    "fast"
  ];
  const accepted = candidates.find((candidate) => definition?.schema.safeParse(candidate).success);
  if (accepted === undefined) throw new Error(`no sample value for managed setting ${key}`);
  return accepted;
}
