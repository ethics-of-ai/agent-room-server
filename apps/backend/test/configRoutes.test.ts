import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { getServiceConfig } from "../src/config/serviceConfig";
import {
  resolveManagedSettingsPath,
  writeManagedSettings,
  type ManagedSettings
} from "../src/config/settingsStore";
import type { ServiceConfig } from "../src/domain/models";

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

describe("PATCH /api/config authorization", () => {
  it("requires the bearer token when AUTH_TOKEN is configured", async () => {
    await withSettingsHome(undefined, async () => {
      process.env.AUTH_TOKEN = "agentroom-secret";
      await withServer(async (app, config) => {
        const anonymous = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "claude_code" }
        });
        expect(anonymous.statusCode).toBe(401);
        // The global preHandler runs before the handler, so nothing was written.
        expect(await settingsFileText(config)).toBeUndefined();

        const authorized = await app.inject({
          method: "PATCH",
          url: "/api/config",
          headers: { authorization: "Bearer agentroom-secret" },
          payload: { runnerKind: "claude_code" }
        });
        expect(authorized.statusCode).toBe(200);
        expect(JSON.parse((await settingsFileText(config))!)).toEqual({
          schemaVersion: 2,
          global: { runnerKind: "claude_code" }
        });
      });
    });
  });

  it("refuses a tier-2 key with 403 until REMOTE_SETTINGS_ADMIN is on", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app, config) => {
        const refused = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { terminalEnabled: true, codexSandboxMode: "danger-full-access" }
        });

        expect(refused.statusCode).toBe(403);
        expect(refused.json().restrictedKeys).toEqual(["global.terminalEnabled", "runners.codex.sandboxMode"]);
        expect(await settingsFileText(config)).toBeUndefined();
      });

      // The master switch is env-injected by the Mac app precisely so a bearer
      // token cannot grant it to itself; flipping it is the operator's decision.
      process.env.REMOTE_SETTINGS_ADMIN = "true";
      await withServer(async (app, config) => {
        const allowed = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { terminalEnabled: true }
        });

        expect(allowed.statusCode).toBe(200);
        expect(allowed.json().settings.terminalEnabled).toMatchObject({
          tier: 2,
          editable: true,
          value: false,
          pendingValue: true
        });
        expect(JSON.parse((await settingsFileText(config))!)).toEqual({
          schemaVersion: 2,
          global: { terminalEnabled: true }
        });
      });
    });
  });

  it("accepts a tier-1 key while the tier-2 gate is closed", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app) => {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "claude_code", codexModel: "gpt-5-codex" }
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().remoteSettingsAdmin).toBe(false);
      });
    });
  });

  it("refuses an environment-locked key with 409 and names it", async () => {
    await withSettingsHome({ codexModel: "gpt-5-codex" }, async () => {
      process.env.RUNNER_KIND = "codex";
      await withServer(async (app, config) => {
        const before = await settingsFileText(config);

        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "claude_code", codexModel: "gpt-5.1-codex-max" }
        });

        expect(response.statusCode).toBe(409);
        expect(response.json().lockedKeys).toEqual(["global.runnerKind"]);
        // All-or-nothing: the unlocked key in the same body is not written either.
        expect(await settingsFileText(config)).toBe(before);
      });
    });
  });

  it("answers the tier-2 gate before the environment lock when both apply", async () => {
    await withSettingsHome(undefined, async () => {
      process.env.TERMINAL_ENABLED = "false";
      await withServer(async (app) => {
        const gated = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { terminalEnabled: true }
        });
        // "You may not change trust settings from here" is the more actionable
        // answer than "this key is locked", so authorization is checked first.
        expect(gated.statusCode).toBe(403);
      });

      process.env.REMOTE_SETTINGS_ADMIN = "true";
      await withServer(async (app) => {
        const locked = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { terminalEnabled: true }
        });
        expect(locked.statusCode).toBe(409);
        expect(locked.json().lockedKeys).toEqual(["global.terminalEnabled"]);
      });
    });
  });
});

describe("PATCH /api/config payload validation", () => {
  it("rejects an unknown key rather than ignoring it", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app, config) => {
        for (const payload of [
          { runnerKindd: "codex" },
          { runnerKind: "claude_code", extra: true },
          {}
        ]) {
          const response = await app.inject({ method: "PATCH", url: "/api/config", payload });
          expect(response.statusCode).toBe(Object.keys(payload).length === 0 ? 200 : 400);
        }
        // Nothing in the rejected bodies reached the file; the empty patch is a
        // no-op, so it writes nothing either.
        expect(await settingsFileText(config)).toBeUndefined();
      });
    });
  });

  it("rejects a tier-3 bootstrap, secret, or execution key", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app) => {
        for (const payload of [
          { authToken: "stolen" },
          { codexExecutable: "/tmp/evil" },
          { claudeCodeExecutable: "/tmp/evil" },
          { terminalShell: "/tmp/evil" },
          { port: 9999 },
          { stateDir: "/tmp/elsewhere" }
        ]) {
          const response = await app.inject({ method: "PATCH", url: "/api/config", payload });
          // Tier 3 has no entry in the patch schema by construction, so asking
          // for one is indistinguishable from a typo and is refused the same way.
          expect(response.statusCode).toBe(400);
        }
      });
    });
  });

  it("rejects a value the managed schema bounds out", async () => {
    await withSettingsHome(undefined, async () => {
      process.env.REMOTE_SETTINGS_ADMIN = "true";
      await withServer(async (app) => {
        for (const payload of [
          { terminalMaxSessions: 100 },
          { terminalMaxSessions: 0 },
          { runnerKind: "copilot" },
          { claudeCodePermissionMode: "yolo" },
          { codexModel: "model; rm -rf /" },
          { gitCommandTimeoutMs: -1 },
          { terminalEnabled: "true" }
        ]) {
          const response = await app.inject({ method: "PATCH", url: "/api/config", payload });
          expect(response.statusCode).toBe(400);
        }
      });
    });
  });
});

describe("PATCH /api/config write behavior", () => {
  it("merges into the existing file and clears a key with null", async () => {
    await withSettingsHome({ runnerKind: "claude_code", codexModel: "gpt-5-codex" }, async () => {
      await withServer(async (app, config) => {
        const merged = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { codexReasoningEffort: "high" }
        });
        expect(merged.statusCode).toBe(200);
        expect(JSON.parse((await settingsFileText(config))!)).toEqual({
          schemaVersion: 2,
          global: { runnerKind: "claude_code" },
          runners: { codex: { model: "gpt-5-codex", reasoningEffort: "high" } }
        });

        const cleared = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { codexModel: null }
        });
        expect(cleared.statusCode).toBe(200);
        expect(JSON.parse((await settingsFileText(config))!).runners.codex).not.toHaveProperty("model");
        // No code default, so a restart leaves it unset: an explicit null.
        expect(cleared.json().settings.codexModel.pendingValue).toBeNull();
      });
    });
  });

  it("returns the refreshed projection with running values and pending state", async () => {
    await withSettingsHome({ runnerKind: "codex" }, async () => {
      await withServer(async (app) => {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "claude_code" }
        });

        // The flat fields keep their meaning: what this process is running with.
        expect(response.json().runnerKind).toBe("codex");
        expect(response.json().settings.runnerKind).toMatchObject({
          value: "codex",
          pendingValue: "claude_code",
          source: "file",
          tier: 1,
          editable: true,
          requiresRestart: true
        });

        // And a follow-up GET agrees, since both read the same bytes.
        const read = await app.inject({ method: "GET", url: "/api/config" });
        expect(read.json().settings.runnerKind.pendingValue).toBe("claude_code");
      });
    });
  });

  it("refuses to merge into a file it could not parse, leaving the bytes alone", async () => {
    await withSettingsHome({ runnerKind: "claude_code" }, async () => {
      await withServer(async (app, config) => {
        await writeFile(config.managedSettingsPath!, "{ broken", "utf8");

        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "codex" }
        });

        // Merging would silently drop the operator's other keys.
        expect(response.statusCode).toBe(409);
        expect(await settingsFileText(config)).toBe("{ broken");
      });
    });
  });

  it("refuses a file written for a newer settings schema, and says which", async () => {
    await withSettingsHome({ runnerKind: "claude_code" }, async () => {
      await withServer(async (app, config) => {
        const text = JSON.stringify({ schemaVersion: 7, global: { runnerKind: "codex" } });
        await writeFile(config.managedSettingsPath!, text, "utf8");

        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "codex" }
        });

        // Same refusal as a broken file, different sentence. This file is not
        // damaged, so "reset it" is the wrong advice — a reset would destroy a
        // posture the operator authored on a newer AgentRoom.
        expect(response.statusCode).toBe(409);
        expect(response.json().settingsSchemaVersion).toBe(7);
        expect(response.json().error).toContain("Update AgentRoom");
        expect(await settingsFileText(config)).toBe(text);
      });
    });
  });

  it("answers 503 when the backend resolved no managed settings path", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-config-routes-"));
    const config: ServiceConfig = {
      runnerKind: "codex",
      host: "0.0.0.0",
      port: 8787,
      workspaceRoot: join(root, "workspaces"),
      stateDir: join(root, "state"),
      editorCatalogDir: join(root, "catalog-assets"),
      requireAuth: false,
      gitCommandTimeoutMs: 30_000,
      codexArgs: []
    };
    const { app } = await buildServer({ config });
    try {
      const patched = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: { runnerKind: "claude_code" }
      });
      expect(patched.statusCode).toBe(503);
      // The read still works; it just reports no pending state.
      expect((await app.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

/**
 * docs/engineering/RUNNERS.md defines the canonical
 * address of a managed setting to its version-2 path, and keeps the version-1
 * flat key working for the declared compatibility window. Both are served and
 * both are accepted, because a headset and a backend upgrade independently —
 * the same dual-emission the canonical event contract already uses.
 */
describe("PATCH /api/config addressing", () => {
  it("accepts either address form for the same setting", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app, config) => {
        const byPath = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { "runners.codex.model": "gpt-5-codex" }
        });
        expect(byPath.statusCode).toBe(200);

        const byLegacyKey = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { claudeCodeModel: "claude-fable-5" }
        });
        expect(byLegacyKey.statusCode).toBe(200);

        expect(JSON.parse((await settingsFileText(config))!)).toEqual({
          schemaVersion: 2,
          runners: { codex: { model: "gpt-5-codex" }, claude_code: { model: "claude-fable-5" } }
        });
      });
    });
  });

  it("refuses a body that names one setting at both addresses", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app, config) => {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { codexModel: "gpt-5-codex", "runners.codex.model": "gpt-5.1-codex-max" }
        });

        // Assigning precedence would silently apply a value the caller did not
        // send, so the ambiguity is answered by refusing it.
        expect(response.statusCode).toBe(400);
        expect(response.json().duplicatedKeys).toEqual(["runners.codex.model"]);
        expect(await settingsFileText(config)).toBeUndefined();
      });
    });
  });

  it("reports every setting at both addresses, and says which is canonical", async () => {
    await withSettingsHome({ codexSandboxMode: "danger-full-access" }, async () => {
      await withServer(async (app) => {
        const body = (await app.inject({ method: "GET", url: "/api/config" })).json();

        expect(body.settingsSchemaVersion).toBe(2);
        expect(body.settings["runners.codex.sandboxMode"]).toMatchObject({
          value: "danger-full-access",
          source: "file",
          tier: 2
        });
        // The legacy alias reports the identical entry, so a client that predates
        // the paths keeps working against a backend that has moved on.
        expect(body.settings.codexSandboxMode).toEqual(body.settings["runners.codex.sandboxMode"]);
      });
    });
  });

  /**
   * docs/engineering/RUNNERS.md requires this. A runner the
   * backend registers can bring a setting no client was built with, so the block
   * has to say enough about a key for a client to draw a control from the
   * metadata alone. Value *kind* is that minimum, and it is reported even for a
   * key with no value — which is the case a client could infer nothing from.
   */
  it("reports each setting's value kind, including one that is unset", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app) => {
        const settings = (await app.inject({ method: "GET", url: "/api/config" })).json().settings;

        expect(settings["global.terminalEnabled"].valueKind).toBe("boolean");
        expect(settings["global.terminalMaxSessions"].valueKind).toBe("number");
        // No code default, so nothing is running with it — and the shape is
        // still the answer a control needs.
        expect(settings["runners.codex.model"]).not.toHaveProperty("value");
        expect(settings["runners.codex.model"].valueKind).toBe("string");
      });
    });
  });

  it("reports a closed vocabulary and omits one for an open value", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app) => {
        const settings = (await app.inject({ method: "GET", url: "/api/config" })).json().settings;

        // Without this a client with no catalog entry would offer free text for
        // a key whose PATCH refuses everything but these four.
        expect(settings["runners.codex.sandboxMode"].options)
          .toEqual(["read-only", "workspace-write", "danger-full-access"]);
        expect(settings["runners.claude_code.permissionMode"].options)
          .toEqual(["default", "acceptEdits", "dontAsk", "bypassPermissions"]);

        // Open values carry none: the backend's schema stays the authority for
        // what is too long or too large, and inventing a list would be worse
        // than none.
        expect(settings["runners.codex.model"]).not.toHaveProperty("options");
        expect(settings["global.gitCommandTimeoutMs"]).not.toHaveProperty("options");
        expect(settings["global.terminalEnabled"]).not.toHaveProperty("options");
        // `runnerKind`'s vocabulary is the live registry's, and a client reads it
        // from GET /api/runners; restating it here would be a second, stale
        // admission list.
        expect(settings["global.runnerKind"]).not.toHaveProperty("options");
      });
    });
  });

  /**
   * The drift this pair of fields could introduce, closed at its source: an
   * option the block advertises but the patch refuses is a control that looks
   * editable and is not, which is the exact failure generic metadata prevents.
   */
  it("advertises only values PATCH accepts, at the kind it reports", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app) => {
        const settings = (await app.inject({ method: "GET", url: "/api/config" })).json().settings;

        for (const [address, setting] of Object.entries(settings) as [string, {
          valueKind: string;
          options?: unknown[];
          value?: unknown;
        }][]) {
          if (setting.value !== undefined) {
            expect(typeof setting.value, `${address} runs with a value of another kind`)
              .toBe(setting.valueKind);
          }
          for (const option of setting.options ?? []) {
            expect(typeof option, `${address} offers an option of another kind`)
              .toBe(setting.valueKind);
            const applied = await app.inject({
              method: "PATCH",
              url: "/api/config",
              payload: { [address]: option }
            });
            // 200 applied it; 403 is the tier-2 gate, which is about *who is
            // asking* rather than about the value — both mean the schema took it.
            expect([200, 403], `${address} advertises ${String(option)} but PATCH refuses it`)
              .toContain(applied.statusCode);
          }
        }
      });
    });
  });
});

describe("config_reloaded event", () => {
  it("publishes changed key names only, and audits them", async () => {
    await withSettingsHome(undefined, async () => {
      await withServer(async (app) => {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "claude_code", codexModel: "gpt-5-codex" }
        });
        expect(response.statusCode).toBe(200);

        const logs = await app.inject({ method: "GET", url: "/api/logs" });
        const event = logs
          .json()
          .events.find((candidate: { type: string }) => candidate.type === "config_reloaded");

        expect(event.payload).toMatchObject({
          changedKeys: ["global.runnerKind", "runners.codex.model"],
          requiresRestart: true
        });
        // Names, never values: a value here would put the operator's posture on
        // the wire for every WS subscriber.
        expect(JSON.stringify(event)).not.toContain("gpt-5-codex");
        expect(JSON.stringify(event)).not.toContain("claude_code");

        const audit = await app.inject({ method: "GET", url: "/api/audit" });
        expect(audit.json().events).toContainEqual(
          expect.objectContaining({
            type: "config_reloaded",
            audit: { changedKeys: ["global.runnerKind", "runners.codex.model"] }
          })
        );
      });
    });
  });

  it("publishes nothing when the patch changes no key", async () => {
    await withSettingsHome({ runnerKind: "claude_code" }, async () => {
      await withServer(async (app) => {
        const response = await app.inject({
          method: "PATCH",
          url: "/api/config",
          payload: { runnerKind: "claude_code" }
        });

        expect(response.statusCode).toBe(200);
        const logs = await app.inject({ method: "GET", url: "/api/logs" });
        expect(logs.json().events.map((event: { type: string }) => event.type)).not.toContain("config_reloaded");
      });
    });
  });
});

async function settingsFileText(config: ServiceConfig): Promise<string | undefined> {
  try {
    return await readFile(config.managedSettingsPath!, "utf8");
  } catch {
    return undefined;
  }
}

async function withServer(run: (app: FastifyInstance, config: ServiceConfig) => Promise<void>): Promise<void> {
  const config = getServiceConfig();
  const { app } = await buildServer({ config });
  try {
    await run(app, config);
  } finally {
    await app.close();
  }
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
