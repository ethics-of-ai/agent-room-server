# Moving Parts

## Backend

- `src/config`: dotenv loading, environment parsing, public config projection,
  auth-token bootstrap, and service storage initialization. Also stage 2 of the
  two-stage startup the runner registry needs: the managed `runnerKind` cannot be
  validated without knowing which runners exist, so the registry is built first
  (stage 1) and `getServiceConfig()` parses the settings file against the id
  schema derived from it.
- `src/config/settingsStore.ts`: the backend-owned managed settings file
  (`$AGENTROOM_HOME/config/settings.json`, dev fallback
  `<cwd>/.agentroom/config/settings.json`). It owns the *assembly* of the managed
  setting table rather than the table itself: the globals are declared here and
  every runner-owned setting is declared on that runner's `RunnerDescriptor` as a
  `ManagedSettingDefinition` (`domain/managedSettings.ts`) carrying its schema,
  tier, environment variable, value kind, and default. The file schema, the
  env-name table, the tier table, the defaults, the `PATCH` schema, the
  `/api/config` metadata, and the flat keys `getServiceConfig()` spreads into
  `serviceConfigSchema` are all derived from it, so a registered runner's settings
  exist everywhere at once (Phase 5 of the universal runner boundary, retiring
  leak 8). Each declaration reuses the same schema object `serviceConfigSchema`
  is built from, which is what keeps "a file that parses can never make startup
  throw" true by construction. Beyond the table it owns the
  env-wins-and-locks → file → default resolution, the per-setting provenance
  behind `/api/config`'s `settings` metadata, and the atomic, mutex-serialized
  read-merge-write behind `PATCH /api/config`. That metadata also reports each
  key's *shape* — `valueKind`, and the `options` a declaration bounds it to,
  derived from the declaration's own schema rather than tabulated — which is what
  lets a client draw a setting it was never built with (Phase 1 of
  `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md`), and which reports the
  schema rather than the operator's posture, so it changes nothing about what
  this ungated read exposes. An
  unusable file is dropped whole onto the conservative defaults with one bounded
  warning; the update path refuses to merge into one, since that would drop the
  operator's other settings. Bootstrap, secret, and execution settings are not
  managed at all — that absence is what keeps the ungated `/api/config`
  non-secret. The document it reads and writes is version 2:
  `{ schemaVersion: 2, global: {…}, runners: { <id>: {…} } }`, key-sorted at every
  level so this writer and the macOS app's produce the same bytes. A version-1
  (flat) document is still read and migrated **whole** by the next write that
  changes something — its own `global`/`runners` sections were never applied, so
  only the addresses this backend does not know survive that migration, since
  carrying a known one forward would silently activate a trust value the running
  backend was ignoring. Unknown runner namespaces and fields are preserved
  verbatim and never applied, a malformed *known* value still makes the file
  unusable, and a version this backend does not know is reported as
  `unsupportedSchemaVersion` — unusable, and distinct from broken, because their
  repairs differ. `serializeManagedSettingsDocument` is the pure converter both
  directions run through, including the version-1 rollback the macOS app offers.
  Exposed by `src/routes/configRoutes.ts`,
  which pairs the read with
  the write because the metadata block *is* the contract for what the patch
  accepts: it serves every setting at both its canonical path and its legacy flat
  key with `settingsSchemaVersion` naming the canonical set, and answers unknown
  key or both-addresses-at-once `400`,
  trust-tier-without-`REMOTE_SETTINGS_ADMIN` `403`
  (checked before the lock, being the more actionable answer), env-locked,
  unusable-file, or newer-schema `409`, and one `config_reloaded` carrying
  changed canonical paths, names only.
- `src/config/runnerCatalogFile.ts`: `$AGENTROOM_HOME/config/runners.json`, the
  offline runner catalog a successfully started backend publishes for the macOS
  app, whose settings panes work while the backend is stopped — exactly when they
  cannot ask it. It is the same safe/public projection `GET /api/runners` serves,
  written atomically, never read back by the backend, and best-effort: a failed
  write is one warning, not a startup failure.
- `src/domain`: typed service, workspace, session, status, harness, release,
  audit, and zod schema contracts.
- `src/workspace/LocalWorkspaceRegistry.ts`: user-selected and managed
  workspace registry persisted under `STATE_DIR`, including bounded Git branch
  metadata (with each branch's upstream and ahead/behind counts folded into the
  existing `for-each-ref`, so tracking state costs no extra invocation),
  read-only file-level Git dirty status, fixed read-only HEAD
  file-baseline lookups (`git cat-file`, for editor diff decorations), the fixed
  read-only path enumeration behind the workspace file index
  (`LocalWorkspaceGit.listFiles`: a shell-free
  `git ls-files -z --cached --others --exclude-standard` argv run with the
  registered workspace as cwd, so `.gitignore` is respected and a workspace
  inside a larger repository stays in its own subtree; raw, caller-filtered
  output), and fixed clean-branch switching for registered workspaces.
- `src/workspace/WorkspaceExplorer.ts`: workspace tree, file preview, path
  bounding, secret-name filtering, prompt context formatting, the bounded git
  HEAD file-baseline read (`gitFileBaseline`, same lexical/secret/NUL/cap
  contract as previews), the bounded workspace skills listing (`listSkills`:
  fixed committed skill directories per runner kind, SKILL.md frontmatter
  name/description only, backend-computed `/name`/`$name` invocation tokens for
  the clients' composer slash picker), the cached workspace file index — one
  enumeration (git `ls-files` where available, else a bounded walk) shared by the
  ranked quick-open/`@`-mention list (`listFiles`) and the literal-substring
  content search (`searchFiles`), held per workspace for a ~15s TTL with explicit
  invalidation on a file-creating write and a branch switch (and released on
  workspace unregistration), with every path
  re-filtered through the tree read's lexical/secret/generated-dir rules and
  re-checked for realpath containment at point of use — and the lone bounded write
  (`writeTextFile`): an atomic, optimistic-locked, UTF-8 single-file write that
  reuses the read path's bounding/symlink/secret guards.
- `src/workspace/WorkspaceGitService.ts`: the fixed mutating Git operations —
  stage, unstage, discard, commit, fetch, pull (fast-forward only), push, and
  branch creation. Assembles no command of its own: it classifies paths and calls
  the fixed argv in `LocalWorkspaceGit`, filters every caller-supplied path
  through the tree read's `indexableRelativePath` rules (so a secret-named or
  generated path can be neither staged nor discarded), and refreshes the
  workspace snapshot past its cache so a client sees state after its own command.
  Deliberately excludes history rewriting and forced push; see
  `docs/safety/TRUST_AND_SAFETY.md`.
- `src/agent/AgentSessionService.ts`: in-memory session lifecycle, turn
  execution, Codex thread metadata, message history, stop/cancellation,
  steering-safe metrics, and status snapshots.
- `src/agent/AgentTurnContextAssembler.ts`: backend turn context assembly for
  combining the original user message, explicit workspace context paths, and
  session-scoped attachment ids into the runner prompt plus runner input parts.
- `src/agent/AgentTurnGitDiffTracker.ts`: settle-time turn diff derivation for
  runners that report none of their own (Claude Code; the SDK stream has no
  `turn/diff/updated` analog). Snapshots the workspace's fixed read-only Git
  status before the runner starts, re-reads it when the turn completes, fails,
  or is stopped, and the delta becomes the turn's `coding_diff_updated` —
  emitted just before the terminal `coding_*` event, the order Codex diffs
  arrive in. Counts are attributed only for files clean at turn start, a Git
  read failure never fails the turn, and baselines are in-memory per active
  turn, released on settlement and session deletion. Codex turns never take a
  baseline, so its runner-reported diffs are never double-reported.
- `src/agent/AgentAttachmentStore.ts`: session-scoped image attachment
  validation, hashing, state-dir storage, metadata reads, and Codex local image
  input part resolution.
- `src/artifact`: the in-band live-sketch channel — `ArtifactStreamParser`
  (pure state machine that splits an `<artifact>` region out of the assistant
  delta stream), `ArtifactStore` (bounded, per-session, in-memory artifact
  snapshots released on session deletion), and `artifactPrompt.ts` (the runner
  instruction injected by `AgentTurnContextAssembler` when enabled). The
  parser is driven from `AgentTurnEventApplier`, which republishes prose as
  assistant deltas and artifact body as `coding_artifact_*` events.
- `src/runner/registry.ts`: the runner registry (Phase 3 of the universal runner
  boundary). One `RunnerDescriptor` per runner holding every question the backend
  used to answer by asking *who the runner is*: `promptDelivery` (does the
  standing diagram contract ride the turn prompt, or has the adapter installed it
  on a cached system prompt?), `turnDiffSource` (does the runner report its own
  turn diff, or does `AgentTurnGitDiffTracker` derive one at settlement?),
  `clarifyingQuestions` (native request, descriptor-owned prompt contract, or
  none), `workspaceSkills`, `skillSourceDirs`, `skillInvocationPrefix`,
  `settingsKeyPrefix` (which of the flat version-1 keys are this runner's, and
  therefore where the same setting lives in the version-2 document),
  `settings` (the managed settings this runner owns — one
  `ManagedSettingDefinition` each, with its schema, tier, environment variable,
  value kind, and default, which is what lets a runner bring its own settings
  instead of five tables learning its name),
  `restoreStrategy`, `isConfigured`, and the presentation-only `displayName`.
  `publicRunnerDescriptors` is its safe/public projection, served by
  `src/routes/runnerRoutes.ts` at `GET /api/runners`: id, display name, the
  three availability states, and the observed `ready`, with every policy field
  and every tier-3 value left
  behind. It is what replaced the clients' compiled-in runner enum.
  `registeredRunnerKinds` is the admission list the `AgentRunnerKind` domain type,
  `agentRunnerKindSchema`, and the descriptor table's exhaustiveness all derive
  from — which is why `domain/schemas.ts` imports and re-exports that schema
  rather than declaring a second copy, and why the two Claude Code trust defaults
  moved to the import-free `domain/runnerDefaults.ts` leaf (the registry reaches
  into the Claude Code adapter for its skills gate, so leaving them in
  `schemas.ts` would close a require cycle). `workspaceSkills` is a discriminated
  union rather than a tag plus an optional predicate, so a `gated` runner cannot
  be registered without its gate, and the gate calls through to the adapter's own
  rule rather than restating it — the registry names *that* a gate exists and
  never what it is. Adding a runner is adding an id and the row the compiler then
  demands; `apps/backend/test/runnerRegistry.test.ts` holds the line by scanning
  the backend sources for a behavioral decision on runner identity outside
  `runner/` and the two legacy mapper shims, and by pinning the registered ids to
  `codex`, `claude_code`, and `deepseek` — the list this build ships, which
  grows only by a deliberate rollout-gate decision.
- `src/runner/runtimeReadiness.ts`: the backend half of Phase 6's split
  readiness. It records what an adapter's own capability discovery proved —
  the child spawned, the handshake completed, the model list read — and reports
  it as `ready` on `GET /api/runners`. It initiates nothing: the probe *is* the
  discovery `GET /api/coding-agent/capabilities` already performs, so N
  registered runners never mean N probe children at startup and the runners
  route stays a pollable read. A runner nothing has asked about has no `ready`
  field, because "not probed" is not "not ready"; the state is in-memory per
  process, since a restarted backend has spawned nothing. The other authority —
  is the operator's local executable or credential present? — is the Mac's, and
  has to work with the backend stopped.
- `src/runner/acp`: the external-adapter surface (Phase 7), and the phase's
  whole point — one `AcpRunner` speaking Agent Client Protocol v1 makes every
  ACP-speaking agent *configuration* rather than another adapter. It takes no
  SDK dependency: the official SDK is ESM-only against this CommonJS backend and
  supplies none of the bounds this surface requires, so the protocol is spoken
  directly and its messages are zod-validated on receipt (`protocol.ts`).
  `admission.ts` decides whether a binary may run at all (absolute,
  non-symlink, regular, executable, realpath-resolved) and builds the child
  environment as an **allowlist plus explicit grants** rather than an
  inheritance — the one place an external adapter is deliberately stricter than
  the built-in runners, which inherit the operator's environment because they
  need it to find their own credentials. `AcpStdioClient` is the bounded
  transport: frame size, nesting depth, output volume, stderr tail, and a
  timeout on every request with a `SIGTERM`→`SIGKILL` fallback behind it.
  `config.ts` reads the tier-3 definitions (`ACP_ADAPTERS_ENABLED`,
  `ACP_ADAPTERS`) and turns each into a registry row. The adapter refuses an
  agent that advertises no restore path (AgentRoom reaps and resumes, so an
  unrestorable child would silently start a fresh conversation), consumes a
  `session/load` replay with updates suppressed, declines `fs`/`terminal`
  capabilities, and answers permission requests conservatively unless the
  tier-2 per-adapter `permissionPolicy` says otherwise — `auto_allow` for the
  unattended posture, `ask` to hold the request open for a person through the
  shared store below. Image attachments are negotiated the same way an agent's
  restore path is — from what it advertised at `initialize`
  (`promptCapabilities.image === true`) rather than from a blanket rule. The
  answer is stored on the child that supplied it because retained children can
  negotiate differently; no observation or mixed observations defer to the
  selected child's own handshake rather than letting one child govern another.
  An accepted image is inlined as base64 (ACP has no local-file source), which
  is why the transport's one outbound bound is the decoded image bytes a prompt
  may carry. The model/effort capability descriptor is read the same way — from
  the `configOptions` the `session/new` response already carries, so discovery
  still spawns one child and asks nothing extra (`readSessionSettings`). It maps
  the reserved `model` and `thought_level` categories, leaves generic
  `model_config` unmapped rather than mislabelling context-size or other controls
  as speed, and **drops `mode`**: that is the agent's own sandbox posture, which
  belongs to the tier-2 settings tier rather than to a per-turn selection any
  bearer-token holder can make. A turn's selection is applied with
  `session/set_config_option` before the prompt — ACP has no per-turn model
  parameter — for a value the agent listed and only where it differs from the
  live one. The setter's complete-state response must confirm the value, and a
  complete `config_option_update` refreshes that live state even while idle. See
  `docs/safety/TRUST_AND_SAFETY.md`.
- `src/runner/shared/PendingRequests.ts`: the id-table, clock, per-session cap,
  and release paths every "ask the person driving the session" channel shares.
  It knows nothing about what is asked; `PendingPermissionRequests.ts` and
  `PendingQuestionRequests.ts` put their own vocabulary check and outcome shape
  behind it, so a second adapter never reimplements the wait.
- `src/runner/shared/PendingPermissionRequests.ts`: the waiting half of
  interactive approval, shared rather than adapter-owned for the same reason the
  session host is — a bounded per-session wait is not protocol. It holds one
  outstanding request per id, bounded per session, settles on the option a human
  selected (checked against the ones the agent offered, so an invented option is
  refused rather than forwarded), times out into the caller's own policy
  fallback, and is released with the session, the child, or the turn. A client
  reaches it through one bearer-gated route,
  `AgentSessionService.answerPermissionRequest`, and the optional
  `AgentRunner.answerPermissionRequest` hook — whose absence is what "no such
  outstanding request" means for a runner with no approval channel, so nothing
  along that path reads a runner's identity.
- `src/runner/shared/PendingQuestionRequests.ts`: the waiting half of
  clarifying questions — an agent pausing its turn to ask the person one batch
  of sets (prompt, options, `single`/`multiple`, whether free text is
  `none`/`optional`/`required`, `sensitive`) and continuing with the answers.
  It owns the bounds (8 sets × 8 options, clamped text, a 10-minute clock) and
  the pure `validateQuestionAnswers` the route's refusals come from: every named
  set and option must be one the agent offered, a `single` set takes one, free
  text only where invited, an omitted set is simply unanswered. Outcomes are
  `answered` (by a human, with the answers), `timeout` (the runner applies its
  own away fallback), or `cancelled` (released; nobody decided). The canonical
  kinds are `question_requested`/`question_resolved`; the route is
  `POST /api/agent-sessions/:sessionId/questions/:requestId` →
  `AgentSessionService.answerQuestionRequest` → the optional
  `AgentRunner.answerQuestionRequest` hook; `GET …/questions` serves the batches
  a session still holds (from `AgentTurnEventApplier`'s outstanding map, which
  also writes the rendered answer — `agent/questionTranscript.ts` — into the
  thread as a user message and publishes the `agent_question_resolved` audit).
  `clarifyingQuestionsEnabled` (tier 1) gates the channel for every runner.
  Codex and Claude Code open that wait from their native request mechanisms;
  DeepSeek opens it from its bounded prompt contract and holds the same
  AgentRoom turn across the answer's second Harness protocol prompt.
  See `docs/safety/TRUST_AND_SAFETY.md`.
- `src/runner`: the `AgentRunner` boundary — which since Phase 2 also declares
  the `CanonicalActivity` union and `RunnerMetadata` envelope every adapter
  produces, so protocol knowledge stops at the adapter. Codex's unified-diff
  parsing and plan-step extraction moved here with it
  (`runner/codex/diffSummary.ts`), since a codex-cli that reports a turn diff
  as one unified-diff string is Codex knowledge, not shared mapper knowledge.
  It holds the `CodexAppServerRunner` process
  adapter with default `jsonrpc` and fallback `exec` protocol modes (JSON-RPC
  keeps one Codex app-server thread per AgentRoom session; Codex natively
  loads the registered workspace's `AGENTS.md`, repo skills, and
  `.codex/config.toml` project config layer with no isolation switch, and the
  runner pins `sandbox_workspace_write.network_access` on `thread/start` and
  `thread/resume` so
  that layer cannot widen the operator's network policy — see
  `docs/safety/TRUST_AND_SAFETY.md`; the same per-thread `config` carries the
  two keys that make the agent's `request_user_input` tool available while
  `clarifyingQuestionsEnabled` is on, and `codex/userInput.ts` maps that
  `item/tool/requestUserInput` server request into a clarifying-question batch
  and a settled batch back into the response keyed by the agent's question ids
  — `JsonRpcLineClient.onRequest` is the dispatcher, which refuses any other
  server→client request with `-32601` rather than leaving it unanswered), and the
  `ClaudeCodeRunner` Claude Agent SDK adapter (one persistent SDK session per
  AgentRoom session, provider-credential scrubbing, live `supportedModels()`
  capability discovery cached per backend process with a hardcoded fallback
  catalog, and — by default, and only under the `bypassPermissions` posture —
  loading the registered workspace's `project` settings source so its
  `.claude/skills`, `CLAUDE.md`, subagents, hooks, and MCP servers are available,
  toggled by `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS` and forced off for stricter
  permission modes and for the isolated capability-discovery probe). The Claude
  adapter is also where the CLI's `AskUserQuestion` becomes a clarifying-question
  batch: while `clarifyingQuestionsEnabled` is on it passes the SDK `canUseTool`
  callback (never to the probe), `claudeCode/askUserQuestion.ts` maps the tool's
  questions into minted-id sets and a settled batch back into the tool's
  `updatedInput` (`answers` by question text, `annotations[question].notes` for
  free text, the CLI's `(notes only)` sentinel, a `response` naming a timeout),
  the wait sits in `PendingQuestionRequests`, the turn's interrupt aborts it
  through the callback's `signal`, and every other tool the callback sees is
  refused with the CLI's own headless wording so the permission posture is
  unchanged. Both adapters
  implement the optional `closeSession` hook so
  deleting an AgentRoom session releases its persistent child process, and both
  are session-resilient: quiet children are idle-reaped after 30 minutes, and a
  session whose child died, was killed by an unresponsive cancel, or was reaped
  resumes its recorded native thread/session id (Codex `thread/resume`, SDK
  `resume`) in a fresh child on the next turn, with the same explicit runtime
  settings and isolation posture as a fresh start. Deleting the AgentRoom
  session forgets the resumable id. That lifecycle is **one implementation**,
  not a convention two adapters follow: `shared/PersistentRunnerSessionHost.ts`
  owns the session registry, activity touches, idle timers, teardown, and the
  resumable ids, while spawning, handshaking, and restoring stay with the
  adapter. The `restoreStrategy` an adapter hands the host (`native_resume`,
  `history_replay`, or `unsupported`) is a registry descriptor field since
  Phase 3, not a local constant, and the host arms an idle timer only for a
  runner it can restore — reaping a child that cannot be restored would silently
  start a fresh conversation under the same AgentRoom session id. Codex and
  Claude Code are `native_resume`; DeepSeek is `unsupported`, so it is never
  idle-reaped and cannot continue after its child is killed or lost (see
  `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`).
- `src/runner/deepseek`: the DeepSeek Harness adapter, driving the vendor's
  first-party SDK runtime over newline-delimited JSON-RPC on the child's stdio
  (`DeepSeekHarnessRunner`, `protocol.ts`, `sessionEventMapper.ts`, `settings.ts`,
  `capabilities.ts`, `promptQuestions.ts`). It takes no dependency on the vendor's packages: the
  runtime is an operator-installed executable like `codex`, so the protocol is
  spoken directly and every consumed message is zod-validated on receipt. That
  executable is the SDK runtime (`dsh-jsonrpc-agent`, or the packaged
  single-file build), **not** the `dsh` launcher, whose entry modes are all
  profiles and none of which serves this protocol; and it is handed a mandatory
  Cordis composition through `DSH_CORDIS_CONFIG`, without which it exits
  nonzero, which is why `isConfigured` requires both. Three
  properties of that wire shape it rather than being worked around — a prompt
  returns an enqueue receipt rather than a result (so a turn is bracketed by the
  session log's own `turn/start` … `turn/end`, with the whole-agent
  `running` → `idle` transition as the backstop), there is no prompt-cancel
  or verified restore method (so cancelling kills the child and a later turn
  on that AgentRoom session is refused rather than silently starting fresh),
  and there are no server-to-client requests (so there is no approval channel
  to expose and the permission answer route's `404` is honest). Clarifying
  questions use the separate prompt-contract policy on the descriptor:
  `AgentTurnContextAssembler` injects its bounded grammar when enabled,
  `promptQuestions.ts` removes one valid line-start block from assistant prose
  and mints its canonical ids, and the runner keeps the AgentRoom turn open
  after the asking Harness `turn/end` until the shared wait settles and a second
  `session/prompt` completes. Malformed or oversized blocks stay visible prose;
  ACP descriptors remain `none`. Its
  `sessionEventMapper` is the only place that knows what a DeepSeek session-log
  event means; an event it gives no canonical reading produces no `coding_*`
  event at all. Because the composition is an operator-authored file this
  backend cannot inspect, `settings.ts` pins the two environment values it
  depends on rather than trusting the graph's fallbacks — `DSH_CWD` to the
  registered workspace and `DSH_SESSION_ROOT` under `STATE_DIR`, the latter
  because the stock `?? './.sessions'` default resolves against the child's cwd
  and would write the harness's session log into the repository. Teardown walks
  the documented ladder (`shutdown` → stdin EOF → `SIGTERM` → `SIGKILL`), which
  cancellation deliberately enters below the first rung. See
  `docs/safety/TRUST_AND_SAFETY.md` for the `bypassPermissions`-class posture and
  `docs/engineering/DEEPSEEK_HARNESS_RUNNER.md` for the plan.
- `src/util/parentExitWatchdog.ts`: exits the process when the one that launched
  it goes away, armed from `src/index.ts` only under
  `AGENTROOM_EXIT_WITH_PARENT`. The macOS app also supplies its pid through
  `AGENTROOM_PARENT_PID`, so the backend can detect a launcher that died before
  Node started. The watchdog is armed before asynchronous server construction,
  checks once immediately, and then polls the live parent pid. Both values are
  env-only and absent or off by default, so a backend an operator started
  themselves is never ended by a parent's exit.
- `src/events`: typed runtime event bus and bounded recent event memory.
- `src/protocol/coding`: the canonical coding-agent event schemas and the
  runner-agnostic mapper (Phase 2 of the universal runner boundary). Adapters
  map their own protocol into the `CanonicalActivity` payload union and the
  `RunnerMetadata` correlation envelope declared at the `AgentRunner` boundary;
  `events.ts` dispatches on `activity.canonical.kind` and makes no behavioral
  decision from a runner name, so a third adapter's events flow through it
  unchanged. An activity with no canonical reading produces no `coding_*` event
  — that is how the Codex adapter keeps a non-renderable item out of the
  canonical stream without the mapper knowing what a Codex item is. Native
  detail is preserved beside the canonical payload rather than flattened into
  it: the activity keeps its own `kind`/`content`, the envelope carries a
  bounded `native` blob (dropped whole with `nativeTruncated` rather than
  trimmed when over its key/depth/length/byte limits), and a runner's posture
  stays its own `{ label, value }` — a Codex approval policy and a Claude Code
  permission mode are deliberately not one enum. The legacy per-runner
  `codex`/`claudeCode` blocks are now **projections**, rebuilt from the
  envelope by `legacyMetadata.ts` (payloads, activities) and
  `legacySessionMetadata.ts` (the `AgentSession` DTO, whose canonical block is
  `runner`); those two files are the only ones there allowed to name a runner,
  and both are deletable whole once the advertised contract floor
  (`CODING_EVENT_CONTRACT_VERSION`, reported by `GET /api/config` as
  `codingEventContractVersion`) moves past 2.
- `src/editor`: the backend-served editor language catalog (Phase C/C.5).
  `EditorCatalogStore`/`EditorCatalogManager` resolve the served directory
  (`EDITOR_CATALOG_DIR` operator override when it holds a manifest, else the
  bundled `apps/backend/catalog-assets`, else none), build a versioned in-memory
  manifest from the served bytes, serve referenced blobs under the same read
  bounding as workspaces (`.json`/`.wasm` allowlist, never `.js`), and reload on
  operator request; `editorCatalogManifest.ts` holds the zod contracts. Gated by
  `LANGUAGE_CATALOG_ENABLED`. Shared path/hash helpers live in `src/util`
  (`pathBounding.ts`, `hash.ts`).
- `src/terminal/TerminalSessionService.ts`: the interactive terminal (PTY)
  backend. Spawns a real login shell (`node-pty`) in the realpath of a registered
  workspace, tracks sessions behind the configurable global per-process cap
  (`TERMINAL_MAX_SESSIONS`, default 8, bounded 1–64), reaps idle sessions (timer
  reset on input and output), clamps resize dimensions, and kills the shell on
  close/idle/shutdown. Gated by `terminalEnabled`; never logs shell I/O. Exposed by
  `src/routes/terminalRoutes.ts` at `WS /api/workspaces/:id/terminal` with an
  in-handler bearer check and a JSON `input`/`resize` ↔ `output`/`exit` frame
  protocol. The one documented exception to "no arbitrary shell execution" — see
  `docs/safety/TRUST_AND_SAFETY.md`.
- `src/scene`: the spatial render engine (gated by `SCENE_ENGINE_ENABLED`,
  default on). `geometry/schemas.ts` / `geometry/compose.ts` retain the
  geometry-first `*.scene.json` contract. The Phase 1 solution-diagram compiler
  adds `diagram/schemas.ts` (strict semantic base + human override contracts;
  the base accepts `schemaVersion` 1, 2, or 3, where 2 admits the optional
  `flows` array, 3 admits optional bounded `description` fields on the
  document, nodes, edges, and groups, and older versions keep committed
  documents rendering),
  `diagram/layout.ts` (pure deterministic Sugiyama-lite tiers/platters),
  `diagram/compose.ts` (role vocabulary, primitive entities, connectors,
  overrides, warnings, stable versions, bounded suppressed-hidden-member
  metadata, the bounded `staleOverrides` report — the override entries whose
  ids the base document no longer declares, which compose has always skipped and
  still never deletes, so a rename the agent made is a choice the human can see
  rather than a silent loss — plus the two group rules: a `collapsed`
  group composes to one stand-in entity with its boundary-crossing edges
  re-pointed at it and its internal ones dropped, and a moved group displaces
  the members that carry no placement of their own — neither reaching layout,
  which stays pure over the base document; plus flow resolution, which maps each
  named flow's edge ids to the connectors that survived compose, drops the steps
  that did not, and omits a flow left with none), and `diagram/prompt.ts` (the
  shared Codex/Claude authoring contract). `diagram/humanEdits.ts` adds the
  contract's volatile counterpart (Phase 5 slice 1, widened by Phase 6 slice 6):
  a `DiagramHumanEditTracker` subscribed to the `workspace_file_written` the
  bounded PUT already publishes — agent writes emit no event, which is the
  authorship discrimination — which turns a write to either of a diagram's two
  layers into a bounded per-session "since your last turn" line that
  `AgentTurnContextAssembler` composes into the next turn's prompt for **both**
  runner kinds — a changing value cannot live in Claude Code's stable, cached
  system prompt. An override write reports the placement delta; a base write
  reports the structure delta ("added: cache; connected: orders → cache") once
  the session holds a baseline, and a bounded re-read pointer the first time;
  and whenever a diagram is reported, override ids the base no longer declares
  are named once per session as orphaned human adjustments (the prompt-side
  counterpart of compose's `staleOverrides`). It holds only bounded in-memory
  pointers and compact per-layer
  snapshots (released on `agent_session_deleted`), reads nothing but the
  written diagram's own two files, and stays a
  subscriber rather than a watcher, so the service below keeps its no-state
  property. `diagram/renderFeedback.ts` (visual-refinement Phase 6 slice 1) is
  its agent-authored mirror: a `DiagramRenderFeedbackTracker` that closes the
  loop on the agent's own writes — an unknown role, a validation error, or an
  over-cap document otherwise surfaces only in the volume. It keys on turn
  settlement, never on `workspace_file_written` (which stays the human's
  authorship signal): the settling turn's `coding_diff_updated` file summary —
  the settle-time Git delta for Claude Code, Codex's own `turn/diff/updated` —
  names the turn's `*.diagram.json` writes, and each (at most 4 per turn, the
  rest counted) gets one bounded validation read at settlement, off the
  turn-start path, running the same schema and compose pass as the read route.
  Validations are serialized per session, and prompt preparation awaits the
  in-flight chain — never starting a read of its own — so a queued follow-up
  turn still carries the feedback and outcomes always record in turn order.
  Outcomes wait in memory per session and ride the next accepted turn's prompt
  for both runner kinds as a bounded "what your writes rendered as" line; a
  read failure is skipped silently, a clean render or a reported
  deletion/rename (the diff entry's `oldPath`) clears a pending report, a
  rejected turn — or a report the character cap squeezed out of a delivery —
  leaves the feedback available to retry, and everything is released on
  `agent_session_deleted`, which also cancels in-flight validations. No new
  event,
  route, watcher, scan, or write surface — the service below still keeps its
  no-state property. `diagram/mermaidImport.ts` (Phase 5 slice 3) is the Mermaid import
  bridge: a pure, deterministic, hand-rolled flowchart/graph parser (bounded
  input, no filesystem, no mermaid.js execution, no caller input compiled into
  a regex) that converts an artifact sketch into a schema-valid base document
  emitting only the closed role/kind vocabulary, with every lossy step — a
  sanitized id, a dropped self-loop or subgraph-endpoint edge, a flattened
  nested subgraph — reported as a bounded warning. Exposed by the bearer-gated
  pure-compute `POST /api/spatial-scene/mermaid-import`, which returns
  canonical document *text* plus a filename slug; the client performs the
  write itself through the bounded PUT, create-only. `diagram/editOps.ts`
  (Phase 6 slice 1) is the import bridge's sibling for human semantic
  authoring: a pure, deterministic engine that applies a bounded, zod-typed
  op list (add/relabel/re-role/describe/delete nodes and edges, group
  membership, document rename and describe — deliberately no rename-id op,
  since human overrides key
  on ids; created ids are derived from labels) all-or-nothing to base
  document text, with every knock-on effect of a delete (incident edges,
  flow steps, ungrouped members) a bounded op-indexed warning. Exposed by
  the bearer-gated pure-compute `POST /api/spatial-scene/diagram-edit`,
  which returns new canonical text plus created ids; the client writes it
  through the bounded PUT with the base layer's optimistic-lock token.
  `diagram/canonical.ts` holds the shared id sanitizer, collision ladder, and
  canonical serializer both conversion surfaces emit through, so identical
  documents always produce identical bytes.
  `SpatialSceneService.ts` dispatches both
  suffixes through `WorkspaceExplorer.filePreview` and composes **on every
  read**, with no watcher, tracked-open state, or event machinery. Exposed by
  the single bearer-gated `GET /api/workspaces/:id/spatial-scene`; human writes
  reuse the bounded workspace file PUT.
- `src/state/FileAuditLogStore.ts`: sanitized durable audit entries under
  `STATE_DIR`.
- `src/routes`: health, auth, status/logs/audit, the managed settings read and
  write (`configRoutes.ts`), the registered-runner projection
  (`runnerRoutes.ts`), harness, workspaces,
  coding-agent capabilities, agent sessions (including the one route that
  answers an outstanding permission request), editor language catalog
  (`editorCatalogRoutes.ts`: manifest/asset/status reads + operator reload), the
  spatial render read plus the Mermaid import and diagram edit computes
  (`spatialSceneRoutes.ts`, all registered when
  `SCENE_ENGINE_ENABLED`), the
  interactive terminal (`terminalRoutes.ts`, opt-in), and WebSocket events.
- `src/harness`: agent-facing harness profile plus fixed, path-bounded
  visionOS XcodeGen/xcodebuild feedback actions.

## Clients

- `apps/macos`: launches/supervises the backend — including across its own
  death, which is the case a child process does not survive gracefully: the
  sidecar is launched with `AGENTROOM_EXIT_WITH_PARENT` and the app's expected
  parent pid so it stops when this app does even on a force quit or crash, and
  every launch records the child's pid, kernel start time, executable path, and
  port
  (`Supervision/Process/BackendProcessIdentity.swift`,
  `BackendSidecarRecordStore.swift`) so a later session can adopt a sidecar the
  watchdog did not catch only after the same pid owns the configured listening
  TCP socket, and stop it like its own. A healthy backend without that proof
  stays foreign and untouched —, keeps the bearer token and every
  runner bootstrap slot value in Keychain — keyed by runner id and slot id, from
  one bundled `RunnerBootstrapDescriptor` per runner that also declares how to
  probe the local prerequisite (an installed executable, a presence-only
  `claude login` lookup) and which environment variable each slot is injected as,
  so the descriptors are the launch allowlist and a runner this build does not
  describe contributes no local check and no injected value —, answers Mac
  bootstrap readiness from those probes while showing the backend's own `ready`
  beside it as the separate authority it is, edits the backend-owned managed
  settings file shared with paired clients — reading and writing the same
  version-2 document the backend does (`ManagedSettingsDocument` owns the shape,
  `ManagedSettingsFileStore` the IO), migrating a version-1 file whole on the next
  write, preserving the sections it cannot address **and now showing them
  read-only** (`PreservedManagedSettingRow`), since a runner the backend
  registers can carry a trust setting this build has no field for and the Mac had
  no way to see it — read-only because this app writes the file directly, so a
  value outside a vocabulary it cannot know would make the backend drop the whole
  file onto defaults; and offering the deliberate
  conversion *back* to the flat document an older AgentRoom reads — which
  **refuses** while `runnerKind` names a runner that build predates, since that
  is the one key whose unknown value an older reader rejects outright and
  rewriting it would move the operator's turns onto a different agent; renders its
  runner picker offline from the backend-written `config/runners.json` and falls
  back to its bundled floor, checks runner readiness for the
  effective default kind (Codex executable presence or Claude Code `claude
  login` sign-in), registers local workspace folders, exports redacted
  diagnostics, and packages with backend resources for distribution.
- `apps/visionos`: connects to the Mac backend, checks connection/auth/socket
  state, shows workspaces/files/sessions/messages/events/audit, creates sessions
  with an explicit per-session runner kind (or the backend default), sends turns,
  hosts one or more terminal windows ("panels") per workspace, each with an
  in-window tab strip whose independently retained controllers each own one
  backend PTY session — tabs tear out into their own window and merge across
  same-workspace windows by drag or chip menu, moving the live controller
  without ending its session (`TerminalPanelsStore`),
  derives context paths from explicit `@` file mentions, offers a `/` skill
  picker in the workspace window and scene composers (backed by the bounded
  workspace skills read; narrows while typing and inserts the runner's
  invocation token), can upload selected or
  pasted session-scoped image attachments through the shared client, stops
  turns for steering, badges changed files/folders in the workspace file tree
  from the shared Git status, and renders VS Code-style git gutter decorations
  in the Monaco editor by diffing the buffer against the backend-served HEAD
  baseline (`GitLineDiff` + the `__setGitDiffDecorations` bridge). The editor can
  also toggle a read-only side-by-side diff (HEAD baseline vs working buffer)
  built from two plain Monaco editors with view-zone alignment (`GitDiffHunk` +
  the `__showDiff`/`__hideDiff` bridge), since Monaco's own diff editor needs the
  editor worker this app stubs out. For registry file types
  (`FilePreviewRenderer`, keyed by extension; Markdown first) the editor also
  offers a read-only rendered preview of the live buffer, overlaid the same way
  as the diff and mutually exclusive with it — Markdown renders natively through
  the chat transcript's `ChatMarkdownView` pipeline, so no web view is involved
  and nothing executes. Find-in-file is native chrome — a window
  ornament find bar driving a literal (never regex) Monaco search over the
  `__findInFile`/`__findGoTo`/`__findClear` bridge plus `__revealLine` for
  positioning the active file; the page reports only match counts back
  (`findResult`), never matched text. When the backend reports
  `sceneEngineEnabled`, the windowed workspace's Threads toolbar carries an
  Open Spatial Render menu listing the workspace's own `*.diagram.json` and
  `*.scene.json` documents (discovered through the existing bounded file index,
  refreshed on turn settlement — there is no scene-specific discovery route).
  The same menu starts a New Diagram (Phase 6 slice 2): a name prompt, the
  diagram-edit route with no base text, and a create-only write through the
  bounded PUT walking the Mermaid import's `docs/diagrams/` → root fallback
  and collision ladder (`DiagramWritePlan`, extracted from the import model
  and now shared by both), after which the volume opens on the written path.
  Opening one renders the backend-composed document in a volume with
  RealityKit: primitives for nodes and group platters, oriented shaft-and-cone
  connectors, billboarded SwiftUI label attachments, a rendered state for a
  diagram's validation errors, and drags saved into that document's own
  `*.human.json` override layer through the bounded workspace file write.
  A solution diagram also stands on a faint client-side base plate sized from
  its document-derived content bounds — a depth cue for the otherwise floating
  structure
  (WWDC23 10078), pure render-side decoration that is never hit-testable and
  never reaches a route, an event, or the override layer.
  A document arrives rather than appearing at once
  (`SpatialSceneEntryAnimation`): nodes fade in by layout tier topmost-first,
  connectors follow, labels land last, taking 480 ms at three tiers and 600 ms
  at five with a 660 ms ceiling at any depth, and skipped entirely under Reduce
  Motion. It writes opacity and nothing else, so it cannot
  collide with the drag's transforms, flow playback's materials, or the fit's
  scale — and it runs on arrival only, because reconciliation is also the
  hot-reload path; a reload fades in just the entities it created, which is what
  makes an agent's edit legible rather than a silent swap.
  Its sibling is the re-flow glide (`SpatialSceneReflowAnimation`): when a
  reload re-lays-out the diagram, the entities reconciliation updated in place
  ease briefly from where they were rendered to where the new layout puts
  them, connectors re-aimed each frame, so a structure edit reads as the
  diagram making room rather than churning. It owns the positions of
  non-dragged survivors only — an entity with an active drag belongs to the
  hand, checked at plan time and on every frame — created entities stay the
  arrival fade's business, a document switch glides nothing, and Reduce
  Motion snaps survivors straight to their composed positions.
  Undo is a bounded per-document client-side stack on `SpatialSceneStore` —
  no backend state, no route — recording what each landed edit changed
  (pre-edit base text for a structure transaction, the pre-edit override
  document for placement edits, both for a transaction that pruned or
  co-wrote placement) and replaying it through the same bounded PUT. The
  base half writes with the token of this client's own last base write, so
  undoing past an agent regeneration or another window's edit surfaces as a
  409 that clears the history with an explanation instead of clobbering
  newer work; the ornament offers Undo only once something is undoable.
  Tapping an entity selects it — an emissive highlight plus a detail card in a
  trailing ornament (label, the entity's and each edge's schema-v3
  `description` when the document carries them, group, connected edges),
  derived from the composed
  document with no extra read; selection and drag share one gesture with a
  world-metre dead zone, so a tap selects instead of writing a no-op override.
  A dragged node carries its own connectors, re-aimed each frame from live
  entity transforms (shafts and arrowheads are unit-height and scaled, so this
  costs a transform update, not mesh regeneration), and the drag is clamped to
  the volume's bounds. A locked entity stays targetable, hoverable, and
  selectable — only the drag is refused, with a bounded give and a single
  non-oscillating settle back, and a refused drag selects the entity so the
  card explains it. Nothing is written for a refused drag.
  The card also carries the entity's own edits — lock/unlock, hide, reset
  placement, and, for a group, collapse/expand — and the ornament carries the
  restore list for hidden entities,
  which is the only way back from a `visible: false` that removes an entity from
  the volume. All of them write the same `*.human.json` layer through the same
  bounded PUT a drag uses (`visible` and `locked` were already in the override
  contract; `collapsed` is the one field it gained, on group entries only, and
  no route or event is added), and an edit that leaves an
  override entry empty removes the entry, so the composed `humanEdited` flag
  never outlives the adjustment it describes.
  The ornament's other list is the one the human did not cause: when the
  backend reports `staleOverrides` — adjustments keyed to a node or group the
  agent has since renamed or removed — a control appears naming them and their
  two answers. *Keep* writes nothing, leaving the entries dormant for the day
  the id returns, and is remembered per volume against that exact set of ids, so
  a later turn that orphans one more raises the notice again with all of them.
  *Discard* adopts the agent's layout in one write, clearing each entry through
  the same pruning rule every other edit uses, so the same bounded PUT deletes
  them. Neither adds a route or an event, and an entry that is merely hidden or
  inside a collapsed group is never in the list: it is still in the design.
  A group behaves as one object: collapsed, the backend replaces its members
  with a single stand-in the client simply renders; moved, the platter carries
  the nodes standing on it — live through the gesture, and by the same
  compose-time offset once the group's own override is written, so the
  recomposed read lands on top of the drag rather than snapping it. A member the
  human placed individually keeps its own absolute position in both halves.
  The volume's bottom ornament also cycles between the workspace's spatial
  documents in place (chevrons plus a name menu over the same bounded index,
  no second volume and no new route) and, when the composed document declares
  any, picks which named flow to light: the flow's connectors brighten one hop
  at a time and then stay lit, the sequence plays once rather than looping, and
  Reduce Motion lights the whole path at once. Picking a flow writes nothing —
  it is per-volume view state, cleared when the cycler moves to another
  document. The selection card's Focus verb is the other control in that class:
  a diagram's semantic zoom, which refits the volume to the selected entity's
  neighborhood (a node with its direct connector neighbors, or a group platter
  with the nodes standing on it) at a higher upscale cap, disabling what the
  frame leaves out so nothing spills past the container's clip faces. Focus is
  pure client view state on `SpatialSceneStore` — no route, event, override
  field, or contract change, and the backend composes the identical document
  either way. It is mutually exclusive with flow playback (a lit path partly
  out of frame would show a route with gaps), cleared by the cycler, dissolved
  when a reload drops the focused entity (never left dormant to re-zoom the
  volume when an id returns), and always escapable from the ornament's
  show-whole-diagram control, which outlives the card. The role palette is
  shown and hidden from an Add toggle in the bottom ornament, and both hide
  while focused, because a created node lands at layout position — outside the
  frame, it would materialize invisible.
  The same ornament also moves the document out of the volume and onto a real
  surface in a mixed immersive space, and back. Both presentations render
  through one shared RealityKit view (`SpatialSceneRealityView`) and one
  document store, so a drag in the room writes the same override layer through
  the same bounded PUT; only the container geometry differs — the fit rests the
  content on the anchor plane and the drag clamp bounds it to a furniture-sized
  footprint instead of the volume. Which piece of furniture is a scale preset
  (`SpatialSceneScalePreset`: desk, table, floor), and because that one
  footprint is both the fit target and the clamp, a preset moves reach as well
  as size. Each preset carries the surface class its size implies, so a
  floor-scale diagram asks for a floor rather than for a table it could never
  fit on, along with that surface's minimum bound and its own fallback
  placement; a wall is deliberately not on the axis. Anchoring is RealityKit's
  own (`AnchorEntity(.plane(.horizontal, classification:, minimumBounds:))`), so
  no `ARKitSession` is opened and no world-sensing authorization is involved; a
  room with no matching surface falls back once to a head-relative placement
  (`trackingMode: .once`, never a tracked one), and because that placement is
  one-way the ornament carries a *Place Again* action rather than letting the
  system relocate content under someone. visionOS allows one immersive
  space, so the presentation and the placement both live on `AppStore` and the
  volume window stays open as the document's control surface — its cycler, flow
  picker, hidden list, and selection card all keep working while the geometry is
  in the room, and the scale, re-placement, and the way back sit in a menu on
  the one room control rather than as three more items in the strip.
  `SpatialSceneRoomMemory` carries that arrangement across app launches, in the
  app's own `UserDefaults` and nowhere else: the scale, plus the workspace id
  and path of the document last left resting, so reopening that document puts it
  back on a surface at the size it had. The anchor's *spot* is deliberately not
  in it — RealityKit's anchoring hands the app nothing to store and an ARKit
  `WorldAnchor` is ruled out — so a restore re-resolves a surface instead of
  replaying a position, and a remembered scale and placement cannot disagree.
  Only *Return to Volume* forgets the document; a system dismissal leaves it
  remembered, which is what makes taking the headset off count as leaving the
  diagram out.
  The conversation column raises a
  "diagram updated — open" chip derived purely client-side from the turn's
  `coding_diff_updated` file summary and the settle-time index re-read
  (see `docs/clients/VISIONOS.md`). The artifact canvas above that column
  carries the Mermaid bridge's client half: a finished (non-truncated)
  `kind="mermaid"` artifact grows an Import button that sends its source to
  the backend convert route and writes the returned canonical text through
  the bounded PUT — create-only, preferring `docs/diagrams/<slug>.diagram.json`
  with a workspace-root fallback (the PUT has no recursive mkdir) and bounded
  `-2`…`-5` collision suffixes — then surfaces a status row with the same
  explicit Open step the chip uses and re-keys the document index so the
  toolbar menu lists the import without waiting for a turn.
  The Settings tab is also where the backend's own managed settings are edited.
  It is a split view (`SettingsView`): the sidebar lists the panes — Connection,
  then one per managed section — and the detail column shows one at a time,
  because the app's tab bar is top-level navigation and grouping settings is
  subnavigation inside this window (WWDC23 10076 t=1035). It is assembled from
  the workspace browser's own parts rather than resembling them: one sidebar row
  (`DashboardSidebarRow`, which draws its symbol `.secondary` instead of letting
  `Label` tint it with the accent colour), one set of list/column metrics
  (`dashboardSidebarList()`, `dashboardSidebarRowInsets()`,
  `dashboardSidebarColumnWidth()`), and one glass panel with its header,
  sections, metadata rows, and dividers (`DashboardPocket*`, extracted from
  `WorkspacePocketView`, which now renders through them). Each pane is pocket
  contents; the detail column owns the scrolling, the reading width, and the
  title. The connection pane
  still gates the rest, now by controlling which rows the sidebar has at all:
  `BackendSettingsPane` renders
  `/api/config`'s metadata through a local presentation catalog
  (`ManagedBackendSettingDescriptor` — titles, sections, and control shapes
  only) and patches one key at a time through `PATCH /api/config`. Every policy
  question is the backend's: a control is read-only because the metadata says
  `editable: false` (an environment lock on the Mac, or the trust tier while
  `REMOTE_SETTINGS_ADMIN` is off), a footnote says what a restart would change
  because the metadata carries `pendingValue`, and clearing a key reads as
  "backend default" because the client deliberately keeps no copy of the
  backend's own defaults. That catalog is presentation, not admission: a
  reported setting it has no entry for is still drawn, from the metadata alone
  (`ManagedBackendSettingDescriptor.reported`) — control from `valueKind` and
  `options`, section from `tier` and the address's scope, row name from the
  owning runner's `GET /api/runners` display name — because a runner the backend
  registers brings its own settings and a trust posture no client renders is one
  no operator can hold. A `config_reloaded` event — from this headset, the Mac
  app, or another client — is treated as invalidation and re-reads
  `/api/config`. Each setting is read and patched at whichever address the
  connected backend actually reported — its canonical `global.*`/`runners.*` path
  when it has one, its legacy flat key otherwise — because presence in the
  metadata *is* the advertisement, and patching a path an older backend does not
  know would be a `400` on a control that looked editable. The setting list and
  its addressing are a third copy of the backend's, held to it by
  `apps/backend/test/managedSettingsParity.test.ts`.
- `apps/shared/AgentRoomClient`: shared Swift source package for Apple client
  API DTOs, endpoint construction, bearer auth attachment, response decoding,
  and redaction-friendly request errors. It also holds the two identity-only
  runner floors: the full built-in floor the Mac uses while the backend is
  stopped, and the route-era compatibility floor visionOS uses until
  `GET /api/runners` hydrates. App project definitions include the sources
  directly.

## Runtime Flow

1. Resolve config from env and app-managed paths.
2. Initialize service storage and durable audit under `STATE_DIR`.
3. Register or list local workspaces.
4. Select an existing clean local Git branch for a registered workspace when
   needed.
5. Browse workspace-relative trees and file previews through safe read-only APIs.
6. Create an agent session for a registered workspace and its current branch.
7. Optionally upload image attachments under `STATE_DIR` and attach their ids to
   a turn without dirtying the registered workspace.
8. Start a turn by sending a message, optional selected context paths, and
   optional session-scoped attachment ids.
9. Restore the session branch when needed, then run backend turn context
   assembly before invoking the configured Codex executable in the workspace
   through `AgentRunner`.
10. Stop an active turn when requested and record that turn as cancelled.
    Restorable runners can accept a steering follow-up; DeepSeek requires a new
    AgentRoom session because stopping it kills its non-restorable runtime.
11. Emit native turn updates, structured activity, and runner audit events.
12. Update in-memory session state, message history, metrics, and status
    snapshots.

## Generated And Local State

- Generated Xcode projects are not source of truth. Edit
  `apps/visionos/project.yml` or `apps/macos/project.yml` and regenerate.
- `.env`, `.agentroom`, build output, generated projects, workspaces, tokens,
  and local state must stay out of commits.
