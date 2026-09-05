import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { ZodError } from "zod";
import { editorLanguageConfigurationSchema, parseLanguageConfiguration } from "./editorLanguageConfiguration";
import { sha256Hex } from "../util/hash";
import { boundedRelativeSegments, isInside } from "../util/pathBounding";
import {
  editorCatalogBounds,
  editorCatalogManifestSchema,
  editorGrammarsIndexSchema,
  editorLanguageMapSchema,
  editorTextMateThemeMapSchema,
  editorThemeMapSchema,
  type EditorCatalogAssetRef,
  type EditorCatalogGrammar,
  type EditorCatalogManifest,
  type EditorCatalogScopeGrammar
} from "./editorCatalogManifest";

/** A client-facing refusal from the asset route: the path itself is malformed. */
export class EditorCatalogError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "EditorCatalogError";
  }
}

/** A catalog directory that cannot become a live generation, with a stable code and location. */
export class EditorCatalogAssemblyError extends Error {
  constructor(
    readonly code: string,
    readonly location: string,
    message: string
  ) {
    super(message);
    this.name = "EditorCatalogAssemblyError";
  }
}

export interface EditorCatalogAsset {
  data: Buffer;
  contentType: string;
}

export type EditorCatalogValidationState = "accepted" | "fallback" | "rejected" | "unavailable";

export interface EditorCatalogValidation {
  state: EditorCatalogValidationState;
  code: string | null;
  location: string | null;
}

export type CatalogSnapshotResult =
  | {
      state: "accepted";
      manifest: EditorCatalogManifest;
      assets: ReadonlyMap<string, EditorCatalogAsset>;
      /** Scopes some grammar includes that no grammar in this generation supplies, sorted. */
      unresolvedScopes: readonly string[];
    }
  | { state: "missing"; validation: EditorCatalogValidation }
  | { state: "rejected"; validation: EditorCatalogValidation; detail: string };

export const allowedCatalogExtensions: ReadonlySet<string> = new Set([".json", ".wasm"]);
const contentTypeByExtension: Record<string, string> = {
  ".json": "application/json",
  ".wasm": "application/wasm"
};

type GrammarIndexEntry = ReturnType<typeof editorGrammarsIndexSchema.parse>["grammars"][number];
type ScopeIndexEntry = NonNullable<ReturnType<typeof editorGrammarsIndexSchema.parse>["scopeGrammars"]>[number];

interface ParsedGrammar {
  entry: GrammarIndexEntry | ScopeIndexEntry;
  ref: EditorCatalogAssetRef;
  json: Record<string, unknown>;
  /** Every scope this grammar's `include` rules name outside itself, sorted. */
  externalScopes: readonly string[];
}

/**
 * Read one catalog directory into a complete, validated generation. Every byte the
 * manifest references is read here and returned pinned in `assets`, so a later
 * asset read never consults the disk the manifest was built from.
 */
export async function buildCatalogSnapshot(assetsDir: string): Promise<CatalogSnapshotResult> {
  let root: string;
  try {
    root = await realpath(assetsDir);
  } catch {
    return { state: "missing", validation: unavailableValidation("catalog_directory_missing", null) };
  }

  try {
    await lstat(resolve(root, "EditorGrammars.json"));
  } catch {
    return { state: "missing", validation: unavailableValidation("catalog_index_missing", "EditorGrammars.json") };
  }

  try {
    const loaded = new Map<string, Buffer>();
    const contributions = new Map<string, string>();
    let aggregateBytes = 0;

    const load = async (relativePath: string, maxBytes: number, expectedExtension: string): Promise<Buffer> => {
      const path = normalizeCatalogPath(relativePath);
      if (extname(path).toLowerCase() !== expectedExtension) {
        throw new EditorCatalogAssemblyError("unsupported_asset_type", path, `expected ${expectedExtension}`);
      }
      const cached = loaded.get(path);
      if (cached) {
        if (cached.byteLength > maxBytes) {
          throw new EditorCatalogAssemblyError("asset_too_large", path, "asset exceeds its role-specific bound");
        }
        return cached;
      }
      const data = await readBoundedFile(root, path, maxBytes);
      aggregateBytes += data.byteLength;
      if (aggregateBytes > editorCatalogBounds.aggregateAssetBytes) {
        throw new EditorCatalogAssemblyError("catalog_too_large", path, "catalog exceeds aggregate byte bound");
      }
      loaded.set(path, data);
      contributions.set(path, sha256Hex(data));
      return data;
    };

    const parseJson = async <T>(relativePath: string, schema: { parse(value: unknown): T }): Promise<T> => {
      const data = await load(relativePath, editorCatalogBounds.inlineJsonBytes, ".json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8")) as unknown;
      } catch {
        throw new EditorCatalogAssemblyError("json_invalid", relativePath, "asset is not valid JSON");
      }
      assertJsonDepth(parsed, relativePath);
      return schema.parse(parsed);
    };

    const grammarsIndex = await parseJson("EditorGrammars.json", editorGrammarsIndexSchema);
    const schemaVersion = grammarsIndex.schemaVersion ?? 1;
    const languageMap = await parseJson("EditorLanguages.json", editorLanguageMapSchema);
    const themes = await parseJson("EditorThemes.json", editorThemeMapSchema);
    const textMateThemes = await parseJson("EditorTextMateThemes.json", editorTextMateThemeMapSchema);
    const assets = new Map<string, EditorCatalogAsset>();

    const referenceAsset = async (
      path: string,
      maxBytes: number,
      expectedExtension: string,
      contentType: string
    ): Promise<{ data: Buffer; ref: EditorCatalogAssetRef }> => {
      const data = await load(path, maxBytes, expectedExtension);
      const normalized = normalizeCatalogPath(path);
      assets.set(normalized, { data, contentType });
      return { data, ref: { path: normalized, sha256: sha256Hex(data), bytes: data.byteLength } };
    };

    const parseGrammar = async (entry: GrammarIndexEntry | ScopeIndexEntry): Promise<ParsedGrammar> => {
      const { data, ref } = await referenceAsset(
        entry.grammar,
        editorCatalogBounds.grammarBytes,
        ".json",
        "application/json"
      );
      const json = parseGrammarJson(data, ref.path, entry.scopeName);
      const externalScopes = collectExternalScopes(json, entry.scopeName);
      if (externalScopes.length > editorCatalogBounds.dependenciesPerGrammar) {
        throw new EditorCatalogAssemblyError(
          "grammar_too_many_dependencies",
          ref.path,
          `grammar names more than ${editorCatalogBounds.dependenciesPerGrammar} external scopes`
        );
      }
      return { entry, ref, json, externalScopes };
    };

    const primaries = await Promise.all(grammarsIndex.grammars.map(parseGrammar));
    const auxiliaries = await Promise.all((grammarsIndex.scopeGrammars ?? []).map(parseGrammar));
    const parsedByScope = new Map<string, ParsedGrammar>();
    for (const parsed of [...primaries, ...auxiliaries]) parsedByScope.set(parsed.entry.scopeName, parsed);
    validateInjections(parsedByScope);

    const unresolvedScopes = new Set<string>();
    const dependencyFields = (parsed: ParsedGrammar): Partial<EditorCatalogScopeGrammar> => {
      const resolved: string[] = [];
      for (const scope of parsed.externalScopes) {
        if (parsedByScope.has(scope)) resolved.push(scope);
        else unresolvedScopes.add(scope);
      }
      // Schema 1 predates derived dependencies, so a schema-1 manifest keeps its exact
      // shape for the clients that were built against it.
      if (schemaVersion === 1 || resolved.length === 0) return {};
      return { dependencyScopes: resolved };
    };

    const grammars: EditorCatalogGrammar[] = [];
    for (const parsed of primaries) {
      const entry = parsed.entry as GrammarIndexEntry;
      let languageConfig: string | undefined;
      if (entry.languageConfig) {
        const data = await load(entry.languageConfig, editorCatalogBounds.languageConfigBytes, ".json");
        languageConfig = data.toString("utf8");
        let config: unknown;
        try {
          config = parseLanguageConfiguration(languageConfig);
        } catch {
          throw new EditorCatalogAssemblyError("json_invalid", entry.languageConfig, "language configuration is not valid JSONC");
        }
        assertJsonDepth(config, entry.languageConfig);
        if (!editorLanguageConfigurationSchema.safeParse(config).success) {
          throw new EditorCatalogAssemblyError("language_config_invalid", entry.languageConfig, "language configuration has invalid fields");
        }
        // Clients consume strict JSON, so parser-specific trivia such as a BOM
        // cannot make an accepted backend configuration fail on the headset.
        languageConfig = JSON.stringify(config);
      }
      grammars.push({
        languageId: entry.languageId,
        scopeName: entry.scopeName,
        grammar: parsed.ref,
        ...(languageConfig === undefined ? {} : { languageConfig }),
        ...(entry.embeddedLanguages ? { embeddedLanguages: entry.embeddedLanguages } : {}),
        ...(entry.injectionScopes ? { injectionScopes: entry.injectionScopes } : {}),
        ...dependencyFields(parsed),
        ...(entry.provenance ? { provenance: entry.provenance } : {})
      });
    }
    const scopeGrammars: EditorCatalogScopeGrammar[] = auxiliaries.map((parsed) => ({
      scopeName: parsed.entry.scopeName,
      grammar: parsed.ref,
      ...(parsed.entry.injectionScopes ? { injectionScopes: parsed.entry.injectionScopes } : {}),
      ...dependencyFields(parsed),
      ...(parsed.entry.provenance ? { provenance: parsed.entry.provenance } : {})
    }));

    const onigWasm = (
      await referenceAsset("vs-textmate/onig.wasm", editorCatalogBounds.wasmBytes, ".wasm", "application/wasm")
    ).ref;
    const version = sha256Hex(
      [...contributions.entries()]
        .map(([path, hash]) => `${path}:${hash}`)
        .sort()
        .join("\n")
    );
    const manifest = editorCatalogManifestSchema.parse({
      schemaVersion,
      version,
      languageMap,
      grammars,
      ...(scopeGrammars.length > 0 ? { scopeGrammars } : {}),
      themes,
      textMateThemes,
      engine: { onigWasm }
    });
    validateInjectionGraph(manifest);
    return { state: "accepted", manifest, assets, unresolvedScopes: [...unresolvedScopes].sort() };
  } catch (error) {
    const failure = validationFailure(error);
    return { state: "rejected", validation: failure.validation, detail: failure.detail };
  }
}

async function readBoundedFile(root: string, relativePath: string, maxBytes: number): Promise<Buffer> {
  const segments = relativePath.split("/");
  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new EditorCatalogAssemblyError("asset_missing", relativePath, "referenced asset is absent");
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new EditorCatalogAssemblyError("symlink_not_allowed", relativePath, "catalog assets cannot be symlinks");
    }
  }
  const target = resolve(root, relativePath);
  const realTarget = await realpath(target);
  if (!isInside(root, realTarget)) {
    throw new EditorCatalogAssemblyError("asset_path_escape", relativePath, "asset escapes catalog root");
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new EditorCatalogAssemblyError("unsupported_asset_type", relativePath, "asset is not a regular file");
    }
    if (stat.size > maxBytes) {
      throw new EditorCatalogAssemblyError("asset_too_large", relativePath, `asset exceeds ${maxBytes} bytes`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseGrammarJson(data: Buffer, location: string, expectedScope: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8")) as unknown;
  } catch {
    throw new EditorCatalogAssemblyError("json_invalid", location, "grammar is not valid JSON");
  }
  assertJsonDepth(parsed, location);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EditorCatalogAssemblyError("grammar_invalid", location, "grammar root must be an object");
  }
  const grammar = parsed as Record<string, unknown>;
  if (grammar.scopeName !== expectedScope) {
    throw new EditorCatalogAssemblyError("grammar_scope_mismatch", location, "grammar scope does not match index");
  }
  return grammar;
}

/**
 * The scopes a grammar reaches through `include` rules other than its own repository
 * (`#rule`), itself (`$self`, `$base`), or a rule inside itself (`scope#rule` names the
 * scope before the hash). What the engine cannot resolve at tokenization time simply
 * tokenizes as the enclosing scope, which is why these are derived rather than declared:
 * a declared list could name a dependency the grammar never uses, or omit one it does.
 */
export function collectExternalScopes(grammar: Record<string, unknown>, ownScope: string): string[] {
  const found = new Set<string>();
  const pending: unknown[] = [grammar];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    const record = current as Record<string, unknown>;
    const include = record.include;
    if (typeof include === "string" && !include.startsWith("#") && include !== "$self" && include !== "$base") {
      const scope = include.split("#", 1)[0];
      if (scope && scope !== ownScope) found.add(scope);
    }
    for (const child of Object.values(record)) pending.push(child);
  }
  return [...found].sort();
}

/**
 * A grammar named as an injection must be able to inject: without an
 * `injectionSelector` the engine would register it and never apply it, which is a
 * misdeclared index rather than a working catalog.
 */
function validateInjections(parsedByScope: ReadonlyMap<string, ParsedGrammar>): void {
  for (const parsed of parsedByScope.values()) {
    for (const scope of parsed.entry.injectionScopes ?? []) {
      const injected = parsedByScope.get(scope);
      if (!injected) {
        throw new EditorCatalogAssemblyError("grammar_injection_missing", parsed.ref.path, `injection scope is absent: ${scope}`);
      }
      const selector = injected.json.injectionSelector;
      if (typeof selector !== "string" || selector.trim().length === 0) {
        throw new EditorCatalogAssemblyError(
          "grammar_injection_selector_missing",
          injected.ref.path,
          `grammar is injected into ${parsed.entry.scopeName} but declares no injectionSelector`
        );
      }
    }
  }
}

function assertJsonDepth(value: unknown, location: string): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > editorCatalogBounds.jsonNestingDepth) {
      throw new EditorCatalogAssemblyError("json_too_deep", location, "JSON exceeds nesting bound");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const child of Object.values(current.value)) pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

// The depth bound is the longest injection chain under any scope, so each scope
// memoizes its chain height rather than only whether it was visited: a memo that
// forgot the height would let a nine-long chain pass whenever its tail happened
// to be walked before its head. Plain `include` dependencies are deliberately not
// edges here: TextMate resolves those lazily by reference, so a cycle between
// them (Markdown fences Vue, Vue embeds Markdown) is ordinary, not a fault.
function validateInjectionGraph(manifest: EditorCatalogManifest): void {
  const entries = [...manifest.grammars, ...(manifest.scopeGrammars ?? [])];
  const edges = new Map(entries.map((entry) => [entry.scopeName, entry.injectionScopes ?? []]));
  const visiting = new Set<string>();
  const heights = new Map<string, number>();

  const height = (scope: string): number => {
    const known = heights.get(scope);
    if (known !== undefined) return known;
    if (visiting.has(scope)) {
      throw new EditorCatalogAssemblyError("grammar_dependency_cycle", scope, "grammar dependency cycle detected");
    }
    visiting.add(scope);
    let deepest = 0;
    for (const dependency of edges.get(scope) ?? []) deepest = Math.max(deepest, height(dependency));
    visiting.delete(scope);
    const chain = deepest + 1;
    if (chain > editorCatalogBounds.dependencyDepth) {
      throw new EditorCatalogAssemblyError("grammar_dependency_too_deep", scope, "dependency depth exceeds bound");
    }
    heights.set(scope, chain);
    return chain;
  };

  for (const scope of edges.keys()) height(scope);
}

function validationFailure(error: unknown): { validation: EditorCatalogValidation; detail: string } {
  if (error instanceof EditorCatalogAssemblyError) {
    return {
      validation: { state: "rejected", code: error.code, location: boundedLocation(error.location) },
      detail: error.message
    };
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const location = issue?.path.length ? issue.path.join(".") : "catalog";
    return {
      validation: { state: "rejected", code: "schema_invalid", location: boundedLocation(location) },
      detail: issue?.message ?? "catalog schema is invalid"
    };
  }
  const detail = error instanceof Error ? error.message : "catalog assembly failed";
  return {
    validation: { state: "rejected", code: "catalog_invalid", location: null },
    detail
  };
}

export function acceptedValidation(): EditorCatalogValidation {
  return { state: "accepted", code: null, location: null };
}

export function rejectedValidation(validation: EditorCatalogValidation): EditorCatalogValidation {
  return { ...validation, state: "rejected" };
}

export function unavailableValidation(
  code = "catalog_unavailable",
  location: string | null = null
): EditorCatalogValidation {
  return { state: "unavailable", code, location };
}

function boundedLocation(location: string): string {
  return Buffer.byteLength(location, "utf8") <= editorCatalogBounds.pathBytes
    ? location
    : `${location.slice(0, editorCatalogBounds.pathBytes - 1)}…`;
}

export function catalogContentType(extension: string): string | undefined {
  return contentTypeByExtension[extension];
}

export function normalizeCatalogPath(inputPath: string): string {
  const safePath = boundedRelativeSegments(inputPath, () => {
    throw new EditorCatalogError("Catalog asset path must stay inside the catalog");
  });
  if (!safePath) throw new EditorCatalogError("Catalog asset path is required");
  if (Buffer.byteLength(safePath, "utf8") > editorCatalogBounds.pathBytes) {
    throw new EditorCatalogError("Catalog asset path is too long");
  }
  return safePath;
}
