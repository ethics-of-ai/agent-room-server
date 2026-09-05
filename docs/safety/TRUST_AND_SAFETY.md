# Trust and safety

This document owns AgentRoom's trust decisions, gates, bounds, rationale, and
known limitations. The [API](../api/API.md) owns wire shapes. The
[runner guide](../engineering/RUNNERS.md) owns adapter architecture.

## Security model

AgentRoom is a personal-use system running on an operator's Mac. Registered
local workspaces are the only session targets. The backend owns workspace
access, runner execution, session state, events, and audit. Clients submit
bounded requests; they do not receive provider credentials or a general process
execution API.

When `AUTH_TOKEN` is configured, every mutating HTTP route requires its bearer
token. Reads that expose workspace structure or content, session content,
artifacts, editor assets, spatial documents, questions, Git state, and file
search use the same bearer check explicitly. WebSocket routes authenticate in
their handlers because an upgrade is an HTTP GET.

`WS /api/events` is the existing exception: it is not bearer-authenticated.
Recent events are also available through the ungated status and logs reads.
Live assistant and tool-output events contain bounded text that can include
workspace source content. File and Git mutation events carry metadata only.
Child diagnostics must remain bounded and secret-redacted; sensitive question
discussion follows the [question storage rules](#clarifying-questions) below.
Output limits and diagnostic redaction do not remove source text from the live
stream. Closing this broadcast-read gap remains future hardening.

`AUTH_TOKEN` is removed from every runner child and terminal environment. It is
an API transport secret, not a runner credential. Child-authored diagnostics
pass through `util/redactSecrets` before reaching responses, events, logs, or
durable audit. This redaction covers labelled secrets and bearer values; it is
defense in depth, not a substitute for environment isolation.

## Configuration and secrets

### Managed settings

`$AGENTROOM_HOME/config/settings.json`, with a development fallback under
`.agentroom/config`, contains only managed preferences and trust posture. It
never contains bootstrap, secret, executable, bind, storage, or process-start
settings. In particular, `AUTH_TOKEN`, runner executable paths and arguments,
`TERMINAL_SHELL`, `HOST`, `PORT`, `STATE_DIR`, `WORKSPACE_ROOT`,
`AGENTROOM_HOME`, and `EDITOR_CATALOG_DIR` are not managed keys and cannot be
read or patched through `/api/config`.

Settings resolve in this order: process environment, managed file, code
default. An environment value locks its key. The API reports it as
`source: "env"` and `editable: false`; a file value at that address is inert.
Configuration is snapshotted at process startup. Every managed change requires
a backend restart, and only the macOS app controls that restart.

Trust-tier settings are remotely editable only while the environment-only,
default-off `REMOTE_SETTINGS_ADMIN` master switch is on. While it is off, a
PATCH naming a tier-2 setting returns `403`, and metadata reports that setting
as not editable. The switch is deliberately not a managed setting, so a bearer
token cannot grant itself trust-posture administration.

Global definitions live in `config/globalManagedSettings.ts`; runner-owned
definitions live on `RunnerDescriptor`. Schemas, tiers, environment names,
defaults, API metadata, and PATCH validation derive from those definitions.

The current file format is schema version 2, with `global.<field>` and
`runners.<runnerId>.<field>` addresses. A version-1 flat document is still read
and is migrated as a whole on the next write. Reads never rewrite it. Unknown
runner namespaces and fields are preserved but not applied. A malformed known
value invalidates the whole file. A version-2 file containing a legacy top-level
key is rejected. A newer schema version is reported separately as unsupported
and is not reset automatically.

During version-1 migration, known nested addresses that were previously inactive
are dropped. Carrying them into version 2 could silently activate a trust value
the operator's running backend had ignored; only unknown nested entries survive.

Rollback conversion writes the flat, unversioned version-1 form. It refuses a
default `runnerKind` unknown to the older release instead of substituting a
runner. Writers accept only versions 1 and 2 and sort keys deterministically.

An unreadable, invalid, or unusable settings file is dropped whole and the
backend uses conservative defaults. A write refuses to merge into an invalid
file, publishes atomically through an exclusive sibling temporary file, uses
mode `0600`, and is serialized by a process-local mutex. Cross-process writes
from the backend and macOS app are last-write-wins; adding an optimistic token
is noted hardening.

`GET /api/config` is LAN-readable and exposes posture, not secrets. Each managed
setting appears at both its canonical version-2 address and its legacy flat
address while compatibility requires it. A PATCH may use either address but
may not name both for one setting. `valueKind` and `options` describe the schema.
`config_reloaded` and its audit projection carry changed key names only, never
values.

### Runner catalog and readiness

`GET /api/runners` exposes only runner id, display name, `registered`,
`configured`, `enabled`, and optional observed `ready`. Descriptor policy and
tier-3 bootstrap data never leave the backend. Unknown runner ids render as
themselves and are never coerced to a built-in identity.

Readiness has two authorities:

- Backend readiness records whether the adapter's existing capability probe
  spawned and handshook successfully. The runner read starts no probe. `ready`
  is absent until observed, false after a failed probe, and in-memory only.
- macOS bootstrap readiness checks local prerequisites while the backend may be
  stopped. Bundled `RunnerBootstrapDescriptor` values define executable,
  file-presence, and Keychain-presence probes. File and Keychain probes never
  read or return credential content.

The backend writes the same non-secret identity and availability projection to
`$AGENTROOM_HOME/config/runners.json` for stopped-backend macOS use. It excludes
runtime readiness and all bootstrap details. The backend never reads it.

## Runner execution

The built-in runners are `codex`, `claude_code`, `deepseek`, and `cursor`.
Each runs on the backend behind `AgentRunner`. Sessions pin a runner kind at
creation. Policy above the runner package cannot branch on runner identity.

Restorable persistent children are idle-reaped after 30 minutes. Codex, Claude
Code, and Cursor resume through native identifiers with the same explicit
runtime settings used for a new child. DeepSeek declares restoration
unsupported, is not idle-reaped, and cannot continue the same AgentRoom session
after cancellation or child loss. `PersistentRunnerSessionHost` owns the shared
lifecycle.

### Session persistence

Each session is written through to `STATE_DIR/sessions/<sessionId>.json`, in a
directory created with mode `0700`. The record contains the session, turns,
messages, and native resume id. It is intentionally not redacted because a
redacted transcript would corrupt the conversation, and its reads require the
bearer token when configured.

Every mutation schedules a coalesced per-session write. Persistence does not
depend on graceful shutdown. `SIGINT` and `SIGTERM` still close the backend
under a two-second ceiling so runner, terminal, and store disposal can run; a
second signal exits immediately. The expected-parent watchdog remains abrupt.

A turn running at restart settles failed with `Backend restarted during this
turn`. A recorded native id is seeded into its runner; the backend never reads
provider transcript files to reconstruct the conversation. If the runner starts
a different native conversation, AgentRoom appends a system message explaining
that the new agent has not seen the preceding thread. A restored session whose
descriptor has no restore strategy refuses its next turn with `409`.

Deleting a session tears down its runner and attachments, prevents late writes
from recreating the document, then removes the record before reporting success.
Newer or invalid session documents are left untouched and not served. There is
no retention cap on session count, age, or thread length.

### Permission approval

An interactive approval can exist only when the runner's tier-2 posture selects
`ask`. Client connection never changes that posture. The bearer-authenticated
permission route selects one option the agent offered for one outstanding
request. It cannot name a tool, command, or path, invent an option, or answer a
request in another session.

The wait is five minutes. Timeout applies the configured conservative fallback.
Pending requests are in memory, capped at 8 per session, and released on turn
settlement, child loss, or session deletion. An accepted vocabulary has at most
16 unique exact option ids, each at most 200 characters; malformed, duplicate,
empty, or overlong options are not offered to clients. The resolved event
records request id, option, result, and `human`, `policy`, or `timeout`
authority. Durable audit never stores the proposed tool call.

Runner postures remain distinct. Codex approval policy, Claude Code permission
mode, Cursor's fixed SDK behavior, and each ACP adapter's permission policy are
not collapsed into a universal enum.

### Clarifying questions

Questions are direction, not authorization. The bearer-authenticated answer
route accepts only AgentRoom-minted request, set, and option ids, selects only
offered options, and accepts free text only where invited. At least one set must
be answered; a required set needs a nonblank discussion value. The pending read
and session message history are bearer-gated.

A batch waits for ten minutes, then tells the runner nobody answered. Timeout
never chooses an option. Cancellation and child loss resolve without an
authority. Pending batches are in memory, capped at 8 per session, with no more
than 8 sets and 8 options per set. Text is bounded at every boundary. Invalid
batches are refused rather than truncated into a changed vocabulary.

Audit stores request id, status, authority, and selected option ids. Ordinary
free text is appended to the bearer-gated session history as a user message.
Text from a `sensitive` set is sent to the agent but omitted from events,
history, audit, and logs. The model can later restate it, so this is a storage
rule, not a model non-disclosure guarantee.

Codex enables only its `request_user_input` path per thread and refuses every
other unexpected server-to-client request. Claude Code handles
`AskUserQuestion` in `canUseTool` and refuses any other tool reaching that
callback. Cursor registers one `ask_user_question` custom tool and always
disallows the SDK's `askQuestion`. DeepSeek accepts one line-start
`<agentroom-question>` JSON block, capped at 64 KiB; malformed, inline,
incomplete, oversized, or later blocks remain prose. A valid DeepSeek answer
continues through a second Harness prompt while the same public turn remains
open.

`clarifyingQuestionsEnabled`, env `CLARIFYING_QUESTIONS_ENABLED`, is a tier-1
preference and defaults on. When off, no runner receives a question channel and
Codex's per-thread flags are pinned false.

### Context compaction telemetry

Compaction events report only start, completion, failure, and numeric occupancy
facts supplied by the runner. Model-authored summaries and error text do not
cross the adapter boundary. The channel cannot trigger compaction and adds no
route, setting, gate, or write path.

A compaction threshold is present only when the runner supplies it. A valid
disabled response clears it; failed or malformed control reads preserve the
last known value. Claude Code's bounded five-second control read is asynchronous,
starts no child, and makes no model call. Occupancy updates use the existing
token-usage path and persist with session metrics.

## Built-in runner posture

### Codex workspace configuration and network

AgentRoom's Codex JSON-RPC sessions default to `workspace-write` with workspace
network access off. The backend explicitly pins approval policy, sandbox mode,
and `sandbox_workspace_write.network_access` on start and resume, so a workspace
project config cannot override those values. Operators may enable network and a
wider sandbox as tier-2 trust choices; Git metadata writes require an adequate
sandbox.

Codex itself loads the workspace `AGENTS.md`, `.codex/skills`,
`.agents/skills`, and `.codex/config.toml`. Project config may register MCP
servers and hooks that execute on the Mac. Starting a thread also records the
workspace as trusted in the operator's Codex config. Other nested sandbox keys,
MCP configuration, and hooks are not exhaustively shadowed by AgentRoom. There
is no honest partial-isolation toggle. Do not register a workspace for Codex if
its committed Codex configuration is untrusted. Capability discovery starts no
thread and loads none of this project configuration.

### Claude Code workspace configuration and billing

Claude Code defaults to `bypassPermissions`, including the SDK's required
dangerous-skip opt-in. It is not sandboxed or filesystem-bounded to the
registered workspace. Stricter `acceptEdits`, `dontAsk`, and `default` modes are
tier-2 managed alternatives.

At `bypassPermissions`, `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS` defaults true and
loads the whole SDK `project` settings source: `.claude/skills`, `CLAUDE.md`,
subagents, `.claude/settings.json` hooks and permission rules, `.mcp.json`
servers, `env`, and `apiKeyHelper`. Hooks and stdio MCP servers can execute at
session initialization before a model turn. Only trusted project configuration
should be registered.

Under a stricter permission mode, the runner forces `settingSources: []` so
project hooks and permissions cannot widen the selected posture. Setting
`CLAUDE_CODE_LOAD_WORKSPACE_SKILLS=false` also gives full SDK settings
isolation. The discovery probe always uses `settingSources: []` in the backend
working directory.

The SDK project source excludes interactive `user` and `local` settings, but
`CLAUDE.md` and skills discovery walks from the registered cwd into ancestors.
A workspace registered inside a larger repository can therefore load files
outside the registered subtree. Skill enablement is not a filesystem sandbox.

The runner removes `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH_TOKEN` so trusted
workspaces bill the Mac user's `claude login` subscription. The tier-2
`CLAUDE_CODE_INHERIT_PROVIDER_AUTH` opt-in preserves provider environment
credentials instead. Loaded project settings can reintroduce an API key, auth
token, or credential helper after the scrub, so deterministic billing requires
a trusted workspace or project settings disabled.

### DeepSeek Harness

AgentRoom drives an operator-installed SDK JSON-RPC runtime, not the `dsh`
launcher. It verifies the runtime identity during handshake. The runtime and
Cordis composition are tier-3 environment choices and require both
`DEEPSEEK_EXECUTABLE` and `DEEPSEEK_CORDIS_CONFIG`; argv is backend-built with
no shell.

AgentRoom cannot inspect the composition's sandbox. Upstream examples include
both `danger-full-access` and workspace-write profiles, so DeepSeek is treated
as `bypassPermissions`-class. The tier-2 `permissionMode` is passed through to
the composition's own vocabulary and is not claimed as a backend-enforced enum.
There is no protocol approval callback.

The backend pins `DSH_CWD` to the registered workspace and
`DSH_SESSION_ROOT` under `STATE_DIR`, preventing the common relative persistence
default from dirtying the workspace. The Harness may start subagents and other
processes that inherit its environment; AgentRoom does not separately observe
or contain them. The runtime has no provable resume path, so it stays resident
while idle and the session becomes uncontinuable after cancellation or loss.
Shutdown, EOF, `SIGTERM`, and `SIGKILL` form a bounded teardown ladder;
cancellation skips graceful drain so stopped work cannot finish in the
background.

### Cursor

Cursor's tier-2 `sandbox` defaults true. Measured behavior, not the vendor
description, is authoritative for this release: writes outside the workspace
and network DNS failed, writes inside the workspace and `/private/tmp`
succeeded, and reads from the operator's home directory succeeded. The sandbox
bounds writes and egress, not reads. Workspace `.cursor/sandbox.json` can widen
network egress and AgentRoom cannot pin it. With sandbox off, Cursor is
`bypassPermissions`-class.

Cursor has no interactive approval callback. Tier-2 `autoReview`, default
false, can deny calls but does not widen permissions. Tier-2
`loadWorkspaceSettings`, default true, loads workspace `AGENTS.md`, Cursor
rules, hooks, MCP servers, and skills from `.cursor`, `.agents`, `.claude`, and
`.codex`. Hooks and MCP servers execute within the turn. Off passes
`settingSources: []`; capability discovery always does the same.

The SDK runs in a backend-spawned Node host child. Its cwd is the registered
workspace and its environment is the operator environment minus `AUTH_TOKEN`.
The SDK's shell children inherit that environment. Agent state is pinned under
`STATE_DIR/cursor/agents`.

Billing uses `CURSOR_API_KEY` when supplied, otherwise the SDK sign-in file at
`~/.cursor/sdk/auth.json`. The key, backend URL, and sign-in file are tier 3 and
never returned or logged. The macOS readiness probe checks file existence only.
SDK logout deletes the file but does not revoke the key. A paid Cursor plan is
required. The SDK emits Cursor telemetry with no opt-out exposed by the bundled
version; model inference leaves the Mac. Subagents run inside the host and are
not independently bounded.

Turn model, effort, and fast-mode values are mapped only from the selected
model's declared vocabulary. No free client string is passed to the SDK. Other
runner provider secrets remain visible in bundled runner environments; per-
runner secret isolation is future hardening.

### External ACP adapters

External ACP v1 support is gated by default-off `ACP_ADAPTERS_ENABLED`.
Definitions come from the tier-3 `ACP_ADAPTERS` JSON list. If the gate is off,
nothing is parsed or registered. A malformed list is dropped whole.

Each executable path must be absolute, non-symlink, regular, executable, and
realpath-canonicalized before spawn. Arguments are fixed by the operator's
definition; there is no shell. The child receives only `PATH`, `HOME`,
`TMPDIR`, locale and user identity, plus explicitly granted credential names.
`AUTH_TOKEN` cannot be granted.

Adapter ids use `acp_*` and cannot shadow built-ins. Derived settings prefixes
are compared explicitly against every built-in and configured adapter; any
collision rejects the whole set before registration.

The stdio client caps frames at 1 MiB, nesting depth at 64, stdout volume, and
the retained stderr tail. Handshake, turn, cancel, and shutdown have deadlines.
A transport breach kills the child with a bounded `SIGTERM` then `SIGKILL`
ladder. Every message is schema-validated.

Only agents advertising `session/resume` or `loadSession` are admitted. Replay
updates from `loadSession` are suppressed because AgentRoom already holds the
transcript. AgentRoom advertises no ACP filesystem or terminal capability and
refuses those calls. ACP absolute-path writes lack the workspace API's path and
optimistic-lock guarantees.

Permission policy is a tier-2 per-adapter setting: default `reject`, `ask`, or
`auto_allow`. Every result selects an option the agent offered. Agent
`configOptions` in the `model` and `thought_level` categories may become bounded
turn controls. `model_config` is not misrepresented as speed. `mode` is always
dropped because it can widen the agent's sandbox outside tier-2 administration.

Images are delivered only after that child explicitly advertises
`promptCapabilities.image: true`. Unknown or inconsistent capability state does
not let another child decide. Accepted images are inlined and capped at 16 MiB
total decoded bytes per prompt, in addition to upload bounds.

## Workspace files

Registration accepts existing absolute directories and stores metadata under
`STATE_DIR`, never inside a selected folder. Unregistering does not delete the
folder.

Reads and mutations accept workspace-relative paths. Paths reject NUL, absolute
forms, and `..`; realpath containment is checked at the point of use. Symlink
leaves and escaping intermediate symlinks are refused. Secret-named paths,
generated directories, hidden metadata such as `.DS_Store`, and internal
`.agentroom-tmp` staging names are excluded consistently.

There are exactly seven workspace mutations:

1. text-file PUT;
2. regular-file DELETE;
3. one-level directory POST;
4. same-parent rename;
5. same-workspace move;
6. same-workspace copy;
7. recursive directory DELETE.

All are bearer-gated when configured. They use `node:fs`, not a shell or Git.
Events carry relative paths, types, counts, and byte counts, never file content.
Mutations intentionally dirty the working tree and can race a running agent
turn; optimistic tokens narrow but do not eliminate filesystem races.

Text PUT accepts UTF-8 without NUL, capped at 256 KiB. An overwrite requires a
matching `baseModifiedAt`; no token means create-only. Stale or missing targets
return `409`. Publication is an exclusive sibling temporary file followed by
rename. File DELETE accepts a regular file only and always requires the token.

Directory POST creates one empty directory under an existing parent. It is the
only mutation without an optimistic token because it refuses any occupied name
and replaces nothing. It is non-recursive. Entry names are trimmed single path
components no longer than 255 UTF-8 bytes.

Rename and move require `baseModifiedAt`, accept regular files and directories,
and never overwrite. Rename cannot change the parent. Move stays within the
registered workspace, refuses cross-filesystem moves and a directory moved
into its own subtree, and uses the same no-overwrite implementation. A genuine
same-entry or same-name request is an idempotent no-op; case-only rename is
allowed only for the same inode.

Copy inventories and rechecks the source, stages beside the destination, and
publishes only a complete result. It requires `baseModifiedAt`, follows no
symlinks, and caps every source at 20,000 entries and 1 GiB. Open file handles
are checked for inode, size, and mtime stability. Collision policy defaults to
`fail`; `keep_both` tries the bounded suffix ladder `-2` through `-5`.

Recursive directory DELETE refuses the workspace root. It requires the selected
directory's token and preflights the full tree before removal. Symlinks,
protected names, sockets, devices, unsupported types, more than 20,000 entries,
or more than 1 GiB of regular-file data fail before deletion. It is symlink-safe
but not a transactional snapshot against concurrent regular-file changes.

### File index, search, preview, and skills

The file index and literal content search share one filtered enumeration. Git
workspaces use fixed `git ls-files -z --cached --others --exclude-standard`;
others use a bounded non-symlink-following walk. Every Git result is re-filtered
and every indexed path is realpath-checked again before use.

Search compiles no caller-supplied regular expression. Query is a literal
substring with case and whole-word modifiers. Include globs use a linear
matcher. Bounds are 20,000 indexed paths, 200 index results per request with a
default of 50, 2,000 searched files, 20 matches per file, 500 total matches,
256 KiB per file, 3 seconds wall time, and 200 characters per preview. Partial
results set `truncated`. Fixed Git commands share a 16 MiB stdout ceiling.

File preview and HEAD-baseline reads reject binary or NUL content and cap text
at 256 KiB. An over-cap HEAD blob returns metadata without partial content.
The baseline uses fixed `git cat-file` and scopes `HEAD:./<path>` to the
registered directory.

Skill discovery scans only descriptor-owned workspace directories. It follows
no escaping symlink and reads only `SKILL.md` frontmatter name and description,
never the body or executable content. Discovery mirrors the runner's workspace-
settings gate and emits no event or audit entry.

## Git operations

Git status is read-only, bearer-gated when configured, and capped at 200 changed
file summaries. Branch switch accepts an existing local branch only, uses fixed
`git switch`, and refuses a dirty workspace.

The only mutating Git operations are stage, unstage, discard, commit, fetch,
fast-forward-only pull, push, and branch create. They are bearer-gated fixed argv
calls through `execFile`, never a shell. Callers cannot supply flags, remotes,
refs, or refspecs. Amend, reset, rebase, cherry-pick, tag, remote mutation, and
forced push are not exposed.

Every client path passes the workspace secret/generated filter. Explicit unsafe
paths return `415`; stage-all enumerates the uncapped changed set, filters it,
and sends literal pathspecs in bounded batches. It never runs `git add -A`.
Explicit stage and unstage require exact changed-file entries, not directories.
Commit validates the repository's complete staged set and refuses paths outside
the registered workspace or inside protected names.

Discard is destructive, names every path, and has no discard-all form. Remote
operations disable terminal prompts and use SSH batch mode while retaining
normal credential helpers. Their configurable default timeout is 120 seconds.
Git error text has URL userinfo stripped and is secret-redacted. Commit hooks
are intentionally allowed and run under the local command timeout, so committing
trusts workspace hook configuration.

Operation events and audit contain operation, ids, counts, result branch, and
commit only. They contain no file content, path list, remote URL, or credential.
Git index locking prevents corruption but cannot prevent a commit interleaving
with a running unsandboxed agent turn.

## Terminal

The PTY is the only client-facing arbitrary shell surface. `TERMINAL_ENABLED`
is tier 2, defaults false, and removes the WebSocket route entirely while off.
When enabled, the socket authenticates before spawn and starts an unsandboxed
login shell in the realpath of a registered workspace. The shell can `cd`
elsewhere; the starting directory is not a sandbox.

`TERMINAL_MAX_SESSIONS` defaults to 8 and is schema-bounded from 1 to 64 across
the process. Creation reserves a slot before asynchronous lookup. Sessions are
idle-reaped after 30 minutes, resize is clamped, inbound frames are capped, PTY
output is flow-controlled, and socket close, idle reap, or backend shutdown
sends `SIGTERM`.

Input and output exist only on the live socket and are never logged or
persisted. Lifecycle events and audit store ids, workspace identity, exit code,
and duration only. The shell inherits the operator environment plus
`TERM=xterm-256color`, minus `AUTH_TOKEN`. `TERMINAL_SHELL` remains tier 3.

## Feedback harness

The feedback harness is not a shell API. It exposes only fixed visionOS
XcodeGen, build, and targeted-test templates declared by the backend profile.
Every request names a registered AgentRoom workspace, session, and turn. The
backend resolves the fixed project path inside that workspace and refuses an
escape, unregistered root, unknown action, or caller-supplied command fragment.

Output, duration, and exit state are bounded and stream as canonical tool
activity attributed to the runner pinned to the supplied session. The caller
cannot choose that attribution. Harness execution adds no general argv,
environment, cwd, or filesystem surface.

## Editor surfaces

### Language catalog

The editor catalog contains app-global data, never workspace files. It serves
manifest-referenced `.json` and `.wasm` only, never `.js`. Reads are bearer-
gated when configured. `LANGUAGE_CATALOG_ENABLED` gates the surface and defaults
on. The root is an operator override from `EDITOR_CATALOG_DIR`, then the bundled
catalog; an absent catalog returns 404 and clients use bundled assets.

A generation is accepted only after all paths, hashes, sizes, language claims,
grammar relationships, theme maps, and JSON depth validate. Required caps are
256 languages, 4,096 claims with at most 64 per language, 256 primary and 512
auxiliary grammars, dependency depth 8, 2 MiB per grammar or WASM, 64 KiB per
language configuration, 32 MiB aggregate bytes, and JSON depth 32. Schema-2
injection graphs must be acyclic; each grammar may name at most 128 external
scopes. Accepted bytes are pinned in memory.

Reload swaps only a complete valid snapshot. Failure preserves the last accepted
generation, and invalid startup override falls back to bundled data. Status
returns aggregates and bounded error location, not assets. Reload is bearer-
gated and mutating but changes no workspace. `editor_catalog_changed` carries
version and language count only.

The macOS importer copies operator-selected `.json` and `.wasm` into AgentRoom
app support through staging and same-volume rename, retaining the prior override
until validation. It never writes a registered workspace. Maintainer grammar
imports use pinned HTTPS sources, preserve provenance and licenses, validate
data, execute nothing fetched, and sync one way into the backend catalog.

### Language services

`LANGUAGE_SERVICES_ENABLED` is tier 2, defaults false, and removes the workspace
WebSocket while off. The always-present registry read is probe-free and exposes
only identity, configuration, enablement, observed readiness, languages, and the
supported subset of completion, hover, definition, symbols, and semantic tokens.

Built-ins are SourceKit-LSP, pinned TypeScript Language Server 5.3.0 with
TypeScript 5.9.3, pinned Pyright 1.1.413, optional rust-analyzer 2026-08-31,
gopls 0.23.0, Eclipse JDT LS 1.61.0, Kotlin LSP 262.9593.0 alpha, and csharp-ls
0.27.0. Optional executable overrides are tier 3, absolute, regular,
executable, and non-symlink. AgentRoom does not search PATH for them. Arguments
and initialization are descriptor-fixed. TypeScript automatic type acquisition
is disabled. JDT data is backend-owned and removed when its process closes.

External descriptors require both the general gate and default-off
`EXTERNAL_LANGUAGE_SERVICES_ENABLED`. The tier-3
`LANGUAGE_SERVICE_ADAPTERS` document is capped at 64 KiB and 8 descriptors,
strictly validated, and dropped whole on any duplicate, conflict, or malformed
field. IDs use `external_lsp_*`; language ids cannot shadow built-ins. Commands
are admitted absolute non-symlink executables, argv is fixed, and the client
cannot select a descriptor or raw LSP method.

External children receive a small base environment plus at most 16 explicitly
granted uppercase names. Credential-shaped names, provider prefixes,
`AUTH_TOKEN`, and unset values are refused. Language services are not process
sandboxes: project loading can run build tools, plugins, macros, analyzers, or
networked dependency resolution. Only trusted projects should be opened.

The authenticated socket accepts a strict version-1 open, change, request,
cancel, and close protocol. It has no raw method, command, argv, environment,
HTML, or arbitrary JSON escape. Paths use the workspace bounds. Project-root
selection stops at the registered root, uses descriptor markers and priority,
and reports ambiguity. One socket generation leases one canonical file path,
including case aliases.

Host caps are 8 processes globally, 4 per workspace, 32 shadows per process,
256 KiB per shadow, and 32 MiB shadow text globally. LSP frames and queued child
stdin are each capped at 4 MiB; stderr at 64 KiB. Socket frames are capped at
384 KiB inbound and 2 MiB outbound, with 8-frame and 512 KiB operation/send
queues. Outstanding requests are capped at 16 per socket and 64 per process.
Initialize, feature, and shutdown deadlines are 20, 10, and 3 seconds. Changes
coalesce for 150 ms; idle children close after 10 minutes.

Client versions increase strictly. Backend LSP versions continue across replay.
Non-monotonic input requires resync. Crash restart is capped at 3 in 5 minutes
and clears after 10 healthy minutes. Replay uses the latest bounded in-memory
draft, not disk. Stale, cancelled, or cross-generation results are dropped.

Results are normalized and bounded. Definitions remain inside the same
workspace. Completion commands, snippets, additional edits, and insert-replace
edits do not cross the boundary. Plain insertion text is separate and capped at
256 KiB. Documentation and diagnostics render as inert text. Servers may create
bounded work-progress tokens and answer fixed null workspace configuration;
apply-edit, commands, prompts, dynamic registration, and unknown requests get
JSON-RPC `-32601`. Buffer and server payloads are never logged or persisted.

### visionOS code editor

The editor web view serves vendored Monaco only through the private
`agentroom-editor://` bundle scheme. Its CSP uses `default-src 'none'`, limits
scripts, styles, fonts, and images to bundled/data sources, permits bundled WASM,
and sets `connect-src 'none'`. Navigation permits only the editor origin and
hostless `about:blank`.

The native-web bridge accepts a fixed message set. File text, HEAD baseline,
and literal search query enter JavaScript as JSON-encoded string arguments,
never HTML. Find is regex-off and capped at 1,000 matches; result messages carry
counts and ordinals, not matched content. Edits save only through the bounded
workspace PUT. The read-only side-by-side diff has no extra write or network
path. TextMate grammars, language configurations, themes, and Oniguruma WASM are
data injected by native code; missing assets fall back to bundled behavior.

## Attachments and artifacts

Turn context contains the original message, explicit bounded workspace paths,
and session-scoped attachment ids. The backend does no automatic file selection,
embedding, summarization, or arbitrary binary handoff.

Uploads accept PNG, JPEG, and WebP only. The backend validates signature and
type, hashes content, and stores it under `STATE_DIR`. Session deletion removes
its attachment storage. ACP prompts add the separate 16 MiB aggregate bound
described above.

Live artifacts are line-start `<artifact kind="svg|mermaid">` regions in model
text, gated by `ARTIFACTS_ENABLED`, which defaults on. Unknown, malformed, or
inline tags remain ordinary text except an empty self-closing control tag. The
store is in memory, per session, capped at 64 KiB UTF-8 per artifact, and marks
code-point-safe truncation. Artifacts never enter the workspace.

Clients must sandbox model markup. visionOS renders SVG without JavaScript and
Mermaid with a bundled script in strict mode. Both use a hostless in-memory page,
a CSP with no default network source, data-only images, and navigation denial.
Mermaid source is passed as a JSON string, never interpolated into HTML. HTML
with JavaScript and 3D artifact kinds are unsupported.

## Spatial documents

`SCENE_ENGINE_ENABLED`, default on, gates the composed read, Mermaid import,
diagram edit, standing runner prompt contract, and per-turn diagram feedback.
Off removes the routes and prompt additions.

Scene and diagram bases plus sibling `*.human.json` layers are ordinary bounded
workspace files. The backend composes on each read and keeps no watcher or open-
scene registry. Human adjustments write through the existing optimistic file
PUT. Unknown roles and kinds degrade to generic primitives with bounded
warnings; strict schema and reference failures return bounded errors.

Scene documents cap entities at 64. Diagrams cap nodes at 64, edges at 128,
groups at 16, flows at 16 with 32 steps each, and optional version-3 descriptions
at 500 characters. Older schema versions remain valid. Collapsed groups,
hidden members, and stale overrides change only composed bounded data. Stale
overrides are reported and never deleted automatically.

Mermaid import is pure compute. It executes no Mermaid JavaScript, touches no
filesystem, and compiles no caller input as regex. Source is capped at 64 KiB;
line and schema caps apply, and losses produce bounded warnings. The response is
canonical diagram text that a client may create through the existing PUT.

Diagram edit is also pure compute. It accepts base text up to 256 KiB and at
most 32 typed operations, applies all or none, has no id-renaming operation, and
returns canonical text. The client writes with the base `modifiedAt`, so a
concurrent regeneration returns the PUT's `409`. Deletes report bounded
knock-on warnings.

Human-edit summaries observe only existing human `workspace_file_written`
events. They inspect at most 4 diagrams per turn, 8 ids per category, 16 tracked
diagrams per workspace, and 1,200 output characters. They contain ids and change
categories, not labels, descriptions, coordinates, or file text.

Render feedback uses a settled turn's existing diff attribution, reads at most
4 written diagrams, and stores bounded warnings or errors for the next accepted
turn. Both feedback channels are per-session, ordered, in memory, one-shot, and
released on session deletion. They add no route, event, audit, watcher, or
workspace scan. Concurrent human writes can inherit the existing turn-diff
attribution caveat.

The visionOS volume and mixed immersive space render the same composed document
through one native renderer. RealityKit `AnchorEntity` resolves surfaces;
AgentRoom opens no `ARKitSession`, asks for no world-sensing permission, and
receives no plane, mesh, hand, or room geometry. Fallback placement uses a
one-time head-relative anchor.

Scale preset and remembered document identity are device-local preferences.
The physical placement is not stored. Relaunch performs a new surface search.
No room data, preset, or memory reaches a workspace file, route, event, or
backend contract.

## macOS supervision and updates

The app strips every AgentRoom-managed and descriptor-owned secret-tier variable
from its inherited environment, then injects only its configured values. Export
redaction checks all stored slot values, including values no current descriptor
knows. Other developer credentials in the wider environment remain inherited by
the backend and bundled runner children subject to their documented scrubs.

The Claude Code login probe asks Keychain only whether service
`Claude Code-credentials` exists. It requests no item data.

A sidecar may be adopted only when its recorded pid, kernel start time,
executable, port, and ownership of the listening TCP socket still match. An
unrecorded external backend is never signalled. Identity is rechecked immediately
before `SIGINT` or `SIGTERM`. Darwin cannot atomically bind that check to signal
delivery, leaving a narrow pid-reuse race. The expected-parent watchdog is armed
before asynchronous startup and exits an app-owned child if its launcher dies.
Crash restarts are capped.

Published updates use a compile-time `disabled`, `rc`, or `stable` channel.
Source and unsigned builds default disabled and contain no public key or feed.
Signed stable and exact RC builds use fixed feeds and a matched release-only
Ed25519 key, plus Developer ID signing, notarization, and stapling. Packaging
refuses inconsistent channel metadata.

The private RC workflow accepts a version and positive RC number, verifies the
fixed Release Please PR's current synthetic merge and generated-file-only diff,
stages the allowlisted public mirror, scans it, and publishes an immutable RC tag
without moving public `main`. Stable publication follows merging that PR.
Versioned assets are immutable; only the moving RC appcast can be replaced.
Release workflows share serialization. Stable publication verifies the uploaded
fixed feed byte for byte.

Sparkle uses its standard prompt and never installs silently. Enabled builds
check daily by HTTPS with `SUSendProfileInfo` false. Automatic checks default on
but can be disabled through Sparkle's user default; manual checks remain.
Existing updater-disabled installations require one manual install of the first
enabled stable build.

Before update relaunch, an app-owned backend receives a bounded `SIGINT` then
`SIGTERM` shutdown. If it remains alive, termination is cancelled and the
restart marker is cleared. The new app consumes a marker only for a backend that
was running; an intentionally stopped backend stays stopped. Updates do not
rewrite app support, Keychain, workspaces, settings, or durable sessions.

visionOS compatibility uses `GET /health.release` as the local authority and
blocks known-incompatible clients before protected reads. Missing metadata is
unverified, not compatible. Its optional public GitHub release lookup sends no
token or backend address, caches validated public metadata for 24 hours with
ETag revalidation, and cannot alter compatibility or install software.

## Known limitations and future hardening

- Authenticate the broadcast event WebSocket and consider the status/logs
  exposure that accompanies it.
- Add stronger per-runner process, filesystem, network, and secret isolation.
- Consider an active-turn guard for concurrent workspace and Git mutations.
- Add optimistic cross-process coordination for managed settings writes.
- Preserve explicit refusal and recovery semantics as runner protocols evolve.
