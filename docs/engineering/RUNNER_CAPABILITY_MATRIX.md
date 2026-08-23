# Runner Capability Matrix

Phase 0a deliverable of [Universal Runner Boundary](UNIVERSAL_RUNNER_BOUNDARY.md).

**Locations are anchored to `27ffe7f`** (Phase 1) and re-checked after Phases 2
and 3 (2026-08-16); rows those phases retired now carry no location. They were
re-derived against it after that commit's review; its follow-up fixups moved
none of the cited lines. The first draft was measured against the parent commit
and went stale the moment Phase 1 moved the runner files it cited. A `file:line`
below is a pointer for a reader, not a fact the repository maintains: re-derive
one before trusting it, and when a phase retires a leak, give it no location
rather than a plausible wrong one.

Phase 3 turned the *Policy* section below from a specification into a
description: every row in it is now a field on `RunnerDescriptor` in
`apps/backend/src/runner/registry.ts`, and
`apps/backend/test/runnerRegistry.test.ts` fails the build if a behavioral
decision on runner identity reappears outside `runner/` and the two Phase 2
legacy shims.

Every question below is one the backend currently answers by asking **who the
runner is**. This document decides, for each, whether that question is a
*policy* the registry must answer explicitly, *presentation* that may stay
per-runner, or *adapter-internal* detail that never leaves the adapter.

It is the specification Phases 2–5 implement. Writing it first is what prevents
discovering a leak mid-refactor — the first draft of the plan missed three
(turn-diff strategy, workspace-skill availability, session-metadata extraction)
precisely because no such enumeration existed.

## How a row was classified

- **Policy** — the backend changes *behavior* based on the answer. Must become a
  named `RunnerDescriptor` field (Phase 3), because a third runner's answer is
  unknowable from its identity. The Phase 3 acceptance criterion is that no file
  outside `runner/` and the registry makes a behavioral decision from runner
  identity.
- **Presentation** — the answer only changes what a *client* draws. May stay a
  per-runner lookup, but needs a defined fallback so an unknown runner looks
  deliberate rather than broken (Phase 4).
- **Adapter-internal** — the answer lives inside one adapter and is never asked
  from outside it. Listed so a future reader can tell "not yet generalized" from
  "deliberately not generalized".

The governing rule from the plan applies throughout: **generalize the dispatch,
never the payload.** A policy field replaces a conditional; it must not flatten
what a runner's native protocol actually said.

## Policy — becomes a registry field

The table's two columns are the runners the matrix was written against. A third
built-in landed on 2026-08-18 (`deepseek`,
`docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`); rather than widen every row, its
values are listed once below, since the point of the registry is that a new
runner is a row of data rather than a column of exceptions:

| Policy | DeepSeek Harness | Why |
|---|---|---|
| `promptDelivery` | `turn` | The SDK `initialize` carries no system-prompt parameter — the persona is the composed profile's — so the standing contract rides each turn prompt. |
| `turnDiffSource` | `settle_time_git` | The session log has no diff event, so `AgentTurnGitDiffTracker` derives one at settlement, as for Claude Code. |
| `workspaceSkills` | `none` | Whether a composition loads workspace skills is the profile's answer and is not visible on the wire; advertising invocations a session would ignore is what the skills read exists to avoid. |
| `skillSources` / `skillInvocationPrefix` | *(none)* / `/` | Follows from `none`. |
| `restoreStrategy` | `unsupported` | The wire has no resume method, and reusing an id may create an empty pair when the composition has no persistence. The handshake cannot prove persistence, so the host never idle-reaps the child and a cancelled/crashed session is refused rather than silently restarted. |
| `isConfigured` | `DEEPSEEK_EXECUTABLE` **and** `DEEPSEEK_CORDIS_CONFIG` present | Tier 3, like Codex's, but two values rather than one: the runtime demands an explicit Cordis composition and exits nonzero without it, so an executable alone would advertise a runner that fails its first turn. |
| `capabilityDiscoveryCost` | spawns a probe child, cached 5 min | The wire has no `model/list`, so the catalog is static and the probe proves the handshake instead. |

| Policy | Codex | Claude Code | Decided by today | Registry field | Phase |
|---|---|---|---|---|---|
| `promptDelivery` | `turn` | `system` | — *retired; the assembler reads the descriptor* | `promptDelivery: "turn" \| "system"` | **3 — done** |
| `turnDiffSource` | `runner` | `settle_time_git` | — *retired; the session service reads the descriptor* | `turnDiffSource: "runner" \| "settle_time_git"` | **3 — done** |
| `workspaceSkills` | `native` | `gated` | — *retired; the skills route reads `workspaceSkillsAvailable()`* | `workspaceSkills: { mode: "native" } \| { mode: "none" } \| { mode: "gated"; gate }` — a discriminated union, so the compiler requires the gate on the branch that needs one | **3 — done** |
| `skillSources` | `.codex/skills`, `.agents/skills` | `.claude/skills` | — *retired; the explorer reads the descriptor* | `skillSourceDirs: readonly string[]` | **3 — done** |
| `skillInvocationPrefix` | `$` | `/` | — *retired; the explorer reads the descriptor* | `skillInvocationPrefix: string` | **3 — done** |
| `restoreStrategy` | `native_resume` (`thread/resume`) | `native_resume` (SDK `resume`) | — *retired; both adapters pass `runnerDescriptor(kind).restoreStrategy` to the shared host* | `restoreStrategy: "native_resume" \| "history_replay" \| "unsupported"` | **1 (declared) / 3 (sourced) — done** |
| `isConfigured` | `CODEX_EXECUTABLE` present | always (the SDK bundles a CLI) | — *new in Phase 3; feeds the `configured` availability state* | `isConfigured: (config) => boolean` | **3 — done** |
| `imageParts` | `localImage` path (jsonrpc only) | inline base64 block | `AgentRunner.validateInputParts` in both adapters | *(already abstract — `validateInputParts` stays the boundary)* | — |
| `sessionMetadataBlock` | `codex` | `claudeCode` | — *retired; `AgentSession.runner` is set from the canonical `session_started` payload, and the per-runner blocks are projections* | canonical `nativeSessionId` on the metadata envelope | **2 — done** |
| `activityNamespace` | `codex_*` | `claude_code_*` | — *retired; the mapper dispatches on `activity.canonical.kind`* | *none* — replaced by the canonical activity union, not by a namespace field | **2 — done** |
| `harnessAttribution` | stamped `"codex"` unconditionally | — | — *retired; `VisionOSHarness` requires a session-runner resolver* | resolve the supplied `sessionId` and use that session's real runner id | **2 — done** |
| `capabilityDiscoveryCost` | spawns a probe child per request | spawns a probe child, cached 5 min | `runner/codex/CodexAppServerRunner.ts:115`, `runner/claudeCode/ClaudeCodeRunner.ts:97` | lazy per-runner discovery, and it doubles as the runtime-readiness probe — `runner/runtimeReadiness.ts` records what it proved, so no route spawns a child of its own | **6 — done** |
| `runtimeReadiness` | did the app-server start and answer `model/list`? | did the SDK session start and answer `supportedModels()`? | — *new in Phase 6; the adapter answers it by discovering capabilities* | *none* — observed, not declared: a descriptor field would make it configuration rather than evidence | **6 — done** |

Notes on the rows that are easy to get wrong:

- **`restoreStrategy` was decided in Phase 1, not 3, and has landed.** It is the
  one policy the shared session host needs before any registry exists: the host
  must not arm an idle timer for a runner it cannot restore, because reaping a
  non-restorable child silently loses the conversation. Codex and Claude Code
  are `native_resume`; DeepSeek is `unsupported` and is therefore not idle-reaped.
  Phase 3 completed the handoff: the
  descriptor is now the source, and each adapter reads
  `runnerDescriptor(kind).restoreStrategy` instead of declaring a local constant.
- **`workspaceSkills` is a capability, not metadata.** The gate is not "is this
  Claude Code" but "does this runner load workspace settings under its current
  posture". That predicate is `loadsWorkspaceSettings` in
  `runner/claudeCode/settings.ts`, which is Claude
  Code's own trust rule — `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS` honored only under
  `bypassPermissions`. The descriptor names *that a gate exists* and calls
  through to it; the adapter
  still owns *what the gate is*, because flattening two runners' trust postures
  into one enum is the payload mistake in the place it would do real damage.
  Phase 3 made the shape enforce that: `workspaceSkills` is a discriminated
  union, so a `gated` descriptor without a gate does not compile and there is no
  default-closed fallback to reason about.
- **`isConfigured` is bootstrap presence, not readiness.** Added in Phase 3 to
  resolve the `configured` availability state. It asks only whether the operator
  supplied the settings the adapter cannot start without, and it spawns nothing.
  Whether the backend can actually spawn the child and complete the handshake is
  a second authority (`ready`, landed in Phase 6 as an observation of the
  adapter's own capability discovery), and whether the Mac's local prerequisite
  is satisfied — a `claude login` Keychain presence check, say — is a third that
  must work with the backend stopped, answered from a bundled bootstrap
  descriptor. Collapsing them is what produces the "ready in the UI, unusable by
  the backend" failure.
- **`activityNamespace` gets no field.** A `namespace` field would let the core
  mapper keep dispatching on runner identity under a new name. Phase 2 replaces
  the prefix match with a discriminated canonical payload each adapter produces,
  so the mapper stops knowing that `codex_*` or `claude_code_*` exist at all.
- **`harnessAttribution` is a live bug, not just a leak.** A Claude Code
  session's harness activity is currently published as `runnerKind: "codex"`.
  Phase 2 fixes it as part of removing identity from the event path.

## Presentation — may stay per-runner, needs a fallback

| Question | Codex | Claude Code | Unknown runner falls back to | Phase |
|---|---|---|---|---|
| Display name | "Codex" | "Claude Code" | descriptor `displayName` | 4 |
| Buddy asset | bundled buddy | bundled buddy | no buddy (deliberate absence, not a placeholder) | 4 |
| Icon / badge | bespoke | bespoke | generic runner glyph | 4 |
| Activity rendering | native treatment | native treatment | the Phase 2 generic canonical renderer | 2 |
| Runner-specific settings pane | Codex sandbox/approval controls | Claude permission mode / skills toggle | descriptor-declared keys rendered generically | 5 |

The goal is not to remove bespoke chrome. It is that bespoke chrome is an
*enhancement*, never a prerequisite for baseline operation — a runner with none
must look deliberate.

## Adapter-internal — never leaves the adapter

| Detail | Where it lives | Why it stays |
|---|---|---|
| Codex `jsonrpc` vs `exec` protocol | `runner/codex/CodexAppServerRunner.ts:159` | One adapter's compatibility fallback; nothing above the boundary asks. |
| Codex sandbox mode, approval policy, `network_access` pin | `runner/codex/settings.ts` | Documented trust posture. Explicitly **not** reconciled into a universal permission enum. |
| Claude Code `settingSources` / `permissionMode` gating | `runner/claudeCode/settings.ts:64,85` | Same — the other half of the posture that must not be flattened. |
| Codex `turn/interrupt` + kill fallback | `CodexAppServerRunner.ts:174` | Cancellation is already abstract at `AgentRunner.cancel`. |
| Claude Code `query.interrupt()` | `ClaudeCodeRunner.ts:264` | Same. |
| Claude Code result-to-turn routing | `ClaudeCodeRunner.ts:381` | An SDK-shaped ordering problem with no Codex analog. |
| Codex stderr tail + redaction | `CodexAppServerRunner.ts:659,674` | Adapter-authored text; the redaction rule is shared, the tail is not. |

## Verified leak sites

The plan's leak inventory, re-checked against `27ffe7f`. Where a location
differs from the plan's, the one here wins; a leak a phase has already retired
carries **no** location, because a stale pointer into refactored code is worse
than none.

| # | Leak | Current location | Retired by |
|---|---|---|---|
| 1 | Closed kind union + zod enums | — *retired; `registeredRunnerKinds` in `runner/registry.ts` is the admission list, and the `AgentRunnerKind` type, `agentRunnerKindSchema`, and the skills route's query schema all derive from it. The coding-event payload's `runnerKind` was opened in Phase 2 — it is a label, not an admission decision* | **Phase 3 — done** |
| 2 | Native activity kinds matched by string prefix | — *retired; canonical dispatch in `protocol/coding/events.ts`* | **Phase 2 — done** |
| 3 | Duplicated session-host scaffolding | — *retired; the lifecycle is now `runner/shared/PersistentRunnerSessionHost.ts`* | **Phase 1 — done** |
| 4 | Named metadata fields on shared contracts | — *retired at the boundary (`RunnerMetadata`) and on the session (`RunnerSessionMetadata`); the wire keeps `codex`/`claudeCode` only as shim-built projections until the contract floor passes 2* | **Phase 2 — done** |
| 5 | Prompt delivery decided by identity | — *retired; the assembler reads `promptDelivery`* | **Phase 3 — done** |
| 6 | Turn-diff strategy decided by identity | — *retired; the session service reads `turnDiffSource`* | **Phase 3 — done** |
| 7 | Workspace-skill availability decided by identity | — *retired; the skills route reads `workspaceSkillsAvailable()` and the derived kind schema* | **Phase 3 — done** |
| 8 | Flat per-runner config mirrored across backend and clients | `config/serviceConfig.ts`, `config/settingsStore.ts`, both Swift key enums | Phase 5 |
| 9 | Closed Swift enum driving UI selectors | `AgentRunnerKind.swift` + six production `allCases` sites | Phase 4 |
| 10 | Bespoke readiness switch | — *retired; `SetupReadiness` reads the bundled `RunnerBootstrapDescriptor` for the default runner, and a runner with no descriptor contributes no check* | **Phase 6 — done** |
| 11 | Session metadata extracted by native activity identity | — *retired; `runnerSessionMetadataFromActivity` keys on canonical `session_started`* | **Phase 2 — done** |
| 12 | Harness coding events stamped as Codex regardless of session | — *retired; both runner kinds covered by `visionosHarness.test.ts`* | **Phase 2 — done** |
| 13 | Tier-3 secrets and bootstrap policy hard-coded in Swift | — *retired; slots and probes are bundled `RunnerBootstrapDescriptor` data, `BackendSecretValues` keys them by runner and slot, the launch environment is those descriptors' allowlist, and `BackendLaunchConfiguration` no longer takes managed settings* | **Phase 6 — done** |
| 14 | visionOS transcript/activity identity depends on native kind | — *retired; both paths read `CodingAgentActivity.canonical` and the runner envelope* | **Phase 2 — done** |
| 15 | Swift coding-event type is a closed enum | — *retired; `CodingAgentEventType` and `CodingCanonicalActivityKind` are lossless `RawRepresentable` structs* | **Phase 2 — done** |

Two patterns in the tree were already the target shape and were copied rather
than reinvented: the per-kind record that used to live in
`workspace/WorkspaceExplorer.ts` (adding a runner is adding a row — it is now
two descriptor fields, and the compiler demands the row) and
`CodingAgentCapabilities` in `domain/models.ts`, an abstract shape each runner
maps *into* and both clients render without knowing the runner.

## What this matrix deliberately does not answer

- **Trust posture.** There is no universal `permissionPosture` field and there
  will not be one. Codex's sandbox/network pin and Claude Code's
  `settingSources` gate stay per-runner, documented under their own headings in
  `docs/safety/TRUST_AND_SAFETY.md`.
- **Filesystem and terminal capability for external adapters.** Decided in Phase
  0b/7 (advertised `false`), not here.
- **The runner-id representation in the settings file.** Decided in Phase 5's
  version-2 contract.
