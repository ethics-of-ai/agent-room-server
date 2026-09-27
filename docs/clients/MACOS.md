# macOS app

The macOS app is AgentRoom's local operator surface. It owns backend setup,
sidecar supervision, runner bootstrap, managed settings, workspace registration,
LAN pairing, diagnostics, language-catalog import, and published app updates.
It does not run coding agents or Git commands directly.

Backend setup and recovery recipes are in
[Local Mac server](../operations/LOCAL_MAC_SERVER.md). Runner-specific setup is
in [DeepSeek Harness](../engineering/DEEPSEEK_HARNESS_RUNNER.md) and
[Cursor SDK](../engineering/CURSOR_SDK_RUNNER.md).

## Responsibilities

- Start, stop, restart, and health-check the bundled backend.
- Store `AUTH_TOKEN` and descriptor-owned bootstrap slots in Keychain.
- Edit `$AGENTROOM_HOME/config/settings.json` while the backend is running or
  stopped.
- Own the environment-only `REMOTE_SETTINGS_ADMIN` master switch.
- Register existing folders and request bounded branch switches through the API.
- Mirror backend sessions, transcripts, metrics, events, and active-turn cancel.
- Display pairing URLs and export secret-redacted diagnostics.
- Import and validate data-only editor catalogs.
- Edit the local model catalog at `$AGENTROOM_HOME/config/models.json`.
- Run the source-controlled Sparkle update channel.

The Threads dashboard is read and control UI over backend sessions. It does not
create sessions, send turns, select context or model settings, upload
attachments, or execute a runner.

## Backend launch

The app launches the compiled backend with app-support, bind, port, workspace,
catalog, expected-parent, bearer-token, and descriptor-owned bootstrap values.
Managed settings are deliberately not injected because an environment value
would lock the shared file.

The effective roots are:

```text
AGENTROOM_HOME=$HOME/Library/Application Support/AgentRoom
WORKSPACE_ROOT=$HOME/Developer/AgentRoom/Workspaces
EDITOR_CATALOG_DIR=$AGENTROOM_HOME/catalog-assets
HOST=0.0.0.0
```

The launch environment preserves the operator's PATH and adds common developer
locations. Before injection, the app strips all managed and descriptor-owned
secret-tier names it owns so a shell export cannot shadow Keychain or lock a
managed control. `CODEX_RUNNER_PROTOCOL` stays tier 3; the backend defaults it
to JSON-RPC and a deliberate `.env` override may select compatibility `exec`.

Development builds expect `apps/backend/dist/index.js`:

```bash
pnpm --filter @agentroom/backend build
```

## Sidecar ownership

Normal quit sends `SIGINT` and escalates to `SIGTERM`. The backend also receives
`AGENTROOM_EXIT_WITH_PARENT=true` and the app pid. Its watchdog checks before
asynchronous startup and exits when the expected parent disappears.

The app records pid, kernel start time, executable path, and port for each
successful launch. A later app process adopts that sidecar only if every field
still matches, that exact process owns the configured listening socket, and
health succeeds. Identity is checked again immediately before signalling.
Darwin still leaves a narrow pid-reuse race between check and signal; the
accepted residual is documented in
[Trust and safety](../safety/TRUST_AND_SAFETY.md#macos-supervision-and-updates).

An unrecorded backend, including an operator's `pnpm dev`, is shown as running
outside the app and is never adopted or stopped. Lifecycle buttons derive from
whether a supervised process exists, not health state alone, so a hung owned
process can still be stopped.

## Managed settings

The app and backend share the version-2, key-sorted managed settings file. The
app writes it directly so repair and configuration work while the backend is
stopped. Writes read, merge, validate, and publish atomically. A version-1 flat
file is read and migrates whole on the next change; unknown namespaces and
fields survive without being applied.

An invalid file receives an explicit reset offer. A newer schema does not: the
safe action is to upgrade the app, not destroy a posture authored by a newer
version. The Advanced pane can convert a current file to the old flat form for
downgrade. Conversion refuses a default runner unknown to the older build
instead of silently choosing another runner.

The backend's `$AGENTROOM_HOME/config/runners.json` gives the app a safe offline
runner identity and availability cache. Live `/api/runners` wins. An absent,
invalid, empty, or newer cache falls back to identities bundled into this app.

Environment-locked values render read-only. File values differing from a live
backend appear as pending and offer restart. Paired-client changes arrive as a
value-free `config_reloaded` event, after which the app rereads the API metadata
and file.

The Advanced pane owns the spatial-engine preference, the
tier-2 terminal and language-service controls, plus `REMOTE_SETTINGS_ADMIN`.
The last remains an environment-only, default-off Mac decision. Paired clients
can change tier-1 preferences without it; they can change trust settings only
while it is on.

Sketches have no Mac setting. Supporting clients find repository sketches
through the `repositorySketches` capability.

The Codex network toggle writes both `codexWorkspaceNetworkAccess` and the
required sandbox mode. It does not rewrite runner protocol or arguments.

## Runner bootstrap and readiness

Runner availability has two independent answers:

- This app checks local bootstrap prerequisites while the backend may be
  stopped.
- The backend reports observed runtime `ready` only after capability discovery
  spawned and handshook with a child.

Each bundled `RunnerBootstrapDescriptor` owns tier-3 slots, environment names,
and `executablePath`, `filePath`, `keychainPresence`, or `filePresence` probes.
Descriptors also form the launch-environment allowlist. They are bundled rather
than served because a remotely supplied executable or environment name would be
code execution by configuration.

Codex has a required executable path. Detection includes standalone installs,
package-manager installs, and ChatGPT's bundled Codex. Codex also has an
informational presence-only check for the `~/.codex/auth.json` file
`codex login` writes. It is informational because a Codex that keeps its
sign-in in the Keychain or under another `CODEX_HOME` writes no file there. The
backend's `codex_login` check is the proof once the backend runs. Claude Code has an
informational executable path because the SDK includes a CLI, plus a required
presence-only lookup for the `claude login` Keychain item. The lookup requests
no secret data. Presence cannot tell a live sign-in from an expired one, so the
backend's `claude_login` check is the proof once the backend runs.

The Claude descriptor declares a sign-in command. When the Keychain lookup
finds nothing or the backend reports `claude_login` as unavailable, Settings
offers **Sign in to Claude**. It writes a `.command` file that runs
`claude auth login` with the executable probe's resolved CLI, opens it in
Terminal, and then offers **Check again**, which reruns both checks. The file
is user-only, deletes itself when it runs, and quotes the path for zsh. With no
local CLI the row gives the command to run instead.

The Codex descriptor declares the same pair. **Sign in to Codex** runs
`codex login` with the Codex executable probe's resolved path, and it appears
when the auth file is missing or the backend reports `codex_login` as
unavailable. **Sign out of Codex** runs `codex logout` after a confirmation that
warns it signs out every `codex` CLI sharing `~/.codex`.

When the Keychain item exists and the backend has not reported `claude_login`
as unavailable, the row offers **Sign out of Claude** instead. A confirmation
warns that `claude auth logout` removes the Keychain item every `claude` CLI on
the Mac shares. The command runs in Terminal the same way, followed by
**Check again**. Both **Check again** and **Check with backend** read
capabilities with `refresh=true`, so the backend's discovery cache cannot hide a
sign-in or sign-out that just happened.

DeepSeek requires an executable, composition source, fixed arguments for Node,
and a provider key. Local checks validate executable, composition, and Node SDK
entrypoint while the backend is stopped. They do not validate provider access.
The key is stored in Keychain and masked unless the operator reveals it. Its
row can also remove the stored key after a confirmation. A source checkout can
populate Node, entrypoint, and composition through **Use a source checkout**.
The chooser reads without executing, resolves paths, confines files to the
checkout, and rejects comma-containing entrypoints. Review the selected Cordis
graph before launch. Full setup is in the
[DeepSeek guide](../engineering/DEEPSEEK_HARNESS_RUNNER.md).
The packaged backend includes the compiled AgentRoom Cordis-tools plugin; the
packaging script refuses a missing, non-regular, or symlinked plugin resource.
Select **AgentRoom managed** to generate the standard graph and refresh plugin
paths automatically. Custom is the default for existing configurations and
preserves the operator's YAML. Custom tool compositions still need an explicit
plugin entry. The setup choice is bundled and Keychain-held, outside remotely
managed settings. Changes apply after backend restart.

Backend checks display runtime and optional-tool readiness separately, with
repair text and the session-continuation notice. The provider stays unverified
until an explicit **Test provider connection** action returns a response. The
button discloses possible API usage, disables while pending, and reports a safe
result. It sends no workspace files or tool requests.

Cursor has no bootstrap slot because its SDK is bundled and its default
credential file is SDK-owned. Its required `filePresence` probe stats
`~/.cursor/sdk/auth.json` without reading it. A Cursor Pro or better account is
required by the measured SDK. Sign-in and renewal commands are in the
[Cursor guide](../engineering/CURSOR_SDK_RUNNER.md#credentials-and-billing).

Only the default runner's unmet required probes block initial setup. A missing
runner not selected as default does not prevent backend launch.

## Threads and diagnostics

The app reads health, config, runners, status, sessions, messages, logs, audit,
and workspace metadata from the backend. It may cancel the active turn through
the fixed endpoint.

A context-window bar displays runner-supplied occupancy and compaction threshold
only. It never invents a threshold for a runner that did not publish one. The
accessible headroom text carries the same numeric meaning as the visual marker.

Diagnostics export redacts every stored bootstrap value, including slots this
build no longer knows. Status reports only whether a slot is configured.

## Editor language catalog

The Languages pane imports a catalog folder containing its manifest and
`.json` or `.wasm` assets. It copies data only into a sibling staging directory,
swaps the candidate, asks the backend to validate and reload, and retains the
prior override until acceptance. Rejection rolls back. Reset removes the
operator override and returns to bundled assets.

The pane shows safe status: source, content version, schema versions, language
and grammar counts, unresolved scopes, bounded validation code and relative
location, and semantic-service availability. It never shows executable paths,
argv, environment values, absolute project roots, or raw child errors.

`editor_catalog_changed` carries version and language count only. visionOS then
fetches and verifies every blob before activating the generation. The
[catalog API](../api/API.md#editor-language-catalog) owns the wire contract;
[language-catalog safety](../safety/TRUST_AND_SAFETY.md#language-catalog) owns
validation, activation, and import bounds.

## Model catalog

The Models pane edits the local copy of the backend's model catalog, whose
loader and precedence live in
[`RUNNERS.md`](../engineering/RUNNERS.md#model-catalog). It reads the bundled
catalog from `dist/runner/modelCatalog.json` beside the backend entrypoint the
app launches. Each runner's list starts from the local copy when that copy
lists the runner, and from the bundled catalog otherwise.

A save writes only the runner sections that differ from the bundled catalog,
so untouched runners keep receiving app updates. A section edited back to the
bundled list is dropped, and a save with no differing section removes the file.
The app writes the file directly and atomically, so editing works while the
backend is stopped. It checks the backend's rules first, trims fields the way
the backend schema does, and refuses to save while any rule fails. The backend
reads the file only at startup. A save made while the backend runs therefore
offers a restart, the same apply rule as managed settings. An existing file the
app cannot read is reported, and saving replaces it.

## Updates

The build selects `disabled`, `rc`, or `stable`. Source and unsigned builds
default disabled, contain no Sparkle public key or feed, start no updater, and
keep manual update controls disabled with an explanation.

Signed stable builds use the fixed latest-stable feed. Exact
`vX.Y.Z-rc.N` builds use the moving RC appcast whose enclosure points to the
immutable versioned RC asset. `macos-sparkle.mjs` owns this closed mapping.
Packaging rejects a disabled build containing metadata or an enabled build
missing its fixed feed, key, or signing identity.

Sparkle checks enabled channels daily and shows its standard install prompt.
It never installs silently and refuses downgrade. `SUSendProfileInfo` is false.
Automatic checks can be disabled with:

```bash
defaults write dev.agentroom.AgentRoomMac SUEnableAutomaticChecks -bool false
```

Before relaunch, the app records a restart marker only for a running app-owned
backend, holds termination, sends the bounded `SIGINT` then `SIGTERM` sequence,
and cancels termination if the process remains alive. The new app consumes the
marker and restarts that backend. An intentionally stopped backend stays
stopped; app support, Keychain, settings, workspaces, and sessions are retained.

Publication policy and RC validation are in
[Open-source mirror](../operations/OPEN_SOURCE_MIRROR.md).

## Storage and distribution

The app creates:

- `$AGENTROOM_HOME/config`;
- `$AGENTROOM_HOME/state`;
- `$HOME/Developer/AgentRoom/Workspaces`.

It refuses an app-support schema marker from a newer release. The shared
settings file is writable by app and backend; the runner catalog cache is
backend-written and app-read.

Build the distribution from the repository root:

```bash
npx pnpm dist:macos
```

Artifacts appear at:

```text
build/distribution/macos/AgentRoom.app
build/distribution/macos/AgentRoom.dmg
```
