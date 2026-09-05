import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EditorCatalogStore } from "../src/editor/EditorCatalogStore";
import type { EditorCatalogManifest } from "../src/editor/editorCatalogManifest";

const repoRoot = resolve(__dirname, "../../..");
const catalogAssetsDir = resolve(__dirname, "..", "catalog-assets");
const corpusPath = resolve(__dirname, "fixtures/editorGrammarCorpus.json");
// The engine the headset runs is the vendored one under the visionOS tree; the public
// mirror ships the catalog without it, so this suite skips there rather than pretending
// another build of the engine is the same thing.
const engineDir = resolve(repoRoot, "apps/visionos/AgentRoom/Resources/Monaco/vs-textmate");
const hasEngine = existsSync(join(engineDir, "vscode-textmate.js")) && existsSync(join(engineDir, "vscode-oniguruma.js"));

interface CorpusExpectation {
  line: number;
  token: string;
  scopes: string[];
}

interface CorpusFixture {
  languageId: string;
  title: string;
  text: string;
  expect: CorpusExpectation[];
  expectLanguage?: Array<{ line: number; token: string; languageId: string }>;
}

interface Corpus {
  schemaVersion: number;
  fixtures: CorpusFixture[];
}

interface TokenizedLine {
  line: number;
  tokens: Array<{ text: string; scopes: string[] }>;
}

interface Registry {
  loadGrammar(scopeName: string): Promise<{
    tokenizeLine(line: string, state: unknown, timeLimit?: number): { tokens: Array<{ startIndex: number; endIndex: number; scopes: string[] }>; ruleStack: unknown };
  } | null>;
}

interface Engine {
  registry: Registry;
  initial: unknown;
}

const require = createRequire(__filename);

async function loadEngine(store: EditorCatalogStore, manifest: EditorCatalogManifest): Promise<Engine> {
  const textmate = require(join(engineDir, "vscode-textmate.js"));
  const oniguruma = require(join(engineDir, "vscode-oniguruma.js"));
  const wasm = (await store.readAsset(manifest.engine.onigWasm.path))!.data;
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const entries = new Map(
    [...manifest.grammars, ...(manifest.scopeGrammars ?? [])].map((grammar) => [grammar.scopeName, grammar])
  );
  const registry: Registry = new textmate.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
      createOnigString: (text: string) => new oniguruma.OnigString(text)
    }),
    loadGrammar: async (scopeName: string) => {
      const entry = entries.get(scopeName);
      if (!entry) return null;
      const asset = await store.readAsset(entry.grammar.path);
      return asset ? textmate.parseRawGrammar(asset.data.toString("utf8"), entry.grammar.path) : null;
    },
    getInjections: (scopeName: string) => entries.get(scopeName)?.injectionScopes
  });
  return { registry, initial: textmate.INITIAL };
}

async function tokenize(engine: Engine, scopeName: string, text: string): Promise<TokenizedLine[]> {
  const grammar = await engine.registry.loadGrammar(scopeName);
  expect(grammar, `grammar for ${scopeName} did not load`).not.toBeNull();
  let state = engine.initial;
  return text.split("\n").map((line, index) => {
    const result = grammar!.tokenizeLine(line, state, 500);
    state = result.ruleStack;
    return {
      line: index,
      tokens: result.tokens.map((token) => ({ text: line.slice(token.startIndex, token.endIndex), scopes: token.scopes }))
    };
  });
}

function render(lines: TokenizedLine[]): string {
  return lines
    .map((line) => `${line.line}: ${line.tokens.map((token) => `${JSON.stringify(token.text)}<${token.scopes.slice(1).join(" ")}>`).join(" ")}`)
    .join("\n");
}

describe.skipIf(!hasEngine)("editor grammar corpus", async () => {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as Corpus;
  let manifest: EditorCatalogManifest;
  let engine: Engine;
  let byLanguage: Map<string, EditorCatalogManifest["grammars"][number]>;

  // Vitest collects skipped suites too. Load the private engine only when
  // this suite actually runs; the public mirror intentionally omits it.
  beforeAll(async () => {
    const store = await EditorCatalogStore.create(catalogAssetsDir);
    manifest = store.getManifest()!;
    engine = await loadEngine(store, manifest);
    byLanguage = new Map(manifest.grammars.map((grammar) => [grammar.languageId, grammar]));
  });

  it("has a fixture for every TextMate language and no fixture for a language without a grammar", () => {
    const declared = manifest.languageMap.version === 3
      ? manifest.languageMap.languages.filter((language) => language.syntaxSource === "textmate").map((language) => language.id)
      : manifest.grammars.map((grammar) => grammar.languageId);

    expect(new Set(corpus.fixtures.map((fixture) => fixture.languageId))).toEqual(new Set(declared));
    expect(corpus.fixtures.map((fixture) => fixture.languageId)).toHaveLength(declared.length);
  });

  it("loads every catalog scope, including auxiliary and injected grammars", async () => {
    for (const grammar of [...manifest.grammars, ...(manifest.scopeGrammars ?? [])]) {
      expect(await engine.registry.loadGrammar(grammar.scopeName), grammar.scopeName).not.toBeNull();
    }
  });

  for (const fixture of corpus.fixtures) {
    it(`tokenizes ${fixture.languageId}: ${fixture.title}`, async () => {
      const grammar = byLanguage.get(fixture.languageId);
      expect(grammar, `no primary grammar for ${fixture.languageId}`).toBeDefined();
      const started = performance.now();
      const lines = await tokenize(engine, grammar!.scopeName, fixture.text);
      const elapsed = performance.now() - started;
      const dump = render(lines);

      expect(fixture.expect.length).toBeGreaterThan(0);
      for (const expectation of fixture.expect) {
        const line = lines[expectation.line];
        expect(line, `line ${expectation.line} is missing\n${dump}`).toBeDefined();
        const token = line.tokens.find((candidate) => candidate.text.trim() === expectation.token);
        expect(token, `token ${JSON.stringify(expectation.token)} not on line ${expectation.line}\n${dump}`).toBeDefined();
        for (const scope of expectation.scopes) {
          expect(token!.scopes, `${JSON.stringify(expectation.token)} on line ${expectation.line} lacks ${scope}\n${dump}`).toContain(scope);
        }
      }
      // Every fixture is a few lines; a grammar that takes seconds on them is a
      // regression the headset would feel on every keystroke.
      expect(elapsed).toBeLessThan(2_000);
    });
  }
});
