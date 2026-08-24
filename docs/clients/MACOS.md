# macOS App

The macOS app is the local operator surface. It owns setup, backend process
supervision, LAN pairing URLs, local workspace registration, diagnostics, and
Keychain-backed AgentRoom/Codex launch settings.

The macOS app does not run coding agents directly. It launches or supervises the
backend, and the backend runs Codex through the `AgentRunner` adapter.

## Responsibilities

- Start, stop, restart, and health-check the backend sidecar.
- Store `AUTH_TOKEN` and every runner bootstrap slot value (`CODEX_EXECUTABLE`,
  `CODEX_ARGS`, `CLAUDE_CODE_EXECUTABLE`, `DEEPSEEK_EXECUTABLE`,
  `DEEPSEEK_ARGS`, `DEEPSEEK_CORDIS_CONFIG`, and `DEEPSEEK_API_KEY`) in
  Keychain, keyed by runner and slot rather than as fields per runner — see
  *Runner Bootstrap* below.
- The backend defaults to `CODEX_RUNNER_PROTOCOL=jsonrpc` and starts its own
  app-server; use the app-managed config `.env` to opt into `exec` compatibility
  mode until the Mac settings UI exposes a dedicated control. This app no longer
  derives either key from the Git network toggle: the Codex adapter owns what
  launching its protocol requires, and overriding a deliberately pinned `exec`
  was a bug rather than a convenience.
- Edit the backend-owned managed settings file
  (`$AGENTROOM_HOME/config/settings.json`) that both this app and paired clients
  read, and own the master switch for whether clients may change trust settings.
- Register existing local folders through `POST /api/workspaces`.
- Switch registered Git workspaces to existing clean local branches through the
  backend branch endpoint.
- Mirror backend-owned Codex sessions through `/api/status`,
  `/api/agent-sessions`, and session message endpoints. The Threads dashboard
  shows session metadata, stored transcript messages, selected context metadata,
  recent per-session backend events, and active-turn stop controls without
  offering a Mac-side turn composer.
- Display LAN URLs for simulator and physical Vision Pro pairing.
- Import editor language packs and push them to connected Vision Pro editors from
  the Languages settings pane (see below).
- Show `/health`, `/api/config`, `/api/logs`, `/api/audit`, and workspace
  diagnostics.
- Export diagnostics with configured secret values redacted.

## Runtime Environment

The app launches the compiled backend with:

```text
AGENTROOM_HOME=$HOME/Library/Application Support/AgentRoom
PORT=<configured port>
HOST=0.0.0.0
PATH=<inherited PATH plus common developer tool paths>
WORKSPACE_ROOT=$HOME/Developer/AgentRoom/Workspaces
EDITOR_CATALOG_DIR=$AGENTROOM_HOME/catalog-assets
AUTH_TOKEN=<from Keychain, when configured>
CODEX_EXECUTABLE=<from Keychain>
CODEX_ARGS=<from Keychain, when configured>
CODEX_MODEL=<from app-managed config .env, when configured>
CODEX_SERVICE_TIER=<from app-managed config .env, when configured>
CODEX_RUNNER_PROTOCOL=<from app-managed config .env only; the backend defaults to jsonrpc>
CODEX_APPROVAL_POLICY=<from app-managed config .env, when configured>
CLAUDE_CODE_EXECUTABLE=<from Keychain, when a local claude CLI was detected>
DEEPSEEK_EXECUTABLE=<from Keychain, when configured>
DEEPSEEK_ARGS=<from Keychain, when a source checkout supplies the entrypoint>
DEEPSEEK_CORDIS_CONFIG=<from Keychain, when configured>
DEEPSEEK_API_KEY=<from Keychain, when configured>
REMOTE_SETTINGS_ADMIN=<from the Advanced settings toggle; default false>
AGENTROOM_EXIT_WITH_PARENT=true
AGENTROOM_PARENT_PID=<the current app process id>
```

## Backend Sidecar Ownership

The sidecar is a child process, and quitting the app stops it:
`applicationWillTerminate` sends SIGINT and escalates to SIGTERM. That is the
whole story only for a normal quit. A force quit, a crash, and Xcode's stop
button never reach it, and the backend is then reparented to launchd and keeps
holding the port with nobody supervising it. Two things answer that, one on
each side, because neither alone is enough.

The backend stops when its launcher does. `AGENTROOM_EXIT_WITH_PARENT` and the
launcher's `AGENTROOM_PARENT_PID` are set only here. The sidecar checks that
expected pid before backend startup begins, then polls its live parent pid and
exits when it changes (`apps/backend/src/util/parentExitWatchdog.ts`). The
initial check covers an app that dies before Node can arm the timer; after that,
the polling window is at most a couple of seconds. A backend an operator starts
themselves has no parent whose death should end it, so `pnpm dev` is untouched.

The app recognises its own sidecar across launches. Every successful launch
records the child's pid, its kernel start time, its executable path, and the
port, in the app's own defaults. A later session adopts that process only when
all of it still matches, that exact process owns a listening TCP socket on the
configured port, and the backend is healthy there. It then supervises the
process exactly as if it had spawned it: the status reads running, and
Stop and Restart work. The start time is what makes this safe — pids are
recycled, and the pair is unique for the life of the machine — and the
inspector re-checks the identity immediately before the signal call. Darwin
does not expose an atomic identity-check-and-signal handle for an arbitrary
process, so a residual pid-reuse race remains between that check and `kill`;
the narrow limit and rationale are recorded in the trust posture. An adopted
sidecar's stdout and stderr belonged to the session that spawned it, so its
process log starts empty and `/api/logs` is where its output is read.

Both exist because either can miss. The watchdog cannot help an operator whose
orphan predates it, and adoption cannot help one whose backend is hung. What
adoption deliberately does **not** cover is a backend this app did not start:
without a matching launch record the state stays *Running Outside App* with the
lifecycle controls disabled, because stopping an operator's own `pnpm dev` from
a button labelled Stop Backend is not this app's call. The status detail says
so and says what to do instead.

The lifecycle controls render from `canStartBackend`, `canStopBackend`, and
`canRestartBackend` rather than from the reported state alone, because the state
does not say whether a process exists. A backend that is running but has stopped
answering `/health` reads as *Failed*, and refusing to stop it there is the same
corner the orphan put the operator in. Each control folds the state together
with the observed `hasSupervisedProcess`, so a button is offered exactly when
pressing it would do something: Stop whenever a supervised process is there,
Start only when one is not.

## Managed Backend Settings

Runtime preferences and trust posture — the default runner, the Codex sandbox
and network policy, the interactive terminal, the spatial scene engine, and the
model/effort defaults — live in the backend-owned
`$AGENTROOM_HOME/config/settings.json` rather than in the launch environment.
The app **writes that file directly** instead of calling `PATCH /api/config`, so
the panes keep working while the backend is stopped, which is exactly when an
operator is fixing why it would not start. Every write is a read-merge-write, so
a Mac-side toggle preserves the settings a paired client patched.

The file is the same version-2 document the backend writes — `global` for the
backend's own settings, `runners.<id>` for a runner's — and this app produces
byte-identical output for the same settings, because both writers key-sort at
every level. A version-1 (flat) file is still read and is converted whole by the
next write that changes something; sections this app cannot address (an
unregistered runner's namespace, a field a newer AgentRoom added) ride through
every write verbatim.

Those sections are now also **shown**, read-only, in the Runner pane
(`PreservedSettingsSection`; Phase 1 of
`docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md`). Adding a coding agent is a
backend registration, so a runner the backend registers brings its own managed
settings — including trust-posture ones — and an `auto_allow` permission policy
set from a paired client used to run on this Mac with nothing on this Mac saying
so. Each row is named the way the headset names the same setting
(`ManagedSettingLabel`, shared), with the runner named through the catalog so an
id this build does not know renders as itself rather than as another runner.

They stay **read-only**, and that is the honest answer rather than a shortcut.
The headset edits through `PATCH /api/config`, where the backend validates every
value and refuses what its schema does not accept. This app writes the file
directly, so there is nothing to refuse it: a value outside a vocabulary it
cannot know would make the backend drop the *whole* file onto defaults and take
the operator's entire trust posture with it. Change one from the client that set
it, or update AgentRoom.

Two states are deliberately distinguished. A file this app **cannot parse** is
reported with a reset offer, which is the only overwrite of a file it could not
read. A file written for a **newer** settings schema is refused instead: it is
not damaged, so resetting it would discard a posture the operator authored on a
newer AgentRoom — the repair is updating this app.

Going back to an older AgentRoom is a supported step. The Advanced pane's
**Convert settings for an older AgentRoom** rewrites the file as the flat
document a pre-nested backend reads (deliberately with no `schemaVersion` field,
since an absent version *is* the old one). Every setting this release knows
survives both directions, and a current backend converts the file forward again
on its next change. Without that conversion an older backend would call the file
malformed and drop the whole trust posture onto defaults.

One posture the conversion **refuses** to carry, and the refusal is the point.
`runnerKind` is the one setting whose value an older build can reject: an
unregistered runner's whole `runners.<id>` namespace is preserved-and-never-
applied by both readers, so a third runner's *settings* cross a downgrade
untouched — but `runnerKind` is a **known** key there, and a malformed known
value makes the file unusable, which is the same whole-file drop the conversion
exists to prevent. So a default runner that predates the target build (a bundled
`deepseek`, or an operator's own `acp_*` adapter) closes the button and the
caption says which runner and why — even when the file is already flat, since a
version-1 shape does not make that value acceptable to the older reader.
Changing the default runner first is the operator's call, deliberately:
rewriting `runnerKind` for them would be this app quietly moving their turns
onto a different agent. The store refuses independently of the button, since it
is what actually writes the file.

The runner picker has an offline floor to match: a backend that started
successfully leaves `$AGENTROOM_HOME/config/runners.json` — the same safe/public
projection `GET /api/runners` serves — and the app prefers it while the backend
is stopped, falling back to the runners this build ships knowing when the file is
absent, unreadable, empty, or newer than it understands. A live `/api/runners`
always wins.

Consequences worth knowing:

- **The app no longer injects those variables.** Injecting them would lock every
  managed key to `source: "env"` and make the shared file inert. The names stay
  in the launch scrubber, so a value inherited from whatever launched the app (a
  shell export, an Xcode scheme) cannot silently lock a control the panes present
  as editable.
- **Deliberate environment locking still works** through the app-managed
  `$AGENTROOM_HOME/config/.env`, which the backend loads itself. A key set there
  reports `source: "env"` on `/api/config`, and the pane renders its control
  read-only with a caption saying so, rather than accepting an edit that would
  change nothing.
- **Everything applies on the next backend launch.** When the file no longer
  matches what the running process has, `/api/config` reports a `pendingValue`
  and the panes offer a restart.
- **First run seeds the file** from the app preferences that used to be
  injected, so an upgrade preserves the behavior the operator already had. Once
  the file exists it is authoritative. A legacy `CODEX_REASONING_EFFORT` value
  is likewise migrated from Keychain into `codexReasoningEffort` and removed
  from the backend launch environment.
- **Paired-client edits update the Mac panes live.** The app listens for the
  value-free `config_reloaded` event, then re-reads both `/api/config` metadata
  and the shared file. An environment-locked control displays the backend's
  running value rather than the inert file value.
- **An unusable file is never merged into.** The backend drops such a file
  whole and runs on conservative defaults. The Mac also validates the backend's
  strict shape (known keys and non-null optionals), stable value vocabularies,
  identifiers, and numeric bounds, reports the same state, and offers an explicit
  reset rather than silently rewriting the operator's work. Registry membership
  is the exception: `runnerKind` remains a non-null string so this compatibility
  floor can preserve a runner id introduced by a newer backend.

The Runner settings pane includes an **Allow fetch, pull, and push** toggle for
trusted workspaces where Codex needs to write Git metadata and reach remotes
through the local SSH agent or Git credential helper. It is one operator choice
written as two honest keys in `settings.json`: `codexWorkspaceNetworkAccess:
true` with `codexSandboxMode: "danger-full-access"`, restored to `false` with
`"workspace-write"` when disabled. The toggle does not change
`CODEX_RUNNER_PROTOCOL` or `CODEX_ARGS`: the backend's Codex adapter owns its
app-server launch, and an explicit protocol override stays in the app-managed
config `.env` because it is a bootstrap key the settings file cannot hold.
The app preserves the inherited `PATH`
and adds common developer tool locations such as `/opt/homebrew/bin` and
`/usr/local/bin`, so authenticated tools like `gh` are discoverable by Codex
turns for pull request creation. Use the app-managed config `.env` for
`CODEX_APPROVAL_POLICY`, `CODEX_RUNNER_PROTOCOL`, and backend settings that do
not yet have dedicated Mac UI controls. The app
strips stale provider and git automation environment values from the backend
launch environment before starting the sidecar.

The Advanced settings pane carries two managed feature toggles: **Enable
interactive terminal** (`terminalEnabled`, off by default — see
`docs/safety/TRUST_AND_SAFETY.md`) and **Enable spatial scene volumes**
(`sceneEngineEnabled`, on by default), which gates the backend's bearer-auth'd
composed-scene read route and, through `/api/config`, the visionOS Spatial Scene
open affordance. Both take effect on the next backend launch.

Beside them is **Allow clients to change trust settings**
(`REMOTE_SETTINGS_ADMIN`, off by default), the master switch for remote tier-2
edits. Paired clients can always change preferences such as the default runner
or model; this switch is what additionally lets them change trust posture —
terminal access, the Claude Code permission mode and workspace-settings loading,
the Codex sandbox and network policy — with only the AgentRoom bearer token.
Leaving it off keeps those decisions physically on this Mac. It is deliberately
an app setting injected at launch, never a key in `settings.json`: a key in the
file could be granted by whoever already holds the bearer token, which is the
escalation the switch exists to prevent. The client surface it gates is the
visionOS Settings tab, which renders the Trust section disabled with an
explanation while the switch is off (`docs/clients/VISIONOS.md`). See
`docs/safety/TRUST_AND_SAFETY.md`.

## Runner Bootstrap And The Two Readiness Authorities

Whether a runner will work is **two questions with two authorities**, and this
app is deliberately only one of them (Phase 6 of
`docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`):

- **Mac bootstrap readiness** — is the local prerequisite present on this
  machine? This app answers it, and it must answer with the backend **stopped**,
  which is exactly when an operator is fixing why it would not start.
- **Backend runtime readiness** — can the backend actually spawn that runner's
  child and complete its handshake? Only the backend can answer, and it reports
  it as `ready` on `GET /api/runners`. The Runner pane shows it as its own row
  with a "Check with backend" action, because reading a runner's capabilities is
  what establishes it. The two can honestly disagree — an installed CLI the
  backend still cannot start — and showing one answer for both is what produces
  a runner that reads ready and does not run.

What this app holds and probes per runner is a **bundled bootstrap descriptor**,
not a hand-written case: a runner's tier-3 *slots* (each naming the environment
variable its value is injected as) and its *probes* (`executable_path`,
`keychain_presence`), plus the messages each probe shows. Slot values live in the
Keychain blob keyed by runner id and slot id, so a runner that reuses an existing
slot or probe kind gets its controls, its checks, its launch injection, and its
diagnostics without new Swift. A genuinely new local primitive still needs a
scoped change and a safety review.

The descriptors are bundled with the app **on purpose**. `GET /api/runners` and
`config/runners.json` say which runners exist and never what starting one
requires: a served descriptor that could name an executable path or an
environment variable would be remote code execution by configuration. So the
lists can differ, and a runner this build has no descriptor for simply
contributes no local check rather than another runner's.

The launch environment is built by walking those descriptors, which makes them
the allowlist: a stored value for a runner or slot this build does not describe
is preserved in Keychain and reaches no child process.

Concretely, the app checks for an installed Codex CLI at startup and when safe
checks run, saving the detected executable path to Keychain. This includes the
Codex executable bundled inside ChatGPT.app, as well as standalone and package
manager installations. The Runner settings check can rerun detection manually;
if Codex is not found, install or update ChatGPT/Codex on the Mac and rerun the
check.

The app runs the same probe kind for the Claude Code CLI, saving the detected
path as `CLAUDE_CODE_EXECUTABLE`. This one is *informational* rather than
required: the Claude Agent SDK bundles its own `claude`, so turns still run when
nothing local is found, and it never contributes a setup-blocking item. It
matters because the spawned CLI — not the SDK — owns the model
catalog `supportedModels()` returns, and the bundled CLI is pinned to the
installed SDK release, so a backend running only the bundled binary can advertise
an older model list than the `claude` the operator keeps updated. Runner settings
show the resolved path, allow an explicit override, and can rerun detection.
Claude Code's other probe is the presence-only `claude login` Keychain lookup,
which is required and never reads the credential.

DeepSeek Harness has a required executable probe for `dsh-jsonrpc-agent` — the
SDK runtime, deliberately not the `dsh` launcher, which boots profiles and
serves no SDK protocol, so searching for it would save a path that can never
complete a handshake and report a ready runner that is not one. An operator who
installed the packaged single-file runtime instead fills the slot by hand: its
name carries a platform suffix the search cannot express.

One trap is specific to this app rather than to the runtime, and it only bites
the packaged build: a runtime bin installed from npm is a Node script with a
`#!/usr/bin/env node` shebang, and a Finder-launched AgentRoom hands its backend
a minimal `PATH` with no `node` on it, so the shebang does not resolve and the
child dies before the handshake.

The recommended setup below sidesteps that by naming the interpreter in the
executable slot and the entrypoint in the argument list, which is also why the
search finding nothing is a normal state here rather than a problem: a source
build sits at a path no search can guess. The probe still answers, because
`executablePath` validates a stored value *before* it searches — a hand-entered
`node` reports satisfied, and the `dsh-jsonrpc-agent` search stays a convenience
for an installed bin. What it does **not** cover is the entrypoint, since the
`arguments` slot has no probe. Pointing the executable slot at an npm bin or at
`node_modules/.bin/dsh-jsonrpc-agent` needs an `sh` wrapper that names the
interpreter absolutely; `docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`
(*Setting up a runtime*) carries that wrapper verbatim, the pinned npm
alternative, and the findings behind both.

Beside it the descriptor declares a `filePath` slot for
`DEEPSEEK_CORDIS_CONFIG`, the Cordis composition the runtime boots. It is
required rather than optional because the runtime exits without one, and it is
a distinct slot kind because it names a **data file the backend hands the
child**, never one it spawns. A required file-path probe checks that the
operator's chosen path is absolute, readable, and present; it searches nowhere
and normalizes the saved path before the backend receives it. Runner settings
also store comma-separated `DEEPSEEK_ARGS`, which unlike Codex's selects no
protocol mode — but on the source path it carries the entrypoint the
interpreter runs, so it is empty only when Executable names a runtime bin.
A fourth slot holds the provider key (`DEEPSEEK_API_KEY`), and it is the first
credential this app has held for a runner. Codex brings its own configuration
and Claude Code its `claude login`, so neither needed one; a runner whose key has
nowhere to live but the environment does, and the alternative was an operator
hand-editing a plaintext dotfile — strictly worse than the Keychain for the same
secret. It is a distinct **secret** slot kind only because display differs:
storage, injection, and redaction were already uniform, since
`DiagnosticsTextRedactor` walks every *stored* slot value rather than a list of
known fields, so an exported bundle covers a credential the moment one exists.
The field renders masked and carries no probe — nothing can validate a key
without spending it, and a Check that could only say "saved" would imply a
verification this app cannot perform.

Those four descriptor-declared names are the only DeepSeek bootstrap values the
app injects, which is also what makes them authoritative: the launch strips every
declared name from the inherited environment before injecting, so once the slot
exists a shell-exported `DEEPSEEK_API_KEY` no longer reaches the backend. A key
in `$AGENTROOM_HOME/config/.env` still applies, because the backend reads that
file itself.

### Setting up DeepSeek Harness from a clone

The recommended way to get a runtime, because the checkout ships the example
compositions and lets you read the plugins you are about to trust.

**1. Build the clone.**

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install && pnpm run build
```

`pnpm dsh web` is upstream's front door and is not the way in here — that is the
`dsh` launcher, which serves no SDK protocol.

**2. Point the app at the checkout.** In Settings → Runner → DeepSeek Harness,
press **Use a source checkout…** and choose the folder you just cloned. The app
reads it and fills all three fields:

| Field | Filled with |
|---|---|
| Executable | your Node interpreter, found on this Mac |
| Arguments | the built entrypoint, from the `bin` entry in `packages/examples/jsonrpc-demo/package.json` |
| Composition | `examples/jsonrpc-agent/cordis.yml` |

It reads and never executes, keeps whatever it could derive when something is
missing, and names what it could not — an unbuilt checkout reports exactly that
rather than "not found". It resolves symlinks before accepting the manifest,
entrypoint, or composition, and refuses any regular file that lands outside the
chosen checkout. It also refuses a checkout whose entrypoint path contains a
comma, because `DEEPSEEK_ARGS` uses commas as argument separators. Node goes in
*Executable* because the backend runs
*Executable* with *Arguments* after it: this is `node some-script.js`, and
naming Node by its full path is what keeps it working when the app is launched
from Finder. To fill the fields by hand instead, those are the three values.

**3. Read the composition it chose.** The status line names the file. That file,
not AgentRoom, decides which tools the agent gets and whether it can write
outside the workspace — check what `sandbox-policy` sets `mode` to, that nothing
mounts a console logger or terminal UI (stdout is the protocol), and that the
session-persistence plugin is given an explicit `root`. The walk deliberately
never picks `minimal.cordis.yml`, which mounts `danger-full-access`.

**4. Press Check** on Executable and Composition; both should report satisfied.
There is no check on Arguments.

**5. Paste your provider key** into the **API key** field. It goes to this Mac's
Keychain and is injected when the backend launches. It has to reach the child
this way rather than through the harness's own credential store, which publishes
asynchronously and loses the race against the prompt AgentRoom sends straight
after the handshake.

**6. Restart the backend** from this app, then choose DeepSeek Harness when
creating a session.

Two behaviors to expect. A hand-typed *Arguments* path is never validated, so a
typo passes step 4 and surfaces as Node's own `cannot find module` on the
runtime readiness row. And stopping a turn ends that conversation: this runner has no
verified resume path, so create a new session rather than sending a follow-up.

Only the **default runner's** unmet prerequisites block setup. A Codex or
DeepSeek CLI that was never installed is not a setup failure on a Mac whose
backend is going to start a different runner.

The AgentRoom auth token pane can generate a bearer token, reveal or hide it,
and copy it to the clipboard for pairing visionOS clients. Generated tokens
still need to be saved so the backend sidecar receives them at launch.

Registered Git workspaces show current branch metadata in settings. Branch
selection goes through the backend; the Mac app does not run arbitrary Git
commands itself.

The Threads dashboard is a visual layer over backend session state. It refreshes
server-owned sessions, selected thread messages, status metrics, and recent
events from the backend, and it may request cancellation for an active turn
through the fixed session cancel endpoint. It does not create sessions, send
turns, choose model settings, select file context, upload attachments, or run
Codex directly.

Development builds locate `apps/backend/dist/index.js`, so build the backend
before launching the app from Xcode:

```bash
pnpm --filter @agentroom/backend build
```

## Editor Language Catalog

The Languages settings pane lets an operator push new or updated code-editor
languages (TextMate grammars, themes, and VS Code language configs) to connected
Vision Pro editors **without shipping an app update** (Phase C.5).

- **Import Catalog Folder…** picks a folder shaped like the catalog
  (`EditorGrammars.json` at its root, plus `grammars/`, `language-configs/`, and
  `vs-textmate/`). The app copies only `.json`/`.wasm` **data** (never `.js`) into
  the app-managed override dir `$AGENTROOM_HOME/catalog-assets` (a clean replace),
  then asks the running backend to reload.
- **Reload** re-reads the override dir (then the bundled catalog) and swaps in any
  changes; **Reset to Bundled** empties the override dir so the backend serves its
  built-in catalog again.
- The pane shows which catalog is being served (imported vs. bundled), the version,
  and the language count.

The app injects `EDITOR_CATALOG_DIR=$AGENTROOM_HOME/catalog-assets` at launch so the
import target and the backend's read path are one source of truth. The backend
prefers the override dir when it holds a manifest, otherwise serves the bundled
catalog, otherwise serves none (clients then use their own bundled editor assets).
When the version changes, the backend broadcasts `editor_catalog_changed` over
`WS /api/events` and the visionOS editor re-hydrates live; the event carries no
asset content and clients verify each blob's sha256. The reload and status routes
are gated by `LANGUAGE_CATALOG_ENABLED` and require the bearer token when
`AUTH_TOKEN` is configured. See `docs/safety/TRUST_AND_SAFETY.md`.

## Storage

With `AGENTROOM_HOME`, the app ensures these directories exist:

- `$AGENTROOM_HOME/config`
- `$AGENTROOM_HOME/state`
- `$HOME/Developer/AgentRoom/Workspaces`

It writes `$AGENTROOM_HOME/config/app-support-schema.json` and refuses to run
against a future schema marker until the app is upgraded. It also owns
`$AGENTROOM_HOME/config/settings.json` jointly with the backend (see Managed
Backend Settings above): both write it atomically, and cross-process contention
is last-write-wins for a single operator. `$AGENTROOM_HOME/config/runners.json`
is the backend's alone — the app only reads it, as the offline runner floor.

## Distribution

From the repository root:

```bash
npx pnpm dist:macos
```

The script builds the backend, builds the macOS app, copies backend resources
and Node into `AgentRoom.app`, and creates:

```text
build/distribution/macos/AgentRoom.app
build/distribution/macos/AgentRoom.dmg
```
