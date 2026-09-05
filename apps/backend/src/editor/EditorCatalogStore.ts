import { extname } from "node:path";
import type { EditorCatalogManifest } from "./editorCatalogManifest";
import {
  acceptedValidation,
  allowedCatalogExtensions,
  buildCatalogSnapshot,
  normalizeCatalogPath,
  rejectedValidation,
  unavailableValidation,
  type EditorCatalogAsset,
  type EditorCatalogValidation
} from "./editorCatalogAssembly";

export { EditorCatalogError } from "./editorCatalogAssembly";
export type { EditorCatalogAsset, EditorCatalogValidation, EditorCatalogValidationState } from "./editorCatalogAssembly";

export interface EditorCatalogLogger {
  warn(obj: unknown, msg?: string): void;
}

export type EditorCatalogSource = "override" | "bundled" | "none";

export interface EditorCatalogStatusSummary {
  source: EditorCatalogSource;
  version: string | null;
  schemaVersion: number | null;
  languageMapVersion: number | null;
  languageCount: number;
  syntaxProviders: { monaco: number; textmate: number; plaintext: number };
  primaryGrammarCount: number;
  scopeGrammarCount: number;
  /**
   * Distinct scopes the live grammars include that no grammar supplies. Text under
   * such a scope tokenizes as its enclosing scope, so the count is what an operator
   * reads as "these embedded blocks stay plain".
   */
  unresolvedScopeCount: number;
  validation: EditorCatalogValidation;
}

export interface EditorCatalogReloadResult extends EditorCatalogStatusSummary {
  accepted: boolean;
  changed: boolean;
}

type AssemblyState = "accepted" | "missing" | "rejected";

/** An immutable, fully validated catalog generation with its referenced bytes pinned in memory. */
export class EditorCatalogStore {
  private constructor(
    private readonly manifest: EditorCatalogManifest | null,
    private readonly assets: ReadonlyMap<string, EditorCatalogAsset>,
    private readonly assemblyState: AssemblyState,
    private readonly assemblyValidation: EditorCatalogValidation,
    private readonly unresolved: readonly string[]
  ) {}

  static async create(assetsDir: string, logger?: EditorCatalogLogger): Promise<EditorCatalogStore> {
    const result = await buildCatalogSnapshot(assetsDir);
    if (result.state === "accepted") {
      return new EditorCatalogStore(result.manifest, result.assets, "accepted", acceptedValidation(), result.unresolvedScopes);
    }
    if (result.state === "rejected") {
      logger?.warn(
        { err: result.detail, code: result.validation.code, location: result.validation.location },
        "editor catalog assets present but rejected"
      );
    }
    return new EditorCatalogStore(null, new Map(), result.state, result.validation, []);
  }

  static unavailable(): EditorCatalogStore {
    return new EditorCatalogStore(null, new Map(), "missing", unavailableValidation(), []);
  }

  getManifest(): EditorCatalogManifest | null {
    return this.manifest;
  }

  hasManifest(): boolean {
    return this.manifest !== null;
  }

  state(): AssemblyState {
    return this.assemblyState;
  }

  validation(): EditorCatalogValidation {
    return this.assemblyValidation;
  }

  /** Scopes the accepted grammars include that this generation does not supply, sorted. */
  unresolvedScopes(): readonly string[] {
    return this.unresolved;
  }

  /** Serve only a blob pinned into this accepted generation; disk is never consulted here. */
  async readAsset(inputPath: string): Promise<EditorCatalogAsset | null> {
    const safePath = normalizeCatalogPath(inputPath);
    const extension = extname(safePath).toLowerCase();
    if (!allowedCatalogExtensions.has(extension)) return null;
    const asset = this.assets.get(safePath);
    return asset ? { data: Buffer.from(asset.data), contentType: asset.contentType } : null;
  }
}

/** Runtime-reloadable owner that swaps only complete accepted catalog generations. */
export class EditorCatalogManager {
  private store = EditorCatalogStore.unavailable();
  private currentSource: EditorCatalogSource = "none";
  private currentValidation: EditorCatalogValidation = unavailableValidation();
  private initialized = false;

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

  async reload(): Promise<EditorCatalogReloadResult> {
    const previousVersion = this.store.getManifest()?.version ?? null;
    const override = await EditorCatalogStore.create(this.overrideDir, this.logger);

    if (override.state() === "rejected" && this.initialized) {
      return this.preserve(override.validation());
    }

    if (override.state() === "accepted") {
      return this.accept(override, "override", acceptedValidation(), previousVersion);
    }

    const bundled = await EditorCatalogStore.create(this.bundledDir, this.logger);
    if (bundled.state() === "rejected" && this.initialized) {
      return this.preserve(bundled.validation());
    }

    if (bundled.state() === "accepted") {
      if (override.state() === "rejected") {
        const rejected = override.validation();
        this.logger?.warn(
          { code: rejected.code, location: rejected.location },
          "editor catalog override rejected at startup; serving the bundled catalog"
        );
        return this.accept(bundled, "bundled", { ...rejected, state: "fallback" }, previousVersion);
      }
      return this.accept(bundled, "bundled", acceptedValidation(), previousVersion);
    }

    if (override.state() === "rejected" || bundled.state() === "rejected") {
      const rejected = override.state() === "rejected" ? override.validation() : bundled.validation();
      if (this.initialized) return this.preserve(rejected);
      return this.accept(EditorCatalogStore.unavailable(), "none", rejectedValidation(rejected), previousVersion, false);
    }

    return this.accept(EditorCatalogStore.unavailable(), "none", unavailableValidation(), previousVersion);
  }

  /** A rejected runtime candidate changes only the reported validation; the live generation stays. */
  private preserve(validation: EditorCatalogValidation): EditorCatalogReloadResult {
    this.logger?.warn(
      { code: validation.code, location: validation.location },
      "editor catalog reload rejected; keeping the last accepted generation"
    );
    this.currentValidation = rejectedValidation(validation);
    return { ...this.status(), accepted: false, changed: false };
  }

  private accept(
    store: EditorCatalogStore,
    source: EditorCatalogSource,
    validation: EditorCatalogValidation,
    previousVersion: string | null,
    accepted = true
  ): EditorCatalogReloadResult {
    this.store = store;
    this.currentSource = source;
    this.currentValidation = validation;
    this.initialized = true;
    const version = store.getManifest()?.version ?? null;
    return { ...this.status(), accepted, changed: previousVersion !== version };
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

  status(): EditorCatalogStatusSummary {
    const manifest = this.store.getManifest();
    if (!manifest) {
      return {
        source: this.currentSource,
        version: null,
        schemaVersion: null,
        languageMapVersion: null,
        languageCount: 0,
        syntaxProviders: { monaco: 0, textmate: 0, plaintext: 0 },
        primaryGrammarCount: 0,
        scopeGrammarCount: 0,
        unresolvedScopeCount: 0,
        validation: this.currentValidation
      };
    }
    const grammarLanguages = new Set(manifest.grammars.map((grammar) => grammar.languageId));
    const syntaxProviders = { monaco: 0, textmate: 0, plaintext: 0 };
    if (manifest.languageMap.version === 3) {
      for (const language of manifest.languageMap.languages) syntaxProviders[language.syntaxSource] += 1;
    } else {
      for (const language of manifest.languageMap.languages) {
        syntaxProviders[grammarLanguages.has(language.id) ? "textmate" : "monaco"] += 1;
      }
    }
    return {
      source: this.currentSource,
      version: manifest.version,
      schemaVersion: manifest.schemaVersion,
      languageMapVersion: manifest.languageMap.version,
      languageCount: manifest.languageMap.languages.length,
      syntaxProviders,
      primaryGrammarCount: manifest.grammars.length,
      scopeGrammarCount: manifest.scopeGrammars?.length ?? 0,
      unresolvedScopeCount: this.store.unresolvedScopes().length,
      validation: this.currentValidation
    };
  }
}
