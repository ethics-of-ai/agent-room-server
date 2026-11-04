import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectExternalScopes } from "../src/editor/editorCatalogAssembly";
import { EditorCatalogStore } from "../src/editor/EditorCatalogStore";
import { editorCatalogBounds } from "../src/editor/editorCatalogManifest";
import { catalogAssetsDir, copyCatalog } from "./support/editorCatalogFixtures";


interface GrammarsIndex {
  version?: number;
  schemaVersion?: number;
  grammars: Array<Record<string, unknown>>;
  scopeGrammars?: Array<Record<string, unknown>>;
}

const readIndex = async (catalog: string): Promise<GrammarsIndex> =>
  JSON.parse(await readFile(join(catalog, "EditorGrammars.json"), "utf8")) as GrammarsIndex;

const writeIndex = async (catalog: string, index: GrammarsIndex): Promise<void> =>
  writeFile(join(catalog, "EditorGrammars.json"), JSON.stringify(index));

describe("collectExternalScopes", () => {
  it("names the scopes a grammar includes and nothing internal to it", () => {
    const grammar = {
      scopeName: "source.demo",
      patterns: [
        { include: "#local" },
        { include: "$self" },
        { include: "$base" },
        { include: "source.demo#internal" },
        { include: "source.other#rule" },
        { include: "text.html.basic" }
      ],
      repository: { local: { patterns: [{ include: "source.css" }, { include: "source.other" }] } }
    };

    expect(collectExternalScopes(grammar, "source.demo")).toEqual(["source.css", "source.other", "text.html.basic"]);
  });
});

describe("the committed catalog's dependency records", () => {
  it("derives resolved dependencies for every grammar at schema 2", async () => {
    const store = await EditorCatalogStore.create(catalogAssetsDir);
    const manifest = store.getManifest()!;
    const byScope = new Map(
      [...manifest.grammars, ...(manifest.scopeGrammars ?? [])].map((grammar) => [grammar.scopeName, grammar])
    );

    expect(manifest.schemaVersion).toBe(2);
    expect(byScope.get("text.html.derivative")?.dependencyScopes).toEqual(["text.html.basic"]);
    expect(byScope.get("text.html.basic")?.dependencyScopes).toEqual(["source.css", "source.js"]);
    expect(byScope.get("text.html.vue")?.dependencyScopes).toEqual(
      expect.arrayContaining(["source.ts", "source.tsx", "text.html.derivative", "text.html.markdown"])
    );
    expect(byScope.get("source.yaml")?.dependencyScopes).toEqual(["source.yaml.1.2", "source.yaml.embedded"]);
    // A dependency must be a scope this generation supplies; the schema holds that too.
    for (const grammar of byScope.values()) {
      for (const dependency of grammar.dependencyScopes ?? []) expect(byScope.has(dependency)).toBe(true);
      for (const injected of grammar.injectionScopes ?? []) expect(byScope.has(injected)).toBe(true);
    }
    // Fenced-code scopes no grammar supplies stay visible as a count, never silently zero.
    expect(store.unresolvedScopes().length).toBeGreaterThan(0);
    expect(store.unresolvedScopes()).toContain("source.elixir");
    expect(store.unresolvedScopes()).not.toContain("source.css");
    expect(store.unresolvedScopes()).not.toContain("source.python");
  });

  it("records injections on their host scopes", async () => {
    const store = await EditorCatalogStore.create(catalogAssetsDir);
    const manifest = store.getManifest()!;
    const html = manifest.grammars.find((grammar) => grammar.languageId === "html")!;
    const vue = manifest.grammars.find((grammar) => grammar.languageId === "vue")!;
    const typescript = manifest.grammars.find((grammar) => grammar.languageId === "typescript")!;

    expect(html.scopeName).toBe("text.html.derivative");
    expect(html.injectionScopes).toEqual(["vue.directives", "vue.interpolations"]);
    expect(html.embeddedLanguages).toEqual({ "source.css": "css", "source.js": "javascript" });
    expect(vue.injectionScopes).toContain("vue.sfc.style.variable.injection");
    expect(typescript.injectionScopes).toEqual(["documentation.injection.ts"]);
    for (const grammar of [...manifest.grammars, ...(manifest.scopeGrammars ?? [])]) {
      expect(grammar.provenance?.license).toBe("MIT");
    }
  });
});

describe("dependency and injection validation", () => {
  it("rejects a grammar index that is not schema 2", async () => {
    const catalog = await copyCatalog("agentroom-catalog-deps-");
    const index = await readIndex(catalog);
    delete index.schemaVersion;
    await writeIndex(catalog, index);
    const store = await EditorCatalogStore.create(catalog);

    expect(store.getManifest()).toBeNull();
    expect(store.validation()).toMatchObject({ state: "rejected", code: "schema_invalid", location: "schemaVersion" });
  });

  it("refuses an injection whose grammar declares no injectionSelector", async () => {
    const catalog = await copyCatalog("agentroom-catalog-deps-");
    const index = await readIndex(catalog);
    const css = index.grammars.find((grammar) => grammar.languageId === "css")!;
    css.injectionScopes = ["source.json"];
    await writeIndex(catalog, index);
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toEqual({
      state: "rejected",
      code: "grammar_injection_selector_missing",
      location: "grammars/json.tmLanguage.json"
    });
  });

  it("refuses an injection into a scope the generation does not carry", async () => {
    const catalog = await copyCatalog("agentroom-catalog-deps-");
    const index = await readIndex(catalog);
    const css = index.grammars.find((grammar) => grammar.languageId === "css")!;
    css.injectionScopes = ["vue.absent"];
    await writeIndex(catalog, index);
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toMatchObject({ code: "grammar_injection_missing", location: "grammars/css.tmLanguage.json" });
  });

  it("refuses a grammar that names more external scopes than the bound", async () => {
    const catalog = await copyCatalog("agentroom-catalog-deps-");
    const patterns = Array.from({ length: editorCatalogBounds.dependenciesPerGrammar + 1 }, (_, index) => ({
      include: `source.dependency${index}`
    }));
    await writeFile(
      join(catalog, "grammars/css.tmLanguage.json"),
      JSON.stringify({ scopeName: "source.css", patterns })
    );
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toMatchObject({ code: "grammar_too_many_dependencies", location: "grammars/css.tmLanguage.json" });
  });
});
