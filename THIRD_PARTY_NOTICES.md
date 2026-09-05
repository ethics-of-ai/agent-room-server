# Third-party notices

The source code in this repository is licensed under the MIT license
([`LICENSE`](LICENSE)). The packaged `AgentRoom.app`, and the DMG that carries
it, also contain software from other parties. This file lists what the package
step (`scripts/package-macos.mjs`) puts inside the bundle and the terms each
part ships under. Each component keeps its own license file inside the bundle
where it has one.

## Node.js runtime

`AgentRoom.app/Contents/Resources/node` is a Node.js macOS distribution (the
24 LTS line for published releases). Node.js is distributed under the MIT
license together with the licenses of the components it bundles (V8, OpenSSL,
ICU, npm, and others). The distribution's own `LICENSE` file, which lists all
of them, is retained at `Contents/Resources/node/LICENSE`.

## Sparkle

`AgentRoom.app/Contents/Frameworks/Sparkle.framework` is Sparkle 2.9.6, used to
check, verify, install, and relaunch macOS app updates. Sparkle is distributed
under the MIT license. Its source package includes the license, and this notice
records Sparkle in the distributed app. Source and notices are available from
<https://github.com/sparkle-project/Sparkle>.

## npm dependencies

`AgentRoom.app/Contents/Resources/node_modules` holds the backend's dependency
tree as installed with pnpm. The authoritative inventory for a given build is
`pnpm licenses list --prod` run in `apps/backend` at the commit the release was
cut from. At the time of writing the production set falls under these licenses,
each package carrying its own license file in its directory:

| License | Packages |
| --- | --- |
| MIT | 148 packages, including `fastify` and the `@fastify/*` plugins, `@anthropic-ai/sdk`, `node-pty`, `pino`, `pyright`, `zod`, `@babel/runtime` |
| Apache-2.0 | `@connectrpc/connect`, `@connectrpc/connect-node`, `@connectrpc/connect-web` (the Cursor SDK's RPC client), `typescript`, `typescript-language-server` |
| Apache-2.0 AND BSD-3-Clause | `@bufbuild/protobuf` |
| BSD-2-Clause | `dotenv`, `json-schema-typed` |
| BSD-3-Clause | `fast-uri`, `light-my-request`, `qs`, `secure-json-parse` |
| ISC | 13 packages, including `@statsig/client-core`, `@statsig/js-client`, `fastq`, `inherits`, `isexe`, `once`, `semver`, `setprototypeof`, `yaml` |
| BlueOak-1.0.0 | `glob`, `lru-cache`, `minimatch`, `minipass`, `path-scurry` |
| Unlicense | `fast-sha256` |
| Anthropic commercial terms | `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/claude-agent-sdk-darwin-arm64` (see below) |
| Cursor Terms of Service | `@cursor/sdk`, `@cursor/sdk-darwin-arm64` (see below) |

The package step copies the pnpm virtual store as installed, so a build may
also carry development tooling alongside the production set. Those packages
keep their license files in their own directories too.

## TypeScript language service

The optional editor language-service process uses
`typescript-language-server` 5.3.0 and TypeScript 5.9.3. Both are distributed
under Apache-2.0, remain unmodified, and retain their package license files in
the application bundle. AgentRoom pins them as production dependencies so the
packaged server uses the same tested implementation as development and CI.

## Pyright language service

The optional Python editor language-service process uses Pyright 1.1.413.
Pyright is distributed under MIT, remains unmodified, and retains its package
license file in the application bundle. AgentRoom pins it as a production
dependency so the packaged server uses the same tested implementation as
development and CI.

## Claude Agent SDK and Claude Code

`@anthropic-ai/claude-agent-sdk` and its `darwin-arm64` platform package are
"© Anthropic PBC. All rights reserved" and are used subject to the agreements
at <https://code.claude.com/docs/en/legal-and-compliance>. The platform package
contains the Claude Code binary, so the DMG ships with Claude Code preinstalled.
Anthropic's published conditions for that, which AgentRoom follows:

- The Claude Code binary is not modified. AgentRoom runs it as published and
  does not remove, disable, or restrict any authentication method built into
  it.
- Each person authenticates with their own Anthropic credentials. AgentRoom
  uses the Mac user's own `claude login` session, holds no Anthropic
  credential of its own, and neither pays for, resells, nor intermediates
  Claude usage.
- AgentRoom does not use the Claude Code or Anthropic names or logos in its own
  name or branding.

The Claude Code binary stays governed by Anthropic's terms wherever it is
accessed from, including from inside this bundle.

## Cursor SDK

`@cursor/sdk` and its `darwin-arm64` platform package are "© Anysphere Inc.
All rights reserved. Use is subject to Cursor's
[Terms of Service](https://cursor.com/terms-of-service)." That sentence is the
whole license file each package ships. The platform package carries the
Anysphere-signed `cursorsandbox`, `rg`, and tree-sitter binaries the SDK's
local agent runs, so the DMG ships with the Cursor SDK preinstalled. Cursor
publishes no sentence equivalent to Anthropic's preinstall permission; what
supports bundling is that the package is published on public npm for
installation into products, and that Cursor staff have said on the record that
embedding Cursor as a backend service in a product is a supported use of the
SDK. The conditions AgentRoom binds itself to:

- The SDK and its platform binaries ship unmodified. The signing pass leaves
  Anysphere's signatures in place, so the bundle runs what Cursor published.
- Each person authenticates with their own Cursor account, through the SDK's
  own web sign-in or their own API key, on their own plan (Cursor Pro or
  better). AgentRoom holds no Cursor credential, pays for no usage, and neither
  resells nor intermediates Cursor access. Usage appears in that person's
  Cursor dashboard under the SDK tag, and Cursor's Privacy Mode applies as it
  does in the IDE.
- AgentRoom does not use the Cursor or Anysphere names or logos in its own
  name or branding; "Cursor" appears only as the runner's display name.
- AgentRoom uses no output of the runner to train a model and makes no claim
  about regulated data.

The SDK stays governed by Cursor's terms wherever it is accessed from,
including from inside this bundle. Whether shipping the unmodified package
inside an installer is covered has not yet been confirmed in writing by Cursor;
[Open source mirror](docs/operations/OPEN_SOURCE_MIRROR.md) (Decision 10)
records that as the one open licensing item.

## Editor language catalog

`AgentRoom.app/Contents/Resources/backend/catalog-assets` holds the TextMate
grammars, language configurations, themes, and the Oniguruma WebAssembly module
the backend serves to editor clients. The bundled third-party syntax data is:

- grammars and language configurations from `microsoft/vscode`, under MIT;
- Vue grammars and its language configuration from `vuejs/language-tools`,
  under MIT;
- the MDX grammar copied as JSON from `shikijs/textmate-grammars-themes`, with
  the grammar's MIT terms from `wooorm/markdown-tm-language`; and
- the MDX language configuration from `mdx-js/mdx-analyzer`, under MIT.

The exact refs and source paths are in
[`apps/backend/catalog-assets/grammars/PROVENANCE.md`](apps/backend/catalog-assets/grammars/PROVENANCE.md).
The complete terms travel with the catalog as
[`vscode.txt`](apps/backend/catalog-assets/grammars/LICENSES/vscode.txt),
[`vue.txt`](apps/backend/catalog-assets/grammars/LICENSES/vue.txt),
[`mdx.txt`](apps/backend/catalog-assets/grammars/LICENSES/mdx.txt), and
[`mdx-analyzer.txt`](apps/backend/catalog-assets/grammars/LICENSES/mdx-analyzer.txt).

`onig.wasm` comes from `vscode-oniguruma` and is used by `vscode-textmate`.
Their versions and source paths are in
[`apps/backend/catalog-assets/vs-textmate/PROVENANCE.md`](apps/backend/catalog-assets/vs-textmate/PROVENANCE.md),
with the complete
[`vscode-oniguruma` license](apps/backend/catalog-assets/vs-textmate/vscode-oniguruma.LICENSE.txt)
and
[`vscode-textmate` license](apps/backend/catalog-assets/vs-textmate/vscode-textmate.LICENSE.md)
beside it. `vscode-oniguruma` is MIT and retains the BSD terms of the Oniguruma
project it builds on. The AgentRoom themes are part of this repository and use
its MIT license. See also
[`apps/backend/catalog-assets/README.md`](apps/backend/catalog-assets/README.md).

## Everything else

The backend's `public/` debug page is part of this repository and is covered by
its MIT license.
