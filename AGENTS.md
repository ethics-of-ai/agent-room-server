# AGENTS.md

Guidance for coding agents working in this repository.

This repository is a public mirror of the backend, macOS app, and shared Swift
client from a private monorepo. This file is maintained by hand in that repo's
`mirror/overlay/` and restates the upstream rules for the paths that exist
here. If a rule or document names a file you cannot find, it lives in the
private repository (usually under the visionOS app), and the rule still holds
for the code that is here. Rule changes are ported upstream and arrive in the
next sync; `docs/operations/OPEN_SOURCE_MIRROR.md` describes the sync.

## Project shape

AgentRoom is a Mac-hosted local AI engineering session bridge. The backend owns
workspace registration, runner execution, session state, events, audit, and
safe file-context injection. The macOS app is the operator client. A visionOS
app, the main session client, exists in the private repository and is not part
of this tree.

- `apps/backend`: TypeScript + Node.js + Fastify backend.
- `apps/macos`: SwiftUI Mac operator app for backend setup, local workspace
  selection, launch, supervision, and diagnostics.
- `apps/shared/AgentRoomClient`: shared Swift source package for Apple client
  API contracts and REST request behavior.
- `docs`: architecture, API, operations, safety, and engineering notes.
- `scripts`: macOS packaging and install scripts.

The backend is the source of truth. Clients must not directly run coding agents
or read provider credentials.

## Current runtime model

1. Register an existing absolute local folder with `POST /api/workspaces`.
2. Create an in-memory agent session with `POST /api/agent-sessions`.
3. Send one turn at a time with `POST /api/agent-sessions/:id/turns`.
4. Optionally attach selected workspace-relative `context.paths`; the backend
   resolves, bounds, and injects previews into the runner prompt while storing
   the original user message unchanged.
5. Observe native events through `WS /api/events`, snapshots through
   `/api/status`, and sanitized durable entries through `/api/audit`.

The API accepts runner kinds `codex`, `claude_code`, and `deepseek`;
`RUNNER_KIND` selects the default (codex) and sessions pin their runner kind at
creation. Codex defaults to `CODEX_RUNNER_PROTOCOL=jsonrpc` for rich sessions
and keeps `CODEX_RUNNER_PROTOCOL=exec` as a compatibility fallback. Claude Code
runs through the Claude Agent SDK (`ClaudeCodeRunner`), with one persistent SDK
session per AgentRoom session. Both implementations stay behind the
`AgentRunner` boundary.

## Core principles

- Keep the backend UI-independent.
- Keep runtime defaults explicit: registered local workspaces and Codex runner
  sessions are the normal path.
- The Mac app is a conduit for selecting workspaces, supervising sessions, and
  observing backend state; any other client drives turns through the same REST
  and WebSocket API.
- Do not commit secrets, tokens, `.env`, local state, generated Xcode projects,
  workspaces, or build output.
- Preserve user-selected workspaces; do not delete user workspaces unless
  explicitly requested.
- Keep workspace browsing and file preview APIs read-only, bounded,
  registered-workspace-only, and symlink-safe. The single exception is the
  bounded, optimistic-locked workspace file write
  (`PUT /api/workspaces/:id/file` → `WorkspaceExplorer.writeTextFile`); do not
  widen it. → `docs/safety/TRUST_AND_SAFETY.md` (*Workspace file writing*)

## How to read the rules below

Each rule is a documented architecture or trust decision. The rule sections are
the index; the document after the arrow carries the full posture, bounds, and
rationale. Read it before touching that surface. Changing a rule means changing
that document, this file, `CLAUDE.md`, and the test that pins it, together.
`docs/safety/TRUST_AND_SAFETY.md` is a flat list of entries; a pointer names the
entry's lead phrase.

## Backend rules

Placement:

- Use TypeScript strict mode. Validate external input with zod.
- Config resolution lives in `apps/backend/src/config`; domain contracts and zod
  schemas in `apps/backend/src/domain`; workspace registration and file context
  in `apps/backend/src/workspace`; runtime events in `apps/backend/src/events`;
  durable sanitized audit in `apps/backend/src/state`; runner adapters and the
  registry in `apps/backend/src/runner`; the canonical coding-event mapper in
  `apps/backend/src/protocol/coding`; the spatial engine in
  `apps/backend/src/scene`; the editor language catalog in
  `apps/backend/src/editor`; the terminal in `apps/backend/src/terminal`.
- Keep turn-based client control behind backend-owned agent session APIs.
- Never log auth tokens, provider credentials, or secrets.

Runners:

- Runner protocol stays behind `AgentRunner`; every other fact about a runner is
  a `RunnerDescriptor` field in `runner/registry.ts`, and
  `registeredRunnerKinds` is the admission list `AgentRunnerKind` and
  `agentRunnerKindSchema` derive from. No file outside `runner/` and the
  registry decides behavior from runner identity (presentation may name a
  runner, policy may not), and `apps/backend/test/runnerRegistry.test.ts` fails
  the build on one. Generalize the dispatch, never the payload; no universal
  permission enum; the built-in list is `codex`, `claude_code`, and `deepseek`
  and grows only by a deliberate rollout-gate decision
  (`docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`); startup is two-stage
  (registry, then managed settings).
  → `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`,
  `docs/engineering/RUNNER_CAPABILITY_MATRIX.md`,
  `docs/architecture/MOVING_PARTS.md` (`src/runner/registry.ts`)
- The persistent-child lifecycle is `runner/shared/PersistentRunnerSessionHost.ts`;
  adapters supply spawn/restore/teardown and declare a `restoreStrategy`. Do not
  reimplement it or make the host speak a protocol. Codex and Claude Code are
  `native_resume`; DeepSeek is `unsupported`, is never idle-reaped, and a
  cancelled or crashed DeepSeek runtime makes that AgentRoom session
  uncontinuable rather than silently starting a fresh conversation.
  → `docs/architecture/MOVING_PARTS.md` (`src/runner`)
- Adapters map their protocol into the `CanonicalActivity` union and
  `RunnerMetadata` envelope; `protocol/coding/events.ts` dispatches on
  `activity.canonical.kind` alone. The legacy `codex`/`claudeCode` blocks are
  projections built only by `legacyMetadata.ts` / `legacySessionMetadata.ts`,
  deletable when `codingEventContractVersion` passes 2. Do not reintroduce a
  native-kind prefix match, a per-runner branch outside those shims, or a
  runner-identity fallback for harness attribution.
  → `docs/architecture/MOVING_PARTS.md` (`src/protocol/coding`),
  `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` (Phase 2)
- `GET /api/runners` (`routes/runnerRoutes.ts`) is the registry's one
  safe/public projection: id, `displayName`, `registered`/`configured`/
  `enabled`, observed `ready`, and never a policy field or a tier-3 value.
  Readiness has two authorities and stays two (backend runtime `ready`, proved
  by capability discovery and omitted until asked; Mac bootstrap readiness,
  answered on the Mac). `$AGENTROOM_HOME/config/runners.json` is the same
  projection written for offline Mac use, never read back.
  → `docs/safety/TRUST_AND_SAFETY.md` (`GET /api/runners`; *two authorities*;
  *offline runner catalog*), `docs/api/API.md` (Runners)
- External agents stay behind the single ACP v1 adapter in
  `apps/backend/src/runner/acp` (no SDK dependency), off by default
  (`ACP_ADAPTERS_ENABLED`, tier-3 `ACP_ADAPTERS`), with a documented trust
  posture: admitted executables, allowlisted child env, bounded transport,
  restorable agents only, `fs`/`terminal` declined, permissions refused unless
  the tier-2 `permissionPolicy` allows, images only when advertised and within
  budget, `configOptions` mapped for `model`/`thought_level` and never `mode`,
  `acp_*` ids with collision-checked settings prefixes. Do not widen it.
  → `docs/safety/TRUST_AND_SAFETY.md` (*External ACP adapters*),
  `docs/engineering/ACP_CONFORMANCE.md`,
  `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md` (Phases 3 to 5)
- Interactive permission approval is exactly one mutating, bearer-gated route
  (`POST /api/agent-sessions/:sessionId/permissions/:requestId` →
  `AgentSessionService.answerPermissionRequest` → the optional
  `AgentRunner.answerPermissionRequest` hook) selecting an option the agent
  itself offered; asked only under a tier-2 `ask` posture; bounded
  (`permissionTimeoutMs`); held in `runner/shared/PendingPermissionRequests.ts`;
  audit records the decision, never the tool call.
  → `docs/safety/TRUST_AND_SAFETY.md` (*Interactive permission approval*),
  `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md` (Phase 2)

Configuration:

- Managed settings live in `$AGENTROOM_HOME/config/settings.json`
  (`config/settingsStore.ts`, `routes/configRoutes.ts`), under five rules none
  of which is relaxed silently: managed settings only (the
  bootstrap/secret/execution tier never enters the file, the metadata, or the
  PATCH schema); env wins and locks, else file, else default; everything applies
  on restart; which settings exist is declared (globals in `settingsStore.ts`,
  runner settings on the `RunnerDescriptor`) and every table is derived; one
  file, one schema (version 2 written, version 1 read and migrated whole,
  unknown namespaces preserved, a newer version reported as unsupported).
  `REMOTE_SETTINGS_ADMIN` stays environment-only and default off; an unusable
  file is dropped whole; `config_reloaded` carries names only; both addresses
  are served and accepted with `valueKind`/`options`. The Swift mirrors are held
  to the backend by `apps/backend/test/managedSettingsParity.test.ts`.
  → `docs/safety/TRUST_AND_SAFETY.md` (*managed settings file*),
  `docs/api/API.md` (Config), `docs/architecture/MOVING_PARTS.md`
  (`src/config/settingsStore.ts`)

Workspace surfaces:

- No arbitrary shell execution API. The single documented exception is the
  interactive terminal (`apps/backend/src/terminal`,
  `WS /api/workspaces/:id/terminal`): off by default (`TERMINAL_ENABLED`),
  capped (`TERMINAL_MAX_SESSIONS`), registered only when enabled, bearer-authed
  in-handler, started in a registered workspace, unsandboxed once running, never
  logging shell I/O. → `docs/safety/TRUST_AND_SAFETY.md` (*interactive terminal*)
- Harness actions stay fixed, path-bounded, registered-workspace-only.
  → `docs/engineering/HARNESS_ENGINEERING.md`
- If `AUTH_TOKEN` is configured, mutating routes require bearer auth, and so do
  the reads that expose project structure or content (tree, preview, Git status
  and file-baseline, skills, file index, search, spatial render, session
  messages, artifacts; `routes/readAuthorization.ts`).
- The workspace file index and content search stay bounded and literal: no
  caller-supplied regex, every path (including `git ls-files` output)
  re-filtered and realpath-checked at point of use, every bound reported through
  `truncated`. → `docs/safety/TRUST_AND_SAFETY.md` (*file-index and
  content-search*)
- Mutating Git stays behind `workspace/WorkspaceGitService.ts` and the fixed
  argv in `LocalWorkspaceGit` (stage, unstage, discard, commit, fetch, ff-only
  pull, push, branch create): no shell, no caller flags/refspecs/remotes, no
  history rewriting or forced push, every path through `indexableRelativePath`,
  never `git add -A`. → `docs/safety/TRUST_AND_SAFETY.md` (*Mutating Git
  operations*)
- The spatial render engine (`apps/backend/src/scene`, `SCENE_ENGINE_ENABLED`)
  composes `*.scene.json` / `*.diagram.json` with their `*.human.json` override
  layers on every read through one bearer-gated route plus two bearer-gated
  pure-compute POSTs (`mermaid-import`, `diagram-edit`) whose output the client
  writes through the bounded PUT. No scene write route, watcher, scene event,
  tracked-open state, or client-side composition; base `schemaVersion` 1 to 3
  all keep rendering; `staleOverrides` are reported, never deleted. The two
  per-turn prompt injections (`diagram/humanEdits.ts` on
  `workspace_file_written`, `diagram/renderFeedback.ts` on turn settlement)
  stay bounded, in-memory, and add no surface.
  → `docs/safety/TRUST_AND_SAFETY.md` (spatial render engine, Mermaid import,
  diagram edit, and prompt-injection entries),
  `docs/architecture/MOVING_PARTS.md` (`src/scene`), `docs/api/API.md`
- The editor language catalog (`apps/backend/src/editor`,
  `routes/editorCatalogRoutes.ts`, `LANGUAGE_CATALOG_ENABLED`) serves
  app/global `.json`/`.wasm` data only, never `.js`, never a workspace file.
  → `docs/architecture/MOVING_PARTS.md` (`src/editor`)

## Client rules

- The macOS app, like every AgentRoom client, is a REST/WebSocket client; it
  does not execute Codex, shell commands, or provider tools.
- Render coding-agent activity from the canonical block, never a native kind:
  `CodingAgentActivity.canonical` decides what an activity is,
  `CodingRunnerMetadata` supplies correlation and posture, and
  `CodingAgentEventType`/`CodingCanonicalActivityKind` are lossless
  `RawRepresentable` structs (switches carry a `default`). Do not add a
  `codex_*`/`claude_code_*` allowlist to any renderer state.
  → `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` (Phase 2)
- Which runners a client offers is `GET /api/runners`, never a compiled-in
  list; the apps hydrate a `RunnerCatalog` from it. The Mac's stopped-backend
  path falls back to `RunnerCatalog.builtIn` (identity only). A remote client
  falls back to `RunnerCatalog.legacyBackendFallback`, which contains only
  runners predating the route, so it never advertises a newly bundled runner
  without backend availability metadata. `AgentRunnerKind` is for bespoke
  presentation only and is not `CaseIterable`; an unknown runner id renders as
  itself and is never coerced to a known runner.
  → `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` (Phase 4),
  `docs/safety/TRUST_AND_SAFETY.md` (`GET /api/runners`)
- The macOS runner bootstrap contract is bundled and stays bundled: one
  `RunnerBootstrapDescriptor` per runner
  (`apps/macos/AgentRoomMac/Supervision/RunnerBootstrap/`) declaring tier-3
  slots and probes, the launch environment built by walking them (so they are
  the allowlist), `BackendLaunchConfiguration` reading no managed setting, and
  nothing in it arriving from the backend.
  → `docs/clients/MACOS.md` (*Runner Bootstrap And The Two Readiness
  Authorities*), `docs/safety/TRUST_AND_SAFETY.md` (*two authorities*)
- Shared Apple DTOs and REST behavior live in `apps/shared/AgentRoomClient`,
  compiled directly into each app: no package dependency, no
  `import AgentRoomClient`, no app-local alias or shadow declarations
  (`apps/backend/test/swiftModelStructure.test.ts`).
  → `docs/engineering/SWIFTUI_STANDARDS.md`
- Follow `docs/engineering/SWIFTUI_STANDARDS.md` when reading, writing, or
  reviewing Swift/SwiftUI code in `apps/macos` or `apps/shared`.

## Xcode rules

- Do not manually create or edit generated `.xcodeproj` files.
- Keep `apps/macos/project.yml` as the project definition.
- SwiftUI code should compile after running XcodeGen.

## Documentation rules

- Treat `README.md`, `docs/**`, `AGENTS.md`, and `CLAUDE.md` as part of the
  product surface for agents and operators.
- Update docs when changing routes, event names, config variables, safety
  posture, packaging behavior, or client responsibilities.
- Do not reference removed concepts such as Linear tracker/orchestrator
  workflow policy unless those modules are reintroduced in code.
- This repository is a mirror: documentation changes, like code changes, are
  ported into the private repository and arrive here in the next sync.
- `GET /api/harness` advertises `docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md`
  among its grounding documents. That file is not in this tree; it lives with
  the visionOS app in the private repository.

## Verification

Before claiming backend work is complete, run:

```bash
pnpm typecheck
pnpm --filter @agentroom/backend build
pnpm test
```

Some backend tests compare the backend against the visionOS app or the Apple
reference indexes; they skip when those trees are absent, which they are here.

For server/runtime changes, also smoke check the compiled backend:

```bash
PORT=8799 pnpm --filter @agentroom/backend start
curl -sS http://127.0.0.1:8799/health
curl -sS http://127.0.0.1:8799/api/status
```

Stop the test server before finishing.

For macOS app project changes, run:

```bash
cd apps/macos
xcodegen generate
```

If XcodeGen or Xcode is not available, state that explicitly.

For docs-only changes, run a targeted stale-reference check such as:

```bash
rg -n "apps/backend/src/(orchestrator|tracker|workflow)|docs/operations/CONNECTION_SETUP|Bundle For Distribution|Linear\\+Codex|enable_git_branch_automation|enable_git_push_automation|per-issue|stop-at-human-review|runtime policy front matter|WORKFLOW\\.md policy" \
  CLAUDE.md README.md docs
```

## Safety notes

The complete trust posture, every default, gate, bound, and the reasoning
behind it, is `docs/safety/TRUST_AND_SAFETY.md`; harness posture is
`docs/engineering/HARNESS_ENGINEERING.md`. Do not weaken a documented default
without updating that doc, this file, `CLAUDE.md`, and the tests that pin it.
