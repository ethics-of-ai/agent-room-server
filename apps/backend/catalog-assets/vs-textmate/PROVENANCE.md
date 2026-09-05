# Vendored TextMate highlighting assets — provenance

These assets implement the editor's data-driven TextMate highlighting engine
(language-support Phase B). They are
vendored — there is **no in-repo build/vendoring script** — so this file records
exactly where each asset came from, so it can be re-fetched and updated.

All of these are loaded with **no network access**: the engine code is
`<script>`-loaded from the private `agentroom-editor://` scheme, and the `.wasm`,
grammars, and language-configs are read by native and injected over the editor
bridge (the page runs under `connect-src 'none'`). See `MonacoSchemeHandler` and
`MonacoEditorView`.

## Engine (code) — `vs-textmate/`

| File | Package | Version | Source | License |
|---|---|---|---|---|
| `vscode-textmate.js` | `vscode-textmate` (npm) | 9.3.2 | `npm pack` → `package/release/main.js` | MIT (`vscode-textmate.LICENSE.md`) |
| `vscode-oniguruma.js` | `vscode-oniguruma` (npm) | 2.0.1 | `npm pack` → `package/release/main.js` | MIT (`vscode-oniguruma.LICENSE.txt`) |
| `onig.wasm` | `vscode-oniguruma` (npm) | 2.0.1 | `npm pack` → `package/release/onig.wasm` | MIT (`vscode-oniguruma.LICENSE.txt`) |

Both engine files are UMD bundles whose AMD branch calls an **anonymous**
`define([], factory)`. Monaco's `vs/loader.js` installs a global AMD `define`, so
these must be loaded **through the AMD loader** (`require(['vscode-textmate', …])`)
or **before** `loader.js` (their global branch sets `window.vscodetextmate` /
`window.onig`). They must not be dropped in as plain `<script>` tags *after*
`loader.js` — that hits the anonymous-define path. (Wiring is Phase B step 2.)

Re-fetch:

```bash
npm pack vscode-textmate@9.3.2 vscode-oniguruma@2.0.1
# tar xzf each; copy package/release/main.js and package/release/onig.wasm
```

## Grammars and language configurations (data)

The grammars under `grammars/` and the VS Code language configurations under
`language-configs/` are no longer vendored by hand. The maintainer importer
`apps/backend/scripts/import-editor-grammars.mjs` fetches each one verbatim from the
ref pinned in `apps/backend/scripts/editor-grammar-sources.json`, validates it as
JSON data against the catalog bounds, and writes the generated record
`grammars/PROVENANCE.md` beside the license texts in `grammars/LICENSES/`. Read that
record for the current file, scope, upstream path, and license table, and which
embedded scopes still fall back to their enclosing scope.

Re-import after changing the source table:

```bash
node apps/backend/scripts/import-editor-grammars.mjs
```

It ends by running `sync-catalog-assets.mjs`, so the committed backend catalog
stays byte-identical to this tree, and regenerates the language support matrix.

> **Caveat — JSONC:** vscode ships most `language-configuration.json` files as
> **JSONC** (`//` comments and/or trailing commas), so they are *not* strict JSON.
> They are vendored faithfully; the consuming code must strip JSONC before
> `JSONSerialization` / `JSON.parse`.
