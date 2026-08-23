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

  it("hands the runtime the composition it refuses to start without", () => {
    // `$DSH_CORDIS_CONFIG` outranks the argv positional, so pinning it here
    // leaves DEEPSEEK_ARGS free and cannot be crowded out by a non-empty argv.
    expect(deepseekChildEnv(config({ deepseekCordisConfig: "/etc/dsh/cordis.yml" }), "/ws").DSH_CORDIS_CONFIG)
      .toBe("/etc/dsh/cordis.yml");
  });

  it("pins the agent workspace so a composition cannot bind its tools elsewhere", () => {
    // The child's own cwd is already the registered workspace, so this agrees
    // with the stock `process.env.DSH_CWD ?? process.cwd()` fallback. Stating it
    // is the point: a config layer that reads the variable cannot relocate the
    // bash and filesystem tools, the same reflex as the Codex network pin.
    process.env.DSH_CWD = "/somewhere/else";
    expect(deepseekChildEnv(config(), "/Users/me/repos/app").DSH_CWD).toBe("/Users/me/repos/app");
  });

  it("pins the session log under STATE_DIR, never the registered workspace", () => {
    // The stock compositions resolve persistence as
    // `process.env.DSH_SESSION_ROOT ?? './.sessions'`, and that relative default
    // lands against the child's cwd — the operator's repository. Unpinned, the
    // harness would dirty the working tree it is being asked to work in.
    process.env.DSH_SESSION_ROOT = "./.sessions";
    const env = deepseekChildEnv(config({ stateDir: "/var/agentroom" }), "/Users/me/repos/app");

    expect(env.DSH_SESSION_ROOT).toBe("/var/agentroom/deepseek/sessions");
    expect(env.DSH_SESSION_ROOT?.startsWith("/Users/me/repos/app")).toBe(false);
  });

  it("resolves a relative STATE_DIR before handing it to the workspace child", () => {
    const env = deepseekChildEnv(config({ stateDir: ".agentroom/state" }), "/Users/me/repos/app");

    expect(env.DSH_SESSION_ROOT).toBe(resolve(".agentroom/state/deepseek/sessions"));
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
        config({ deepseekExecutable: "/opt/homebrew/bin/dsh-jsonrpc-agent", deepseekArgs: ["--verbose", "2"] })
      )
    ).toEqual({ executableName: "dsh-jsonrpc-agent", argsCount: 2 });
  });
});
