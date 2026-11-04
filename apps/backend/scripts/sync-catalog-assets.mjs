#!/usr/bin/env node
// Sync the backend language-catalog asset directory from the visionOS app's
// curated editor asset set. The app bundle is the one editing source for
// grammars, themes, language configurations and the Oniguruma wasm. This script
// copies that set into `apps/backend/catalog-assets/`, which the backend serves
// over the bearer-auth'd catalog routes. `catalogSyncParity.test.ts` fails if
// the committed backend copy drifts from the app source.
//
// DATA ONLY: the backend serves `.json` + `.wasm`. The TextMate engine JS
// (`vscode-textmate.js`, `vscode-oniguruma.js`) stays bundled in the app and is
// never copied here, so the catalog can never serve executable language packs.
// Grammars and themes enter the app source through the maintainer importers
// (`import-editor-grammars.mjs` and `import-editor-themes.mjs`). Both run this
// sync after they write; the grammar importer then regenerates the language
// support matrix. Run it by hand after editing the app's editor assets directly.
//
// This script stays standalone. The public mirror publishes it without the
// shared import module, so it must not import from `catalog-import-shared.mjs`.
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "../../..");

// The committed served directory (relative to repo root).
export const catalogAssetsDir = "apps/backend/catalog-assets";

// Source of truth in the visionOS app bundle. The four manifest JSONs live at the
// Resources root; the grammar/config/wasm bytes live under Resources/Monaco.
const appResources = "apps/visionos/AgentRoom/Resources";

// Copy plan: each entry maps an app-bundle source to a path under catalog-assets.
// `dir` entries expand to their files; `excludeExts` drops engine code so only
// servable data lands in the backend tree.
const catalogSpecs = [
  { kind: "file", src: `${appResources}/EditorLanguages.json`, dest: "EditorLanguages.json" },
  { kind: "file", src: `${appResources}/EditorGrammars.json`, dest: "EditorGrammars.json" },
  { kind: "file", src: `${appResources}/EditorThemes.json`, dest: "EditorThemes.json" },
  { kind: "file", src: `${appResources}/EditorTextMateThemes.json`, dest: "EditorTextMateThemes.json" },
  { kind: "dir", src: `${appResources}/Monaco/grammars`, dest: "grammars", onlyExts: [".json"] },
  // Provenance and license texts travel with the grammars they cover. Neither is
  // servable (the asset route admits only manifest-referenced .json/.wasm); they exist
  // so the committed catalog, and the public mirror that ships it, carry attribution.
  { kind: "file", src: `${appResources}/Monaco/grammars/PROVENANCE.md`, dest: "grammars/PROVENANCE.md" },
  { kind: "dir", src: `${appResources}/Monaco/grammars/LICENSES`, dest: "grammars/LICENSES", onlyExts: [".txt"] },
  // Imported themes are converted into the two theme maps above; their provenance and
  // license texts travel the same way the grammars' do.
  { kind: "file", src: `${appResources}/Monaco/themes/PROVENANCE.md`, dest: "themes/PROVENANCE.md" },
  { kind: "dir", src: `${appResources}/Monaco/themes/LICENSES`, dest: "themes/LICENSES", onlyExts: [".txt"] },
  { kind: "dir", src: `${appResources}/Monaco/language-configs`, dest: "language-configs", onlyExts: [".json"] },
  { kind: "dir", src: `${appResources}/Monaco/vs-textmate`, dest: "vs-textmate", excludeExts: [".js"] }
];

// Expand the copy plan into a flat list of absolute {source, dest} file pairs.
// Exported so the parity test can assert the committed tree matches the app source.
export async function collectCatalogFiles(repoRoot = defaultRepoRoot) {
  const pairs = [];
  for (const spec of catalogSpecs) {
    const source = resolve(repoRoot, spec.src);
    if (spec.kind === "file") {
      pairs.push({ source, dest: spec.dest });
      continue;
    }
    for (const name of (await readdir(source)).sort()) {
      const ext = extname(name).toLowerCase();
      if (spec.onlyExts && !spec.onlyExts.includes(ext)) continue;
      if (spec.excludeExts && spec.excludeExts.includes(ext)) continue;
      if (!(await stat(resolve(source, name))).isFile()) continue;
      pairs.push({ source: resolve(source, name), dest: `${spec.dest}/${name}` });
    }
  }
  return pairs;
}

export async function syncCatalogAssets({ repoRoot = defaultRepoRoot, log = () => {} } = {}) {
  const destRoot = resolve(repoRoot, catalogAssetsDir);
  const pairs = await collectCatalogFiles(repoRoot);

  // Hard guard: never copy executable code into the served catalog.
  const offending = pairs.find(({ dest }) => extname(dest).toLowerCase() === ".js");
  if (offending) {
    throw new Error(`Refusing to sync executable asset into the catalog: ${offending.dest}`);
  }

  // Rebuild the dir from scratch so removed app assets propagate (no stragglers).
  await rm(destRoot, { recursive: true, force: true });
  await mkdir(destRoot, { recursive: true });
  for (const { source, dest } of pairs) {
    const destination = resolve(destRoot, dest);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { dereference: true });
  }

  // A short README so the committed dir explains itself; not served (`.md`).
  await writeFile(
    resolve(destRoot, "README.md"),
    [
      "# Backend language catalog assets",
      "",
      "Generated by `apps/backend/scripts/sync-catalog-assets.mjs` from the visionOS app's",
      "curated editor assets (`apps/visionos/AgentRoom/Resources`). Do not edit by hand —",
      "edit the app source and re-run the sync script. The backend serves these as DATA",
      "(`.json` + `.wasm`) over the flag-gated, bearer-auth'd `/api/editor/catalog` routes.",
      "",
      "This is the only catalog the backend serves. It loads this directory once at",
      "startup. A Mac release ships a new copy, and paired visionOS clients pick it up",
      "the next time they connect.",
      ""
    ].join("\n")
  );

  log(`Synced ${pairs.length} catalog asset files into ${catalogAssetsDir}`);
  return pairs.map(({ dest }) => dest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncCatalogAssets({ log: (message) => console.log(message) }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
