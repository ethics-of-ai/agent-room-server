import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/domain/models";
import {
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_SCHEMA_VERSION,
  bundledModelCatalog as modelCatalog,
  installModelCatalog,
  loadModelCatalog,
  parseModelCatalog,
  resolveModelCatalogPath
} from "../src/runner/modelCatalog";
import { DEFAULT_CURSOR_MODEL } from "../src/runner/cursor/capabilities";
import { deepseekCapabilities } from "../src/runner/deepseek/capabilities";
import { DEFAULT_DEEPSEEK_MODEL } from "../src/runner/deepseek/settings";

const catalogPath = resolve(__dirname, "..", "src", "runner", "modelCatalog.json");

function document(): any {
  return JSON.parse(readFileSync(catalogPath, "utf8"));
}

describe("model catalog file", () => {
  it("parses the bundled file at the current schema version", () => {
    expect(document().schemaVersion).toBe(MODEL_CATALOG_SCHEMA_VERSION);
    expect(parseModelCatalog(document())).toEqual(modelCatalog);
  });

  it("lists the model each runner falls back to when nothing is configured", () => {
    expect(modelCatalog.runners.deepseek.models.map((model) => model.id)).toContain(DEFAULT_DEEPSEEK_MODEL);
    const cursorDefault = modelCatalog.runners.cursor.fallbackModels.find((model) => model.isDefault);
    expect(cursorDefault?.id).toBe(DEFAULT_CURSOR_MODEL);
  });

  it("rejects a schema version this build does not read", () => {
    expect(() => parseModelCatalog({ ...document(), schemaVersion: 2 })).toThrow();
  });

  it("rejects unknown keys rather than ignoring them", () => {
    const value = document();
    value.runners.deepseek.models[0].contextWindow = 1000;
    expect(() => parseModelCatalog(value)).toThrow();
  });

  it("rejects duplicate model ids", () => {
    const value = document();
    value.runners.deepseek.models.push({ ...value.runners.deepseek.models[0] });
    expect(() => parseModelCatalog(value)).toThrow(/unique/);
  });

  it("rejects a Claude Code model effort outside the runner vocabulary", () => {
    const value = document();
    value.runners.claude_code.reasoningEfforts = value.runners.claude_code.reasoningEfforts.filter(
      (effort: { id: string }) => effort.id !== "xhigh"
    );
    expect(() => parseModelCatalog(value)).not.toThrow();
    value.runners.claude_code.fallbackModels[0].reasoningEfforts = ["xhigh"];
    expect(() => parseModelCatalog(value)).toThrow(/reasoningEfforts/);
  });

  it("rejects a Claude Code effort the runner would refuse at turn time", () => {
    const value = document();
    value.runners.claude_code.reasoningEfforts.push({ id: "minimal", label: "Minimal" });
    expect(() => parseModelCatalog(value)).toThrow();
  });

  it("rejects a Cursor depth default that is not one of its values", () => {
    const value = document();
    const model = value.runners.cursor.fallbackModels.find((entry: { depth?: unknown }) => entry.depth);
    model.depth.defaultValue = "ultra";
    expect(() => parseModelCatalog(value)).toThrow(/defaultValue/);
  });

  it("rejects more than one Cursor default", () => {
    const value = document();
    value.runners.cursor.fallbackModels[1].isDefault = true;
    expect(() => parseModelCatalog(value)).toThrow(/default/);
  });

  it("rejects a model id outside the bounded id shape", () => {
    const value = document();
    value.runners.deepseek.models[0].id = "bad id; rm -rf";
    expect(() => parseModelCatalog(value)).toThrow();
  });
});

describe("local model catalog", () => {
  afterEach(() => installModelCatalog(modelCatalog));

  async function home(contents?: string): Promise<{ home: string; path: string }> {
    const root = await mkdtemp(join(tmpdir(), "agentroom-model-catalog-"));
    const path = resolveModelCatalogPath(root);
    if (contents !== undefined) {
      await mkdir(join(root, "config"), { recursive: true });
      await writeFile(path, contents);
    }
    return { home: root, path };
  }

  const deepseekOnly = {
    schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
    runners: { deepseek: { models: [{ id: "deepseek-local", label: "Local" }] } }
  };

  it("lives beside settings.json", async () => {
    const { home: root, path } = await home();
    expect(path).toBe(join(root, "config", "models.json"));
  });

  it("uses the bundled catalog when there is no local file", async () => {
    const { path } = await home();
    expect(await loadModelCatalog(path)).toEqual({ catalog: modelCatalog, source: "bundled" });
  });

  it("replaces only the runners the local file lists", async () => {
    const { path } = await home(JSON.stringify(deepseekOnly));
    const loaded = await loadModelCatalog(path);
    expect(loaded.source).toBe("local");
    expect(loaded.catalog.runners.deepseek.models.map((model) => model.id)).toEqual(["deepseek-local"]);
    expect(loaded.catalog.runners.cursor).toEqual(modelCatalog.runners.cursor);
    expect(loaded.catalog.runners.claude_code).toEqual(modelCatalog.runners.claude_code);
  });

  it("ignores an invalid local file with a bounded reason", async () => {
    const invalid = { ...deepseekOnly, runners: { deepseek: { models: [] } } };
    const { path } = await home(JSON.stringify(invalid));
    const loaded = await loadModelCatalog(path);
    expect(loaded.catalog).toBe(modelCatalog);
    expect(loaded.source).toBe("bundled");
    expect(loaded.error).toMatch(/^runners\.deepseek\.models/);
  });

  it("ignores a local file that is not JSON", async () => {
    const { path } = await home("{");
    expect((await loadModelCatalog(path)).error).toBe("not valid JSON");
  });

  it("refuses an oversized local file without parsing it", async () => {
    const { path } = await home(" ".repeat(MODEL_CATALOG_MAX_BYTES + 1));
    expect((await loadModelCatalog(path)).error).toMatch(/larger than/);
  });

  it("feeds the installed catalog to runner capabilities", async () => {
    const { path } = await home(JSON.stringify(deepseekOnly));
    installModelCatalog((await loadModelCatalog(path)).catalog);
    const ids = deepseekCapabilities({} as ServiceConfig).settings.models.map((model) => model.id);
    // The code default is still offered even when the local list omits it.
    expect(ids).toEqual(["deepseek-local", DEFAULT_DEEPSEEK_MODEL]);
  });
});
