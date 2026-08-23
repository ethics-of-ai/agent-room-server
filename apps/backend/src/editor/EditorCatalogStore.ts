import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../util/hash";
import { boundedRelativeSegments, isInside } from "../util/pathBounding";
import type {
  EditorCatalogAssetRef,
  EditorCatalogGrammar,
  EditorCatalogManifest
} from "./editorCatalogManifest";

// The catalog serves DATA only. The TextMate engine JS stays bundled in the app
// (same-origin, `script-src 'self'`); the backend never serves executable code,
// so a blob request for anything but these extensions is rejected.
const allowedExtensions = new Set([".json", ".wasm"]);
const contentTypeByExtension: Record<string, string> = {
  ".json": "application/json",
  ".wasm": "application/wasm"
};

export class EditorCatalogError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "EditorCatalogError";
  }
}

export interface EditorCatalogAsset {
  data: Buffer;
  contentType: string;
}

export interface EditorCatalogLogger {
  warn(obj: unknown, msg?: string): void;
}

// Index shape of the bundled `EditorGrammars.json` the sync script copies in. The
// served manifest dereferences the grammar/config paths it lists.
const grammarsIndexSchema = z.object({
  grammars: z.array(
    z.object({
      languageId: z.string().min(1),
      scopeName: z.string().min(1),
      grammar: z.string().min(1),
      languageConfig: z.string().min(1).optional()
    })
  )
});

/**
 * Boot-time, in-memory editor language catalog. The manifest is assembled once by
 * scanning and hashing the curated asset directory, so the manifest's hashes and
 * the bytes the asset route serves can never drift (same process, same files).
 * Holds only the small inlined assets + hashes in memory; grammar/wasm bytes are
 * read from disk per request through the bounded {@link readAsset}.
 */
export class EditorCatalogStore {
  // Exact set of catalog-relative paths the manifest references (grammar blobs +
  // the Oniguruma WASM). The asset route serves only these, so it is a pure
  // "fetch a blob the manifest advertised" endpoint, never a directory browser.
  private readonly referencedPaths: Set<string>;

  private constructor(
    private readonly assetsDir: string,
    private readonly manifest: EditorCatalogManifest | null
  ) {
    this.referencedPaths = new Set(
      manifest ? [...manifest.grammars.map((grammar) => grammar.grammar.path), manifest.engine.onigWasm.path] : []
    );
  }

  static async create(assetsDir: string, logger?: EditorCatalogLogger): Promise<EditorCatalogStore> {
    const manifest = await buildManifest(assetsDir, logger);
    return new EditorCatalogStore(assetsDir, manifest);
  }

  /** The assembled manifest, or null when no catalog is present (client stays bundled). */
  getManifest(): EditorCatalogManifest | null {
    return this.manifest;
  }

  hasManifest(): boolean {
    return this.manifest !== null;
  }

  /**
   * Read one catalog asset, bounded to the served directory. Mirrors the
   * WorkspaceExplorer read guards: lexical normalize (reject NUL/absolute/`..`),
   * realpath containment, extension allowlist, and symlink-leaf refusal. Throws
   * {@link EditorCatalogError} with status 400 on a structurally invalid path;
   * returns null for anything not a servable, in-bounds, existing file (-> 404).
   */
  async readAsset(inputPath: string): Promise<EditorCatalogAsset | null> {
    const safePath = normalizeCatalogPath(inputPath);
    const extension = extname(safePath).toLowerCase();
    if (!allowedExtensions.has(extension)) return null;
    // Only blobs the manifest advertises are servable; everything else (the
    // top-level index/theme JSONs, which are inlined, the README, etc.) is 404.
    if (!this.referencedPaths.has(safePath)) return null;

    let root: string;
    try {
      root = await realpath(this.assetsDir);
    } catch {
      return null;
    }

    const targetPath = resolve(root, safePath);
    let leafStat;
    try {
      leafStat = await lstat(targetPath);
    } catch {
      return null;
    }
    // Never follow a symlink leaf out of the catalog, and never serve a directory.
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null;

    let realTarget: string;
    try {
      realTarget = await realpath(targetPath);
    } catch {
      return null;
    }
    if (!isInside(root, realTarget)) return null;

    const data = await readFile(realTarget);
    return { data, contentType: contentTypeByExtension[extension] };
  }
}

/** Which directory the live catalog snapshot was assembled from. */
export type EditorCatalogSource = "override" | "bundled" | "none";

export interface EditorCatalogReloadResult {
  changed: boolean;
  source: EditorCatalogSource;
  version: string | null;
}

/**
 * Runtime-reloadable wrapper over {@link EditorCatalogStore} with a two-tier
 * directory resolution (Phase C.5). The operator override dir is preferred when it
 * holds a manifest; otherwise the shipped bundled dir is used; otherwise no catalog
 * is served (clients fall back to their own bundled assets). Each {@link reload}
 * rebuilds an immutable {@link EditorCatalogStore} snapshot and swaps it atomically,
 * so an operator can push a new/updated catalog without restarting the backend.
 */
export class EditorCatalogManager {
  // Definite-assignment: the only construction path is `create()`, which awaits an
  // initial `reload()` before returning, and `reload()` never throws (the store
  // builder degrades to a null manifest rather than throwing).
  private store!: EditorCatalogStore;
  private currentSource: EditorCatalogSource = "none";

  private constructor(
    private readonly overrideDir: string,
    private readonly bundledDir: string,
    private readonly logger?: EditorCatalogLogger
  ) {}

  static async create(opts: {
    overrideDir: string;
    bundledDir: string;
    logger?: EditorCatalogLogger;
  }): Promise<EditorCatalogManager> {
    const manager = new EditorCatalogManager(opts.overrideDir, opts.bundledDir, opts.logger);
    await manager.reload();
    return manager;
  }

  /**
   * Re-resolve the catalog from disk (override → bundled → none) and swap in the
   * new snapshot. Returns whether the aggregate version actually changed, so the
   * caller only broadcasts `editor_catalog_changed` on a real change.
   */
  async reload(): Promise<EditorCatalogReloadResult> {
    const previousVersion = this.store?.getManifest()?.version ?? null;

    const override = await EditorCatalogStore.create(this.overrideDir, this.logger);
    let nextStore: EditorCatalogStore;
    let nextSource: EditorCatalogSource;
    if (override.hasManifest()) {
      nextStore = override;
      nextSource = "override";
    } else {
      const bundled = await EditorCatalogStore.create(this.bundledDir, this.logger);
      nextStore = bundled;
      nextSource = bundled.hasManifest() ? "bundled" : "none";
    }

    // Atomic swap: both stores are fully built before either field is reassigned,
    // so a concurrent readAsset/getManifest never observes a torn snapshot.
    this.store = nextStore;
    this.currentSource = nextSource;

    const version = nextStore.getManifest()?.version ?? null;
    return { changed: previousVersion !== version, source: nextSource, version };
  }

  getManifest(): EditorCatalogManifest | null {
    return this.store.getManifest();
  }

  hasManifest(): boolean {
    return this.store.hasManifest();
  }

  readAsset(inputPath: string): Promise<EditorCatalogAsset | null> {
    return this.store.readAsset(inputPath);
  }

  source(): EditorCatalogSource {
    return this.currentSource;
  }
}

async function buildManifest(
  assetsDir: string,
  logger?: EditorCatalogLogger
): Promise<EditorCatalogManifest | null> {
  let root: string;
  try {
    root = await realpath(assetsDir);
  } catch {
    // No catalog directory at all -> serve no catalog (client uses bundled assets).
    return null;
  }

  let grammarsIndexRaw: string;
  try {
    grammarsIndexRaw = await readFile(resolve(root, "EditorGrammars.json"), "utf8");
  } catch {
    // Directory present but no index file -> treat as "no catalog here".
    return null;
  }

  try {
    // Accumulate `${path}:${sha256}` for every contributing file (inlined or
    // referenced) so `version` changes iff any asset content changes.
    const contributions: string[] = [];

    const referenceAsset = async (relativePath: string): Promise<EditorCatalogAssetRef> => {
      // Canonicalize the path the manifest advertises (and that `readAsset` later matches a
      // request against) so a non-canonical index entry (`./x`, `a//b`, backslashes) can't
      // advertise a path the asset route then 404s; `..`/absolute/NUL degrade the whole catalog.
      const path = boundedRelativeSegments(relativePath, () => {
        throw new EditorCatalogError("Catalog asset path must stay inside the catalog");
      });
      const data = await readFile(resolve(root, path));
      const sha256 = sha256Hex(data);
      contributions.push(`${path}:${sha256}`);
      return { path, sha256, bytes: data.byteLength };
    };
    const inlineJson = async (relativePath: string): Promise<unknown> => {
      const text = await readFile(resolve(root, relativePath), "utf8");
      contributions.push(`${relativePath}:${sha256Hex(text)}`);
      return JSON.parse(text);
    };
    const inlineText = async (relativePath: string): Promise<string> => {
      const text = await readFile(resolve(root, relativePath), "utf8");
      contributions.push(`${relativePath}:${sha256Hex(text)}`);
      return text;
    };

    const grammarsIndex = grammarsIndexSchema.parse(JSON.parse(grammarsIndexRaw));
    contributions.push(`EditorGrammars.json:${sha256Hex(grammarsIndexRaw)}`);

    const grammars: EditorCatalogGrammar[] = [];
    for (const entry of grammarsIndex.grammars) {
      grammars.push({
        languageId: entry.languageId,
        scopeName: entry.scopeName,
        grammar: await referenceAsset(entry.grammar),
        ...(entry.languageConfig ? { languageConfig: await inlineText(entry.languageConfig) } : {})
      });
    }

    const languageMap = await inlineJson("EditorLanguages.json");
    const themes = await inlineJson("EditorThemes.json");
    const textMateThemes = await inlineJson("EditorTextMateThemes.json");
    const onigWasm = await referenceAsset("vs-textmate/onig.wasm");

    const version = sha256Hex([...contributions].sort().join("\n"));
    return { version, languageMap, grammars, themes, textMateThemes, engine: { onigWasm } };
  } catch (error) {
    // Present-but-malformed catalog: degrade loudly (logged) rather than crash the
    // server; the client falls back to its bundled assets.
    logger?.warn(
      { err: error instanceof Error ? error.message : error },
      "editor catalog assets present but failed to assemble; serving no catalog"
    );
    return null;
  }
}

function normalizeCatalogPath(inputPath: string): string {
  const safePath = boundedRelativeSegments(inputPath, () => {
    throw new EditorCatalogError("Catalog asset path must stay inside the catalog");
  });
  if (!safePath) {
    throw new EditorCatalogError("Catalog asset path is required");
  }
  return safePath;
}
