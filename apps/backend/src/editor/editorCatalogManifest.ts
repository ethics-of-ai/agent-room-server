import { z } from "zod";

// The backend-served editor language catalog (Phase C). A versioned manifest plus
// blob assets let the visionOS editor pick up new/updated TextMate grammars,
// themes, and language configs WITHOUT an app update. Small assets (the language
// map, themes, and per-language configs) are inlined; large assets (grammars and
// the Oniguruma WASM) are referenced by content hash and fetched from the bounded
// asset route. `version` is an aggregate content hash so it changes iff any asset
// changes, driving the client's incremental, content-addressed cache.

export const editorCatalogAssetRefSchema = z.object({
  // Catalog-relative path under the served asset directory, e.g.
  // "grammars/swift.tmLanguage.json" or "vs-textmate/onig.wasm".
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative()
});

export const editorCatalogGrammarSchema = z.object({
  languageId: z.string().min(1),
  scopeName: z.string().min(1),
  // Large `.tmLanguage.json`; fetched as bytes from the asset route.
  grammar: editorCatalogAssetRefSchema,
  // VS Code language configuration, inlined as raw (JSONC) text — the client
  // strips JSONC and converts it to Monaco's shape, exactly like the bundled path.
  languageConfig: z.string().optional()
});

export const editorCatalogManifestSchema = z.object({
  version: z.string().min(1),
  // EditorLanguages.json contents (filename/extension -> Monaco languageId map).
  languageMap: z.unknown(),
  grammars: z.array(editorCatalogGrammarSchema),
  // EditorThemes.json (Phase A named-token themes) and EditorTextMateThemes.json
  // (Phase B scope themes), inlined as parsed JSON.
  themes: z.unknown(),
  textMateThemes: z.unknown(),
  engine: z.object({ onigWasm: editorCatalogAssetRefSchema })
});

export type EditorCatalogAssetRef = z.infer<typeof editorCatalogAssetRefSchema>;
export type EditorCatalogGrammar = z.infer<typeof editorCatalogGrammarSchema>;
export type EditorCatalogManifest = z.infer<typeof editorCatalogManifestSchema>;
