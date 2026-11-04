import type { EditorCatalogManifest } from "./editorCatalogManifest";
import {
  acceptedValidation,
  buildCatalogSnapshot,
  normalizeCatalogPath,
  type EditorCatalogAsset,
  type EditorCatalogValidation
} from "./editorCatalogAssembly";

export { EditorCatalogError } from "./editorCatalogAssembly";

interface EditorCatalogLogger {
  warn(obj: unknown, msg?: string): void;
}

/** An immutable, fully validated catalog generation with its referenced bytes pinned in memory. */
export class EditorCatalogStore {
  private constructor(
    private readonly manifest: EditorCatalogManifest | null,
    private readonly assets: ReadonlyMap<string, EditorCatalogAsset>,
    private readonly assemblyValidation: EditorCatalogValidation,
    private readonly unresolved: readonly string[]
  ) {}

  static async create(assetsDir: string, logger?: EditorCatalogLogger): Promise<EditorCatalogStore> {
    const result = await buildCatalogSnapshot(assetsDir);
    if (result.state === "accepted") {
      return new EditorCatalogStore(result.manifest, result.assets, acceptedValidation(), result.unresolvedScopes);
    }
    if (result.state === "rejected") {
      logger?.warn(
        { err: result.detail, code: result.validation.code, location: result.validation.location },
        "editor catalog assets present but rejected"
      );
    }
    return new EditorCatalogStore(null, new Map(), result.validation, []);
  }

  getManifest(): EditorCatalogManifest | null {
    return this.manifest;
  }

  hasManifest(): boolean {
    return this.manifest !== null;
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
    const asset = this.assets.get(normalizeCatalogPath(inputPath));
    return asset ? { data: Buffer.from(asset.data), contentType: asset.contentType } : null;
  }
}
