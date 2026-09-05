import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EditorCatalogManager, EditorCatalogStore } from "../src/editor/EditorCatalogStore";
import {
  editorCatalogBounds,
  editorLanguageMapSchema,
  editorTextMateThemeMapSchema,
  editorThemeMapSchema
} from "../src/editor/editorCatalogManifest";

const catalogAssetsDir = resolve(__dirname, "..", "catalog-assets");
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

const copyCatalog = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "agentroom-catalog-validation-"));
  const catalog = join(root, "catalog-assets");
  await cp(catalogAssetsDir, catalog, { recursive: true });
  return catalog;
};

describe("editor catalog schemas", () => {
  it("accepts explicit deterministic ambiguities independent of candidate order", () => {
    const language = (id: string) => ({
      id,
      displayName: id,
      syntaxSource: "monaco" as const,
      extensions: ["m"]
    });
    const ambiguity = {
      kind: "extension" as const,
      value: "m",
      candidates: [
        { languageId: "matlab", projectMarkers: ["*.prj"], priority: 50 },
        { languageId: "objective-c", projectMarkers: ["*.xcodeproj"], priority: 100 }
      ],
      fallbackLanguageId: "objective-c"
    };
    expect(
      editorLanguageMapSchema.safeParse({
        version: 3,
        languages: [language("matlab"), language("objective-c")],
        ambiguities: [ambiguity]
      }).success
    ).toBe(true);
    expect(
      editorLanguageMapSchema.safeParse({
        version: 3,
        languages: [language("objective-c"), language("matlab")],
        ambiguities: [{ ...ambiguity, candidates: [...ambiguity.candidates].reverse() }]
      }).success
    ).toBe(true);
  });

  it("rejects duplicate unmodeled claims and catalog bounds", () => {
    const language = (id: string, extension: string) => ({
      id,
      displayName: id,
      syntaxSource: "monaco" as const,
      extensions: [extension]
    });
    expect(
      editorLanguageMapSchema.safeParse({
        version: 3,
        languages: [language("alpha", "x"), language("beta", "x")]
      }).success
    ).toBe(false);
    expect(
      editorLanguageMapSchema.safeParse({
        version: 3,
        languages: Array.from({ length: editorCatalogBounds.languages + 1 }, (_, index) =>
          language(`lang-${index}`, `x${index}`)
        )
      }).success
    ).toBe(false);
    expect(editorLanguageMapSchema.safeParse({ version: 4, languages: [language("alpha", "x")] }).success).toBe(false);
    expect(
      editorLanguageMapSchema.safeParse({
        version: 3,
        languages: [language("alpha", "x"), language("ALPHA", "y")]
      }).success
    ).toBe(false);
  });

  it("rejects unknown theme fields instead of forwarding arbitrary JSON", () => {
    expect(
      editorThemeMapSchema.safeParse({
        Test: { base: "vs", rules: [], executable: "no" }
      }).success
    ).toBe(false);
    expect(
      editorTextMateThemeMapSchema.safeParse({
        Test: { settings: [{ settings: { foreground: "#fff", arbitrary: true } }] }
      }).success
    ).toBe(false);
  });

  it("rejects a theme map that lacks the AgentRoom light or dark theme", () => {
    const monaco = { base: "vs", rules: [] };
    expect(editorThemeMapSchema.safeParse({ "AgentRoom-Light": monaco, "AgentRoom-Dark": monaco }).success).toBe(true);
    expect(editorThemeMapSchema.safeParse({ "AgentRoom-Light": monaco, Other: monaco }).success).toBe(false);
    const textMate = { settings: [] };
    expect(editorTextMateThemeMapSchema.safeParse({ "AgentRoom-Light": textMate }).success).toBe(false);
  });
});

describe("accepted editor catalog generations", () => {
  it("rejects invalid language configurations and retains the last accepted generation", async () => {
    const catalog = await copyCatalog();
    try {
      const manager = await EditorCatalogManager.create({ overrideDir: catalog, bundledDir: catalogAssetsDir });
      const version = manager.getManifest()!.version;
      const previous = manager.getManifest()!.grammars.find((entry) => entry.languageId === "swift")!.languageConfig;
      for (const invalid of ["", "// comment only", "/* comment only */", "not JSON at all", "null", "[]", '{"brackets":true}',
        '{"extra":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}']) {
        await writeFile(join(catalog, "language-configs/swift.json"), invalid);
        expect(await manager.reload()).toMatchObject({ accepted: false, changed: false, version });
        expect(manager.getManifest()!.grammars.find((entry) => entry.languageId === "swift")!.languageConfig).toBe(previous);
      }
      for (const jsonc of [
        '{ // comments are permitted\n "comments": { "lineComment": "//" }, "wordPattern": "[,}]", }',
        '\ufeff{"comments":{"lineComment":"//"},"wordPattern":"[,}]"}',
        '\u00a0{"comments":{"lineComment":"//"},"wordPattern":"[,}]"}'
      ]) {
        await writeFile(join(catalog, "language-configs/swift.json"), jsonc);
        expect(await manager.reload()).toMatchObject({ accepted: true });
        const config = manager.getManifest()!.grammars.find((entry) => entry.languageId === "swift")!.languageConfig!;
        expect(JSON.parse(config)).toEqual({ comments: { lineComment: "//" }, wordPattern: "[,}]" });
      }
    } finally {
      await rm(catalog, { recursive: true, force: true });
    }
  });

  it("pins the bytes that produced the manifest hash", async () => {
    const catalog = await copyCatalog();
    const store = await EditorCatalogStore.create(catalog);
    const grammarRef = store.getManifest()!.grammars.find((grammar) => grammar.languageId === "swift")!.grammar;
    const before = await store.readAsset(grammarRef.path);
    await writeFile(join(catalog, grammarRef.path), "{\"scopeName\":\"source.changed\"}");
    const after = await store.readAsset(grammarRef.path);

    expect(after?.data).toEqual(before?.data);
    expect(after && sha256(after.data)).toBe(grammarRef.sha256);
  });

  it("keeps the last accepted runtime snapshot when an override becomes invalid", async () => {
    const override = await copyCatalog();
    const manager = await EditorCatalogManager.create({ overrideDir: override, bundledDir: catalogAssetsDir });
    const version = manager.getManifest()!.version;
    const grammarPath = manager.getManifest()!.grammars[0].grammar.path;
    const grammar = await manager.readAsset(grammarPath);

    await writeFile(join(override, "EditorLanguages.json"), "{invalid");
    const result = await manager.reload();

    expect(result).toMatchObject({
      accepted: false,
      changed: false,
      source: "override",
      version,
      validation: { state: "rejected" }
    });
    expect((await manager.readAsset(grammarPath))?.data).toEqual(grammar?.data);
  });

  it("uses bundled assets when the startup override is invalid", async () => {
    const override = await copyCatalog();
    await writeFile(join(override, "EditorLanguages.json"), "{invalid");
    const manager = await EditorCatalogManager.create({ overrideDir: override, bundledDir: catalogAssetsDir });

    expect(manager.source()).toBe("bundled");
    expect(manager.status().validation).toMatchObject({ state: "fallback", code: "json_invalid" });
    expect(manager.status().languageCount).toBe(76);
  });

  it("rejects an over-limit language map before it becomes live", async () => {
    const catalog = await copyCatalog();
    const languageMap = {
      version: 3,
      languages: Array.from({ length: editorCatalogBounds.languages + 1 }, (_, index) => ({
        id: `lang-${index}`,
        displayName: `Language ${index}`,
        syntaxSource: "monaco",
        extensions: [`x${index}`]
      }))
    };
    await writeFile(join(catalog, "EditorLanguages.json"), JSON.stringify(languageMap));
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toMatchObject({ state: "rejected", code: "schema_invalid" });
  });

  it("rejects a grammar that exceeds its byte ceiling", async () => {
    const catalog = await copyCatalog();
    await writeFile(
      join(catalog, "grammars/swift.tmLanguage.json"),
      Buffer.alloc(editorCatalogBounds.grammarBytes + 1, 0x20)
    );
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toMatchObject({ state: "rejected", code: "asset_too_large" });
  });

  it("rejects a schema-two grammar dependency cycle", async () => {
    const catalog = await copyCatalog();
    const indexPath = join(catalog, "EditorGrammars.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      schemaVersion?: number;
      grammars: Array<Record<string, unknown>>;
      scopeGrammars?: Array<Record<string, unknown>>;
    };
    const provenance = { family: "fixture", source: "test", version: "1", license: "MIT" };
    index.schemaVersion = 2;
    index.grammars = index.grammars.map((grammar) => ({
      ...grammar,
      provenance,
      ...(grammar.languageId === "swift" ? { injectionScopes: ["source.extra"] } : {})
    }));
    // Two synthetic injections that inject into each other; both declare a selector so
    // the cycle, not a missing selector, is what the assembly refuses.
    index.scopeGrammars = [
      ...(index.scopeGrammars ?? []),
      { scopeName: "source.extra", grammar: "grammars/extra.tmLanguage.json", injectionScopes: ["source.extra2"], provenance },
      { scopeName: "source.extra2", grammar: "grammars/extra2.tmLanguage.json", injectionScopes: ["source.extra"], provenance }
    ];
    await writeFile(indexPath, JSON.stringify(index));
    for (const name of ["extra", "extra2"]) {
      await writeFile(
        join(catalog, `grammars/${name}.tmLanguage.json`),
        JSON.stringify({ scopeName: `source.${name}`, injectionSelector: "L:source", patterns: [] })
      );
    }
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toMatchObject({ state: "rejected", code: "grammar_dependency_cycle" });
  });

  it("bounds grammar dependency depth regardless of index order", async () => {
    const chain = async (length: number, reverse: boolean): Promise<EditorCatalogStore> => {
      const catalog = await copyCatalog();
      const indexPath = join(catalog, "EditorGrammars.json");
      const index = JSON.parse(await readFile(indexPath, "utf8")) as {
        schemaVersion?: number;
        grammars: Array<Record<string, unknown>>;
        scopeGrammars?: Array<Record<string, unknown>>;
      };
      const provenance = { family: "fixture", source: "test", version: "1", license: "MIT" };
      index.schemaVersion = 2;
      index.grammars = index.grammars.map((grammar) => ({ ...grammar, provenance }));
      const scopeGrammars: Array<Record<string, unknown>> = [];
      for (let depth = 0; depth < length; depth += 1) {
        const scopeName = `source.chain${depth}`;
        const grammarPath = `grammars/chain${depth}.tmLanguage.json`;
        await writeFile(
          join(catalog, grammarPath),
          JSON.stringify({ scopeName, injectionSelector: "L:source", patterns: [] })
        );
        scopeGrammars.push({
          scopeName,
          grammar: grammarPath,
          provenance,
          ...(depth + 1 < length ? { injectionScopes: [`source.chain${depth + 1}`] } : {})
        });
      }
      index.scopeGrammars = [...(index.scopeGrammars ?? []), ...(reverse ? scopeGrammars.reverse() : scopeGrammars)];
      await writeFile(indexPath, JSON.stringify(index));
      return EditorCatalogStore.create(catalog);
    };
    const bound = editorCatalogBounds.dependencyDepth;

    expect((await chain(bound, false)).hasManifest()).toBe(true);
    expect((await chain(bound + 1, false)).validation()).toMatchObject({ code: "grammar_dependency_too_deep" });
    // Listing the chain tail-first must not let a memoized walk skip the depth check.
    expect((await chain(bound + 1, true)).validation()).toMatchObject({ code: "grammar_dependency_too_deep" });
  });

  it("reports a missing referenced asset with a stable code and catalog-relative location", async () => {
    const catalog = await copyCatalog();
    await rm(join(catalog, "grammars/swift.tmLanguage.json"));
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toEqual({
      state: "rejected",
      code: "asset_missing",
      location: "grammars/swift.tmLanguage.json"
    });
  });

  it("rejects a grammar nested deeper than the JSON bound", async () => {
    const catalog = await copyCatalog();
    const depth = editorCatalogBounds.jsonNestingDepth;
    await writeFile(
      join(catalog, "grammars/swift.tmLanguage.json"),
      `{"scopeName":"source.swift","patterns":${"[".repeat(depth)}${"]".repeat(depth)}}`
    );
    const store = await EditorCatalogStore.create(catalog);

    expect(store.hasManifest()).toBe(false);
    expect(store.validation()).toMatchObject({ state: "rejected", code: "json_too_deep" });
  });
});
