# CLAUDE.md

Guidance for Claude Code and other Claude-based coding agents working in this
repository. `AGENTS.md` is the cross-agent source of truth; keep this file in
sync when repository rules change.

This repository is a public mirror of the backend, macOS app, and shared Swift
client from a private monorepo. This file is maintained by hand in that repo's
`mirror/overlay/`. If a rule or document names a file you cannot find, it lives
in the private repository (usually under the visionOS app), and the rule still
holds for the code that is here. `docs/operations/OPEN_SOURCE_MIRROR.md`
describes the sync.

## Read first

Start with these files before non-trivial implementation, debugging, review, or
documentation work:

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture/ARCHITECTURE.md`
4. `docs/architecture/MOVING_PARTS.md`
5. `docs/safety/TRUST_AND_SAFETY.md`
6. `docs/api/API.md`
7. `package.json`
8. `apps/backend/package.json`

If a file listed in old instructions is missing, do not assume it still exists.
Verify the current tree with `rg --files`.

## Current architecture

AgentRoom is a local Mac-hosted bridge for agentic coding sessions:

- The Fastify backend owns registered workspaces, agent sessions (Codex,
  Claude Code, and DeepSeek runner kinds), runner execution, canonical
  `coding_*` events, status snapshots, and durable audit.
- The macOS app launches and supervises the backend sidecar, stores launch
  secrets in Keychain, registers local workspaces, and renders diagnostics.
- The visionOS app, the main session client, is not in this repository. Any
  client reaches the backend over REST/WebSocket: it browses registered
  workspace files, selects explicit `@` file context, creates sessions, sends
  turns, and renders live status.
- Shared Apple client DTOs and REST request behavior live in
  `apps/shared/AgentRoomClient`; app projects compile those sources directly
  from XcodeGen rather than declaring a separate local package dependency.

There is no active Linear tracker, orchestrator workflow engine, or
`WORKFLOW.md` policy file in this checkout. Do not build against those concepts
unless a task explicitly reintroduces them.

## Non-negotiables

Each rule below is a documented architecture or trust decision. This list is
the index; the document after the arrow carries the full posture, bounds, and
rationale. Read it before touching that surface. Changing a rule means changing
that document, `AGENTS.md`, this file, and the test that pins it, together.
`docs/safety/TRUST_AND_SAFETY.md` is a flat list; a pointer names its entry's
lead phrase.

### Backend and runners

- The backend is the source of truth. Clients never run coding agents, execute
  shell commands, or read provider credentials.
- Runner protocol stays behind `AgentRunner`; every other fact about a runner is
  a `RunnerDescriptor` field in `apps/backend/src/runner/registry.ts`. No file
  outside `runner/` and the registry decides behavior from runner identity
  (presentation may name a runner; policy may not);
  `apps/backend/test/runnerRegistry.test.ts` enforces it. No universal
  permission enum; built-in `registeredRunnerKinds` is
  `codex`/`claude_code`/`deepseek` and grows only by a deliberate rollout-gate
  decision.
  → `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`,
  `docs/engineering/RUNNER_CAPABILITY_MATRIX.md`
- Adapters map their protocol into `CanonicalActivity` + `RunnerMetadata`; the
  mapper in `apps/backend/src/protocol/coding` dispatches on `canonical.kind`
  only, and the legacy `codex`/`claudeCode` blocks are shim projections that go
  when `codingEventContractVersion` passes 2. The persistent-child lifecycle is
  `runner/shared/PersistentRunnerSessionHost.ts`: Codex and Claude Code declare
  `native_resume`; DeepSeek declares `unsupported`, is never idle-reaped, and
  refuses a same-session continuation after cancellation or child loss rather
  than silently starting a fresh conversation.
  → `docs/architecture/MOVING_PARTS.md` (`src/protocol/coding`, `src/runner`)
- `GET /api/runners` is the registry's one public projection (identity,
  availability states, observed `ready`), never a policy field or tier-3 value.
  Readiness has two authorities and stays two: backend runtime `ready` and Mac
  bootstrap readiness. → `docs/safety/TRUST_AND_SAFETY.md` (`GET /api/runners`;
  *two authorities*), `docs/api/API.md` (Runners)
- External agents go through the one ACP v1 adapter
  (`apps/backend/src/runner/acp`, no SDK dependency), off by default, with a
  documented trust posture (admission, allowlisted env, bounded protocol,
  restore-only, declined `fs`/`terminal`, refused permissions, negotiated
  images, `mode` never projected). Do not widen it.
  → `docs/safety/TRUST_AND_SAFETY.md` (*External ACP adapters*),
  `docs/engineering/ACP_CONFORMANCE.md`
- Interactive permission approval is one bearer-gated route
  (`POST /api/agent-sessions/:sessionId/permissions/:requestId`) selecting an
  option the agent itself offered; asked only under the tier-2 `ask` posture,
  bounded, decision-only audit.
  → `docs/safety/TRUST_AND_SAFETY.md` (*Interactive permission approval*)
- Codex JSON-RPC is the default; `exec` is a fallback. Claude Code runs through
  the Agent SDK with credential scrubbing and the documented `bypassPermissions`
  default. Both runners' workspace-settings loading (Codex: native, network
  pinned on start and resume; Claude Code: `project` source under
  `bypassPermissions` only) is a documented trust decision. Do not change the
  defaults, gates, or the pin silently.
  → `docs/safety/TRUST_AND_SAFETY.md` (Codex and Claude Code entries)
- External input is validated with zod; contracts live in
  `apps/backend/src/domain`.

### Configuration

- Managed settings are `$AGENTROOM_HOME/config/settings.json`
  (`config/settingsStore.ts`, `routes/configRoutes.ts`; `GET`/`PATCH
  /api/config`). The bootstrap/secret/execution tier never enters the file, the
  metadata, or the PATCH schema; env wins and locks → file → default; everything
  applies on restart; `REMOTE_SETTINGS_ADMIN` is env-only, default off; which
  settings exist is declared on the globals and each `RunnerDescriptor`, and
  every table is derived. The file is version 2 with version 1 read/migrated
  whole; `$AGENTROOM_HOME/config/runners.json` is the offline runner catalog.
  → `docs/safety/TRUST_AND_SAFETY.md` (*managed settings file*),
  `docs/api/API.md` (Config)
- The Mac's runner bootstrap is a **bundled** `RunnerBootstrapDescriptor` per
  runner (`apps/macos/AgentRoomMac/Supervision/RunnerBootstrap/`) and is the
  launch-env allowlist; nothing in it may arrive from the backend.
  → `docs/clients/MACOS.md` (*Runner Bootstrap And The Two Readiness
  Authorities*)

### Workspace surfaces

- No arbitrary shell execution API. The one exception is the interactive
  terminal (`WS /api/workspaces/:id/terminal`): off by default
  (`TERMINAL_ENABLED`), capped, bearer-authed, unsandboxed once running, never
  logging I/O. → `docs/safety/TRUST_AND_SAFETY.md` (*interactive terminal*)
- Harness actions stay fixed, path-bounded, registered-workspace-only.
  → `docs/engineering/HARNESS_ENGINEERING.md`
- When `AUTH_TOKEN` is set, mutating routes and every read exposing project
  structure or content require bearer auth (`routes/readAuthorization.ts`).
- Workspace browsing is read-only except the single bounded, atomic,
  optimistic-locked `PUT /api/workspaces/:id/file`.
  → `docs/safety/TRUST_AND_SAFETY.md` (*Workspace file writing*)
- File index and search are bounded and literal: no caller regex, every path
  re-filtered and realpath-checked, every bound reported via `truncated`.
  → `docs/safety/TRUST_AND_SAFETY.md` (*file-index and content-search*)
- Mutating Git is `WorkspaceGitService` over fixed argv only (stage, unstage,
  discard, commit, fetch, ff-only pull, push, branch create): no shell, no
  caller flags/refspecs/remotes, no history rewriting or force, never
  `git add -A`. → `docs/safety/TRUST_AND_SAFETY.md` (*Mutating Git operations*)
- The spatial render engine (`apps/backend/src/scene`, `SCENE_ENGINE_ENABLED`)
  is compose-on-read over `*.scene.json`/`*.diagram.json` plus a `*.human.json`
  override layer written through the bounded PUT: one read route, two
  pure-compute POSTs (`mermaid-import`, `diagram-edit`), and no scene write
  route, watcher, event, or client-side composition. The two per-turn prompt
  injections (`diagram/humanEdits.ts`, `diagram/renderFeedback.ts`) stay
  bounded and in-memory. → `docs/safety/TRUST_AND_SAFETY.md` (spatial render
  engine entries), `docs/architecture/MOVING_PARTS.md` (`src/scene`),
  `docs/api/API.md`
- Secrets come from env or Keychain and are never logged, returned, or
  committed. Preserve registered user-selected workspaces.

### Clients

- Clients render coding-agent activity from `canonical`/`runner`, never a
  native kind; event and activity kinds are lossless `RawRepresentable`. Which
  runners a client offers is `GET /api/runners`; `AgentRunnerKind` is not
  `CaseIterable`; an unknown runner id renders as itself. The Mac keeps the full
  identity-only `RunnerCatalog.builtIn` floor while stopped; a remote client
  uses the route-era `RunnerCatalog.legacyBackendFallback` until backend
  metadata hydrates, so a newer runner is not advertised on a failed catalog
  read.
  → `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` (Phases 2 and 4)
- Shared DTOs and REST code live in `apps/shared/AgentRoomClient`, compiled into
  each app directly: no package dependency, no `import AgentRoomClient`, no
  app-local shadow declarations (`apps/backend/test/swiftModelStructure.test.ts`).
  → `docs/engineering/SWIFTUI_STANDARDS.md`
- Do not manually edit generated Xcode projects; edit `project.yml` and run
  XcodeGen.
- Follow `docs/engineering/SWIFTUI_STANDARDS.md` for Swift/SwiftUI work in
  `apps/macos` or `apps/shared`.

## Useful map

- Backend config: `apps/backend/src/config`; managed settings store and its
  read/write route: `apps/backend/src/config/settingsStore.ts`,
  `apps/backend/src/routes/configRoutes.ts`
- Domain contracts and zod schemas: `apps/backend/src/domain`
- Fastify server and routes: `apps/backend/src/server.ts`,
  `apps/backend/src/routes`
- Agent sessions and turn lifecycle: `apps/backend/src/agent/AgentSessionService.ts`
- Runner adapters and the runner registry: `apps/backend/src/runner`,
  `apps/backend/src/runner/registry.ts`
- Workspace registry, tree, preview, and context injection:
  `apps/backend/src/workspace`
- Events: `apps/backend/src/events`
- Spatial scene engine: `apps/backend/src/scene`,
  `apps/backend/src/routes/spatialSceneRoutes.ts`
- Editor language catalog (Phase C/C.5): `apps/backend/src/editor`,
  `apps/backend/src/routes/editorCatalogRoutes.ts`
- Interactive terminal (PTY): `apps/backend/src/terminal/TerminalSessionService.ts`,
  `apps/backend/src/routes/terminalRoutes.ts`
- Durable audit: `apps/backend/src/state`
- macOS client: `apps/macos`
- Shared Swift client contracts and REST code: `apps/shared/AgentRoomClient`
- SwiftUI client standards: `docs/engineering/SWIFTUI_STANDARDS.md`
- Packaging: `scripts/package-macos.mjs`, `scripts/install-macos.mjs`,
  `scripts/codesign/node-runtime.entitlements`
- How this repository is produced: `docs/operations/OPEN_SOURCE_MIRROR.md`

## Verification

For backend work:

```bash
pnpm typecheck
pnpm --filter @agentroom/backend build
pnpm test
```

Some backend tests compare the backend against the visionOS app or the Apple
reference indexes; they skip when those trees are absent, which they are here.

For server/runtime behavior, also smoke check the compiled backend and stop it
afterward:

```bash
PORT=8799 pnpm --filter @agentroom/backend start
curl -sS http://127.0.0.1:8799/health
curl -sS http://127.0.0.1:8799/api/status
```

For macOS project changes:

```bash
cd apps/macos
xcodegen generate
```

For docs-only changes, run a targeted stale-reference check across agent-facing
docs and update any mismatches before finishing.
