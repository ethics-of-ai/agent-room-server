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

## Grammars (data) — `grammars/`

Redistributed from **microsoft/vscode @ tag `1.125.0`** (MIT). The canonical
upstream repo + commit embedded in each grammar's `version`/`information_for_contributors`
is listed below; consult the upstream repo for the grammar's original license.

| File | scope | vscode path (@ 1.125.0) | Canonical upstream @ commit |
|---|---|---|---|
| `swift.tmLanguage.json` | `source.swift` | `extensions/swift/syntaxes/swift.tmLanguage.json` | jtbandes/swift-tmlanguage @ `3fca2fa` |
| `typescript.tmLanguage.json` | `source.ts` | `extensions/typescript-basics/syntaxes/TypeScript.tmLanguage.json` | microsoft/TypeScript-TmLanguage @ `48f6086` |
| `typescriptreact.tmLanguage.json` | `source.tsx` | `extensions/typescript-basics/syntaxes/TypeScriptReact.tmLanguage.json` | microsoft/TypeScript-TmLanguage @ `48f6086` |
| `javascript.tmLanguage.json` | `source.js` | `extensions/javascript/syntaxes/JavaScript.tmLanguage.json` | microsoft/TypeScript-TmLanguage @ `48f6086` |
| `json.tmLanguage.json` | `source.json` | `extensions/json/syntaxes/JSON.tmLanguage.json` | microsoft/vscode-JSON.tmLanguage @ `9bd83f1` |
| `markdown.tmLanguage.json` | `text.html.markdown` | `extensions/markdown-basics/syntaxes/markdown.tmLanguage.json` | microsoft/vscode-markdown-tm-grammar @ `0812fc4` |
| `shell.tmLanguage.json` | `source.shell` | `extensions/shellscript/syntaxes/shell-unix-bash.tmLanguage.json` | jeff-hykin/better-shell-syntax @ `35020b0` |
| `yaml.tmLanguage.json` | `source.yaml` | `extensions/yaml/syntaxes/yaml.tmLanguage.json` | RedCMD/YAML-Syntax-Highlighter @ `c42cf86` |

Re-fetch (per file):

```bash
curl -sSL https://raw.githubusercontent.com/microsoft/vscode/1.125.0/<vscode-path> -o grammars/<file>
```

**Embedded grammars are a known, bounded limitation:** these grammars reference
other scopes (Markdown fenced code, TSX→JS). Only the curated scopes above are
registered, so embedded blocks of an unregistered language fall back to plain text
until their grammar is added.

## Language configurations (data) — `language-configs/`

Same source (microsoft/vscode @ `1.125.0`, MIT). These drive editor affordances
(comment toggling, bracket matching, auto-closing pairs), not highlighting, and
are applied in a later Phase B step (`monaco.languages.setLanguageConfiguration`).

> **Caveat — JSONC:** vscode ships most `language-configuration.json` files as
> **JSONC** (`//` comments and/or trailing commas), so they are *not* strict JSON.
> They are vendored faithfully; the consuming code must strip JSONC before
> `JSONSerialization` / `JSON.parse`. (`shell.json` and `yaml.json` happen to be
> strict JSON.)

| File | vscode path (@ 1.125.0) | Format |
|---|---|---|
| `swift.json` | `extensions/swift/language-configuration.json` | JSONC |
| `typescript.json` | `extensions/typescript-basics/language-configuration.json` | JSONC |
| `javascript.json` | `extensions/javascript/javascript-language-configuration.json` | JSONC |
| `json.json` | `extensions/json/language-configuration.json` | JSONC |
| `markdown.json` | `extensions/markdown-basics/language-configuration.json` | JSONC |
| `shell.json` | `extensions/shellscript/language-configuration.json` | strict JSON |
| `yaml.json` | `extensions/yaml/language-configuration.json` | strict JSON |

`typescriptreact` (`source.tsx`) reuses `typescript.json`.
