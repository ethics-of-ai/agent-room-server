import { mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_PROVIDER,
  deepseekChildEnv,
  deepseekCommandAudit,
  deepseekContentBlocks,
  deepseekInitializeParams,
  effectiveDeepSeekSettings
} from "../src/runner/deepseek/settings";

const config = (overrides: Partial<ServiceConfig> = {}): ServiceConfig =>
  ({
    runnerKind: "deepseek",
    host: "0.0.0.0",
    port: 8787,
    workspaceRoot: "/tmp/workspaces",
    stateDir: "/tmp/state",
    editorCatalogDir: "/tmp/catalog-assets",
    requireAuth: false,
    gitCommandTimeoutMs: 30_000,
    codexArgs: [],
    deepseekArgs: [],
    ...overrides
  }) as ServiceConfig;

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("DeepSeek Harness effective settings", () => {
  it("lets a turn select the model and falls back to the configured default", () => {
    expect(effectiveDeepSeekSettings(config({ deepseekModel: "deepseek-v4-flash" }), undefined).model)
      .toBe("deepseek-v4-flash");
    expect(
      effectiveDeepSeekSettings(config({ deepseekModel: "deepseek-v4-flash" }), { model: "deepseek-v4-pro" }).model
    ).toBe("deepseek-v4-pro");
  });

  it("defaults the provider to the route the runtime mounts on its own", () => {
    expect(effectiveDeepSeekSettings(config(), undefined).provider).toBe(DEFAULT_DEEPSEEK_PROVIDER);
    expect(effectiveDeepSeekSettings(config({ deepseekProvider: "local" }), undefined).provider).toBe("local");
  });

  it("carries maxTokens only when the operator set one", () => {
    expect(effectiveDeepSeekSettings(config(), undefined).maxTokens).toBeUndefined();
    expect(effectiveDeepSeekSettings(config({ deepseekMaxTokens: 49_152 }), undefined).maxTokens).toBe(49_152);
  });
});

describe("DeepSeek Harness initialize parameters", () => {
  it("hands the runtime the registered workspace as its cwd", () => {
    const params = deepseekInitializeParams(
      "/Users/me/repos/app",
      effectiveDeepSeekSettings(config({ deepseekModel: "deepseek-v4-pro" }), undefined)
    );

    expect(params).toEqual({
      cwd: "/Users/me/repos/app",
      provider: DEFAULT_DEEPSEEK_PROVIDER,
      model: "deepseek-v4-pro"
    });
  });

  it("falls back to the model the capabilities read advertises, not the composition's own", () => {
    // `model` is required by the protocol, and the catalog already reports this
    // id as `defaultSettings.model`. Refusing here would refuse the very default
    // the same response advertised — and would make runtime readiness
    // unprovable until the operator guessed a model, from the one read whose job
    // is to tell them which models exist.
    const params = deepseekInitializeParams("/tmp/ws", effectiveDeepSeekSettings(config(), undefined));

    expect(params).toMatchObject({ model: DEFAULT_DEEPSEEK_MODEL });
  });

  it("prefers the turn's selection, then the operator's default, then the catalog's", () => {
    expect(effectiveDeepSeekSettings(config(), undefined).model).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(effectiveDeepSeekSettings(config({ deepseekModel: "deepseek-v4-pro" }), undefined).model)
      .toBe("deepseek-v4-pro");
    expect(effectiveDeepSeekSettings(config({ deepseekModel: "deepseek-v4-pro" }), { model: "custom" }).model)
      .toBe("custom");
  });
});

describe("DeepSeek Harness child environment", () => {
  it("scrubs AgentRoom's own bearer token", () => {
    // AUTH_TOKEN is the API's transport secret, not a provider credential, so it
    // reaches no child — including the sub-agents `dsh` can start.
    process.env.AUTH_TOKEN = "agentroom-secret";
    expect(deepseekChildEnv(config(), "/Users/me/repos/app").AUTH_TOKEN).toBeUndefined();
  });

  it("inherits the rest of the environment so the runtime finds its own credentials", () => {
    process.env.DEEPSEEK_API_KEY = "provider-key";
    expect(deepseekChildEnv(config(), "/Users/me/repos/app").DEEPSEEK_API_KEY).toBe("provider-key");
  });

  it("passes the managed approval posture as the harness's own DSH_PERMISSION_MODE", () => {
    // The SDK wire has no parameter for it, so the harness's own environment
    // variable is the sanctioned channel — and the managed value wins over an
    // exported one, so the posture /api/config reports is the one the child gets.
    process.env.DSH_PERMISSION_MODE = "exported";
    expect(deepseekChildEnv(config({ deepseekPermissionMode: "read-only" }), "/Users/me/repos/app").DSH_PERMISSION_MODE)
      .toBe("read-only");
    expect(deepseekChildEnv(config(), "/Users/me/repos/app").DSH_PERMISSION_MODE).toBe("exported");
  });

  it("drops the retired composition variable, which the launcher no longer reads", () => {
    // The composition travels as a `--patch` argument. An exported value is
    // removed so nothing downstream mistakes it for the mounted graph.
    const previous = process.env.DSH_CORDIS_CONFIG;
    process.env.DSH_CORDIS_CONFIG = "/etc/dsh/cordis.yml";
    try {
      expect(deepseekChildEnv(config({ deepseekCordisConfig: "/etc/dsh/cordis.yml" }), "/ws").DSH_CORDIS_CONFIG)
        .toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DSH_CORDIS_CONFIG;
      else process.env.DSH_CORDIS_CONFIG = previous;
    }
  });

  it("pins the agent workspace so a composition cannot bind its tools elsewhere", () => {
    // The child's own cwd is the backend-owned Harness home, so this value and
    // the `initialize` cwd are how the graph learns the workspace. A config
    // layer that reads the variable cannot relocate the bash and filesystem
    // tools, the same reflex as the Codex network pin.
    process.env.DSH_CWD = "/somewhere/else";
    expect(deepseekChildEnv(config(), "/Users/me/repos/app").DSH_CWD).toBe("/Users/me/repos/app");
  });

  it("pins the session log under STATE_DIR, never the registered workspace", () => {
    // An operator composition may resolve persistence relative to the
    // workspace. Unpinned, the harness would dirty the working tree it is
    // being asked to work in.
    process.env.DSH_SESSION_ROOT = "./.sessions";
    const env = deepseekChildEnv(config({ stateDir: "/var/agentroom" }), "/Users/me/repos/app");

    expect(env.DSH_SESSION_ROOT).toBe("/var/agentroom/deepseek/sessions-v2/custom");
    expect(env.DSH_SESSION_ROOT?.startsWith("/Users/me/repos/app")).toBe(false);
  });

  it("gives managed and custom setup separate roots, apart from the earlier one", () => {
    // A custom patch may keep upstream's zstd default while managed setup
    // writes plain JSONL, and the store refuses a root holding both. The
    // earlier root already mixes them, so neither mode may use it.
    const managed = deepseekChildEnv(config({ stateDir: "/var/agentroom", deepseekCompositionMode: "managed" }), "/w");
    const custom = deepseekChildEnv(config({ stateDir: "/var/agentroom", deepseekCompositionMode: "custom" }), "/w");

    expect(managed.DSH_SESSION_ROOT).toBe("/var/agentroom/deepseek/sessions-v2/managed");
    expect(custom.DSH_SESSION_ROOT).toBe("/var/agentroom/deepseek/sessions-v2/custom");
  });

  it("gives each custom patch its own root, named by the patch contents", async () => {
    // Two custom patches may choose different encodings, and so may one patch
    // edited in place, so neither may share a root with the other.
    const dir = await mkdtemp(join(tmpdir(), "agentroom-dsh-patch-"));
    const zstd = join(dir, "zstd.patch.yml");
    const plain = join(dir, "plain.patch.yml");
    await writeFile(zstd, "- insert: []\n");
    await writeFile(plain, "- insert: []\n# compression: none\n");
    const root = (cordis: string) =>
      deepseekChildEnv(config({ stateDir: "/var/agentroom", deepseekCordisConfig: cordis }), "/w").DSH_SESSION_ROOT;

    const first = root(zstd);
    expect(first).toMatch(/^\/var\/agentroom\/deepseek\/sessions-v2\/custom\/[0-9a-f]{16}$/);
    expect(root(plain)).not.toBe(first);
    expect(root(zstd)).toBe(first);
    await writeFile(zstd, "- insert: []\n# compression: none\n");
    expect(root(zstd)).toBe(root(plain));
  });

  it("resolves a relative STATE_DIR before handing it to the workspace child", () => {
    const env = deepseekChildEnv(config({ stateDir: ".agentroom/state" }), "/Users/me/repos/app");

    expect(env.DSH_SESSION_ROOT).toBe(resolve(".agentroom/state/deepseek/sessions-v2/custom"));
    expect(isAbsolute(env.DSH_SESSION_ROOT as string)).toBe(true);
    expect(env.DSH_SESSION_ROOT?.startsWith("/Users/me/repos/app")).toBe(false);
  });
});

describe("DeepSeek Harness prompt content", () => {
  it("puts the prompt text first and inlines attachments as image blocks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentroom-deepseek-attachment-"));
    const imagePath = join(root, "shot.png");
    await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));

    const blocks = await deepseekContentBlocks("Explain this", [
      { type: "localImage", path: imagePath, contentType: "image/png" }
    ]);

    expect(blocks).toEqual([
      { type: "text", text: "Explain this" },
      { type: "image", mimeType: "image/png", data: Buffer.from([1, 2, 3, 4]).toString("base64") }
    ]);
  });
});

describe("DeepSeek Harness command audit", () => {
  it("records the executable name and argument count, never the arguments", () => {
    // The audit line is durable; DEEPSEEK_ARGS is operator configuration and can
    // name a path that has no business in a log.
    expect(
      deepseekCommandAudit(
        config({ deepseekExecutable: "/opt/homebrew/bin/dsh", deepseekArgs: ["--verbose", "2"] })
      )
    ).toEqual({ executableName: "dsh", argsCount: 2 });
  });
});
