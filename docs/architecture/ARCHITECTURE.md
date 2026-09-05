# Architecture

AgentRoom is a Mac-hosted local-agent bridge. The backend owns local workspace
registration, session state, runner execution, file-context injection, state
snapshots, logs, audit, and WebSocket events. macOS and visionOS are clients.

```text
visionOS / macOS clients
  REST + WebSocket
      |
Fastify backend on Mac
  config + storage
  workspace registry and explorer
  agent session service
  backend turn context assembly
  session attachment storage
  bounded harness actions
  AgentRunner registry (codex | claude_code | deepseek | cursor)
  EventBus + audit log
      |
local Codex app-server / Claude Code session / DeepSeek Harness runtime / Cursor SDK host
```

## Boundaries

- The backend is the source of truth for registered workspaces, sessions, turns,
  messages, metrics, recent events, and audit. Sessions, their turns, and their
  messages are durable: one JSON document per session under
  `STATE_DIR/sessions/`, written through on every mutation and read back
  before any route registers, so a thread outlives the process that created
  it. The runner keeps its own memory of the conversation, AgentRoom keeps its
  record, and the recorded native id is the join: at startup the service seeds
  that id back into the runner through the optional
  `AgentRunner.rememberResumableId` hook, and the next turn resumes through the
  same path a reaped child takes. A thread is never reconstructed from a
  runner's transcript files. See `docs/safety/TRUST_AND_SAFETY.md`.
- Clients create sessions and send turns through REST APIs. They do not launch
  Codex, run shell commands, or read provider credentials. Direct workspace
  mutation is limited to bounded file PUT/DELETE, a non-recursive directory
  POST, same-parent entry rename,
  same-workspace entry move and copy, and recursive directory DELETE requests;
  the backend performs them behind the same path bounding, symlink guard, secret
  filtering, and optimistic locks as reads. Recursive delete and entry copy each
  add a complete capped subtree preflight; directory creation carries no lock at
  all, because it replaces nothing and refuses an occupied name.
- The runner boundary is `AgentRunner`, and beside it sits the runner registry
  (`runner/registry.ts`), which answers every question about a runner that is not
  the runner's own protocol. One `RunnerDescriptor` per runner declares where the
  backend's standing instructions are delivered, who reports a turn's diff,
  whether workspace skills load, the skill directories and invocation prefix, how
  a lost child is restored, and whether the bootstrap it needs is configured.
  Which runners exist is that registry's answer too: the `AgentRunnerKind` type
  and the zod schema every external boundary validates against both derive from
  its admission list, so a registered runner is accepted everywhere at once, and
  `GET /api/runners` serves the one safe/public projection of it — a runner's id,
  display name, and the three availability states (`registered`, `configured`,
  `enabled`) that the registry keeps separate precisely so a client cannot read
  one as another. It is what the apps' runner pickers hydrate from, replacing a
  compiled-in Swift enum, so a registered runner becomes selectable without
  shipping the clients again; the descriptor's policy fields and every tier-3
  bootstrap value stay behind it. Beside those three sits a fourth state from a
  different authority: `ready` is not configuration but evidence — what the
  adapter's own capability discovery proved about spawning the child and
  completing the handshake. It is observed rather than asked for, so the route
  initiates nothing, a runner nothing has enquired about carries no `ready` at
  all, and the answer lives only as long as the process that established it. The
  authority it is deliberately *not* is the Mac's: whether the operator's local
  executable or credential is present has to be answerable with the backend
  stopped, which is exactly when this route does not exist.
  Policy may not be decided from a runner's identity anywhere above it —
  presentation may, and legitimately does. The backend keeps a separate registry
  of runner *instances* keyed by runner kind; each session pins its runner kind at
  creation. `CodexAppServerRunner` speaks Codex app-server JSON-RPC by default
  with `exec` as a compatibility fallback. `ClaudeCodeRunner` drives the
  Claude Agent SDK with one persistent SDK session (spawned `claude` child
  process) per AgentRoom session, streamed partial-message deltas, and
  `interrupt()`-based turn cancellation. Persistent runner children are
  idle-reaped after 30 minutes only when the adapter declares a restore path.
  Codex, Claude Code, and Cursor resume their native thread (Codex
  `thread/resume`, Claude Agent SDK `resume`, Cursor `Agent.resume`) after
  reaping or child loss. DeepSeek declares restoration
  unsupported, so its child stays resident while idle and a cancelled or lost
  runtime makes that AgentRoom session uncontinuable rather than silently
  starting a fresh conversation.
- Adding a coding agent is a *registration*, not a port, and the last step of
  that is external adapters. One `AcpRunner` (`runner/acp`) speaks Agent Client
  Protocol v1, so an ACP-speaking agent an operator names in the environment
  becomes a selectable runner without a code change — it registers at startup,
  appears on `GET /api/runners`, brings its own managed setting, and streams
  through the same canonical mapper as the built-ins. Which runners exist is
  therefore partly a startup answer, so the runner-id schema resolves against the
  live registry while the *built-in* admission list stays closed. The trust
  boundary is what keeps that safe rather than merely convenient: the channel is
  off by default, definitions are tier-3 environment-only and never served, the
  executable is admitted before it is spawned, the child environment is an
  allowlist rather than an inheritance, the protocol is bounded at every step,
  only restorable agents are admitted, and the filesystem and terminal
  capabilities ACP offers are declined — the bounded workspace PUT stays the only
  client-initiated write. See `docs/safety/TRUST_AND_SAFETY.md`.
- A runner that asks permission mid-turn can be answered by a person, which is a
  third answer beside the two a stored posture can give on its own. It is one
  mutating, bearer-gated route selecting one of the options the *agent* offered
  for one outstanding request, opened only by that runner's own tier-2 `ask`
  posture — never by a client merely being connected, since a posture that
  changed with who was listening would be no posture. The wait is bounded and the
  configured policy answers behind it, so an absent operator delays a turn rather
  than hanging it, and the resolved event names the authority (`human`, `policy`,
  `timeout`) because "allowed" means something different in each case. What a
  client needs in order to decide rides the live request event; what durable
  audit keeps is the decision alone.
- A runner that is unsure which way to go can pause its turn and ask: one
  batch of clarifying-question sets (a prompt, the options it offers, how many
  may be chosen, whether free text is invited) announced on the canonical
  stream, held open in the same shared waiting store as permission requests,
  and answered through one bearer-gated route that selects offered options and
  carries the person's own words. Answering authorizes nothing; ids are
  AgentRoom-minted so the agent never reads a client string as one; the wait is
  bounded and a timeout is reported as a timeout, never as a default choice; the
  audit keeps the decision while the thread keeps the words. Claude Code asks
  through its `AskUserQuestion` tool over the SDK callback; Codex through
  `item/tool/requestUserInput`; Cursor through one `ask_user_question` custom
  tool the host relays to the backend as a `question/ask` request; DeepSeek,
  whose SDK has no request channel, through a descriptor-owned bounded prompt
  block that the adapter resumes with a second Harness prompt inside the same
  AgentRoom turn. A runner whose
  descriptor declares neither path has nothing outstanding. One tier-1 setting
  turns the channel off for every runner.
- Backend turn context assembly combines the original user message, selected
  workspace context, and session-scoped attachment ids into the runner prompt
  plus runner input parts before execution.
- Workspace file access is backend-owned, registered-workspace-only,
  symlink-checked, and bounded. Reads (tree, file preview, Git status, the
  git HEAD file baseline that backs editor diff decorations and the visionOS
  editor's read-only side-by-side diff view, the skills listing that backs
  the composer slash picker, and the ranked file index plus literal-substring
  content search that back quick-open, the `@` mention picker, and
  search-in-all-files) are read-only. `WorkspaceExplorer.writeTextFile` behind
  `PUT /api/workspaces/:id/file` accepts a bounded UTF-8 text body for a
  single existing-parent path, rejects secret-named and generated-directory
  segments, refuses symlink leaves, requires an optimistic-lock `baseModifiedAt`
  to overwrite, and publishes atomically (temp + rename). It intentionally
  dirties the working tree — unlike attachments/artifacts, which stay under
  `STATE_DIR`. `WorkspaceExplorer.deleteFile` behind DELETE on the same route
  accepts regular files only, requires `baseModifiedAt`, and uses `unlink`.
  `createDirectory` behind `POST /api/workspaces/:id/directory` makes one empty
  directory under an existing parent — the container counterpart of the PUT's
  create branch, deliberately not recursive, and the one mutation with no
  optimistic-lock token, since exclusivity rather than a token is what keeps it
  from adopting a folder someone else made.
  `renameEntry` changes one file/folder leaf name without moving or overwriting;
  `moveEntry` is that same relocation generalized to a second directory in the
  same workspace, which is why rename delegates to it rather than repeating it,
  and it adds the two refusals only a cross-directory operation can hit (a
  folder landing in its own subtree, and a destination on another filesystem);
  `copyEntry` duplicates an entry after inventorying it, staging it beside the
  destination, and publishing it under the chosen name only once complete —
  the one workspace write whose bytes never transit the API, so the subtree
  caps bound it rather than the 256 KB body cap;
  `deleteDirectory` inventories the full subtree before recursive removal and
  refuses the workspace root, protected entries, symlinks, unsupported types,
  more than 20,000 entries, or more than 1 GiB of regular-file data.
- Git mutation is backend-owned and fixed. Clients drive source control through
  `WorkspaceGitService` (stage, unstage, discard, commit, fetch, pull, push,
  branch creation, plus the existing branch switch); each is a fixed argument
  vector run without a shell, with no caller-supplied flags, refspecs, remotes, or
  refs. Nothing rewrites history, pull is fast-forward only, and every
  caller-supplied path passes the same filter as the read routes. See
  `docs/safety/TRUST_AND_SAFETY.md`.
- Session attachments uploaded by clients are backend-owned, validated, hashed,
  and stored under `STATE_DIR`, not inside registered workspaces.
- Native backend events stream through `WS /api/events`, including canonical
  `coding_*` events for session, turn, plan, diff, tool, permission,
  assistant-message, and live artifact activity. What makes them canonical is
  where the mapping happens: each adapter maps its own protocol into a
  discriminated `CanonicalActivity` payload and a `RunnerMetadata` correlation
  envelope at the `AgentRunner` boundary, and the shared mapper dispatches on
  that payload rather than on which runner produced it. This is deliberately
  not the AG-UI mistake it replaced — the lesson there was about *flattening*,
  not abstraction, so native detail stays reachable beside the canonical
  payload (the activity's own kind and content, a bounded `native` blob, and
  each runner's own posture label) and the pre-canonical per-runner blocks
  survive as shim-built projections until the advertised contract floor retires
  them. The client consequence is the point: an unrecognized runner, canonical
  activity kind, or event type degrades to a generic rendering instead of
  failing a decode, so a third adapter needs no client change to appear.
  Codex reports its own turn
  diffs (`turn/diff/updated`); Claude Code does not, so the backend derives
  that session's `coding_diff_updated` at turn settlement by comparing the
  workspace's fixed read-only Git status against a snapshot taken at turn
  start (`AgentTurnGitDiffTracker`) — bounded file summaries only, no new
  route, event type, or Git invocation class.
- Live artifacts are model-authored sketches the runner writes in-band as an
  `<artifact kind="svg|mermaid">` region of its assistant text. The backend
  parses that region out of the unified assistant delta stream (identical for
  every runner), keeps it out of the chat transcript, and republishes it as
  `coding_artifact_*` events backed by a bounded, per-session, in-memory store
  released on session deletion. Nothing is written into the registered
  workspace. The channel is gated by `ARTIFACTS_ENABLED`.
- The editor language catalog is backend-served **app/global data, not workspace
  files**: TextMate grammars, themes, language configs, and the Oniguruma WASM
  that let the visionOS editor pick up new languages without an app update. It is
  served by bounded read routes (manifest, asset, status) plus an operator reload,
  never touches a registered workspace or the workspace file API, and serves only
  `.json`/`.wasm` data — never executable `.js`. The served directory resolves
  `EDITOR_CATALOG_DIR` (operator override) else the bundled `catalog-assets`;
  clients verify each blob's `sha256` and fall back to bundled assets. The channel
  is gated by `LANGUAGE_CATALOG_ENABLED`.
- Mac-hosted editor semantics use a separate `EditorLanguageService` boundary,
  not `AgentRunner` or the syntax catalog. A descriptor registry selects the
  fixed SourceKit-LSP, bundled TypeScript or Pyright, or optional configured
  rust-analyzer, gopls, Eclipse JDT LS, Kotlin LSP, or csharp-ls adapter from the
  document language and a deterministic, workspace-bounded project root. A
  second default-off gate may add whole-list-validated `external_lsp_*`
  descriptors for language ids no built-in claims; they use the same adapter,
  host, and closed client protocol. The
  host owns process instances, in-memory
  document shadows and path leases, UTF-16/version mapping, cancellation, idle
  close, and bounded crash replay. Its probe-free registry read is always
  present; the closed, bearer-authenticated workspace WebSocket and child
  execution exist only when `LANGUAGE_SERVICES_ENABLED` is on (default off).
- The spatial render engine (gated by `SCENE_ENGINE_ENABLED`, default on) is a
  **scene-as-data** channel for human-in-the-loop 3D co-editing. Geometry-first
  scenes use `<name>.scene.json`; semantic solution diagrams use
  `<name>.diagram.json`, which the backend zod-validates, lays out through a
  deterministic Sugiyama-lite pass, and maps to bounded primitive entities and
  connectors. Both formats keep client placement in a separate sibling
  `*.human.json` layer so agent regeneration cannot clobber it. One
  bearer-gated route serves both formats through `SpatialSceneService`, which
  reconstructs every response through the explorer's bounded file preview and
  keeps no watcher, tracked-open state, or scene event. Beside it sits one
  bearer-gated pure-compute POST (`/api/spatial-scene/mermaid-import`) that
  turns a Mermaid flowchart — typically an artifact sketch the client already
  holds — into canonical `.diagram.json` text with a bounded, deterministic,
  hand-rolled parser (no filesystem, no mermaid.js execution, no caller
  regex); the client writes that text itself through the bounded PUT
  create-only, so the bridge converts without adding a write surface. The backend supplies the
  standing semantic contract to Codex turn prompts and Claude Code's system
  prompt, plus two non-constant per-turn injections, one per author. The first
  is a bounded
  per-turn summary of what the human changed in a diagram since that session's
  last turn: placement adjustments in its override layer, structure edits to the
  base document, and the override ids a base rewrite left orphaned. That summary
  needs no new machinery either: both layers' only human write path is the
  bounded PUT, which already publishes
  `workspace_file_written` (agent writes never do — that asymmetry is the
  authorship discrimination), so a tracker subscribed to that event replaces both
  a watcher and a per-turn scan of the workspace, and the contract's own
  read-the-sibling rule remains the floor for anything it does not see.
  The second closes the loop in the other direction: at a turn's settlement,
  the `*.diagram.json` documents its own diff summary says the turn wrote get
  one bounded validation read each (at most four, off the turn-start path),
  and the compose warnings or validation errors the volume would show wait in
  memory to ride that session's next turn prompt — keyed on turn settlement,
  the agent-authorship signal the diff tracker already uses, never on
  `workspace_file_written`, which stays the human's.
  Human writes reuse the bounded optimistic-locked workspace PUT. The
  visionOS volume renders both formats natively with RealityKit and discovers
  a workspace's spatial documents through the existing bounded file index —
  there is no scene-specific discovery route. The rest of the client's diagram
  surface is derived rather than served: the selection detail card comes from
  the composed document the volume already holds, the volume's in-place
  document cycler walks that same bounded index, and the transcript's "diagram
  updated" chip is suffix matching over the turn's existing
  `coding_diff_updated` summary plus the settle-time index re-read — so none of
  them adds a route or an event. Two small composed-document metadata lists sit
  beside the render entities, neither of which is one. `suppressedHiddenEntities`
  preserves the source id and label of a member that collapsing omits and that
  was already hidden, so the existing restore ornament can still reach it.
  `staleOverrides` reports the one thing the two-layer split cannot prevent: an
  override entry keys on a bare semantic id, so a node the agent renames or
  removes leaves the human's adjustment attached to nothing. Compose has always
  skipped such an entry and deliberately still does not delete it — an id that
  returns picks its placement back up, which is what makes regeneration
  non-destructive — so the report is what turns a silent orphan into a choice.
  Adopting the agent's layout instead is the client rewriting the same override
  layer without those entries through the same bounded PUT; keeping them writes
  nothing at all, which is the honest shape for a decision to change nothing. The same holds for the
  manipulation rules layered on top: connectors re-aimed live from a dragged
  node's transform, the drag clamped to the volume, and a locked entity kept
  selectable while its drag is refused, are all client-side reads of the
  composed document the volume already holds. The entity edits beside them —
  lock/unlock, hide, reset placement, and the ornament list that restores a
  hidden entity — write only the `*.human.json` layer through the same bounded
  optimistic-locked PUT a drag uses, on override fields (`visible`, `locked`)
  the contract already carried, so they add no field, route, or event either.
  Group collapse is the one place the diagram override layer grew a field
  (`collapsed`, group ids only) rather than only reaching one it already had,
  and the rules it drives stay in the engine: a collapsed group composes to a
  single stand-in entity with its boundary-crossing edges re-pointed at it, and
  a moved group displaces the members that carry no placement of their own.
  Both are compose-time rules over the same two files — layout stays a pure
  function of the base document, so neither re-flows the diagram, and the client
  renders what comes back instead of inventing a collapsed treatment of its own.
  The source contract has gained a version twice, each time for an optional
  field older documents keep rendering without: `schemaVersion: 2` added
  `flows`, and `schemaVersion: 3` added bounded `description` fields on the
  document, nodes, edges, and groups — the agent's anchored explanation of why
  a component exists, passed through compose verbatim so the selection card
  can show it without a second read. A flow is an ordered list of edge ids that compose
  resolves to the connectors actually drawn, so the client lights a path without
  mapping ids or knowing why a step is missing; a step whose connector was
  dropped by a collapse or a hide is simply not in the composed flow, and a flow
  with nothing left is omitted. Choosing a flow is purely read: it writes
  nothing, so it touches no override layer, route, or event. The client's focus
  control (zoom to a selected entity's neighborhood) is the same class of
  purely-read view state, and it exists entirely client-side: the volume refits
  its own render to a subset of the composed document, so the backend serves
  the identical document focused or not and cannot tell the difference.
  AR presence is the same document in a second presentation rather than a
  second channel: the volumetric window and a mixed immersive space share one
  RealityKit view and one document store, so drag, selection, group carrying,
  and flow playback behave identically and still land in the same
  `*.human.json` layer through the same bounded PUT. Anchoring is RealityKit's
  own — the app asks for a horizontal surface and the system resolves it, so no
  `ARKitSession` is opened, no plane geometry reaches the client, and no
  world-sensing authorization is involved; a room with no surface falls back to
  a one-shot head-relative placement. Because visionOS allows one immersive
  space at a time, which document is in the room is app state rather than
  per-volume state, and the window that opened it stays open as its control
  surface. How big it is out there is a preset on that same app state — desk,
  table, or floor — and because the footprint is both the fit target and the
  drag clamp, a preset changes reach as well as size. Size and surface class are
  one choice rather than two: a floor-scale diagram asks the system for a floor,
  since no table is 1.6 m across and asking for one would simply leave the
  anchor unresolved. A wall is deliberately not on that axis. None of it reaches
  the backend — the preset is client state with no contract field, route, or
  event, and the composed document is identical at every scale. What survives an
  app launch is that choice and the document it applied to, held device-locally
  in the app's own defaults. The *spot* is not persisted and cannot be:
  RealityKit's anchoring hands the app nothing to write down, and the one API
  that remembers a physical point across launches is an ARKit `WorldAnchor` the
  safety posture rules out. A remembered room therefore re-resolves its surface
  rather than restoring coordinates, which is also why a remembered scale and a
  remembered placement can never disagree.
- Backend configuration has two sources and one seam between them. Bootstrap,
  secret, and execution settings stay in the environment (the macOS app injects
  them from Keychain at launch), because a file cannot configure a process that
  has not started — and because an executable path is remote code execution by
  configuration, `AUTH_TOKEN` is the credential a request rides on, and the
  bind/storage class would strand the backend mid-edit. Everything else is a
  *managed* setting in the backend-owned `$AGENTROOM_HOME/config/settings.json`:
  preferences (default runner, models, effort, feature flags, Git timeouts) and
  trust posture (terminal access and its cap, the Claude Code permission
  mode/workspace-settings loading/credential inheritance, the Codex approval
  policy, sandbox mode, and workspace network access). `GET /api/config` reports
  each managed key with its provenance and `PATCH /api/config` edits them, while
  the macOS app writes the same file directly so its panes keep working with the
  backend stopped. Precedence is one rule — env wins and *locks* the key, else
  the file, else the code default — and the restart rule is likewise one rule:
  config is snapshotted once at startup and the gated routes are
  registered-or-absent from that snapshot, so everything managed applies on
  restart and nothing is reconfigured underneath a running turn. That is also
  why the pending-restart state needs no machinery: the route re-reads the file
  per request and reports where it disagrees with the running snapshot.
  *Which* settings exist is not written down in the config layer at all: the
  globals are declared there, and every runner-owned setting is declared on that
  runner's descriptor with its schema, tier, environment variable, and default,
  so the file schema, the env table, the tiers, the defaults, the patch schema,
  and the metadata are one derivation rather than five lists that have to agree.
  The file itself is a nested document — `global.<field>` and
  `runners.<runnerKind>.<field>` — which is what lets a registered runner have
  settings without a table elsewhere learning its name. The older flat document is
  still read and is migrated whole by the next write that changes something, never
  key by key: one setting at two addresses is a precedence question nobody should
  have to answer. An unknown runner namespace is preserved verbatim and never
  applied, a malformed *known* value still makes the file unusable, and a file
  declaring a newer version is reported as a distinct state rather than as damage,
  because the repairs differ — update the app, not reset the file, which would
  discard a posture the operator did author. Going *back* is a supported step
  rather than a lost posture: the Mac can rewrite the file as the flat document an
  older backend reads, and a current one converts it forward again on the next
  change. `GET /api/config` reports each setting at both addresses during the
  compatibility window, so a client and a backend can upgrade independently. The
  tier-3 exclusion is what keeps the ungated `GET /api/config` non-secret, and
  the trust tier is remotely editable only behind `REMOTE_SETTINGS_ADMIN`, an
  environment-only switch the Mac injects — a managed setting there could be
  granted by whoever already holds the bearer token. Beside the settings file a
  started backend leaves `runners.json`, the same safe/public projection
  `GET /api/runners` serves, because the Mac's panes run when the backend does
  not; it is a cache the backend never reads. See
  `docs/safety/TRUST_AND_SAFETY.md`.
- Repository-specific harness actions may run fixed, path-bounded feedback
  commands such as `apps/visionos` XcodeGen and xcodebuild checks. They are not
  arbitrary shell execution APIs.
- The interactive terminal (`WS /api/workspaces/:id/terminal`) is the one
  deliberate exception to the no-shell-execution boundary. It is **off by default**
  (`TERMINAL_ENABLED`) and registered only when enabled. When on, the backend
  spawns a real PTY login shell (`node-pty`) in the realpath of a registered
  workspace, bridges it over a bearer-authed bidirectional WebSocket, and reaps it
  on socket close / idle / shutdown. It is **unsandboxed once running** — the
  client-driven analog of the Claude Code `bypassPermissions` posture — and never
  logs shell I/O. See `docs/safety/TRUST_AND_SAFETY.md`.
- The editor language-service WebSocket is the other workspace-scoped execution
  protocol. It accepts only bounded document synchronization and five named
  semantic features; it is not a raw LSP tunnel. `/api/events` remains the only
  broadcast event socket.

## Runtime Flow

1. Resolve config from process env, repo `.env`, and optional
   `AGENTROOM_HOME/config/.env`.
2. Initialize `STATE_DIR` and durable audit storage.
3. Register or list existing absolute local workspaces.
4. For Git workspaces, expose local branch metadata and switch only to existing
   clean local branches through a fixed backend route.
5. Read bounded workspace trees or file previews when clients browse context.
6. Create an agent session for a registered workspace and record the current
   workspace branch when one exists. The record is written through to
   `STATE_DIR/sessions/` from here on, and a restart hydrates it, settles any
   turn that was running as failed, and seeds the runner's resume id.
7. Start a turn with one user message, optional selected `context.paths`, and
   optional session-scoped attachment ids plus safe coding-agent settings
   selected from backend capabilities.
8. Switch the workspace back to the session branch when needed, then run
   backend turn context assembly to inject bounded file/directory context and
   resolve session attachments while preserving the original stored user
   message.
9. Run Codex through `AgentRunner` in the workspace path. In JSON-RPC mode, the
   backend sends image attachments as `localImage` input parts and reuses one
   Codex app-server thread for the AgentRoom session.
10. Stop requests cancel the active runner turn and record it as cancelled.
    Restorable runners leave the same thread available for a steering
    follow-up; stopping DeepSeek kills its non-restorable runtime, so a new
    AgentRoom session is required.
11. Publish native lifecycle, canonical coding-agent, activity, update, and
    runner audit events.
12. Persist sanitized durable audit entries for lifecycle and runner events.

## Client Shape

- The macOS app is the operator surface. It locates Node/backend resources,
  launches or supervises the backend sidecar, stores bearer tokens and
  executable/bootstrap settings in Keychain, edits the backend-owned managed
  settings file, registers local folders, shows LAN pairing URLs, exports
  redacted diagnostics, and caps crash restarts. Its half of runner readiness is
  the local one — is the executable installed, is the credential there — and it
  is answered from bundled bootstrap descriptors precisely because it has to be
  answerable with the backend stopped. Those descriptors are also what the child
  environment is assembled from, which keeps "what may be injected" and "what
  this build knows how to hold" the same list, and keeps generic launch assembly
  from reading any one runner's configuration.
- The visionOS app stores `serverBaseURL` and `authToken` with `@AppStorage`,
  checks health/status/auth/WebSocket connectivity, browses registered workspace
  trees, previews safe files, derives context paths from explicit `@` mentions,
  uploads selected or pasted image attachments through backend session attachment APIs,
  creates sessions, sends turns, stops active turns for steering, renders
  live status, and edits the backend's managed settings in a Settings tab whose
  sidebar lists the connection pane and one pane per managed section. That
  surface is a pure projection of `/api/config`'s metadata: locked,
  editable, and pending-restart are the backend's answers rather than client
  policy, and it keeps no copy of the backend's code defaults — a cleared key
  simply reads as "backend default".
- `apps/shared/AgentRoomClient` is the shared Swift source package for Apple
  client DTOs, endpoint construction, bearer auth attachment, response
  decoding, and redaction-friendly request errors. The macOS and visionOS
  XcodeGen project definitions include those sources directly.

## Extension Points

- Add new local runners by implementing `AgentRunner` and keeping process
  execution on the Mac backend.
- Add backend API surface through typed Fastify routes with zod validation.

Do not add arbitrary shell execution APIs. Do not move runner execution into
visionOS or macOS UI code.
