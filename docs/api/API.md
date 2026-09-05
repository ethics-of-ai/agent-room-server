# API

Base URL defaults to `http://<mac-host>:8787`.

Use [the documentation index](../README.md) to find the owning design or
operational guide. This document owns consumer-visible wire behavior: routes,
authentication, request and response shapes, status codes, and compatibility.

If `AUTH_TOKEN` is set, mutating requests require:

```http
Authorization: Bearer <token>
```

Secrets are never returned by API responses.

## Health

`GET /health`

```json
{
  "ok": true,
  "uptimeSeconds": 12,
  "runnerKind": "codex",
  "mode": "agent-bridge",
  "release": {
    "backendVersion": "0.3.1",
    "apiVersion": "2026-05-12",
    "minimumSupportedClientApiVersion": "2026-05-12",
    "compatibleClients": {
      "macos": { "minimumVersion": "0.1.0" },
      "visionos": { "minimumVersion": "0.1.0" }
    }
  }
}
```

`release` is the connected backend's compatibility authority. A client checks
both the product-version floor for its platform and the API-version floors. It
may be absent on an older backend; absence means unverified, not compatible.
The envelope contains public release policy only and is not bearer-gated.

## Status

`GET /api/status` returns the bridge snapshot:

```json
{
  "runnerKind": "codex",
  "uptimeSeconds": 12,
  "sessions": [
    {
      "id": "agent-session-abc123",
      "workspaceId": "workspace-abc123def456",
      "workspacePath": "/Users/me/repos/my-app",
      "runnerKind": "codex",
      "modelContextWindowTokens": 258400,
      "contextWindowUsedTokens": 14920,
      "status": "idle",
      "turnCount": 1,
      "createdAt": "2026-06-06T00:00:00.000Z",
      "updatedAt": "2026-06-06T00:00:10.000Z"
    }
  ],
  "activeSessionIds": [],
  "recentEvents": [],
  "metrics": {
    "totalSessions": 1,
    "runningSessions": 0,
    "completedTurns": 1,
    "failedTurns": 0,
    "cancelledTurns": 0,
    "inputTokens": 14898,
    "outputTokens": 22,
    "totalTokens": 14920
  }
}
```

## Config

`GET /api/config` returns safe release/config metadata: default runner kind,
`codingEventContractVersion` (which `coding_*` event contract this backend
speaks — see the WebSocket section; a client compares it against the minimum it
accepts instead of assuming the apps shipped together),
Codex runner protocol, Codex approval/sandbox/network policy, Claude Code
permission mode, provider-auth inheritance flag, and the
`claudeCodeLoadWorkspaceSkills` boolean (whether Claude Code sessions load the
registered workspace's `project` settings source; see the safety doc), the
`terminalEnabled`, `languageServicesEnabled`, and `sceneEngineEnabled`
booleans, host, port, workspace
root, state dir, auth requirement, and release compatibility.

The response never includes `AUTH_TOKEN`, `CODEX_EXECUTABLE`, `CODEX_ARGS`,
`CLAUDE_CODE_EXECUTABLE`, `SOURCEKIT_LSP_EXECUTABLE`, `TERMINAL_SHELL`, or provider credentials. Clients read
`terminalEnabled` to decide whether to offer the terminal pane,
`languageServicesEnabled` to decide whether semantic execution can be offered, and
`sceneEngineEnabled` to decide whether to offer the spatial scene volume.

### Managed settings metadata

Alongside those flat fields — which always report what this process is **running
with** — the response carries an additive `settings` block, a top-level
`remoteSettingsAdmin` boolean, and `settingsSchemaVersion`. `settings` has one
entry per *managed* setting, at **both** of its addresses:

```json
{
  "remoteSettingsAdmin": false,
  "settingsSchemaVersion": 2,
  "settings": {
    "global.runnerKind": {
      "value": "codex",
      "source": "env",
      "tier": 1,
      "editable": false,
      "requiresRestart": true
    },
    "runnerKind": { "…": "the same entry, at its version-1 key" },
    "global.terminalEnabled": {
      "value": false,
      "source": "default",
      "tier": 2,
      "valueKind": "boolean",
      "editable": false,
      "requiresRestart": true,
      "pendingValue": true
    },
    "runners.codex.sandboxMode": {
      "value": "workspace-write",
      "source": "file",
      "tier": 2,
      "valueKind": "string",
      "options": ["read-only", "workspace-write", "danger-full-access"],
      "editable": false,
      "requiresRestart": true
    },
    "codexSandboxMode": { "…": "the same entry, at its version-1 key" }
  }
}
```

- `settingsSchemaVersion` is the settings-file shape this backend applies and
  writes, and it says which address set is **canonical**: at version 2 that is the
  `global.<field>` / `runners.<runnerKind>.<field>` paths, which is where a
  setting lives in the file and which runner owns it. The flat version-1 keys are
  reported beside them for the compatibility window — a headset and a backend
  upgrade independently, so a client that only knows the flat keys keeps working —
  and both entries are the same object. A client should prefer the path when the
  response carries one and fall back to the flat key when it does not; presence is
  the advertisement.

- `source` is `env` | `file` | `default`. Precedence is exactly that: an
  environment variable wins and **locks** the key, else the backend-owned
  `$AGENTROOM_HOME/config/settings.json`, else the code default.
- `tier` is `1` (preference) or `2` (trust posture). Tier 3 — `AUTH_TOKEN`,
  executable paths, `TERMINAL_SHELL`, host/port, the storage directories — is
  absent from this block **by construction**, which is what keeps an ungated
  `GET /api/config` non-secret. Which settings appear here is the backend's
  registry answer: the globals it declares plus the settings each registered
  runner declares, so a runner the backend registers brings its own settings with
  it rather than waiting for a client release.
- `valueKind` is `string` | `boolean` | `number`, and `options` is the closed
  vocabulary the setting's declaration accepts. Together they are what lets a
  client render a setting it was **not built with** — a runner the backend
  registers brings its settings along, so a client that could only draw keys it
  compiled in would leave an operator's posture unreachable. `valueKind` is
  reported for every setting, including one whose `value` is absent, because that
  is exactly the case a client could infer no shape from. `options` is present
  only where the declaration bounds the value: an open one (a model id, a
  timeout) omits it and the backend's schema stays the authority for what is too
  long or too large, and `runnerKind` omits it because its vocabulary is the live
  registry's — `GET /api/runners` is where a client reads that. A client should
  render a control from these rather than from a guess: offering free text for a
  key with `options` makes a value the PATCH refuses look like a valid edit.
- `editable` folds both policies into the one flag a client should render from:
  it is false for an env-locked key, and false for a tier-2 key while
  `remoteSettingsAdmin` is off.
- `requiresRestart` is always `true`. Config is snapshotted once at startup and
  routes are registered-or-absent from that snapshot, so everything managed
  applies on backend restart.
- `pendingValue` appears only when the file on disk no longer agrees with the
  running snapshot: it is the value a restart would produce, or `null` when a
  restart would leave the key unset. It is omitted for an env-locked key (a file
  value there is inert, not pending) and whenever the file could not be read.
  The route re-reads the file per request to derive it — compose-on-read, no
  watcher.

### `PATCH /api/config`

Changes managed settings by merging a partial patch into
`$AGENTROOM_HOME/config/settings.json`. It writes that one JSON file in the
backend-owned config directory — never a registered workspace, never an
executable path, never a shell — and adds no runtime reconfiguration: the change
takes effect when the operator restarts the backend from the Mac app.

Body: an object whose keys are managed setting addresses — the canonical
version-2 path, or the version-1 flat key, in whatever mix a client sends. An
explicit `null` clears a setting back to its code default; an absent one is left
untouched. The merge is serialized per process and is all-or-nothing.

```bash
curl -X PATCH http://127.0.0.1:8787/api/config \
  -H 'authorization: Bearer <token>' -H 'content-type: application/json' \
  -d '{"runners.codex.model":"gpt-5-codex","runners.codex.reasoningEffort":null}'
```

Naming one setting at both addresses in the same body is a `400` carrying
`duplicatedKeys`, not a resolution: assigning precedence would apply a value the
caller did not send. `restrictedKeys`, `lockedKeys`, and the `config_reloaded`
event's `changedKeys` all report **canonical paths**, and still names only.

A patch that changes something also migrates the settings file to the version-2
document if it was still the flat version-1 shape — whole, in one atomic write.
A patch that changes nothing writes nothing.

Statuses:

| Status | When |
|---|---|
| `200` | Applied (or a no-op). Body is the refreshed `GET /api/config` projection, so the client re-renders from one reply. |
| `400` | Unknown key, a value the managed schema rejects, or one setting named at both of its addresses (body carries `duplicatedKeys`). Unknown keys are never silently ignored, and a tier-3 key has no entry in the schema, so asking for one is refused as a typo would be. |
| `401` | `AUTH_TOKEN` is configured and the bearer token is missing or wrong (the global mutating-method preHandler). |
| `403` | The patch names a tier-2 key while `remoteSettingsAdmin` is off. Body carries `restrictedKeys`. |
| `409` | The patch names an environment-locked key (body carries `lockedKeys`); the settings file on disk cannot be parsed and merging would drop the operator's other keys; or the file declares a settings schema this backend cannot read (body carries `settingsSchemaVersion`, and the fix is updating AgentRoom on the Mac rather than resetting the file). |
| `503` | The backend resolved no managed settings path (not reachable from a normal startup). |

The tier-2 gate is checked **before** the environment lock, because "trust
settings can only be changed on the Mac" is the more actionable answer when both
apply. The gate itself is `REMOTE_SETTINGS_ADMIN`, an environment-only master
switch the macOS app injects — deliberately *not* a managed key, since a key in
the file could be granted by whoever already holds the bearer token. See
`docs/safety/TRUST_AND_SAFETY.md`.

A patch that changes at least one key publishes one `config_reloaded` event (see
WebSocket below). A patch that changes nothing publishes none.

## Runners

`GET /api/runners` reports which coding-agent runners this backend registers:

```json
{
  "runners": [
    {
      "runnerKind": "codex",
      "displayName": "Codex",
      "registered": true,
      "configured": false,
      "enabled": true
    },
    {
      "runnerKind": "claude_code",
      "displayName": "Claude Code",
      "registered": true,
      "configured": true,
      "enabled": true,
      "ready": true
    }
  ]
}
```

This is the safe/public projection of the backend's runner registry, and clients
render their runner pickers from it rather than from a compiled-in list — so a
runner the backend registers is selectable without shipping the apps again. The
states are reported separately on purpose: `registered` means the backend
knows the id, `configured` means the bootstrap it cannot start without is
present (Codex needs `CODEX_EXECUTABLE`; DeepSeek Harness needs both
`DEEPSEEK_EXECUTABLE` and the `DEEPSEEK_CORDIS_CONFIG` composition its runtime
refuses to start without; the Claude Agent SDK resolves its own
bundled CLI, so Claude Code is configured without one, and the bundled Cursor
SDK resolves its own sign-in, so Cursor is too), and `enabled` means the
operator has turned it on. Collapsing them is what produces a runner that reads
ready in a client and cannot start.

`ready` is the fourth state and a **different authority**: not what the operator
configured, but what the adapter proved at runtime — that the backend could spawn
the child, complete the handshake, and read its model list. It is therefore
**absent until something has asked**, and absent is not `false`: nothing here
spawns a probe, so a poll of this route costs nothing and N registered runners
never mean N children at startup. Reading a runner's capabilities
(`GET /api/coding-agent/capabilities?runnerKind=…`) *is* the probe, and the next
read of this route reports what it proved — for that runner alone. The state is
per backend process, so a restart returns it to unknown. A failed probe reports
`ready: false` and nothing else: the child's own diagnostic text stays on the
bounded `error` of the capabilities response and never joins this projection.

The other authority is the Mac's, and it is deliberately not here: whether the
local prerequisite is satisfied (an installed CLI, a `claude login` credential)
must be answerable while the backend is **stopped**, which is exactly when this
route cannot be reached, so the macOS app answers that one locally. See
`docs/engineering/RUNNERS.md` and `docs/clients/MACOS.md`.

Deliberately absent: every descriptor field the backend decides behavior from
(prompt delivery, turn-diff source, workspace-skill policy, restore strategy),
and anything tier-3. An executable path, an environment variable name, or a
Keychain slot is never in a descriptor, so `configured` reports *that* the
operator supplied a runner's bootstrap without reporting what it is.

The list is not fixed at build time. Besides the four runners AgentRoom ships
(`codex`, `claude_code`, `deepseek`, `cursor`), it
includes any **externally configured ACP adapter** the operator defined in
`ACP_ADAPTERS` while `ACP_ADAPTERS_ENABLED` is on (ids are namespaced `acp_*`).
Such a runner appears here exactly like a built-in one — id, display name,
availability, and the observed `ready` — and its tier-3 definition (the
executable, its arguments, the environment names it was granted) appears
nowhere: not on this route, not in `config/runners.json`, and not in
`GET /api/config`. Clients need no change to offer it, which is the point of
hydrating pickers from this route. `POST /api/agent-sessions` accepts its id as
`runnerKind` because the runner-id schema resolves against the live registry
rather than a compiled-in enum. See `docs/safety/TRUST_AND_SAFETY.md`.

Like `GET /api/config`, this read is not gated by the mutating-method bearer
check: it is the operator's posture, not their credentials. A backend that
predates the route answers `404`. The Mac falls back to its full bundled
identity floor because its settings UI must work while the backend is stopped;
a remote client falls back only to runners that predate the route, so a newly
bundled runner is not advertised without this endpoint's availability metadata.
A backend that starts successfully also writes this projection to
`$AGENTROOM_HOME/config/runners.json` — minus `ready`, which a backend that has
just started has proved nothing about and a stopped one could only misreport —
and that file is the macOS app's offline floor:
its settings panes work while the backend is stopped, which is exactly when they
cannot ask. That file is a cache the backend never reads, and the Mac falls back
to its bundle for an absent, unreadable, empty, or newer-versioned one. Clients
must render a runner id they have no descriptor for as itself —
never resolved to a known runner. See `docs/safety/TRUST_AND_SAFETY.md` and
`docs/engineering/RUNNERS.md`.

## Coding Agent Capabilities

`GET /api/coding-agent/capabilities` returns safe client-renderable controls
for the configured coding agent. The optional
`?runnerKind=codex|claude_code|deepseek|cursor`
query selects a specific runner; without it the route serves the backend's
default runner (`RUNNER_KIND`). For Codex JSON-RPC, the backend asks the local
Codex app-server for `model/list` and maps visible model, optional advertised
context window token capacity, reasoning effort, and speed choices into a
stable AgentRoom shape. Codex speed is presented as `standard` and, when the model
exposes it, `fast`. Standard speed is the implicit Codex default; selecting it
does not send a service tier override to Codex:

```json
{
  "runnerKind": "codex",
  "settings": {
    "models": [
      {
        "id": "gpt-example",
        "label": "GPT Example",
        "description": "Model description",
        "contextWindowTokens": 128000,
        "isDefault": true,
        "reasoningEfforts": [
          { "id": "minimal", "label": "Minimal", "description": "Lower reasoning" },
          { "id": "high", "label": "High", "description": "Higher reasoning" }
        ],
        "defaultReasoningEffort": "minimal",
        "serviceTiers": [
          { "id": "standard", "label": "Standard", "description": "Standard Codex speed" },
          { "id": "fast", "label": "Fast", "description": "1.5x speed, increased usage" }
        ],
        "defaultServiceTier": "standard"
      }
    ],
    "defaultSettings": {
      "model": "gpt-example",
      "reasoningEffort": "minimal",
      "serviceTier": "standard"
    }
  }
}
```

If Codex is not configured or cannot expose models, the route still returns an
empty settings list plus a bounded error string.

For `claude_code`, the backend discovers models live through the Claude Agent
SDK `supportedModels()` control request and maps them into the same shape with
reasoning effort choices (`low`, `medium`, `high`, `xhigh`) and an empty
`serviceTiers` list (Claude Code has no speed-tier analog). Successful
discovery results are cached briefly per backend process so repeated
capability reads do not each spawn an SDK session. If discovery fails, a
hardcoded fallback catalog of current Claude model aliases is returned with a
bounded error string; fallback responses are not cached, so the next request
retries live discovery.

For a configured **ACP adapter**, the descriptor comes from the `configOptions`
list the agent returns on `session/new` — the readiness probe already performs
that handshake, so discovery asks no extra question and spawns no extra child.
ACP v1 has no model-*list* method, but `configOptions` carries selectors tagged
with a reserved category. `model` becomes `models`, and `thought_level` becomes
each model's `reasoningEfforts`; that effort list is session-scoped in ACP rather
than per-model, so the same list appears on every model. Generic `model_config`
is not reported as `serviceTiers`: ACP treats the category as a UX hint that may
mean context size, speed/quality, or several controls, none of which can be
represented honestly by selecting the first one and labelling it "Speed". The
fourth category, `mode`, is **never reported**: it is the
agent's own sandbox/approval posture, and turn settings carry none of the tier-2
gating that every other runner posture has — see
`docs/safety/TRUST_AND_SAFETY.md`. An agent that offers no model selector, or one
whose only selectors are unmappable, yields the same empty settings list any
unconfigured runner does. A selection sent with a turn is applied to the session
with `session/set_config_option` before the prompt; a value the agent did not
list, or a field it offers no selector for, fails the turn rather than being
silently dropped. The setter's complete refreshed list must confirm the selected
value. Agent-initiated `config_option_update` notifications replace the live
session record even between turns, so a later selection is never skipped against
stale state.

For `cursor`, the backend reads the live catalog through the bundled Cursor SDK
(`Cursor.models.list()`) inside a throwaway host child, and the read is the
runtime-readiness probe: spawn, `initialize`, `models/list`, `shutdown`. Each
model's depth parameter (`effort` on Anthropic, Grok, and Gemini models,
`reasoning` on OpenAI, Kimi, and GLM models) becomes its `reasoningEfforts`,
and the boolean `fast` parameter becomes `serviceTiers` (`standard`, `fast`). A
model that declares neither carries empty lists rather than borrowed ones, and
the variant Cursor marks as the model's default supplies
`defaultReasoningEffort` and `defaultServiceTier`. `thinking` and `context` are
not selectable AgentRoom turn settings. When the default variant declares a
bounded `context` value such as `300k` or `1m`, it is projected as the model's
`contextWindowTokens`; Cursor Auto and models without that metadata omit the
field. A selection sent with a turn rides the SDK's `ModelSelection.params`
under the parameter name the model declared;
a value the model does not offer fails the turn rather than running at the
model's default. The managed `runners.cursor.reasoningEffort` is different: it
is one operator default for every model, so it applies where the selected model
offers it and is otherwise left out, because Cursor's vocabularies differ per
model and a default that fits Claude Opus 5 would otherwise fail every turn on
Composer. Successful discovery is cached for five minutes; a failed probe
returns the static fallback catalog with a bounded error and is not cached.

Note that `reasoningEffort` on a turn is an **open id bounded by shape**, not a
closed vocabulary: the list a client renders comes from the model's own
`reasoningEfforts`, and a registered runner may advertise values outside the
Codex and Claude Code managed-setting vocabulary (a configured ACP adapter can offer `max` or `ultra`; Cursor
offers `extra-high` and `max`). The closed `none|minimal|low|medium|high|xhigh`
vocabulary still bounds the `codexReasoningEffort` and
`claudeCodeReasoningEffort` *managed settings*, which `GET /api/config` reports
as those keys' `options`; `cursorReasoningEffort` is open for the reason above,
so it reports none.

The active thread's effective context window is exposed on agent sessions as
`modelContextWindowTokens` when a runner reports one. That runtime value is
preferred over the optional model-list `contextWindowTokens` field because a
runner may apply an effective thread window that differs from its catalog
default. When a runner reports `contextWindowUsedTokens` without either
capacity field, clients can still show the latest request footprint but must
not present the missing capacity as still loading indefinitely.

Beside those sits `contextCompactionThresholdTokens`, the occupancy at which
the session's runner auto-compacts. Only a runner that publishes the number
reports one. Claude Code reads it from the live CLI child at turn start; Codex
keeps its limit internal, Cursor summarizes on a schedule it does not publish,
and DeepSeek reports nothing. Absence therefore means unknown, never "this
runner does not compact", and a client must render that absence as absence
rather than drawing a line at some share of the capacity. A failed, timed-out,
or unsupported threshold read supplies no new knowledge and preserves the last
runner-reported value. A valid Claude Code response that says auto-compaction
is disabled, or has no usable threshold, clears the cached value. The value is
persisted with the session record, so a restored thread carries its pre-restart
threshold until a later authoritative read replaces or clears it.

## Editor Language Catalog

These routes let the visionOS editor source its syntax-highlighting assets
(VS Code-grade TextMate grammars, themes, language configurations, and the
Oniguruma WASM) from the backend so new or updated languages ship without an app
update. The assets are **app/global catalog data, not workspace files**; these
routes never touch a registered workspace or the workspace file API. The reads
(`GET /api/editor/catalog`, `/asset`, and `/status`) require the bearer token
when `AUTH_TOKEN` is configured; the operator `POST /api/editor/catalog/reload`
is mutating and is bearer-gated by the global preHandler. All are gated by
`LANGUAGE_CATALOG_ENABLED` (default on); when disabled, or when the served asset
directory is absent, the read routes return `404` and clients fall back to their
bundled editor assets.

`GET /api/editor/catalog` returns a versioned manifest. Small assets (the
language map, themes, scope themes, and per-language configurations) are inlined;
large assets (grammars and the Oniguruma WASM) are referenced by content hash and
fetched separately. `version` is an aggregate content hash, so it changes only
when an asset changes, driving the client's incremental, content-addressed cache.
`schemaVersion` is independent from that hash; absence means schema 1 for an old
server, while schema 2 admits dependent scopes, injections, embedded-language
mappings, and grammar provenance.

At schema 2 a grammar entry carries what the editor page needs beyond the
grammar's own bytes. `injectionScopes` names the grammars injected into that root
scope (Vue's directive grammar into HTML, the JSDoc grammar into TypeScript).
`embeddedLanguages` maps an embedded scope to the language id that owns it
(`source.css` inside HTML is `css`), so the encoded token metadata names the
embedded language and bracket matching follows it. `dependencyScopes` is derived
by the backend from the grammar's own `include` rules and lists the catalog scopes
it reaches; it is never declared, so a catalog cannot claim a dependency it does
not use or hide one it does. `provenance` records the family, the pinned upstream
source, its version, and its license. `scopeGrammars` holds the auxiliary grammars
that have no language of their own: dependencies (`text.html.basic`, the versioned
YAML grammars) and injections. A client defines every grammar in both lists before
activating a language, so an `include` and an injection both resolve on the page.
An `include` no grammar supplies is not an error; text under that scope tokenizes
as its enclosing scope, and the status route counts those scopes.

```json
{
  "catalog": {
    "schemaVersion": 2,
    "version": "<sha256-hex>",
    "languageMap": {
      "version": 3,
      "languages": [
        {
          "id": "html",
          "displayName": "HTML",
          "syntaxSource": "textmate",
          "extensions": ["html", "htm", "xhtml"],
          "modelineIds": ["html"]
        }
      ]
    },
    "grammars": [
      {
        "languageId": "html",
        "scopeName": "text.html.derivative",
        "grammar": { "path": "grammars/html-derivative.tmLanguage.json", "sha256": "...", "bytes": 1399 },
        "languageConfig": "{ /* VS Code language configuration (JSONC) */ }",
        "embeddedLanguages": { "source.css": "css", "source.js": "javascript" },
        "injectionScopes": ["vue.directives", "vue.interpolations"],
        "dependencyScopes": ["text.html.basic"],
        "provenance": {
          "family": "vscode",
          "source": "github.com/microsoft/vscode@1.125.0/extensions/html/syntaxes/html-derivative.tmLanguage.json",
          "version": "1.125.0",
          "license": "MIT"
        }
      }
    ],
    "scopeGrammars": [
      {
        "scopeName": "text.html.basic",
        "grammar": { "path": "grammars/html.tmLanguage.json", "sha256": "...", "bytes": 84416 },
        "dependencyScopes": ["source.css", "source.js"],
        "provenance": { "family": "vscode", "source": "...", "version": "1.125.0", "license": "MIT" }
      },
      {
        "scopeName": "vue.directives",
        "grammar": { "path": "grammars/vue-directives.tmLanguage.json", "sha256": "...", "bytes": 385 },
        "dependencyScopes": ["text.html.vue"],
        "provenance": { "family": "vue", "source": "...", "version": "v3.3.11", "license": "MIT" }
      }
    ],
    "themes": { "AgentRoom-Light": { }, "AgentRoom-Dark": { } },
    "textMateThemes": { "AgentRoom-Light": { }, "AgentRoom-Dark": { } },
    "engine": { "onigWasm": { "path": "vs-textmate/onig.wasm", "sha256": "...", "bytes": 473151 } }
  }
}
```

`GET /api/editor/catalog/asset?path=grammars/swift.tmLanguage.json` returns one
referenced blob as raw bytes with the matching `Content-Type` (`application/json`
or `application/wasm`) and `Cache-Control: no-store`. The path is bounded to the
curated asset directory exactly like the workspace read routes (lexical
normalization rejecting `..`/absolute/NUL, realpath containment, symlink-leaf
refusal for every path component) and is additionally restricted to a **`.json`/`.wasm` extension
allowlist** and to **paths the manifest references** — the route never serves
executable code (`.js`) or unreferenced files. Status codes: `400` for a
malformed or missing `path`, `401` when `AUTH_TOKEN` is configured and the bearer
token is missing, `404` for an unknown/unreferenced/absent asset or when the
catalog is unavailable. The visionOS client verifies each returned blob's
`sha256` against the manifest before use. The backend validates the complete
snapshot under the documented catalog bounds and pins the accepted generation's
bytes in memory, so later disk changes cannot make a manifest disagree with a blob.
Both theme maps must define `AgentRoom-Light` and `AgentRoom-Dark`, the names every
client resolves; a catalog missing either is rejected whole.

`GET /api/editor/catalog/status` reports which catalog is live for the macOS
Languages pane (Phase C.5). It returns no asset bytes — only whether the catalog
is `enabled`, the `source` of the live snapshot (`override` for the operator
`EDITOR_CATALOG_DIR`, `bundled` for the shipped `catalog-assets`, or `none`),
schema versions, total detected languages, syntax-provider and grammar counts,
how many embedded scopes the live grammars include that no grammar supplies
(`unresolvedScopeCount`; text under those scopes stays on its enclosing scope),
and a bounded validation code/location:

```json
{
  "enabled": true,
  "source": "override",
  "version": "<sha256-hex>",
  "schemaVersion": 2,
  "languageMapVersion": 3,
  "languageCount": 76,
  "syntaxProviders": { "monaco": 64, "textmate": 12, "plaintext": 0 },
  "primaryGrammarCount": 12,
  "scopeGrammarCount": 14,
  "unresolvedScopeCount": 73,
  "validation": { "state": "accepted", "code": null, "location": null }
}
```

`POST /api/editor/catalog/reload` re-resolves the catalog from disk (the operator
`EDITOR_CATALOG_DIR` when it holds a manifest, else the bundled `catalog-assets`,
else none) and atomically swaps in the new snapshot. A malformed runtime candidate
is rejected and the last accepted snapshot remains live; an invalid startup
override uses the bundled snapshot. It is a mutating route, so it
requires the bearer token when `AUTH_TOKEN` is configured. When the aggregate
`version` actually changes, the backend broadcasts an `editor_catalog_changed`
event over `WS /api/events` so connected visionOS editors re-hydrate live; an
idempotent reload that changes nothing emits no event. The response reports the
outcome and repeats the status route's counts and validation fields (abbreviated
here):

```json
{
  "reloaded": true,
  "accepted": true,
  "source": "override",
  "version": "<sha256-hex>",
  "changed": true,
  "validation": { "state": "accepted", "code": null, "location": null }
}
```

`accepted: false` means the candidate was rejected, `changed` is false, and the
reported source/version still identify the previous live generation.

## Editor Language Services

`GET /api/editor/language-services` is the safe, probe-free registry projection
for Mac-hosted editor semantics. It is always present, including when execution
is disabled. Reading it never resolves an executable or starts a child:

```json
{
  "protocolVersion": 1,
  "services": [
    {
      "id": "sourcekit_lsp",
      "displayName": "SourceKit-LSP",
      "configured": true,
      "enabled": false,
      "languageIds": ["swift", "c", "cpp", "objective-c"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols", "semantic_tokens"]
    },
    {
      "id": "typescript_language_server",
      "displayName": "TypeScript Language Server",
      "configured": true,
      "enabled": false,
      "languageIds": ["typescript", "typescriptreact", "javascript"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols", "semantic_tokens"]
    },
    {
      "id": "pyright_language_server",
      "displayName": "Pyright Language Server",
      "configured": true,
      "enabled": false,
      "languageIds": ["python"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols"]
    },
    {
      "id": "rust_analyzer",
      "displayName": "rust-analyzer",
      "configured": false,
      "enabled": false,
      "languageIds": ["rust"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols", "semantic_tokens"]
    },
    {
      "id": "gopls",
      "displayName": "gopls",
      "configured": false,
      "enabled": false,
      "languageIds": ["go"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols", "semantic_tokens"]
    },
    {
      "id": "eclipse_jdt_ls",
      "displayName": "Eclipse JDT Language Server",
      "configured": false,
      "enabled": false,
      "languageIds": ["java"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols"]
    },
    {
      "id": "kotlin_lsp",
      "displayName": "Kotlin Language Server",
      "configured": false,
      "enabled": false,
      "languageIds": ["kotlin"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols", "semantic_tokens"]
    },
    {
      "id": "csharp_ls",
      "displayName": "csharp-ls",
      "configured": false,
      "enabled": false,
      "languageIds": ["csharp"],
      "featureKinds": ["completion", "hover", "definition", "document_symbols"]
    }
  ]
}
```

`ready` is omitted until an authenticated socket has attempted that descriptor
in the current backend process. A successful initialization records `true`; a
failed attempt records `false`. The projection never contains an executable
path, argv, environment name or value, stderr, project path, or document text.

`WS /api/workspaces/:workspaceId/editor/language-service` is registered only
when the tier-2 `LANGUAGE_SERVICES_ENABLED` setting is true (default false).
Otherwise the upgrade is a plain `404`. When `AUTH_TOKEN` is configured, the
handler verifies `Authorization: Bearer <token>` before accepting document
content or resolving a language server. The optional tier-3
`SOURCEKIT_LSP_EXECUTABLE` is an absolute executable override; without it the
first authenticated open resolves the active Xcode toolchain with the fixed
`xcrun --find sourcekit-lsp` command. TypeScript and JavaScript use pinned
production dependencies: the current Node runtime starts the resolved
`typescript-language-server` 5.3.0 CLI with fixed `--stdio` argv and supplies
the resolved TypeScript 5.9.3 `tsserver.js` as a fixed initialization option.
Automatic type acquisition is disabled, so the server does not invoke npm to
fetch ambient types. Python uses pinned Pyright 1.1.413: the current Node
runtime starts the resolved `pyright/langserver.index.js` entry with fixed
`--stdio` argv. It advertises completion, hover, definition, and document
symbols, but not semantic tokens. The bundled services have no executable
override or managed setting.

Rust, Go, Java, Kotlin, and C# use optional operator-installed services selected
only by the tier-3 environment values `RUST_ANALYZER_EXECUTABLE`,
`GOPLS_EXECUTABLE`, `JDTLS_EXECUTABLE`, `KOTLIN_LSP_EXECUTABLE`, and
`CSHARP_LS_EXECUTABLE`. Each value must name an absolute executable regular
file that is not a symlink; AgentRoom never searches `PATH` for these servers.
The admitted versions and fixed argv are rust-analyzer 2026-08-31 with no
arguments, gopls 0.23.0 with `serve` and fixed semantic-token initialization,
Eclipse JDT LS 1.61.0 with a unique backend-owned `-data` directory, Kotlin LSP
262.9593.0 alpha with `--stdio`, and csharp-ls 0.27.0 with `--loglevel warning`.
These values and launch details are never managed settings or public fields.

An operator can add an external LSP descriptor without changing either Apple
client. This path has a second default-off gate,
`EXTERNAL_LANGUAGE_SERVICES_ENABLED`, and reads definitions only from the
tier-3 `LANGUAGE_SERVICE_ADAPTERS` environment value. Both that gate and the
global `LANGUAGE_SERVICES_ENABLED` switch must be on before the descriptor can
run. The JSON value is capped at 64 KiB and eight definitions; a malformed,
duplicated, overlapping, or over-limit list is ignored as a whole. Each
definition supplies a namespaced `external_lsp_*` id, display name,
operator-tested version, absolute executable, fixed argv, one or more language
ids, bounded exact or dot-suffix project markers, standalone-root policy, a
subset of the five feature kinds, and optional non-credential environment
grants. External language ids must be unique and cannot overlap a built-in, so
an environment definition cannot replace the implementation selected for Swift,
TypeScript, Python, Rust, Go, Java, Kotlin, or C#.

The executable must be a regular executable file and not a symlink; it is
realpath-resolved again at launch. Its child receives only the base language
service environment (`PATH`, `HOME`, `TMPDIR`, locale, and user names) plus
explicit non-credential grants. External descriptors are treated as able to
invoke project build tools and load plugins, regardless of their implementation,
because configuration cannot make an arbitrary binary less trusted. They use
the existing bounded work-done-progress and null workspace-configuration
responses; every other server request is refused. The safe registry projection
still returns only id, display name, configured/enabled/observed-ready state,
language ids, and feature kinds. It never returns the definition, executable,
argv, markers, version, or environment names and values.

Client frames form a closed protocol: `open` carries one workspace-relative
path, language id, positive `clientVersion`, and full text; `change` carries a
newer version and full text; `request` carries a unique request id, the current
client version, one of the five named feature kinds, and an applicable UTF-16
position/range; `cancel` names that request id; `close` releases the document.
There is no field for an LSP method, command, executable, environment, HTML, or
arbitrary JSON. Server frames are `status`, `diagnostics`, `response`, or a
stable-code `error`; status, diagnostic, and response frames carry the client
version used by the backend. Status describes the current connection and may
precede edits queued during startup or replay; diagnostics and feature results
apply only to their exact document version. Positions are zero-based UTF-16 code units
and ranges are half-open.

The backend realpath-bounds the regular, non-secret, non-symlink document, walks
ancestors no higher than its registered workspace, and selects the nearest
descriptor-owned project marker. Same-directory marker priority breaks a tie;
an unresolved tie reports `ambiguous_project`. One process is shared only by
the same `(workspaceId, descriptorId, projectRoot)`, and one authenticated
socket leases a workspace path at a time (`document_busy` for a competitor).
The TypeScript descriptor gives `tsconfig.json` and `jsconfig.json` equal
priority above `package.json`; files with no marker use the registered workspace
root. The Pyright descriptor prefers `pyrightconfig.json` over `pyproject.toml`
and then Django's `manage.py`; it also permits the registered workspace root for
standalone files. rust-analyzer prefers `rust-project.json` over `Cargo.toml`;
gopls prefers `go.work` over `go.mod`; Eclipse JDT LS prefers Eclipse project
metadata, then Maven, then Gradle; Kotlin LSP prefers Gradle settings, then
Gradle build files, then Maven; csharp-ls prefers `.slnx`, `.sln`, then
`.csproj`. Rust, Go, Java, and Kotlin permit standalone workspace-root files;
csharp-ls requires a project marker and otherwise reports `project_not_found`.

The fixed ceilings are 8 processes globally/4 per workspace, 32 documents per
process, 256 KiB per shadow, 32 MiB of shadow text globally, 4 MiB per LSP
frame, 4 MiB queued stdin per child including active writes and framing bytes,
384 KiB inbound/2 MiB outbound per socket frame, separate 8-frame/512 KiB
inbound-operation and send queues, and 16 outstanding requests per socket/64 per process. Initialize,
feature, and shutdown deadlines are 20 s/10 s/3 s; changes coalesce for 150 ms;
idle children close after 10 minutes; at most three crash restarts occur in five
minutes. Replay uses the latest in-memory draft and a new LSP version—it never
rereads an unsaved buffer from disk.

Normalized results cap diagnostics/completions/definitions at 500/200/20,
document symbols at 1,000 nodes and depth 16, and semantic tokens at 20,000
five-integer tokens. A completion can carry optional plain `insertText`, capped
at 256 KiB, separately from its display `label`; `textEdit` takes precedence.
Commands, snippets, additional edits, insert-replace edits, outside-workspace
definitions, and unknown server requests are omitted or refused. Documentation
and diagnostics preserve literal text, including code punctuation and markup
source. Clients disable HTML rendering and executable links.
Each descriptor owns its fixed server-request allowlist.
SourceKit-LSP answers bounded `window/workDoneProgress/create` only. The
TypeScript, Pyright, rust-analyzer, gopls, Eclipse JDT LS, Kotlin LSP, and
csharp-ls language servers also receive one fixed `null` per bounded
`workspace/configuration` item. Buffer and server payloads are never logged.
The complete execution posture is in
`docs/safety/TRUST_AND_SAFETY.md`.

## Workspaces

### Registration and listing

`GET /api/workspaces` returns registered local workspaces.
For Git repositories, each workspace snapshot includes the current branch,
local branches, whether a local branch is current, `hasRemote` (true for any
configured remote, regardless of its name), the `origin` URL when available,
and whether uncommitted or untracked changes are present.

Each branch — and the snapshot itself, for the current branch — also carries its
tracking state when it has an upstream: `upstream` (`origin/main`), `ahead` and
`behind` commit counts, and `upstreamGone` when the upstream ref no longer exists
on the remote. A branch with no upstream reports none of these, which is how a
client knows a push means *publishing*. The counts come from the remote-tracking
ref, so they are only as fresh as the last fetch — `POST …/git/fetch` is what
refreshes them. All of it comes from the single `for-each-ref` that already built
the branch list, so the snapshot costs no extra Git invocation.

`POST /api/workspaces`

```json
{
  "path": "/Users/me/repos/my-app",
  "name": "my-app",
  "kind": "user_selected"
}
```

The path must be an existing absolute directory. Registration stores metadata
under `STATE_DIR` and does not write files inside the selected workspace.

### Tree and file preview

`GET /api/workspaces/:workspaceId/tree?path=&depth=3` returns a bounded,
read-only folder tree for a registered workspace. Generated and local-state
directories such as `.git`, `node_modules`, `dist`, `build`, and `.agentroom`
are hidden. Paths are workspace-relative and must stay inside the registered
workspace, including after symlink resolution. Each file entry's `previewable`
flag marks a non-binary, non-secret text file within the 256 KB write cap — one
the editor can open (and, when writable, save).

```json
{
  "workspaceId": "workspace-abc123def456",
  "path": "",
  "entries": [
    {
      "type": "directory",
      "name": "apps",
      "path": "apps",
      "children": []
    },
    {
      "type": "file",
      "name": "README.md",
      "path": "README.md",
      "sizeBytes": 512,
      "previewable": true
    }
  ]
}
```

`GET /api/workspaces/:workspaceId/file-preview?path=README.md` returns a
bounded UTF-8 preview for a workspace-relative file. Secret-like files and
binary files are not previewable. The optional `maxBytes` query parameter raises
the read cap from the 24 KB browse default up to the 256 KB write cap and is
itself bounded to that cap (a larger value is rejected with `400`); the editor
sends it to load a file in full for editing, so a file between 24 KB and the
write cap comes back with `truncated: false` and stays editable instead of
read-only. When `AUTH_TOKEN` is configured, workspace tree and file-preview
reads require the bearer token because they expose project structure and file
contents.

### File index and content search

`GET /api/workspaces/:workspaceId/files?query=app&limit=50` returns a bounded,
ranked index of a registered workspace's files, backing quick-open and the
composer's `@` mention picker. `query` is optional (trimmed, at most 200
characters; absent or empty means "unfiltered"); `limit` is an optional integer
from 1 to 200 and defaults to 50.

```json
{
  "workspaceId": "workspace-abc123def456",
  "query": "app",
  "files": [
    { "path": "src/app.ts", "name": "app.ts", "previewable": true },
    { "path": "docs/app-notes.md", "name": "app-notes.md", "previewable": true }
  ],
  "truncated": false
}
```

Entries carry path metadata only, never file content, and `previewable` has the
same meaning as in the tree read. Ranking runs backend-side and is
case-insensitive, best tier first: exact basename, basename prefix, basename
substring, path substring, then a subsequence ("fuzzy") match over the whole
path. Ties break on the shorter path and then alphabetically, so the order is
stable for a given index — which also means an unfiltered listing is
shortest-path-first rather than alphabetical. `truncated` is `true` when the
enumeration hit its 20,000-path cap or when ranked candidates remained beyond
the ones the response returned.

The enumeration behind the index is shared with the content search below and
cached per workspace for about 15 seconds, so a client typing into either
surface does not re-enumerate (or re-fork Git) per keystroke; concurrent misses
share one build. For a Git workspace it comes from a fixed
`git ls-files -z --cached --others --exclude-standard` invocation — no shell, no
client-supplied arguments — run with the registered workspace as the working
directory: tracked plus untracked-but-not-ignored paths, `.gitignore` respected
for free, and nothing above the registered directory even when that directory
sits inside a larger repository. Any other workspace (including one whose Git
invocation fails) falls back to a bounded filesystem walk. Every path, including
one that came back from Git, must still pass the read routes' lexical bounding
and the tree read's secret-name/generated-directory filters before it enters the
index, and realpath containment is re-checked when an entry is returned, so a
symlink pointing out of the workspace is skipped rather than followed. The cache
is dropped when a workspace mutation creates, renames, or deletes a path, and
when a branch switch changes the checkout, so both surfaces observe those
immediately.

Status codes: `400` for an invalid query (an over-long `query`, a `limit` outside
1–200), `401` when `AUTH_TOKEN` is configured and the bearer token is missing
(the index exposes project structure), and `404` for an unknown workspace. Like
the other read routes it emits no events and no audit entries.

`GET /api/workspaces/:workspaceId/search?query=needle&matchCase=true&wholeWord=true&include=src/*.ts&limit=500`
returns bounded literal-substring matches from the files in that same index —
the "search in all files" read.

`query` is required (trimmed, 1 to 200 characters) and is matched as a **literal
substring; there is no regex in v1**, because a caller-supplied pattern is an
in-process ReDoS vector (see `docs/safety/TRUST_AND_SAFETY.md`). `matchCase` and
`wholeWord` are optional booleans and accept only the explicit tokens `true`,
`false`, `1`, or `0`. `include` is an optional simple glob (at most 200
characters). `limit` is an optional integer from 1 to 500 (default 500) and
bounds the **total number of matches returned, not the number of files
scanned**.

```json
{
  "workspaceId": "workspace-abc123def456",
  "query": "needle",
  "files": [
    {
      "path": "src/app.ts",
      "matches": [
        {
          "line": 2,
          "column": 7,
          "length": 6,
          "preview": "const needle = needleValue;",
          "previewColumn": 7
        }
      ],
      "truncated": false
    }
  ],
  "totalMatches": 1,
  "filesScanned": 1,
  "truncated": false
}
```

`line`, `column`, and `previewColumn` are all 1-indexed (the Monaco convention
the editor clients already use), and `column`/`length` are UTF-16 code-unit
offsets into the matched line. `preview` is the matched line capped at 200
characters centred on the match, so a minified or generated file cannot return a
megabyte-long line, and `previewColumn` is where the match sits *inside*
`preview` — a client highlights from it without recomputing the trim. A file's
`truncated` is `true` when that file had more matches than were returned (its
per-file cap, the remaining total budget, or because only its first 256 KB was
read); the top-level `truncated` is `true` when a global bound cut the run short.

Every bound reports partial results through `truncated` rather than running long:
20,000 indexed paths, at most 2,000 files scanned, 20 matches per file, 500 total
matches, 256 KB read per file, a 3,000 ms wall-clock budget, and the 200-character
preview. Candidates are scanned in sorted path order, so a truncated run is
deterministic rather than arbitrary. `filesScanned` counts the files actually
opened and read — a binary file is counted and then skipped, while candidates
excluded by `include`, refused by the secret-name filter, missing, or resolving
outside the workspace are never opened.

`include` is deliberately not a regex either. Matching is case-insensitive; `*`
matches any run of characters *including* `/`, `?` matches exactly one, and there
is no `*`/`**` distinction. A pattern containing `/` is matched against the full
workspace-relative path, otherwise against the basename; a pattern with no
wildcard is an exact-path, directory-prefix, or basename filter (`src` matches
everything under `src/`). The pattern is applied by a linear two-pointer matcher,
so caller input is never compiled into a regular expression.

Status codes: `400` for an invalid query (a missing, blank, or over-long `query`,
a non-boolean flag token, a `limit` outside 1–500), `401` when `AUTH_TOKEN` is
configured and the bearer token is missing (the search returns file content), and
`404` for an unknown workspace. It emits no events and no audit entries.

### Workspace skills

`GET /api/workspaces/:workspaceId/skills?runnerKind=claude_code` lists the
skills a runner kind would natively load from a registered workspace, so client
composers can offer a `/` slash picker. The optional `runnerKind` query accepts
`codex` or `claude_code`; without it the route uses the backend default
(`RUNNER_KIND`). The route is a bounded, read-only scan of the workspace's
fixed committed skill directories (`.claude/skills` for Claude Code;
`.codex/skills` and `.agents/skills` for Codex, first directory winning a name
collision): it parses only each `SKILL.md`'s frontmatter `name` and
`description` — never skill body content — follows the tree read's symlink
containment (an escaping link is skipped), caps the list at 50 skills, and
emits no events or audit entries. Each skill's `invocation` is the
runner-appropriate composer token (`/name` for Claude Code slash commands,
`$name` for Codex skill mentions), so clients never hardcode per-runner
syntax. For `claude_code`, `available` mirrors the workspace-settings gate
(`CLAUDE_CODE_LOAD_WORKSPACE_SKILLS`, honored only under `bypassPermissions`;
see `docs/safety/TRUST_AND_SAFETY.md`): when sessions would not load workspace
skills the route reports `available: false` with an empty list rather than
advertising invocations an isolated session would ignore. Codex loads repo
skills natively, so `available` is always `true`. When `AUTH_TOKEN` is
configured, this read requires the bearer token because skill names and
descriptions expose project structure.

```json
{
  "workspaceId": "workspace-abc123def456",
  "runnerKind": "claude_code",
  "available": true,
  "skills": [
    {
      "name": "prime-context",
      "description": "Prime repository context before non-trivial work.",
      "invocation": "/prime-context",
      "source": ".claude/skills"
    }
  ]
}
```

### File and directory mutations

`PUT /api/workspaces/:workspaceId/file` writes a bounded UTF-8 text file to a
registered workspace. The backend performs the write behind the same path
bounding, symlink guard, and secret/generated-directory filtering as the read
routes.

For every workspace mutation in this section, a protected path also includes
names hidden by workspace tree and index reads: `.DS_Store` and any name ending
in the backend's internal `.agentroom-tmp` staging suffix. Such a name is
refused with `415` rather than created successfully but omitted from subsequent
reads.

```json
{
  "path": "docs/notes.md",
  "content": "updated text\n",
  "baseModifiedAt": "2026-06-14T00:00:00.000Z"
}
```

`path` is workspace-relative; its parent directory must already exist (no
recursive directory creation). `content` is UTF-8 text only (NUL bytes are
rejected) and is capped at 256 KB. `baseModifiedAt` is an optimistic-lock token
equal to the `modifiedAt` of the `WorkspaceFilePreview` the client last loaded;
it is required to overwrite an existing file and a missing or stale token is
rejected with `409` so a blind overwrite of a file changed since it was loaded
cannot clobber newer content. A token presented after rename or delete also
returns `409` rather than recreating the old path. On success the route returns the refreshed
`WorkspaceFilePreview` for the written file, with `201` on create and `200` on
overwrite. The write is atomic (temp file plus rename) and emits a sanitized
`workspace_file_written` event (`workspaceId`, `workspacePath`, `path`,
`sizeBytes`, `created` — never the file content). Status codes: `400` for an
invalid payload or out-of-bounds path, `401` when `AUTH_TOKEN` is configured and
the bearer token is missing (this is a mutating route), `404` when the workspace
or the path's parent directory does not exist, `409` for a missing/stale
`baseModifiedAt`, and `415` for a secret-named or generated-directory path, a
symlink leaf, a directory target, or non-UTF-8 content. The write intentionally
dirties the working tree, which can subsequently block a branch switch.

`DELETE /api/workspaces/:workspaceId/file` removes one regular workspace file.
It does not accept directories; recursive directory removal uses the separate,
explicitly named route below.

```json
{
  "path": "docs/notes.md",
  "baseModifiedAt": "2026-06-14T00:00:00.000Z"
}
```

`baseModifiedAt` is required and must equal the file's current on-disk mtime,
normally taken from the rendered `WorkspaceTreeEntry` or
`WorkspaceFilePreview`. A missing token is an invalid payload; a stale one is a
`409`, and the file remains untouched. The route applies the PUT route's lexical
path bounds, secret/generated filtering (including the resolved parent), parent
realpath containment, and symlink-leaf refusal, then deletes with
`node:fs.unlink` only. On success it returns `200`:

```json
{
  "workspaceId": "workspace-abc123def456",
  "path": "docs/notes.md",
  "sizeBytes": 128,
  "deleted": true
}
```

It invalidates the workspace file index and emits a sanitized
`workspace_file_deleted` event containing `workspaceId`, `workspacePath`,
`path`, and `sizeBytes`, never content. Status codes: `400` for an invalid
payload or out-of-bounds path, `401` when the configured bearer token is
missing, `404` for an unknown workspace/file/parent, `409` for a stale token,
and `415` for a directory, symlink leaf, or secret/generated path.

`POST /api/workspaces/:workspaceId/directory` creates one empty directory. It
shares its path with the recursive delete below and differs by method, the way
the file PUT and DELETE do.

```json
{
  "path": "docs/diagrams"
}
```

`path` is workspace-relative and its parent directory must already exist: this
route is **not recursive**, exactly like the file PUT, so one request creates one
directory and a caller that wants a chain asks for each link. It is also the one
mutation with **no `baseModifiedAt`** — nothing is being replaced, so there is no
prior version a caller could be asked to prove it had seen. What stands in for
the token is exclusivity: an occupied name is a `409` rather than a silent
success on a folder someone else made. The path passes the same lexical
bounding, secret-name and generated-directory refusal, and realpath containment
as every other write, and the leaf goes through the same 255-byte name rule as
rename.

```json
{
  "workspaceId": "workspace-abc123def456",
  "path": "docs/diagrams",
  "modifiedAt": "2026-08-29T00:00:00.000Z",
  "created": true
}
```

Success returns `201` and the new directory's `modifiedAt`, so it is immediately
a rename, move, paste, or delete target without a second read. It emits
`workspace_directory_created` (`workspaceId`, `workspacePath`, `path`) and is
deliberately the one mutation that does **not** invalidate the workspace file
index: that index enumerates files, and an empty directory contributes none — the
first write inside it is a create, which invalidates then. Status codes: `400`
for an invalid payload, an out-of-bounds path, an over-long leaf name, or the
workspace root; `401` when the configured bearer token is missing; `404` for an
unknown workspace or a parent directory that does not exist; `409` when the name
is already taken by a file or a directory; and `415` for a secret-named or
generated-directory path.

`POST /api/workspaces/:workspaceId/entry/rename` renames one regular file or
directory within its current parent. It is not a move endpoint and never
overwrites another entry.

```json
{
  "path": "docs/notes.md",
  "newName": "ideas.md",
  "baseModifiedAt": "2026-06-14T00:00:00.000Z"
}
```

`newName` is one trimmed leaf name, at most 255 UTF-8 bytes. `/`, `.`, `..`,
secret/generated names, and names that would resolve to another existing
sibling are refused. `baseModifiedAt` must match the selected entry's current
mtime. A same-name request succeeds as an idempotent no-op; a same-inode
case-only rename is allowed on case-insensitive Mac filesystems only when both
spellings resolve to the same directory entry. A distinct hard link remains an
occupied sibling and returns `409`. The response contains the old and new
workspace-relative paths:

```json
{
  "workspaceId": "workspace-abc123def456",
  "oldPath": "docs/notes.md",
  "path": "docs/ideas.md",
  "entryType": "file",
  "sizeBytes": 128,
  "renamed": true
}
```

`sizeBytes` is present for files and omitted for directories. A successful
change invalidates the file index and emits `workspace_entry_renamed` with the
same fields plus `workspacePath`; a no-op emits no event. Status codes: `400`
for an invalid payload, path, or leaf name; `401` when the configured bearer
token is missing; `404` for an unknown workspace/entry/parent; `409` for a stale
token or occupied destination; and `415` for a symlink, unsupported entry type,
or protected path.

The no-overwrite rule also holds if another process creates the destination
after validation: files claim the new name with an exclusive hard link before
removing the old link, while directories reserve the new name before renaming.

`POST /api/workspaces/:workspaceId/entry/move` relocates one regular file or
directory to another folder in the same workspace. It is rename generalized to
a second directory and runs the same implementation, so it inherits the whole
no-overwrite contract above.

```json
{
  "path": "docs/notes.md",
  "destinationParent": "docs/archive",
  "newName": "notes.md",
  "baseModifiedAt": "2026-06-14T00:00:00.000Z"
}
```

`destinationParent` is required and may be empty: `""` is the workspace root, a
real destination rather than an omission. It is bounded exactly as every other
written parent is (lexical normalization, realpath containment,
secret/generated refusal on both the caller's text and the resolved path) and
must already be a directory. `newName` is optional; omitting it keeps the
entry's own name, which is what a plain paste into another folder does.
`baseModifiedAt` must match the entry's current mtime.

The response matches the rename route's, with `moved` in place of `renamed`:

```json
{
  "workspaceId": "workspace-abc123def456",
  "oldPath": "docs/notes.md",
  "path": "docs/archive/notes.md",
  "entryType": "file",
  "sizeBytes": 128,
  "moved": true
}
```

A move to the entry's existing path is an idempotent no-op that emits no event,
including when the destination parent uses an in-workspace symlink spelling
that resolves back to that same path.
A successful change invalidates the file index and emits `workspace_entry_moved`
with the same fields as the rename event plus `workspacePath`, so a client
re-keys the old path identically. There is deliberately no collision strategy:
silently renaming an entry someone asked to move would apply a decision they did
not make, so an occupied destination is a `409`. Status codes: `400` for an
invalid payload, an out-of-bounds path, or a folder moving into itself or a
descendant; `401` when the configured bearer token is missing; `404` for an
unknown workspace, entry, or destination parent; `409` for a stale token or an
occupied destination; and `415` for a symlink, an unsupported entry type, a
protected path, a destination that is not a directory, or a destination on
another filesystem.

`POST /api/workspaces/:workspaceId/entry/copy` duplicates one regular file or
directory inside the same workspace. The source is never touched.

```json
{
  "path": "docs/notes.md",
  "destinationParent": "docs/archive",
  "baseModifiedAt": "2026-06-14T00:00:00.000Z",
  "onCollision": "keep_both"
}
```

`path`, `destinationParent`, `newName`, and `baseModifiedAt` mean exactly what
they mean for a move. `baseModifiedAt` is required even though nothing is
removed: it is what makes the result a copy of the entry the client actually
rendered, and a stale token is a `409` telling it to re-read and copy again.

`onCollision` is `fail` (the default, the same refusal rename gives) or
`keep_both`, which takes the next name on a bounded `-2`…`-5` ladder that
suffixes the stem rather than the extension (`notes.md` → `notes-2.md`,
`.gitignore` → `.gitignore-2`) and then refuses. The response reports the name
it actually took, so a client never guesses one.

Unlike the file PUT, a copy's bytes never transit this API, so the 256 KB body
cap does not apply to it. It is bounded by the recursive-delete caps instead —
20,000 entries and 1 GiB — applied to a single file as much as to a tree, and
it refuses symlinks, protected or generated names, and unsupported entry types
the same way. The whole subtree is inventoried before a byte is written, and
the result is staged beside the destination and published under the chosen name
only once complete, so a failed copy leaves nothing partial behind. The copy
pass does not trust that preflight: it rechecks directories around their
listing, opens every regular file with `O_NOFOLLOW`, verifies that the opened
device/inode, size, and mtime match the selected entry, reads through that
pinned handle under the byte cap, and stats it again before publication. A
source replaced with a symlink or another inode therefore fails with `409`, and
the returned counts describe the completed copy pass.

```json
{
  "workspaceId": "workspace-abc123def456",
  "sourcePath": "docs/notes.md",
  "path": "docs/archive/notes-2.md",
  "entryType": "file",
  "fileCount": 1,
  "directoryCount": 0,
  "sizeBytes": 128,
  "copied": true
}
```

A file reports `fileCount: 1` and `directoryCount: 0`; a directory reports its
inventory, with `directoryCount` including the copied directory itself. Success
returns `201`, invalidates the file index, and emits `workspace_entry_copied`
with the same fields plus `workspacePath`. It carries `sourcePath` rather than
`oldPath` because a copy vacates nothing. Status codes: `400` for an invalid
payload, an out-of-bounds path, or a folder copied into itself or a descendant;
`401` when the configured bearer token is missing; `404` for an unknown
workspace, entry, or destination parent; `409` for a stale token, an occupied
destination under `fail`, or an exhausted ladder under `keep_both`; `413` when
the source exceeds an inventory cap; and `415` for a symlink, an unsupported
entry type, a protected path, or a destination that is not a directory.

`DELETE /api/workspaces/:workspaceId/directory` recursively removes one
directory after a complete bounded preflight.

```json
{
  "path": "docs/generated",
  "baseModifiedAt": "2026-06-14T00:00:00.000Z"
}
```

The path must name a directory below the workspace root, and `baseModifiedAt`
must match its current mtime. Before removing anything, the backend inventories
the whole subtree and refuses protected/generated names, symlinks,
socket/device/other unsupported entries, more than 20,000 entries including the
selected directory, or more than 1 GiB of regular-file data. It rechecks the
selected directory's type and mtime after the inventory, then removes that one
directory recursively. Any preflight failure leaves the subtree untouched.

```json
{
  "workspaceId": "workspace-abc123def456",
  "path": "docs/generated",
  "fileCount": 18,
  "directoryCount": 4,
  "sizeBytes": 24576,
  "deleted": true
}
```

`directoryCount` includes the selected directory. Success invalidates the file
index and emits `workspace_directory_deleted` with the same counts plus
`workspacePath`, never content. Status codes: `400` for an invalid/root/out-of-
bounds path; `401` when the configured bearer token is missing; `404` for an
unknown workspace/directory/parent; `409` for a stale or concurrently changed
selected directory; `413` when an inventory cap is exceeded; and `415` for a
file target, symlink, protected subtree, or unsupported entry type.

### Git status and file baseline

`GET /api/workspaces/:workspaceId/git/status` returns canonical file-level Git
dirty status for a registered workspace. The route uses fixed read-only Git
invocations, not a shell or client-supplied command arguments. When
`AUTH_TOKEN` is configured, this route requires bearer auth because changed file
paths and line counts expose project metadata.

```json
{
  "workspaceId": "workspace-abc123def456",
  "isRepository": true,
  "branch": "feature/example",
  "clean": false,
  "counts": {
    "total": 2,
    "staged": 1,
    "unstaged": 1,
    "untracked": 0,
    "conflicts": 0
  },
  "files": [
    {
      "path": "apps/backend/src/server.ts",
      "status": "modified",
      "staged": false,
      "unstaged": true,
      "additions": 4,
      "deletions": 1
    },
    {
      "path": "apps/visionos/AgentRoom/Views/NewView.swift",
      "oldPath": "apps/visionos/AgentRoom/Views/OldView.swift",
      "status": "renamed",
      "staged": true,
      "unstaged": false
    }
  ],
  "truncated": false,
  "refreshedAt": "2026-06-08T00:00:00.000Z"
}
```

The `files` array is capped at 200 entries and `truncated` is `true` when more
changed files exist. Non-Git workspaces return `isRepository: false`,
`clean: true`, zero counts, and an empty file list.

`GET /api/workspaces/:workspaceId/git/file-base?path=src/app.ts&maxBytes=262144`
returns the git HEAD version of a workspace-relative file so clients can render
working-tree change decorations against the committed baseline (the visionOS
editor's VS Code-style gutter marks and its read-only side-by-side diff view).
The route uses fixed read-only Git
invocations (`git cat-file`), not a shell; the pathspec is resolved as
`HEAD:./<path>` relative to the registered workspace directory, so a workspace
registered inside a larger repository stays bounded to its own subtree. The path
shares the read routes' lexical bounding (rejecting NUL, absolute, and `..`
segments) and secret-name refusal, and the returned blob shares the preview
contract: UTF-8 text only (a NUL-containing blob is rejected with `415`), capped
by `maxBytes` (1 to the 256 KB write cap; the default is the full cap). A blob
larger than the cap returns metadata with `truncated: true` and no `content`,
because a partial baseline would diff wrongly.

```json
{
  "workspaceId": "workspace-abc123def456",
  "path": "src/app.ts",
  "ref": "HEAD",
  "isRepository": true,
  "existsInHead": true,
  "sizeBytes": 18,
  "encoding": "utf8",
  "content": "const before = 1;\n",
  "truncated": false
}
```

A file not yet in HEAD (added/untracked, or a repository with no commits)
returns `existsInHead: false`, and a non-Git workspace returns
`isRepository: false` — both `200`s with no `content`, since they are ordinary
data states for a diff client, not errors. For a renamed file, clients request
the baseline via the `oldPath` reported by the Git status route. Status codes:
`400` for a malformed query or out-of-bounds path, `401` when `AUTH_TOKEN` is
configured and the bearer token is missing (the read exposes committed file
content), `404` for an unknown workspace, and `415` for a secret-named path, a
directory (tree) target, or a binary blob. Like the other read routes, it emits
no events and no audit entries.

### Mutating Git operations

These eight routes are the source-control surface a client drives: staging,
committing, discarding, the three remote operations, and branch creation. They
are **not** a shell. Each is a fixed argument vector run without a shell, where
the caller contributes workspace-relative paths and a commit message — never a
flag, a refspec, a remote, or a ref. Nothing rewrites history: there is no amend,
reset, rebase, or forced push, and pull is fast-forward only. Full posture is in
`docs/safety/TRUST_AND_SAFETY.md`.

All eight are mutating POSTs, so they require the bearer token when `AUTH_TOKEN`
is configured. Each publishes one sanitized `workspace_git_operation` event.

Every one returns the same shape — the refreshed workspace and Git status, so a
client re-renders its whole source-control surface from a single reply:

```json
{
  "workspaceId": "workspace-abc123def456",
  "operation": "commit",
  "workspace": { },
  "status": { },
  "paths": ["src/app.ts"],
  "skippedPaths": [".env"],
  "commit": "4a2f1c9...",
  "commitSubject": "Add the value",
  "branch": "feature/example",
  "previousBranch": "main",
  "remote": "origin"
}
```

`operation` is one of `stage`, `unstage`, `discard`, `commit`, `fetch`, `pull`,
`push`, `create_branch`. `paths` lists what the operation acted on and
`skippedPaths` what a "stage everything" enumeration refused (see the path rules
below); the remaining fields appear only for the operations that produce them.

| Route | Body | Runs |
|---|---|---|
| `POST …/git/stage` | `{ "paths": ["src/app.ts"] }` or `{ "all": true }` | `git add` |
| `POST …/git/unstage` | `{ "paths": [...] }` or `{ "all": true }` | `git restore --staged` (`git rm --cached` on an unborn HEAD) |
| `POST …/git/discard` | `{ "paths": [...] }` | `git restore --source=HEAD --staged --worktree`, plus `git clean -f` for paths not in HEAD |
| `POST …/git/commit` | `{ "message": "...", "stageAll": true }` | `git commit -m` |
| `POST …/git/fetch` | *(none)* | `git fetch --prune` |
| `POST …/git/pull` | *(none)* | `git pull --ff-only` |
| `POST …/git/push` | `{ "setUpstream": true }` | `git push`, or `git push --set-upstream <remote> <branch>` |
| `POST …/git/branch/create` | `{ "branch": "feature/x" }` | `git switch --create` |

**Paths.** `paths` holds at most 500 workspace-relative paths, each at most 1024
characters. Every one passes the same filter as the tree read and file index
(lexical bounding plus per-segment refusal of secret names and generated
directories). Stage and unstage additionally require every explicit path to be
an exact changed-file entry: directory pathspecs are refused, so naming a safe
parent cannot make Git recurse into a refused secret child. A path refused when
named **explicitly** returns `415`; a path
refused during a `{"all": true}` enumeration is skipped and reported in
`skippedPaths`, so staging everything can never sweep a `.env` into a commit.
`stage`/`unstage` with `all` enumerate from an uncapped status read rather than
the 200-file status projection, so a very dirty tree stages completely.

**Discard has no `all`.** It reverts each named path to its HEAD content and
deletes a path HEAD does not have (untracked, or added to the index only). The
work is not stashed and cannot be recovered, so the caller names every path.

**Commit.** `message` is 1 to 5000 characters. `stageAll` stages every eligible
changed path first, so "commit everything" is one request. The workspace's own
`pre-commit`/`commit-msg` hooks run — `--no-verify` is never passed — and a hook
that rejects the commit surfaces its message. Immediately before `git commit`,
the backend validates the repository's complete staged index, including entries
staged outside AgentRoom and entries outside a registered subdirectory; any
secret-named, generated, or out-of-workspace path rejects the commit with `415`.
A commit with nothing staged is a `409` carrying git's own "nothing to commit"
text.

**Remote operations.** `fetch`, `pull`, and `push` require a configured remote
(`400` otherwise) and run non-interactively: `GIT_TERMINAL_PROMPT=0` plus SSH
batch mode, so a repository that would need an interactive prompt fails with
git's error rather than hanging. Credential helpers still apply. They carry a
separate, longer timeout (`GIT_NETWORK_TIMEOUT_MS`, default 120s). `push` sets an
upstream when `setUpstream` is true or the branch has none (publishing it to the
branch's configured remote, else `origin`, else the sole remote); otherwise it is
a bare `git push` so git's own `push.default` decides the destination. Force
pushing is not exposed.

Status codes: `400` for an invalid payload, a non-repository workspace, a missing
remote, or a detached HEAD on push; `401` when `AUTH_TOKEN` is configured and the
bearer token is missing; `404` for an unknown workspace; `409` for a git failure
(nothing to commit, a non-fast-forward pull or push, an existing branch name, a
rejecting hook) or an explicit stage/unstage path that is not an exact eligible
changed file, carrying git's own message with URL credentials and labelled
secrets redacted; `415` for an explicitly named secret-named, generated-directory,
or out-of-bounds path.

### Branch switching and workspace removal

`POST /api/workspaces/:workspaceId/git/branch` switches a registered Git
workspace to an existing clean local branch:

```json
{
  "branch": "feature/example"
}
```

The route is a fixed Git branch operation, not arbitrary shell execution. The
workspace must be a registered Git repository, the branch must already exist
locally, and the working tree must have no uncommitted or untracked changes
when changing branches. On success it returns the updated workspace snapshot
plus `previousBranch`, `branch`, and `changed`.

`DELETE /api/workspaces/:workspaceId` unregisters a workspace from AgentRoom.
It removes only registry metadata under `STATE_DIR`; it does not delete or
modify the selected folder.

## Spatial Scene And Solution Diagram

`GET /api/workspaces/:workspaceId/spatial-scene?path=main.scene.json` returns
the composed spatial scene for a geometry-first base scene file. A scene is two
ordinary workspace text files under the existing read/write bounding: the agent-authored base layer
`<name>.scene.json` and the client-written human override layer
`<name>.scene.human.json`. The backend validates both with zod and composes
them on every read (human overrides merge field-wise onto base entities;
`removed` ids drop; overrides referencing unknown ids are ignored so a
re-added entity picks its placement back up), returning the composed document
plus each layer's `modifiedAt` optimistic-lock token for the client's next
override write. There is no scene write route: human commits go through the
existing `PUT /api/workspaces/:workspaceId/file`. The route is registered only
when `SCENE_ENGINE_ENABLED` is on (default on; reported as
`sceneEngineEnabled` in `/api/config` — when off the request is a plain 404)
and, like the file-preview read, requires the bearer token when `AUTH_TOKEN`
is configured because it exposes file content.

```json
{
  "workspaceId": "workspace-abc123def456",
  "path": "main.scene.json",
  "version": "<sha256-hex of the composed document>",
  "document": {
    "schemaVersion": 1,
    "name": "Living room draft",
    "entities": [
      {
        "id": "crate-1",
        "geometry": { "kind": "box", "size": [0.2, 0.2, 0.2] },
        "transform": { "position": [0.25, 0.1, -0.1] },
        "material": { "baseColor": "#C8873A" },
        "visible": true,
        "locked": true,
        "humanEdited": true
      }
    ]
  },
  "base": { "path": "main.scene.json", "modifiedAt": "2026-08-05T00:00:00.000Z", "sizeBytes": 214 },
  "human": { "path": "main.scene.human.json", "modifiedAt": "2026-08-05T00:00:10.000Z", "sizeBytes": 120 },
  "humanDocument": {
    "schemaVersion": 1,
    "overrides": [{ "id": "crate-1", "transform": { "position": [0.25, 0.1, -0.1] }, "locked": true }]
  }
}
```

The same route accepts a semantic solution-diagram base path such as
`docs/diagrams/checkout.diagram.json`. The base document contains only nodes,
edges, flat groups, and optional named flows — never coordinates. The backend
strictly validates it,
breaks graph cycles deterministically, assigns longest-path tiers, orders each
tier by barycenter (a seeded downward pass refined by fixed up/down sweeps,
keeping the candidate with the fewest crossings), separates groups into
alternating ± z lanes by document order (ungrouped nodes stay at z = 0),
resolves the role vocabulary to bounded
primitive geometry/materials, creates connectors — straight, or bowed through a
`via` waypoint when an edge spans two or more tiers — resolves each flow to
the connectors that were actually drawn, and finally applies
the sibling `checkout.diagram.human.json` overrides. Identical base input always
produces identical layout. Node and group ids must be disjoint because the human
override layer targets bare semantic ids; flow ids need not be, because a flow is
never an override target.

A base document declares `schemaVersion` 1, 2, or 3. Version 2 added the
optional `flows` array; version 3 added optional `description` fields (1–500
characters, trimmed) on the document, nodes, edges, and groups, and is what an
agent should author today. Older documents keep rendering unchanged, they
simply cannot carry the newer fields (declaring `flows` at version 1, or a
`description` below version 3, is a validation error, so the version stays an
honest capability marker). The composed render document is versioned alongside
them and is now always `3`, since an older source composes to the same shape
with an empty `flows` and no descriptions. Descriptions pass through compose
verbatim onto the composed entities, connectors, and document — the selection
card renders them, so an agent can anchor "why does this exist?" to the
component itself.

```json
{
  "workspaceId": "workspace-abc123def456",
  "path": "docs/diagrams/checkout.diagram.json",
  "version": "<sha256-hex of the composed document>",
  "document": {
    "schemaVersion": 3,
    "kind": "solution",
    "name": "Checkout flow",
    "entities": [
      {
        "id": "node:orders",
        "label": "Orders Service",
        "description": "Owns order state; the only writer of Orders DB.",
        "provenance": { "nodeId": "orders", "groupId": "core" },
        "geometry": { "kind": "box", "size": [0.12, 0.08, 0.12], "cornerRadius": 0.02 },
        "material": { "baseColor": "#4A7FD4", "roughness": 0.5 },
        "transform": { "position": [0, -0.28, 0] },
        "visible": true,
        "locked": false,
        "humanEdited": false
      }
    ],
    "suppressedHiddenEntities": [],
    "staleOverrides": [
      { "id": "legacy-cache", "moved": true, "locked": true }
    ],
    "connectors": [
      {
        "id": "edge:e1",
        "provenance": { "edgeId": "e1" },
        "fromId": "node:api-gw",
        "toId": "node:orders",
        "from": [0, 0, 0],
        "to": [0, -0.28, 0],
        "kind": "sync",
        "label": "REST",
        "arrowheads": "to"
      },
      {
        "id": "edge:e2",
        "provenance": { "edgeId": "e2" },
        "fromId": "node:api-gw",
        "toId": "node:audit",
        "from": [0.15, 0, 0],
        "to": [0.15, -0.56, 0],
        "via": [0.15, -0.28, 0.08],
        "kind": "event",
        "arrowheads": "to"
      }
    ],
    "flows": [
      {
        "id": "flow:place-order",
        "label": "Place an order",
        "provenance": { "flowId": "place-order" },
        "connectorIds": ["edge:e1", "edge:e2"]
      }
    ],
    "warnings": []
  },
  "base": { "path": "docs/diagrams/checkout.diagram.json", "modifiedAt": "2026-08-06T00:00:00.000Z", "sizeBytes": 512 },
  "human": null,
  "humanDocument": null
}
```

A diagram's override layer carries one field the geometry-scene layer does not:
`collapsed`, valid on **group** ids. A collapsed group composes to a single
stand-in entity (a solid box at the platter's own layout position) instead of
its member node entities; edges that crossed the group boundary are re-pointed
at that entity, edges internal to it are dropped, and edges that became parallel
by collapsing take the usual parallel-edge offset. Edges sharing an unordered
endpoint pair are fanned out symmetrically about the shared segment, along a
perpendicular taken from the pair's canonical orientation, 0.03 m apart —
with the bundle's half-width capped at 0.04 m (the smallest palette shape's
perpendicular extent), so a wide bundle compresses its spacing rather than
letting an outer connector's centreline miss the nodes it joins. Each edge
past the first carries its position in the bundle as an optional additive
`parallelIndex` on the connector (`1`, `2`, …; absent on the first and on
unbundled edges, so a document without parallel edges composes
byte-identically) — the renderer staggers each parallel edge's midpoint label
along its shaft with it, and an older client that ignores the field simply
keeps every label at the midpoint, which is the previous behavior. Member
override entries are
untouched while collapsed, so expanding restores every placement, lock, and hide
they carried. When a collapsed group omits a member whose override is
`visible: false`, the composed document includes that member once in the bounded
`suppressedHiddenEntities` metadata (`id`, `label`, `isGroup: false`) so a client
can still list and restore it without inventing a render entity. The flag is
ignored on a node id rather than failing the document.

A connector whose edge spans two or more layout tiers carries an optional `via`
waypoint: the drawn midpoint pushed toward the viewer (+z), deterministically
far enough that the two-leg polyline clears the front-most drawn node or
collapsed stand-in on every tier it crosses — group lanes put those at
z = 0.12, past any small fixed push — clamped at a fixed maximum (the bow is a
depth heuristic, not a collision router; past the cap the edge draws through
what it cannot clear, as every edge did before the bow existed), plus a capped,
compressing stagger for the connector's position in its parallel bundle, the
same rule as the sideways fan-out's half-width cap. Layout has no dummy
vertices, so without the bow a chain `A→B→C` plus
the skip edge `A→C` draws the skip straight through `B` whenever barycenter
centres all three — which it usually does. The renderer draws a connector with
a waypoint as two shaft segments through it, arrowhead on the arriving segment;
flow lighting and the flow traveler treat the segments as one connector. Like
`parallelIndex`, the field is additive on the composed contract: an
adjacent-tier edge omits it entirely, so a document without multi-tier edges
composes byte-identically, and an older client that ignores it draws the
straight shaft it always drew.

`staleOverrides` is the other bounded metadata list, and it reports the one thing
the two-layer split cannot prevent. An override entry keys on a bare semantic id,
so a node or group the agent renames or removes leaves the human's adjustment
attached to nothing. Compose has always skipped such an entry, and deliberately
does not delete it — an id that comes back picks its placement up again, which is
what lets a regenerated diagram keep the human's work. This is the report of it:
one entry per orphaned override, in override-file order, carrying that entry's
own fields (`id`, `moved`, and whichever of `visible`/`locked`/`collapsed` it
set) rather than display text. It is not renderable geometry and adds no id the
document did not already carry; it is bounded by the override layer's own cap of
one entry per node plus one per group.

An entry is stale only when the **base document** does not declare its id. A node
the human hid, and a member omitted because its group is collapsed, are both
still in the design and are never reported. There is no route that clears them:
adopting the agent's layout means the client rewriting the same
`*.diagram.human.json` without those entries through the existing bounded PUT,
exactly like any other override edit.

A source `flows` entry is `{ id, label, edges }`, where `edges` is an ordered
list of existing edge ids — the route a request or a message actually takes. The
composed form replaces those edge ids with the composed connector ids that were
actually drawn, in the same order, so a client never maps ids itself. A repeated
edge id is legal and stays a separate step. Steps whose connector does not
exist are dropped rather than reported: an edge internal to a collapsed group,
or one whose endpoint the human hid, has no connector, and the remaining hops
still form a sequence. A flow left with no surviving step is omitted from
`flows` entirely, so a client is never offered a path it cannot show. None of
this is a warning, because each cause is a human view choice rather than a
problem with the document.

A group's `transform.position` override also moves the nodes standing on it: the
group's displacement from its layout position is applied to every member that
does **not** carry a position override of its own, whose absolute placement wins
instead. Only the group's own entry is written for such a move, and only
`position` propagates — a group's rotation or scale override applies to the
platter alone. Neither rule reaches layout, which stays a pure function of the
base document, so collapsing or moving a group never re-flows the rest of the
diagram.

The prompt names the starting role palette (`service`, `datastore`, `queue`,
`cache`, `external`, `actor`, `gateway`, `function`, `load_balancer`, `cdn`,
`auth`, `scheduler`, `blob_storage`, `ml_model`, `stream`), edge kinds (`sync`,
`async`, `read_write`, `event`, `replicates`), the legend mapping each value
to the treatment the human sees (colour, shape, solid versus dashed shaft, and
the terminator glyphs), the optional `flows` array, and the optional
`description` fields with one sentence on when a description earns its place.
The schema deliberately accepts other bounded id-style
values for forward compatibility; the compiler renders them with a generic
treatment and includes a `warnings` entry. Diagram schema/reference failures
are a successful, renderable snapshot whose `document` is a bounded error state,
for example `{ "errors": [{ "path": "base.edges.0.to", "message": "Unknown target node id ..." }] }`.

`human` and `humanDocument` are `null` when the override file does not exist
yet — the normal cold-start state. Geometry kinds are `box`, `sphere`,
`cylinder`, `cone`, `plane`, and `stack` (a vertical column of 2–8 identical
disks — `count`, per-disk `radius`/`height`, and the `gap` between neighbours
— the silhouette `datastore` nodes compose to); units are meters, y-up;
rotation is euler
degrees `[x, y, z]` applied as `qZ * qY * qX`; documents are capped at 64
entities and the 256 KB file write cap. Diagram caps are 64 nodes, 128 edges,
16 groups, 16 flows of at most 32 steps each, 500 characters per
`description`, and the same 256 KB file cap. Status codes: `400` for a missing
`path` query or a path that does not end in `.scene.json` or `.diagram.json`, `401` when
`AUTH_TOKEN` is configured and the bearer token is missing, `404` when the
workspace or base file does not exist, `413` for an oversized file, and `422`
for invalid geometry-scene JSON or schema. Invalid diagram JSON/schema is the
`200` bounded error-document state above so the diagram renderer can show it
and the user can feed it back to the agent.

There is no scene-specific WebSocket event and no backend change detection:
the service composes on read and keeps no state. Clients re-read the composed
route when existing signals fire — a `workspace_file_written` whose path is
one of the scene's two layers (the bounded PUT emits it), or a turn settling
in the workspace (agent file edits never surface as file events).

The backend consumes that same `workspace_file_written` signal in one place, and
it produces no route or event of its own: when its path is one of a diagram's
two layers, the next turn in each session for that workspace carries
a bounded summary of the **delta** the human changed, named against the base
diagram path. A `*.diagram.human.json` write reports placement — moves or
placement resets, hides or shows, locks or unlocks, and collapses or expands. A
`*.diagram.json` write (the diagram-edit route's output landing through the same
bounded PUT) reports structure — nodes added, removed, relabelled, re-roled,
regrouped, or described, edges connected, disconnected, re-kinded, or
described, group edits, and
document renames and descriptions — as a delta once the session has a baseline
(description changes are named by id only, never their text), and as a bounded
"edited (re-read the document)" pointer the first time, since the pre-write
state was never observable. Whenever a diagram is reported, both layers are
compared and any override ids the base document no longer declares are named as
orphaned human adjustments — the prompt-side counterpart of the composed read's
`staleOverrides`, delivered once per session per orphaned id. The summary is
prepended to the runner prompt after the standing
authoring contract. It is delivered once per accepted turn per session, to both
runner kinds (the contract itself still reaches Claude Code through its stable
system prompt instead); a rejected turn leaves the summary available to retry.
It is gated by `SCENE_ENGINE_ENABLED` along with everything else on this surface.
Nothing about it is persisted, audited, or returned by a route.

Its agent-authored mirror adds no route or event either: when a turn settles,
the `*.diagram.json` base paths named by that turn's own `coding_diff_updated`
file summary (the settle-time Git delta for Claude Code, Codex's own
`turn/diff/updated`) each get one bounded validation read — at most 4 per
turn, the rest reported only as a count — and the session's next accepted turn
prompt carries a bounded line naming what each wrote diagram actually rendered
as: compose warnings, validation errors, or the over-cap state, the same
bounded strings the composed read above serves. A clean render clears a
pending report, a deletion or rename (the diff entry's `oldPath`) drops the
stale one, and a read failure is skipped silently. Validations are serialized
per session — the next prompt assembly waits out the in-flight chain rather
than starting reads of its own — and the feedback is in-memory per session,
delivered once on the session's next accepted turn (only lines that fit the summary's
character cap are consumed; the rest stay pending), and released when the
session is deleted. `workspace_file_written` is deliberately not involved:
that event remains the human-edit summary's authorship signal.

### Mermaid import

`POST /api/spatial-scene/mermaid-import` converts Mermaid flowchart/graph
source — typically a `kind="mermaid"` artifact's content — into a canonical
`.diagram.json` base document, so an existing 2D sketch becomes a spatial
solution diagram without asking the agent to redraw it. It is **pure compute**:
no workspace, no filesystem, no mermaid.js execution — a hand-rolled, bounded,
single-pass parser whose few regexes are fixed literals (caller input is never
compiled into a pattern). Nothing is written by this route; the client writes
the returned text through the existing bounded
`PUT /api/workspaces/:workspaceId/file`, create-only (no `baseModifiedAt`), so
an import can never overwrite an existing diagram. Like the rest of this
surface it is registered only when `SCENE_ENGINE_ENABLED` is on (off ⇒ plain
404), and as a mutating POST it requires the bearer token when `AUTH_TOKEN` is
configured.

```json
{
  "source": "flowchart TD\n  api[API] --> db[(Orders DB)]",
  "name": "Order flow"
}
```

`source` is capped at 64 KB (the artifact content cap; over ⇒ `413`). `name` is
an optional display name (1–120 chars) that beats a frontmatter `title:`; the
fallback is `"Imported diagram"`. The success response:

```json
{
  "content": "{\n  \"schemaVersion\": 3,\n  ... }\n",
  "name": "Order flow",
  "slug": "order-flow",
  "warnings": [{ "line": 4, "message": "Self-loop on \"api\" dropped; edge endpoints must differ" }]
}
```

`content` is the canonical document **text** (fixed field order, two-space
indent, trailing newline) rather than a document object, so the client writes
bytes verbatim — no re-serialization — and re-importing an unchanged sketch
produces identical file content. `slug` is the backend-derived filename stem
(the client writes `docs/diagrams/<slug>.diagram.json`, falling back to the
workspace root when that folder does not exist, since the bounded PUT has no
recursive mkdir). Conversion is deterministic and lossy edges are `warnings`,
never silence: sanitized ids (Mermaid's grammar is wider than the diagram id
rule — note a renamed id shifts the override key human adjustments attach to),
dropped self-loops, subgraph-endpoint edges, and invisible links, flattened
nested subgraphs, and circle/cross arrow ends mapped to plain connections.
Node shapes map into the closed role vocabulary (`[( )]` → `datastore`,
`(( ))` → `actor`, `[[ ]]` → `function`, everything else → `service`) and link
families to kinds (dotted → `async`, bidirectional → `read_write`, else
`sync`), so an imported diagram never triggers the compose-side unknown-vocab
fallback.

Status codes: `400` for a malformed payload, `401` when `AUTH_TOKEN` is
configured and the bearer token is missing, `404` when the scene engine is
disabled, `413` for an over-cap `source`, and `422` when well-formed source
cannot be converted (an unsupported diagram type such as `sequenceDiagram`, a
statement that does not parse, an over-cap graph). The `422` body carries the
repo-wide `error` string with the first issue folded in, plus a bounded
structured `errors` array of `{ line?, message }` entries — 1-based lines into
the submitted source. Unlike the composed read's `200` error-document (which
exists so the volume can render a broken diagram's errors), a failed
conversion has no render surface, so it is a plain error status.

### Diagram edit

`POST /api/spatial-scene/diagram-edit` applies a bounded list of semantic
operations to a `.diagram.json` base document and returns the new canonical
document text, so a client can author *structure* — nodes, edges, labels,
roles, groups — by direct manipulation, not only the placement its override
layer already owns. It is the Mermaid import bridge's sibling with the
identical posture: **pure compute** — no workspace, no filesystem, no caller
input compiled into a regex — that never writes. The client writes the
returned text through the existing bounded
`PUT /api/workspaces/:workspaceId/file`, passing the `base.modifiedAt`
optimistic-lock token from the composed read it edited against, so an agent
regenerating the diagram mid-edit surfaces as the PUT's `409`, never as a
silently lost update. Registered only when `SCENE_ENGINE_ENABLED` is on (off ⇒
plain 404); as a mutating POST it requires the bearer token when `AUTH_TOKEN`
is configured.

```json
{
  "baseContent": "{ \"schemaVersion\": 2, ... }",
  "ops": [
    { "op": "addNode", "label": "Redis Cache", "role": "cache", "groupId": "core" },
    { "op": "addEdge", "fromId": "orders", "toId": "redis-cache", "kind": "async" }
  ]
}
```

`baseContent` is the current base document text, verbatim from the bounded
file-preview read — which also returns the `modifiedAt` the client passes to
the PUT as `baseModifiedAt` (the composed read's `base.modifiedAt` matches it,
but the composed read carries no base text) — capped at the 256 KB file write
cap (over ⇒ `413`). Omitting it means
"start from an empty document" — the New Diagram path — and only then may the
optional `name` (1–120 chars, default `"New diagram"`) be supplied; renaming an
existing document goes through the `setName` op instead, so the two paths
cannot disagree. `ops` is 1 to 32 operations, applied in order:

| Op | Fields | Effect |
|---|---|---|
| `addNode` | `label`, `role`, `groupId?` | New node; id derived from the label |
| `addEdge` | `fromId`, `toId`, `kind?` (default `sync`), `label?` | New edge; id is the smallest unused `e<n>` |
| `setNodeLabel` | `nodeId`, `label` | Relabel; the id never changes |
| `setNodeRole` | `nodeId`, `role` | Re-role |
| `setEdgeKind` | `edgeId`, `kind` | Change edge kind |
| `setEdgeLabel` | `edgeId`, `label` (or `null`) | Set or clear an edge label |
| `deleteNode` | `nodeId` | Drops the node, its edges, and affected flow steps (warned) |
| `deleteEdge` | `edgeId` | Drops the edge and affected flow steps (warned) |
| `addGroup` | `label` | New group; id derived from the label |
| `setNodeGroup` | `nodeId`, `groupId` (or `null`) | Move a node into or out of a group |
| `deleteGroup` | `groupId` | Removes the group; members are ungrouped (warned) |
| `setName` | `name` | Rename the document |
| `setNodeDescription` | `nodeId`, `description` (or `null`) | Set or clear a node's description |
| `setEdgeDescription` | `edgeId`, `description` (or `null`) | Set or clear an edge's description |
| `setGroupDescription` | `groupId`, `description` (or `null`) | Set or clear a group's description |
| `setDescription` | `description` (or `null`) | Set or clear the document's description |

There is deliberately **no rename-id op**: ids are the keys human overrides
attach to (see `staleOverrides`), so humans edit labels and the backend derives
ids — `addNode`/`addGroup` sanitize the label through the same id grammar the
Mermaid import uses, with the same deterministic `-2`…`-5`-style collision
ladder. Role and kind values accept any id-grammar string (the schema's open
vocabulary stance); values outside the engine palette compose with the usual
generic treatment and warnings.

```json
{
  "content": "{\n  \"schemaVersion\": 3,\n  ... }\n",
  "name": "Checkout flow",
  "slug": "checkout-flow",
  "warnings": [
    { "opIndex": 0, "message": "Flow \"place-order\" dropped 1 step(s) that referenced deleted edge \"e2\"" }
  ],
  "created": [
    { "opIndex": 0, "type": "node", "id": "redis-cache" },
    { "opIndex": 1, "type": "edge", "id": "e3" }
  ]
}
```

`content` is canonical document text — same serializer, field order, and
trailing newline as the Mermaid import, so identical input always produces
identical bytes and a no-op edit round-trips cleanly. The output document is
always emitted at `schemaVersion` 3; an older base upgrades on its first
edit (it stays valid — it simply carries no `flows` or descriptions).
`created` names the ids
the request allocated so a client can co-write a placement override for a
dropped node without parsing the document. Deleting an edge (directly or via
its node) trims flow steps that referenced it and removes a flow left with no
steps; each such loss is a bounded warning, never silence.

Ops apply **all-or-nothing**: the first inapplicable op (an unknown id, a
self-loop edge, an op that would exceed the 64-node/128-edge/16-group caps)
fails the request with `422` and nothing is returned to write. Status codes:
`400` for a malformed payload (bad op shape, over 32 ops, `name` alongside
`baseContent`), `401` when `AUTH_TOKEN` is configured and the bearer token is
missing, `404` when the scene engine is disabled, `413` for an over-cap
`baseContent`, and `422` when the base document does not parse or validate
(`{ path?, message }` entries) or an op cannot apply (`{ opIndex, message }`
entries, 0-based; the folded `error` string counts ops from 1 for people).

## Terminal

`WS /api/workspaces/:workspaceId/terminal` opens an interactive terminal (PTY)
for a registered workspace. This is the **one documented exception** to "no
arbitrary shell execution": a real login shell, started in the workspace
directory, **unsandboxed once running**. It is **off by default** and the route is
**registered only when `TERMINAL_ENABLED` is set** — otherwise the upgrade is just
a 404. Posture and rationale are in `docs/safety/TRUST_AND_SAFETY.md`.

Auth: this route does its own bearer check on the upgrade (the global preHandler
only gates mutating HTTP methods). When `AUTH_TOKEN` is configured, the client
must send `Authorization: Bearer <token>`; a missing/incorrect token gets an
`error` frame and a `1008` close before any shell is spawned.

Optional `?cols=` and `?rows=` query params seed the initial PTY size (clamped
`1..1000`; defaults `80x24`).

Multiple simultaneous sessions for the same workspace are expected: the visionOS
client keeps them in one or more terminal windows' tab strips, with one
WebSocket/PTY per tab. Moving a tab between those windows moves its live socket
and **creates no session**, so the cap is unaffected by moves. The
global backend cap is `TERMINAL_MAX_SESSIONS` (default 8, bounded 1–64) across all
workspaces. When the cap is full, a new socket receives an `error` frame with
`"Too many active terminal sessions"` and closes before `ready`.

Frames are JSON text. Server → client:

```json
{ "type": "ready", "sessionId": "terminal-session-<uuid>" }
{ "type": "output", "data": "<shell output chunk>" }
{ "type": "exit", "exitCode": 0 }
{ "type": "error", "message": "Unauthorized" }
```

Client → server (send only after `ready`; frames sent before `ready` are queued by
the visionOS client and flushed once it arrives, so early keystrokes are not lost):

```json
{ "type": "input", "data": "ls -la\n" }
{ "type": "resize", "cols": 120, "rows": 40 }
```

A single inbound frame is size-capped (~1 MiB); an oversized frame closes the socket
with `1009`. Shell output is flow-controlled: the PTY is paused when the socket's send
buffer grows and resumed when it drains, so a fast producer with a slow client cannot
grow backend memory without bound.

The shell is killed (`SIGTERM`) when the socket closes, when the session is
idle-reaped, or on backend shutdown; the global cap reserves a slot before the async
workspace lookup, so concurrent upgrades cannot race past it. The backend emits
sanitized `terminal_session_started` / `terminal_session_closed` events and durable
audit entries carrying only `sessionId`, `workspaceId`/`workspacePath`, and (on
close) `exitCode` and `durationMs` — **never** shell input/output, which can
contain secrets.

## Agent Sessions

### Session reads

`GET /api/agent-sessions` lists sessions. Sessions are persisted under
`STATE_DIR/sessions/` and restored at startup, so the list survives a backend
restart; a restored session is served through the same code path as a live
one. A session whose turn was running when the backend stopped comes back
`status: "failed"` with `error: "Backend restarted during this turn"`. The
list requires the bearer token when `AUTH_TOKEN` is configured because each
session summary can carry user or model text in `lastMessage`.

`GET /api/agent-sessions/:sessionId` returns one session and has the same
bearer-token requirement as the list.

`GET /api/agent-sessions/:sessionId/messages` returns ordered message history
for the session thread. Like the artifact read, it requires the bearer token when
`AUTH_TOKEN` is configured, because it exposes user/assistant content:

```json
{
  "messages": [
    {
      "id": "agent-message-abc123",
      "sessionId": "agent-session-abc123",
      "turnId": "agent-turn-abc123",
      "role": "user",
      "content": "Inspect this workspace.",
      "context": {
        "paths": ["README.md"],
        "attachments": [
          {
            "id": "attachment-00000000-0000-0000-0000-000000000001",
            "kind": "image",
            "sourceName": "clipboard.png",
            "contentType": "image/png",
            "sizeBytes": 2048
          }
        ]
      },
      "status": "sent",
      "at": "2026-05-14T00:00:00.000Z"
    }
  ]
}
```

For user messages, `context` is present when the turn included selected
workspace paths or uploaded image attachment ids. It contains safe display
metadata only; image bytes remain in backend-owned attachment storage under
`STATE_DIR`. A user message whose `context.questionRequestId` is set is the
backend's record of a person answering a clarifying-question batch mid-turn
(see the questions routes below): its `content` is the rendered answer — each
set's header or ordinal, its prompt, the chosen labels, and the person's own
free text where the set invited it — so the decision survives a reconnect the
way the turn message does. A `sensitive` set's text renders as `[redacted]`.

`GET /api/agent-sessions/:sessionId/artifacts` returns the session's accumulated
live artifacts for reconnect/late-join, since the WebSocket stream carries only
deltas:

```json
{
  "artifacts": [
    {
      "id": "agent-turn-abc123:artifact-1",
      "sessionId": "agent-session-abc123",
      "turnId": "agent-turn-abc123",
      "kind": "svg",
      "title": "Auth flow",
      "content": "<svg ...>...</svg>",
      "version": 7,
      "isOpen": false,
      "truncated": false,
      "updatedAt": "2026-06-14T00:00:00.000Z"
    }
  ]
}
```

Artifacts are model-authored sketches streamed in-band during a turn (see the
`coding_artifact_*` events below). They are backend-owned, in-memory, bounded,
per-session, and released on session deletion; they are never written into the
registered workspace. When `ARTIFACTS_ENABLED=false`, the list is always empty.
Returns `404` for an unknown session. Like `/messages`, this read requires the
bearer token when `AUTH_TOKEN` is configured, because it exposes model-authored
content.

### Session lifecycle

`DELETE /api/agent-sessions/:sessionId` deletes a thread from the backend
session list, removes its message history and its persisted record, and emits
`agent_session_deleted`. This is the only way a thread's record goes away; a
deleted thread is never restored at a later startup. If the thread has an active turn, deletion first
requests cancellation through the runner boundary. Deletion also releases the
runner's persistent per-session resources, including the spawned Codex
app-server or Claude Code child process kept alive for the thread. The route
deletes only backend session state; it does not delete or modify the
registered workspace.

`POST /api/agent-sessions`

```json
{
  "workspaceId": "workspace-abc123def456",
  "runnerKind": "codex",
  "gitBranch": "feature/example",
  "settings": {
    "model": "gpt-example",
    "reasoningEffort": "high",
    "serviceTier": "fast"
  },
  "title": "Vision turn"
}
```

`runnerKind` accepts `codex`, `claude_code`, `deepseek`, or `cursor` — plus the
id of any configured ACP adapter — and defaults to the backend's configured
`RUNNER_KIND`. A session pins its runner kind at creation; for
`claude_code` the backend keeps one persistent Claude Agent SDK session per
AgentRoom session, and for `deepseek` one DeepSeek Harness SDK runtime.

Two behaviors are specific to `deepseek`, both consequences of its protocol
rather than of this backend. Its wire has no prompt-cancel method, so
`POST …/cancel` kills that session's runtime. Because the handshake cannot
prove the selected composition persists conversation state, AgentRoom refuses
later turns on that session rather than silently starting a fresh conversation;
create a new AgentRoom session to continue. The stopped turn still records as
`cancelled` and the session still returns to `idle`. A turn's interval runs
from the prompt's enqueue receipt to the runtime's own `turn/end` (or, failing
that, its whole-agent `running` → `idle` transition) rather than being causally
assigned to the prompt, so steering or injected work arriving inside that
interval contributes to the turn that is settling. Its permission route reports
`404` like the other built-ins: the SDK wire carries no server-to-client
requests, so there is no outstanding request to answer.

Once a session's runner reports its native session start,
the session gains a bounded runner-agnostic `runner` block —
`nativeSessionId`, `model`, `cwd`, and the runner's own `posture`
(`{ label, value }`) and `sandbox` — plus, for these two runner ids only, the
legacy `codex`/`claudeCode` projections of it that predate that block. New
clients should read `runner`. Image attachments are supported for
`claude_code` and `cursor`; both SDK runners receive base64 image content as
described under turns below.

`gitBranch` is optional. If omitted, the backend records the workspace's
current branch when the session is created. Existing sessions keep that branch
association, and turn execution switches the registered workspace back to the
session branch before invoking the runner when needed.

### Turns and token usage

`POST /api/agent-sessions/:sessionId/turns`

```json
{
  "message": "Inspect this workspace and explain the next smallest change.",
  "context": {
    "paths": ["README.md", "apps/backend/src/server.ts"],
    "attachments": ["attachment-00000000-0000-0000-0000-000000000001"]
  },
  "settings": {
    "model": "gpt-example",
    "reasoningEffort": "high",
    "serviceTier": "fast"
  }
}
```

The backend starts one turn in the selected session and streams native updates
through `WS /api/events`. In JSON-RPC mode, one Codex app-server thread is kept
for the AgentRoom session and subsequent turns reuse that thread. A turn on a
session restored after a backend restart resumes the runner's native
conversation from the recorded `runner.nativeSessionId` (Codex
`thread/resume`, Claude Agent SDK `resume`, Cursor `Agent.resume`, ACP
`session/resume`), with the same runtime settings as a fresh start. If the
runner reports a different native id instead — a rejected resume, a pruned
transcript, a CLI upgrade — the backend appends one `role: "system"` message
to the thread (`This thread could not be resumed after a backend restart. The
agent has started a new conversation and has not seen the messages above.`)
so the person knows the agent's memory does not include the transcript on
screen. A restored `deepseek` session that had a conversation answers `409`
on its next turn, since that runner declares no restore path. Optional
`context.paths` values are workspace-relative paths selected by the client. The
visionOS client derives those paths from `@` file mentions inserted in the turn
composer. The backend resolves supplied paths safely, injects bounded file
previews or directory trees into the runner prompt, and keeps the stored user
message as the original `message`.

Optional `context.attachments` values are ids returned by
`POST /api/agent-sessions/:sessionId/attachments`. Image attachments are stored
under `STATE_DIR` and injected after the text prompt by the session's runner.
Codex JSON-RPC mode passes them as `localImage` input parts. The Claude Code
runner inlines each one as a base64 image content block in the SDK user message
because that SDK has no file-path image source. The Cursor runner reads the
same bounded `localImage` input and passes its base64 data and MIME type through
the SDK's local `send` image contract. Attachment ids are session-scoped; a
turn cannot attach files uploaded to another session. On Codex, image
attachment turns require `CODEX_RUNNER_PROTOCOL=jsonrpc`; the `exec`
compatibility fallback rejects them because it accepts only the text prompt. A
configured ACP adapter takes them only if the agent advertised the
exact ACP boolean `promptCapabilities.image: true`. When every completed
handshake for that adapter has reported non-support, turn start answers
`400 <agent> does not support image attachments`. With no observation or mixed
answers, validation defers to the selected persistent child's own handshake and
the *turn* fails with the same message if that child did not advertise support.
A turn carrying more image bytes than the adapter's prompt budget likewise fails
explicitly. Nothing on either path drops an attachment silently. Optional
`settings` are safe runner controls selected from
`/api/coding-agent/capabilities`. In Codex JSON-RPC mode they map to `turn/start`
model, reasoning effort, and speed overrides.

When Codex reports `thread/tokenUsage/updated`, the backend records cumulative
turn token totals and the thread's effective model context window. The selected
session and status snapshots then include `modelContextWindowTokens` plus
`contextWindowUsedTokens` for displaying per-thread context-window percentage
used. `contextWindowUsedTokens` is live context-window occupancy — the most
recent model request's token footprint (Codex `tokenUsage.last`; for Claude
Code, the latest assistant message's per-request usage, excluding subagent
requests, which run in their own context). It is deliberately not the
cumulative `inputTokens`/`totalTokens` fields, which re-count the cached
conversation on every tool round-trip and therefore overstate occupancy by
roughly a factor of the request count. Clients also receive
`agent_turn_token_usage_updated` and `coding_token_usage_updated` events with
fields such as:

```json
{
  "sessionId": "agent-session-abc123",
  "turnId": "agent-turn-abc123",
  "inputTokens": 14898,
  "cachedInputTokens": 10624,
  "outputTokens": 22,
  "reasoningOutputTokens": 15,
  "totalTokens": 14920,
  "contextWindowUsedTokens": 14920,
  "modelContextWindowTokens": 258400,
  "contextCompactionThresholdTokens": 232560
}
```

`contextCompactionThresholdTokens` is a positive integer when a runner replaces
its known threshold and JSON `null` when that runner explicitly clears a value
it reported earlier. Omission carries no new threshold knowledge. These are the
terms described under Coding Agent Capabilities above; the other fields are
unchanged.

### Image attachments

`POST /api/agent-sessions/:sessionId/attachments` stores a session-scoped image
attachment uploaded with `multipart/form-data` field `file`. The first supported
slice accepts PNG, JPEG, and WebP images. The backend validates the content
type, verifies the image signature, hashes the file, and stores it under
`STATE_DIR` rather than the registered workspace:

```text
STATE_DIR/attachments/<workspaceId>/<sessionId>/<attachmentId>/source
STATE_DIR/attachments/<workspaceId>/<sessionId>/<attachmentId>/metadata.json
```

Response:

```json
{
  "attachment": {
    "id": "attachment-00000000-0000-0000-0000-000000000001",
    "workspaceId": "workspace-abc123def456",
    "sessionId": "agent-session-abc123",
    "kind": "image",
    "sourceName": "clipboard.png",
    "contentType": "image/png",
    "sizeBytes": 2048,
    "sha256": "...",
    "createdAt": "2026-05-23T00:00:00.000Z"
  }
}
```

When `AUTH_TOKEN` is configured, this upload route requires bearer auth like
other mutating routes.

### Permission answers

`POST /api/agent-sessions/:sessionId/permissions/:requestId` answers a permission
request a runner raised mid-turn — the interactive third answer beside the two a
runner's configured posture can give on its own (refuse, or the unattended
allow). It is available only for a runner that asks; the built-in runners
answer from their own postures and expose no outstanding request.

```json
{
  "optionId": "allow-1"
}
```

`requestId` and `optionId` are the values the turn's `coding_permission_requested`
event carried (`requestId`, and one of `options[].optionId`). The route selects
one of the options the **agent itself** offered for that one request and can
express nothing else: it names no tool, path, or command, never invents an
`allow_always`, and reaches no other session. Option ids are opaque strings of at
most 200 characters and are matched exactly — the route does not trim or
truncate them. On success it returns
`{ "session": … }`, the same shape as the cancel route, and the turn continues
with a `coding_permission_resolved` carrying `decidedBy: "human"`.

Requests are held for at most 5 minutes; after that the configured policy answers
instead and the resolved event says `decidedBy: "timeout"`. Status codes: `400`
for a malformed body or an `optionId` the agent did not offer for this request,
`401` when `AUTH_TOKEN` is configured and the bearer token is missing (this is a
mutating route — authorizing an agent's action requires the token), and `404` for
an unknown session or a request that is not outstanding (which is also what a
runner with no approval channel reports). The decision is recorded durably as
`agent_permission_resolved` — which option, on whose authority, never the tool
call it was about. See `docs/safety/TRUST_AND_SAFETY.md`.

### Clarifying-question answers

`POST /api/agent-sessions/:sessionId/questions/:requestId` answers a
clarifying-question batch a runner raised mid-turn. Where a permission request
authorizes one action, a question batch asks for direction: the agent pauses
its turn with one or more *sets* — each a prompt, the options it offers, how
many may be chosen, and whether free text is accepted — and continues once a
person answers. Claude Code raises it through `AskUserQuestion`, Codex through
`request_user_input`, and DeepSeek Harness through a descriptor-owned bounded
assistant-text block because its SDK has no server-to-client request. A runner
whose descriptor declares neither a native nor prompt-contract channel has
nothing outstanding and answers `404`. Gated as a whole by the tier-1 managed setting
`global.clarifyingQuestionsEnabled` (default on): off, no runner is given the
channel and each behaves exactly as before it existed.

For DeepSeek, one AgentRoom turn can contain two Harness protocol turns. The
asking Harness `turn/end` leaves the AgentRoom turn running while the request is
outstanding; a human answer or timeout is queued as another `session/prompt` on
the same live Harness session, and the continuation's terminal event completes
the AgentRoom turn. This is an adapter detail: the route, event pair, session
status, transcript, and audit shapes are identical for all runners. The internal
follow-up contains selected labels and invited discussion, never the
AgentRoom-minted ids.

```json
{
  "answers": [
    { "setId": "set-1", "selectedOptionIds": ["opt-2"], "discussion": "phones first" },
    { "setId": "set-2", "selectedOptionIds": ["opt-1", "opt-3"] }
  ]
}
```

`requestId`, every `setId`, and every `optionId` are the values the turn's
`coding_question_requested` event carried. All three are AgentRoom-minted —
`question-<uuid>`, `set-<n>`, `opt-<n>` — and the adapter keeps its own map
back to the agent's question text and labels, so nothing a client sends is a
string the agent interprets as an id. The batch must contain at least one
entry. Each entry must name a selection or non-blank `discussion`; a
`required` discussion must be non-blank even when the set also offers options.
A set the body omits stays unanswered and is reported
to the agent as such. `selectedOptionIds` must all be options the agent offered
for that set, at most one on a `single` set; `discussion` (≤ 4000 characters)
is accepted only where the set's `discussion` is `optional` or `required`. On
success it returns `{ "session": … }`, the same shape as the cancel route; the
turn continues with a `coding_question_resolved` carrying `decidedBy:
"human"`, and the backend appends the rendered answer to the thread as a user
message (`context.questionRequestId`).

Batches are held for at most 10 minutes; after that the runner applies its own
away fallback — the agent is told nobody answered and to proceed on its best
judgment — and the resolved event says `decidedBy: "timeout"`. A cancelled turn
resolves the batch `cancelled`, with no `decidedBy`. Status codes: `400` for a
malformed or empty body, a set or option the agent did not offer, a second
choice on a `single` set, missing required free text, free text on a set that
accepts none, or an entry with neither;
`401` when `AUTH_TOKEN` is configured and the bearer token is missing (a
mutating route); `404` for an unknown session or a batch that is not
outstanding (which is also what a runner with no way to ask reports). Durable
audit records `agent_question_resolved` — which sets, which option ids, on whose
authority — and never the free text, which is the person's own words and lives
in the thread. See `docs/safety/TRUST_AND_SAFETY.md`.

`GET /api/agent-sessions/:sessionId/questions` lists the batches the session
still holds open, each `{ requestId, turnId, questionSets }` exactly as the
request event carried them, so a client that connects after the recent-event
replay rolled over can still render and answer them. Unlike permission
requests, which settle in minutes, a batch can stay outstanding for ten while
the turn waits on it — long enough for the 200-event replay to move on. The
read returns model-authored text, so it requires the bearer token when
`AUTH_TOKEN` is configured, like `/messages`; `404` for an unknown session.

`POST /api/agent-sessions/:sessionId/cancel` stops the active turn when one is
running. The stopped turn is recorded with `status: "cancelled"` and emits
`agent_turn_cancelled` / `coding_turn_cancelled`, but the session returns to
`status: "idle"` with no `activeTurnId` so clients can immediately send a
follow-up steering turn in the same thread. Late runner output from the stopped
turn is ignored for transcript/session state. DeepSeek is the exception: its
protocol has no cancel or verified restore method, so stopping it makes that
AgentRoom session uncontinuable and a follow-up fails until the client creates a
new session.

## Auth

`GET /api/auth/check` reports whether the supplied bearer token is accepted for
protected actions.

## Harness

`GET /api/harness` returns a read-only agent-facing profile with repository
guardrails, knowledge-map entries, feedback loops, verification commands, and
safety posture. It does not run commands, mutate workspaces, or expose secrets.
The knowledge map includes the Apple WWDC 2023 spatial video manifest at
`docs/reference/apple-wwdc2023-spatial-video-manifest.json`, which future
sessions can use to find paraphrased per-video indexes and jump to exact video
timestamps for visual examples.

The response also includes `visionOSDesignGrounding`, a required preflight for
visionOS design questions, reviews, and UI implementation. Agents must consult
`docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md`, the Apple spatial video
manifest, and `docs/engineering/SWIFTUI_STANDARDS.md`; identify the relevant
Apple cue or timestamp; and restate the AgentRoom client boundary before
proposing or editing UI.

`POST /api/harness/visionos/xcodegen` runs the fixed `xcodegen generate`
workflow in `apps/visionos` for a registered workspace. The resolved
`apps/visionos` directory must stay inside the registered workspace and must
contain `project.yml`.

```json
{
  "workspaceId": "workspace-abc123def456",
  "sessionId": "agent-session-abc123",
  "turnId": "agent-turn-abc123"
}
```

`POST /api/harness/visionos/xcodebuild` runs a fixed visionOS `xcodebuild`
build or targeted test check in `apps/visionos`:

```json
{
  "workspaceId": "workspace-abc123def456",
  "sessionId": "agent-session-abc123",
  "turnId": "agent-turn-abc123",
  "action": "test",
  "onlyTesting": "AgentRoomTests/CodingAgentRendererStateTests"
}
```

The harness never accepts an arbitrary command string. It streams bounded
`coding_tool_activity_*` events for the supplied session and turn, and the
response includes status, exit code, bounded stdout/stderr, and extracted
diagnostic lines. When `AUTH_TOKEN` is configured, these POST routes require
the bearer token like other mutating routes.

## Logs And Audit

`GET /api/logs` returns recent in-memory events.

`GET /api/audit` returns bounded durable audit entries.

Backend process logs include turn timing fields for performance diagnosis:
HTTP accept duration, time to runner start, time to first runner event, time to
first assistant delta, assistant stream duration, total turn duration, event
counts, assistant delta count, and assistant byte count. Completed
`runner_audit` payloads also include first-event, first-output, stream-duration,
max output gap, output byte, and runner event-count fields. WebSocket sends log
slow stream delivery when an event is more than 250 ms old or a socket send
takes more than 250 ms.

## Broadcast WebSocket

`WS /api/events` is the only broadcast event socket and streams typed backend
events. The workspace terminal and editor language-service sockets are separate,
authenticated, workspace-scoped protocols. The server sends an initial
`status_snapshot`, then lifecycle events such as:

- `agent_session_created`
- `agent_session_deleted`
- `agent_turn_started`
- `agent_turn_token_usage_updated`
- `agent_turn_update`
- `agent_turn_activity`
- `agent_turn_succeeded`
- `agent_turn_failed`
- `agent_turn_cancelled`
- `agent_permission_resolved`
- `agent_question_resolved`
- `runner_audit`
- `coding_session_started`
- `coding_turn_started`
- `coding_token_usage_updated`
- `coding_assistant_message_delta`
- `coding_plan_updated`
- `coding_diff_updated`
- `coding_artifact_started`
- `coding_artifact_delta`
- `coding_artifact_completed`
- `coding_tool_activity_started`
- `coding_tool_activity_updated`
- `coding_tool_activity_completed`
- `coding_permission_requested`
- `coding_permission_resolved`
- `coding_question_requested`
- `coding_question_resolved`
- `coding_context_compaction_started`
- `coding_context_compaction_completed`
- `coding_turn_completed`
- `coding_turn_failed`
- `coding_turn_cancelled`
- `workspace_registered`
- `workspace_removed`
- `workspace_branch_changed`
- `workspace_file_written`
- `workspace_file_deleted`
- `workspace_directory_created`
- `workspace_directory_deleted`
- `workspace_entry_renamed`
- `workspace_entry_moved`
- `workspace_entry_copied`
- `workspace_git_operation`
- `config_reloaded`
- `editor_catalog_changed`
- `terminal_session_started`
- `terminal_session_closed`

The `status_snapshot` greeting (like the `/api/status` snapshot) replays recent
events but excludes `coding_artifact_delta` payloads, which can be 64 KB each;
clients seed artifact state from `GET /api/agent-sessions/:sessionId/artifacts`
instead. `/api/logs` remains the unfiltered diagnostics view of the recent-event
buffer.

Slow-client policy: when a socket's send buffer stays saturated during a
streaming turn, the backend drops delta-class events for that socket
(assistant/tool/artifact deltas, token-usage updates, and their legacy mirrors)
rather than buffering without bound, and closes the socket (code `1013`) if the
buffer keeps growing. Clients already re-seed transcript, artifact, and token
state over REST when a turn settles or on reconnect, so a healthy client sees no
difference.

The `coding_*` events are the canonical coding-agent stream for native clients.
Each payload includes `version`, AgentRoom `sessionId`, `runnerKind`, and a
turn-scoped `turnId` where applicable.

**Correlation and display metadata is runner-agnostic.** Every payload carries a
`runner` envelope, and so does every `activity` block inside one:

| Field | Meaning |
| --- | --- |
| `nativeSessionId` | The runner's own session/thread id (Codex `threadId`, Claude Code `session_id`) |
| `nativeTurnId` | The runner's own turn id, when it has one |
| `nativeItemId` | The runner's own item id for this event |
| `model`, `cwd` | As the runner reported them at session start |
| `posture` | `{ label, value }` — the runner's *own* posture name and value (`approvalPolicy`/`never` for Codex, `permissionMode`/`bypassPermissions` for Claude Code). Deliberately not a shared enum: the two are different decisions, and flattening them would lose which one was made |
| `sandbox` | The runner's sandbox description, when it reports one |
| `native` | Bounded per-runner extras with no canonical home (Codex's JSON-RPC `method`, Claude Code's `messageUuid`/`parentToolUseId`). Never required to correlate or render |
| `nativeTruncated` | `true` when `native` exceeded its key/depth/length/byte limits and was **omitted whole** rather than trimmed — a half-blob would read as complete |

**Activity payloads carry a canonical reading.** An `activity` block has a
`canonical` object whose `kind` is one of `session_started`, `turn_started`,
`plan_updated`, `diff_updated`, `reasoning`, `tool_started`, `tool_output`,
`tool_completed`, `permission_requested`, `permission_resolved`,
`question_requested`, `question_resolved`, `context_compaction_started`, or
`context_compaction_completed`. A client
decides what an activity *is* from that, never from the activity's native
`kind` string, which stays beside it for display and diagnostics. For the three
tool kinds it also carries `toolId` — the stable per-call id that is identical
across a call's start, output, and completion, and is how a client correlates
them for any runner. `reasoning` and `tool_output` carry the `delta`.

Two consequences worth planning for: an activity the runner's adapter gives no
canonical reading produces **no** `coding_*` event at all (this is how a
non-renderable Codex item stays out of the stream), and both the event `type`
and the canonical `kind` are open vocabularies — a client must ignore an
unrecognized value rather than fail the whole event's decode.

**Legacy per-runner blocks are still emitted.** `codex` (`method`, `threadId`,
`turnId`, `itemId`, `model`, `cwd`, `approvalPolicy`, `sandbox`) and
`claudeCode` (`sessionId`, `messageUuid`, `parentToolUseId`, `model`, `cwd`,
`permissionMode`) are projections of the `runner` envelope, present only for
those two runner ids. They exist so an independently upgraded client can meet an
older or newer backend, and will be removed when the advertised contract floor
(`codingEventContractVersion` on `GET /api/config`, currently `2`) moves past
them. New clients should read `runner` and `activity.canonical`.

Native activity kinds remain visible for diagnostics — Codex's `codex_*` and
Claude Code's `claude_code_*` — but carry no contract. Thinking deltas from
either runner arrive as `coding_tool_activity_updated` with
`activity.canonical.kind: "reasoning"`.
`coding_token_usage_updated` includes cumulative token fields,
`contextWindowUsedTokens` (live context-window occupancy from the latest model
request — see the turns section), `modelContextWindowTokens` when Codex
reports the live thread's effective model window, and
`contextCompactionThresholdTokens` as a positive integer when the runner
publishes one, or JSON `null` when it explicitly clears its previous value.
Omission carries no new threshold knowledge.
`coding_diff_updated` includes a bounded per-file `files` summary. A renamed
file's entry carries the destination as `path` and the source as an optional
`oldPath` — populated from the Git-status rename entry on the settle-time
path and from the unified diff's `rename from` header on the Codex path; a
copy's source stays on disk and deliberately never carries one. Structured
runner summaries and parsed unified diffs are capped at 100 files, and unified
diff parsing has a separate 1 MiB defensive work bound. The optional
`truncated` field is `true` when either bound omitted part of the runner's diff;
clients must surface that state rather than claiming the returned file list is
the complete turn change set. For Codex the event relays the app-server's own
`turn/diff/updated` stream during the turn. Claude Code reports no diff of its
own (the SDK stream has no such notification), so the backend derives one at
turn settlement instead: it snapshots the workspace's fixed read-only Git
status before the runner starts, re-reads it when the turn completes, fails, or
is stopped, and emits the files whose status changed — just before the
turn's terminal `coding_*` event, the order Codex diffs arrive in. Per-file
`additions`/`deletions` are included only for files clean at turn start (a
pre-dirty file's vs-HEAD counts would attribute lines the turn did not write),
`truncated` also reflects either status read's 200-file cap, and the delta
inherits Git status's limits: work the turn commits or reverts to HEAD content
leaves no status entry to report, and a concurrent change to the workspace (a
client editor write, another session's turn) is attributed to the settling
turn — the same caveat documented for the bounded file write. An empty delta
emits no event only when both status reads were complete. If either was capped
before it could name a changed file, the backend emits an empty, `truncated`
summary so clients know the change set is incomplete. A Git read failure only
means the turn settles without a diff.
The `coding_artifact_*` events stream a model-authored sketch the runner writes
in-band as an `<artifact kind="svg|mermaid" title="…">…</artifact>` region that
begins at the start of a line of its assistant text. The backend parses that
region out of the unified assistant delta stream (so the channel is identical for
every runner), keeps it out of the chat transcript, and republishes it
as `coding_artifact_started` (`artifactId`, `kind`, optional `title`), one or
more `coding_artifact_delta` (`artifactId`, `delta`) as it streams, and
`coding_artifact_completed` (`artifactId`, `bytes`, optional `truncated`) when
the region closes. Each `delta` carries only the bytes the backend actually
retained under the per-artifact 64 KB cap, so the live stream never diverges from
the reconnect snapshot; `truncated` is `true` when the cap was hit. Clients
accumulate deltas by `artifactId` to render the sketch live, and seed reconnect
state from `GET /api/agent-sessions/:sessionId/artifacts`. The channel is gated by
`ARTIFACTS_ENABLED` (default on).
Tool activity payloads include a client-renderable `activity.title` and may
include `activity.description` for the command line, MCP tool target, function
name, or affected file path. Native clients should render those display fields
instead of raw Codex item types such as `commandExecution`.
Codex reasoning or thinking updates are surfaced as
`coding_tool_activity_updated` payloads with `activity.kind:
"codex_reasoning"` and a bounded `delta`; native clients can render them
separately from `coding_assistant_message_delta`, which remains the standard
assistant text output stream. Clients that want a Codex-like transcript should
key assistant deltas and tool activity by bounded `codex.itemId` when present,
because a single AgentRoom turn can contain multiple Codex assistant or tool
items.
`coding_permission_requested` is what a client renders to offer the operator a
choice. Beside the `request` block it already carried (the agent's own tool-call
detail, bounded like every other content on this stream) it may carry `requestId`
and `options` — `{ optionId, name?, kind? }` entries the agent itself supplied.
The vocabulary is bounded before it can be opened: 1–16 unique option ids, each
at most 200 characters, with bounded names and kinds. Their presence is the
advertisement that the request was admitted to the pending store and can be
answered: a runner that decides from its own stored posture, an empty or invalid
vocabulary, or a session already at its eight-request cap carries neither, and
the event is the transcript entry it always was. `kind` is the agent's own classification
(`allow_once`, `reject_once`, …) and is an open string, so an unfamiliar one is
rendered plainly rather than dropped — dropping it would hide the only answer the
agent accepts.

`coding_permission_resolved` says what happened and **who decided**: beside
`requestId` and `status` it may carry the selected `optionId` and `decidedBy` —
`human` (someone answered through the route above), `policy` (the runner's
configured posture answered without asking), or `timeout` (the bounded wait ended
with no human answer, so the policy answered). `decidedBy` is an open string like
every other vocabulary here. Clients should surface it: "allowed" reads very
differently depending on who allowed it.

`agent_permission_resolved` is the sanitized durable counterpart of that event,
and it is the one that reaches `/api/audit`. It carries the session, turn,
workspace, and runner identifiers plus an `audit` block naming the request id,
the selected option, the authority, and the status — **never** the tool call the
agent was about to run, which can carry anything and does not belong in a durable
log.

`coding_question_requested` is what a client renders as a question deck. It
carries `questionSets` — one entry per set: `setId`, an optional short `header`
(≤ 24 characters; a runner's chip label), the `prompt`, `selection` (`single`
or `multiple`), `options` (`optionId`, `label`, optional `description`; at most
8), `discussion` (`none`, `optional`, or `required` — whether the set rejects,
invites, or requires free text; a required field may be beside options or
instead of them), and `sensitive` when the free
text must be entered securely and is never echoed back. At most 8 sets. It
carries `requestId` only while the backend holds the batch open; a batch
announced without one is a record a client renders but cannot answer, the same
rule as a permission request without options. `selection`, `discussion`, and
every status below are open strings on the wire: a client degrades an unknown
value (to single-select, to optional) rather than refusing the batch.

`coding_question_resolved` says what happened: `status` (`answered`, `timeout`,
or `cancelled`), `decidedBy` (`human` or `timeout`; absent when nobody
decided), and for a human answer `questionAnswers` — per answered set, the
`selectedOptionIds` and the `discussion` text, except for a `sensitive` set
whose text is never on the stream. `agent_question_resolved` is the sanitized
durable counterpart that reaches `/api/audit`: identifiers plus an `audit` block
naming the request id, the status, the authority, and each answered set's
option ids — never the free text.

Added under contract version 2: both event types and both canonical kinds are
additive, their new fields optional or self-contained, and a client that
predates them ignores them.

`coding_context_compaction_started` and `coding_context_compaction_completed`
report that the runner summarized its own conversation and now holds less of
it. They exist because without them a long thread's occupancy falls between two
turns with nothing on screen saying why, and the transcript above that point is
a conversation the agent no longer holds in full. The started event carries the
usual identifiers and nothing more. The completed event may add `trigger`
(`auto` or `manual`), `preTokens` and `postTokens` for the occupancy either
side of it, and `failed` when the compaction was attempted and did not succeed,
which is the one case where occupancy did not fall. Each is optional because
the runners report different amounts: Claude Code sends both events with the
trigger and both counts, Codex sends both with no trigger and no counts, Cursor
sends the completed event alone, and DeepSeek sends neither event at all. A
compaction with no counts is
still worth showing, so a client should render what arrived rather than waiting
for a complete set.

The compaction's own summary is never on this stream. It is the model's account
of everything the thread has done, and it stops at the backend's adapter rather
than reaching the payload, the activity `content` block, the transcript, the
recent-event buffer, or durable audit. See `docs/safety/TRUST_AND_SAFETY.md`.

Where a runner reports the occupancy left afterwards, its adapter also emits an
ordinary `coding_token_usage_updated` carrying that number, so the drop and its
cause land in the same tick on the path every other occupancy report already
takes. Nothing above the runner boundary learns what a compaction is. Both
event types and both canonical kinds are additive under contract version 2,
which does not move.

`workspace_git_operation` fires for each mutating Git operation (see the routes
above). It is sanitized like the terminal payloads: `workspaceId`,
`workspacePath`, the `operation`, the `branch`/`previousBranch`/`commit`/`remote`
it produced, `fileCount` (paths acted on), and `changedFileCount` (changed paths
remaining) — **never** file content, a path list, or a remote URL, which for an
HTTPS remote can carry credentials.
`config_reloaded` fires when `PATCH /api/config` changes at least one managed
setting. It carries `changedKeys` (key **names** only), `requiresRestart: true`,
and an `audit` block repeating those names for the durable log — **never**
values, since a value would put the operator's trust posture on the wire for
every subscriber. `GET /api/config` stays the one place that reports values, with
tier 3 excluded from it by construction. Clients refresh that read on receipt to
pick up the new `pendingValue` state, whether the edit came from this client, the
Mac app, or another headset.
`editor_catalog_changed` fires when an operator reload changes the served editor
language catalog (Phase C.5). It carries only `version` and `languageCount` —
never asset bytes — and visionOS re-hydrates the catalog on receipt, verifying
each fetched blob's `sha256` before use (see the Editor Language Catalog routes).
`terminal_session_started` / `terminal_session_closed` fire when an interactive
terminal (PTY) session opens and closes (see the Terminal route). They carry only
`sessionId`, `workspaceId`/`workspacePath`, and (on close) `exitCode` and
`durationMs` — never shell input/output.

Native clients that consume canonical `coding_*` events can connect with
`WS /api/events?legacyTurnEvents=false` to omit mirrored `agent_turn_update`
and `agent_turn_activity` events from the live stream and initial snapshot.
The default stream still includes those legacy events for compatibility.
