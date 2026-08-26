# Universal Runner Boundary

Status: **complete** — Phases 0a and 1–6 landed 2026-08-16; Phase 0b and Phase 7
landed 2026-08-17. Written 2026-08-15 against `139213a`,
revised twice after backend, Swift, and ACP review; the second revision is dated
2026-08-16. See *Revision notes* at the end.

A plan to make adding a coding agent a *registration*, not a *port* — so a third
runner costs one adapter plus descriptors and, only when it introduces a new
Mac bootstrap primitive, one scoped bootstrap integration instead of edits
scattered through the backend, the macOS app, and the visionOS client.

## The problem, in numbers

`AgentRunner` (`apps/backend/src/runner/AgentRunner.ts:130`) is a four-required,
two-optional-method boundary (`getCapabilities`, `validateInputParts`, `run`,
`cancel`; optional `closeSession`, `dispose`). Everything above it — turn
lifecycle, prompt assembly, git diff tracking, attachments, artifacts, audit, the
event bus — is runner-agnostic. The cost of a third runner is not in that
machinery. It is in the places where a runner's *identity* is used where its
*capabilities* belong.

The config tax is sharpest: of the 19 managed settings keys, **11 are
runner-specific**. They are repeated across `config/serviceConfig.ts`,
`config/settingsStore.ts`, both clients' compiled
`ManagedBackendSettingKey.swift` enums, the Mac's typed
`ManagedBackendSettings`, and visionOS's presentation descriptor/catalog. The
key-enum copies are held in sync by
`apps/backend/test/managedSettingsParity.test.ts`. That test is doing exactly its
job — it is the symptom, not the disease.

## The constraint this plan is built around

**AG-UI is not a cautionary tale about abstraction; it is a cautionary tale about
flattening.**

`3cb4c6e` ("feat: add native Codex event rendering") deleted
`apps/shared/AgentRoomAGUI` and replaced the AG-UI projection with the native
`coding_*` protocol in `apps/backend/src/protocol/coding`. The bounded `codex` /
`claudeCode` metadata blocks exist *because* the vendor-neutral projection could
not carry what native Codex events actually said — thread ids, item ids, the
reasoning stream, multiple assistant items in one turn.

So the rule for every phase:

> Generalize the **dispatch**, never the **payload**. Any abstraction that makes
> a runner's native detail unreachable is a regression, no matter how much
> boilerplate it removes.

The corollary, learned the hard way in review: a canonical *tag* is not a
canonical *contract*. Tagging an event `plan_updated` while leaving the mapper to
dig plan steps out of vendor-shaped content just moves the conditional from
`runnerKind` to content inspection. Canonical means a **discriminated payload**
the adapter produces — see Phase 2.

## Non-goals

- Changing any runner's trust posture. Codex's sandbox mode and network-access
  pin, and Claude Code's permission mode and `settingSources` gating, are
  documented decisions in `docs/safety/TRUST_AND_SAFETY.md`. They are not
  reconciled into one abstract enum.
- Removing bespoke adapter code. Each runner still owns its protocol mapping.
  The goal is that the mapping is *all* it owns.
- Reintroducing AG-UI, or any second projection of the event stream.
- Eliminating runner-specific *presentation*. Buddy assets, badges, and icons are
  legitimately per-runner; the goal is a graceful default for unknown runners,
  not the removal of bespoke chrome.

## Revised goal statement

Not "zero Swift changes." Tier-3 bootstrap is deliberately Mac-owned and cannot
be made remote or managed without weakening the trust boundary. The honest
target is:

> **Zero runner-specific visionOS changes and zero runner-identity branches
> above the backend registry.** A runner that fits an existing trusted Mac
> bootstrap slot/probe kind needs only an adapter plus descriptor resources; a
> runner that introduces a genuinely new local prerequisite needs one scoped
> Mac bootstrap edit. **Bespoke presentation remains optional** — a buddy asset,
> custom badge, or native activity treatment is an enhancement, never a
> prerequisite for baseline operation.

Phase 7 pays the Mac bootstrap cost once for the generic ACP adapter. After
that, adding another ACP-speaking agent should be local tier-3 configuration,
not another Swift source change.

## Leak inventory

| # | Leak | Location | Phase |
|---|---|---|---|
| 1 | Closed kind union + zod enums | `domain/models.ts:392`, `domain/schemas.ts:4`, `protocol/coding/eventSchemas.ts:50` | 2–3 |
| 2 | Native activity kinds matched by string prefix | `protocol/coding/events.ts:216-395` | 2 |
| 3 | Duplicated session-host scaffolding (idle reap, resume, close) | `runner/codex/CodexAppServerRunner.ts:213-250`, `runner/claudeCode/ClaudeCodeRunner.ts:286-450` | 1 |
| 4 | Named metadata fields on shared contracts | `runner/AgentRunner.ts:61-62,91-92,99-100`; `domain/models.ts` session blocks; `protocol/coding/eventSchemas.ts:26-52` | 2 |
| 5 | Prompt delivery decided by identity | `agent/AgentTurnContextAssembler.ts:76` | 3 |
| 6 | **Turn-diff strategy decided by identity** | `agent/AgentSessionService.ts:381` | 3 |
| 7 | **Workspace-skill availability decided by identity** | `routes/workspaceRoutes.ts:83,237` | 3 |
| 8 | Flat per-runner config mirrored across backend and clients | `config/serviceConfig.ts:73-87`, `config/settingsStore.ts:60+`, both Swift key enums, `ManagedBackendSettings.swift`, `ManagedBackendSettingDescriptor.swift` | 5 |
| 9 | **Closed Swift enum driving UI selectors** | `AgentRunnerKind.swift:6`, six production `allCases` occurrences at `RunnerSettingsPane.swift:23`, `WorkspaceSceneControlsRow.swift:23,151`, `WorkspaceWindowView.swift:249`, `ManagedBackendSettingDescriptor.swift:33`, `AppStore+BackendSettings.swift:163`, plus source-text tests | 4 |
| 10 | Bespoke readiness switch | `apps/macos/.../SetupReadiness.swift:30-39` | 6 |
| 11 | Session metadata extracted by native activity identity | `protocol/coding/events.ts:397-419`, `agent/AgentTurnEventApplier.ts:126-133` | 2 |
| 12 | Harness coding events stamped as Codex regardless of session | `harness/visionosHarness.ts:223`, `routes/harnessRoutes.ts` | 2 |
| 13 | Tier-3 secrets, env stripping/injection, and Codex bootstrap policy hard-coded in Swift | `BackendSecretValues.swift:3-30`, `BackendRuntime.swift:8-76`, `RunnerSettingsPane.swift:141-156`, runner locator/status types | 6 |
| 14 | visionOS transcript and activity identity depend on native kind/metadata | `ThreadMessageStreamingState.swift:423-443`, `CodingAgentRendererState.swift:242-250,489-530`, `AgentRoomContracts.swift:1466-1476` | 2 |
| 15 | Swift coding-event type is a closed enum | `AgentRoomContracts.swift:1357-1376` | 2 |

Leaks 6, 7, and 9 were missed in the first draft; 11–15 were found in the
second review. 6 and 7 matter because they are **capabilities, not metadata**:
whether a runner reports its own turn diff, and whether a runner loads workspace
skills, are policy questions the registry must answer explicitly. 12 is also a
live correctness bug today: a Claude Code session's harness activity is
misattributed as Codex.

Two existing patterns are already the target shape:

- `WorkspaceExplorer.ts:78-83` keys skill directories and invocation prefixes off
  a per-kind record. Adding a runner is adding a row.
- `CodingAgentCapabilities` (`domain/models.ts:431`) is an abstract shape each
  runner maps *into*, which both clients render without knowing the runner.

---

## Phase 0 — Capability matrix and ACP spike

Before any refactor. Two deliverables, both cheap, both de-risking everything
after.

**0a. Capability matrix.** Enumerate every question the backend currently
answers by asking *who the runner is*, and decide the registry field that
replaces it.

> **Done.** Written up as [Runner Capability Matrix](RUNNER_CAPABILITY_MATRIX.md),
> verified against the tree on 2026-08-16. It widens the starting set below with
> the skill-source/prefix rows, session-metadata extraction, harness
> attribution, and discovery cost, and classifies every row as policy,
> presentation, or adapter-internal. It also moves `restoreStrategy` forward
> into Phase 1, which is the first consumer.

Starting set, from the leak inventory:

| Policy | Codex | Claude Code | Notes |
|---|---|---|---|
| `promptDelivery` | `turn` | `system` | Stable cached system prompt vs per-turn |
| `turnDiffSource` | `runner` | `settle_time_git` | Drives `AgentTurnGitDiffTracker` |
| `workspaceSkills` | `native` | `gated` | Gate is `CLAUDE_CODE_LOAD_WORKSPACE_SKILLS` under `bypassPermissions` |
| `resume` | `thread/resume` | SDK `resume` | Capability, not assumed |
| `imageParts` | `localImage` path | base64 block | Already handled by `validateInputParts` |
| `nativeActivityRendering` | yes | yes | Presentation hint; unknown runners degrade |

The matrix is the actual specification for Phases 2–5. Writing it first is what
prevents discovering leak #11 mid-refactor.

**0b. ACP spike.** Verified again on 2026-08-16: ACP has a stable v1
JSON-RPC-over-stdio protocol and an official TypeScript SDK
(`@agentclientprotocol/sdk` 1.3.0), plus Python, Rust, Kotlin, and Java. v2 is
still explicitly draft. It is mature enough to evaluate before inventing an
AgentRoom-specific protocol. Use the maintained
`@agentclientprotocol/codex-acp` as the reference agent, not the retired
`@zed-industries/codex-acp` package.

> **Done** (2026-08-17). A throwaway client in a scratch directory drove
> `@agentclientprotocol/codex-acp` 1.4.0 (pointed at a local codex through
> `CODEX_PATH`) and round-tripped prompts, a cancellation, and a restore. What it
> established, beyond confirming the four findings below:
>
> - **The preferred restore path is available.** The agent advertises
>   `agentCapabilities.sessionCapabilities.resume` **and** `loadSession: true`,
>   and `session/resume` succeeded — so production takes resume-first, exactly as
>   the v2-facing rule wanted, and `session/load` replay-suppression is the
>   fallback rather than the common case. One shape detail the adapter must not
>   get wrong: `loadSession` is a **boolean** while `sessionCapabilities.resume`
>   is an **object** (`{}`), so a capability check has to be truthiness, never
>   `=== true`.
> - **Declining fs and terminal is honored.** With
>   `clientCapabilities.fs.{readTextFile,writeTextFile}: false` and
>   `terminal: false`, the agent issued **no client request at all** across a
>   shell command, a file write, and a cancellation. The bounded PUT stays the
>   only workspace write.
> - **The permission path is not reachable through this agent**, which is a
>   finding rather than a gap: no `session/request_permission` arrived even under
>   an isolated `CODEX_HOME` with `approval_policy = "untrusted"` and
>   `sandbox_mode = "read-only"` — codex-acp resolves approvals inside itself.
>   The conservative responder must still exist (the protocol has the method and
>   other agents will use it), but it cannot be regression-tested against this
>   reference agent, so its coverage belongs to a **synthetic agent fixture** in
>   the backend suite. That is the better vehicle regardless: deterministic, and
>   it needs neither network nor a provider credential in CI.
> - **The update vocabulary maps cleanly onto the Phase 2 canonical union**, with
>   no flattening: `tool_call`/`tool_call_update` carry a stable `toolCallId`
>   plus `status`/`kind`/`title`/`rawOutput` (→ `tool_started`/`tool_output`/
>   `tool_completed`, `toolId` being the correlation id the union already wants),
>   `agent_message_chunk` → assistant deltas, `agent_thought_chunk` →
>   `reasoning`, and `usage_update` carries `used`/`size`, which are exactly
>   `contextWindowUsedTokens` and `modelContextWindowTokens`. `session/cancel`
>   settles the in-flight `session/prompt` with `stopReason: "cancelled"`, so
>   cancellation needs no out-of-band bookkeeping. Native extras arrive under
>   `_meta.codex`, which is the bounded `native` blob's content.
> - **The SDK is not the right vehicle for this backend**, and the spike is what
>   settles it. `@agentclientprotocol/sdk` is **ESM-only** (`"type": "module"`,
>   `import`-only export conditions) while `apps/backend` compiles to
>   **CommonJS**, so consuming it means a dynamic-`import()` escape hatch that
>   `module: CommonJS` actively downlevels into `require`. Against that: this
>   phase *mandates* frame-size, nesting-depth, and output-volume caps the SDK's
>   `ndJsonStream` does not provide, external input must be zod-validated on
>   receipt regardless of what the SDK already parsed, and the spike's own
>   hand-rolled NDJSON client — the same shape as the existing
>   `runner/shared/JsonRpcLineClient.ts` — drove the real agent through every one
>   of these flows in about 150 lines. So the production adapter speaks ACP v1
>   directly and takes **no new runtime dependency**; the SDK's published
>   `schema/schema.json` stays the conformance reference. The plan's "preferred
>   vehicle" was the SDK, and this is a deliberate departure from it, recorded
>   here rather than discovered later.

Four findings that shape the design:

- **Stable v1 has two restore paths.** Prefer `session/resume` when the agent
  advertises `sessionCapabilities.resume`; it restores without replay. Fall back
  to `session/load` when `loadSession` is advertised; it replays history through
  `session/update`, which the adapter must consume without duplicating
  AgentRoom's existing transcript. The v2 draft removes `session/load` and folds
  replay into `session/resume`, so resume-first is also the forward path.
- **Production adapters must be restorable.** AgentRoom's documented behavior is
  reap-and-resume, including after a child crash and backend restart. A runner
  supporting neither stable-v1 restore path is not admitted as a production
  persistent runner in Phase 7; it may participate in the Phase 0 spike only.
  The host never reaps a child it cannot restore and never silently starts a
  fresh conversation under the same AgentRoom session id.
- **The filesystem capability posture has a clean answer.** ACP's
  `fs/read_text_file` / `fs/write_text_file` take **absolute paths**, carry **no
  optimistic-lock or conflict-detection mechanism**, and mandate create-on-write
  — all three incompatible with AgentRoom's workspace-relative, `baseModifiedAt`,
  parent-must-exist bounded PUT. But these are **client-advertised capabilities**
  checked in the `initialize` response, so AgentRoom simply advertises
  `fs.readTextFile: false` and `fs.writeTextFile: false`, and a conforming agent
  must not call them. Terminal support is likewise optional and is declined for
  the same reason. The v2 draft removes both client capabilities, so declining
  them is also future-facing. Re-advertising either is a separate, later
  decision requiring a `TRUST_AND_SAFETY.md` change, not a v1 default.
- **Permission requests need an answer.** `session/request_permission` is a
  client method, while AgentRoom's current `coding_permission_*` events are
  display-only and there is no permission-answer route. The Phase 0 spike
  auto-rejects by selecting a provided `reject_once` option (or cancels if none
  exists). Phase 7 keeps that conservative default. An operator-selectable
  auto-allow policy is a per-adapter tier-2 trust setting behind
  `REMOTE_SETTINGS_ADMIN`, documented as a `bypassPermissions`-class posture;
  interactive answers require a separate route/UI design and are not smuggled
  into the adapter phase.

**Done when:** the matrix is written; a throwaway ACP client connects to the
official Codex ACP adapter and round-trips a prompt; the spike records whether
`session/resume` or `session/load` is available; a permission request receives
the declared conservative response; and fs/terminal are verified absent from
the advertised client capabilities. No production code.

---

## Phase 1 — Shared session host

> **Done** (2026-08-16). `runner/shared/PersistentRunnerSessionHost.ts`, with
> both adapters routed through it and
> `apps/backend/test/persistentRunnerSessionHost.test.ts` covering the reap,
> restore, and identity rules. All 38 existing runner tests passed unchanged.
> One incidental correctness fix rode along: the Codex child's `close`/`error`
> handlers deleted their session from the registry **by key rather than by
> identity**, so a late handler from a replaced child could evict the session
> that took its place. The host's `release`/`destroy` are identity-checked.
> The unified idle-reap log line is now `"Runner session idle-reaped"` carrying
> `runnerKind`, replacing the two per-runner messages.

Pure deduplication, no contract change. Extract the persistent-child lifecycle
both runners duplicate — `armIdleTimer`, `destroySession`, `closeSession`,
resumable-id bookkeeping, the 30-minute idle window — into a
`PersistentRunnerSessionHost`. Adapters supply spawn, restore, and teardown,
and declare a concrete restore strategy rather than a boolean:
`native_resume`, `history_replay`, or `unsupported`.

Keeps the reap-and-resume semantics documented in
`docs/safety/TRUST_AND_SAFETY.md` in one place instead of two.

The host arms the idle timer only for `native_resume` or `history_replay`.
`unsupported` is explicit and never silently loses a conversation; it is useful
for tests/spikes but is rejected by the production external-adapter admission
rule in Phase 7. Codex and Claude Code retain their current native resume paths,
so this phase changes no shipped lifecycle behavior.

**Verify:** `pnpm typecheck`, backend build, `pnpm test` — all existing runner
tests pass unchanged.

---

## Phase 2 — Canonical event union

> **Done** (2026-08-16). `CanonicalActivity` and `RunnerMetadata` are declared
> at the `AgentRunner` boundary; both adapters produce them; the core mapper
> (`protocol/coding/events.ts`) dispatches on `activity.canonical.kind` and
> makes **no behavioral decision from a runner name**. The legacy `codex`/
> `claudeCode` blocks — on payloads, on activities, and on the session DTO —
> are now projections rebuilt by two bounded shims
> (`protocol/coding/legacyMetadata.ts`, `protocol/coding/legacySessionMetadata.ts`),
> the only files in the mapper allowed to spell a runner's name.
> `apps/backend/test/canonicalCodingEvents.test.ts` drives a synthetic third
> runner (`acp_demo`) through every canonical kind with no mapper change, and
> two visionOS suites render and correlate that runner's reasoning and tool
> activity with no native-kind case. Codex's unified-diff parser and plan-step
> extraction moved into the adapter that owns them
> (`runner/codex/diffSummary.ts`), and the harness attribution bug (leak 12) is
> fixed: `VisionOSHarness` now *requires* a runner resolver and a default,
> because a fixed fallback is what produced the bug.
>
> Three implementation decisions differ from the sketch below, each deliberate:
>
> - **`runnerKind` is not repeated inside `RunnerMetadata`.** The envelope is
>   always attached to a payload that already names the runner, and inside an
>   activity block that payload is one level up. A second copy is two fields
>   that can disagree.
> - **The canonical activity is a payload union at the boundary and a bounded
>   flat block on the wire.** Swift models only `kind`, `toolId`, and `delta` —
>   the three fields that can reach an activity block, since plan and diff
>   canonical activities map to payloads that carry no activity at all.
> - **The event payload's `runnerKind` was relaxed to a bounded string.** It is
>   a label, not an admission decision: a session pins a validated runner kind
>   at creation, and `agentRunnerKindSchema` stays closed until Phase 3. Without
>   this a third adapter's events could not reach the mapper at all, so the
>   Phase 2 acceptance test could not exist. This exposes no third runner id —
>   nothing can create a session with one.
>
> The compatibility floor is `CODING_EVENT_CONTRACT_VERSION = 2`, advertised by
> `GET /api/config` as `codingEventContractVersion` and read by the Swift
> `PublicServiceConfig`. Dual emission continues until the floor moves past 2;
> retiring it means deleting the two shim files and the schema fields they fill.
> Residual question 1 (the concrete retirement signal) is still open.

The heart of the plan, and the part the first draft got wrong.

**Not** a tag alongside vendor-shaped content. A **discriminated canonical
payload** each adapter produces:

```ts
type CanonicalActivity =
  | { kind: "plan_updated"; steps: PlanStep[] }
  | { kind: "diff_updated"; files: DiffFile[]; truncated?: boolean }
  | { kind: "tool_started"; toolId: string; title: string; description?: string }
  | { kind: "permission_requested"; requestId: string; title: string }
  | { kind: "reasoning"; delta: string }
  // …
```

Each adapter owns native → canonical mapping. `protocol/coding/events.ts`
consumes the union and stops knowing anything about Codex or Claude shapes. This
is what actually removes the conditionals, rather than relocating them into
content inspection.

**The metadata envelope, typed.** `Record<string, JsonValue>` was also
underspecified — clients would still need native string keys to correlate and
would lose fields the current Swift renderer actually reads. The envelope
carries **named canonical correlation and display fields** plus a bounded native
blob:

```ts
interface RunnerMetadata {
  runnerKind: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  model?: string;
  cwd?: string;
  posture?: { label: string; value: string };
  sandbox?: JsonValue;
  native?: JsonObject;   // bounded: see limits
  nativeTruncated?: boolean;
}
```

The existing `version: 1` on every `coding_*` payload is the envelope version;
do not add a competing `envelopeVersion`. `posture` is display metadata, not a
universal permission enum: adapters supply the runner's own label/value, so
Codex approval policy and Claude permission mode remain distinct. The native
blob preserves richer detail but is never required for baseline correlation or
rendering.

Limits are explicit and enforced on construction: max serialized bytes, max
nesting depth, max key count, max string length. Over-limit truncates the
`native` blob and sets a flag — never the canonical fields, and never silently.

**Compatibility.** "The apps ship together" is not sufficient — an independently
upgraded headset can meet an older backend and vice versa. Define an explicit
**API compatibility floor**: the backend advertises a contract version, clients
declare the minimum they accept, and dual-emission of legacy `codex`/`claudeCode`
fields continues until the floor moves past them. This mirrors the existing
`?legacyTurnEvents=false` precedent.

Legacy blocks are built by a bounded compatibility shim. The core mapper's done
condition is **no behavioral branch on a runner name**, not the impossible
claim that no compatibility code may spell `codex` or `claudeCode` while those
blocks are still emitted.

The canonical activity discriminator must reach the shared Swift DTO. Native
kind strings remain in `metadata.native`; neither
`ThreadMessageStreamingState` nor `CodingAgentRendererState` may need a
`codex_*`/`claude_code_*` allowlist to decide whether a tool or reasoning update
exists. `CodingAgentActivity.id` keys first on `nativeItemId`/canonical tool id,
not Codex metadata. `CodingAgentEventType` becomes a lossless string-backed type
or gains an explicit unknown representation so a newer backend event does not
make an older client fail the whole event decode.

The harness must resolve the supplied `sessionId` and emit that session's real
runner id; it may not stamp `runnerKind: "codex"`.

**Done when:** the core mapper contains no runner-identity behavior; a synthetic
third adapter produces correct `coding_*` events without modifying it; and both
Swift rendering paths display and correlate that adapter's tool and reasoning
activity with no native-kind case added. Legacy metadata is emitted only by the
compatibility shim.

**Verify:** backend suite; shared-DTO decode tests; both apps regenerated and
built; synthetic unknown-runner decode/render tests in both
`CodingAgentRendererStateTests` and transcript streaming tests; Codex reasoning
and Claude tool activity continue to render identically in the visionOS
transcript; harness tests cover both current runner kinds.

---

## Phase 3 — Runner registry and policy resolution

> **Done** (2026-08-16). `runner/registry.ts` holds a `RunnerDescriptor` per
> runner — `promptDelivery`, `turnDiffSource`, `workspaceSkills`,
> `skillSourceDirs`, `skillInvocationPrefix`, `restoreStrategy`, `isConfigured`,
> plus the presentation-only `displayName` — and `registeredRunnerKinds` is the
> admission list the `AgentRunnerKind` domain type and `agentRunnerKindSchema`
> both derive from. Leaks 5, 6, and 7 are retired at their cited lines:
> `AgentTurnContextAssembler` reads `promptDelivery`, `AgentSessionService` reads
> `turnDiffSource`, and `workspaceRoutes` reads `workspaceSkillsAvailable()` plus
> the derived kind schema. The two per-kind records at
> `WorkspaceExplorer.ts:77-84` became descriptor fields, and both adapters now
> take `restoreStrategy` from their descriptor instead of a local constant, which
> is the handoff the capability matrix noted for `restoreStrategy` when Phase 1
> landed it early.
>
> Three implementation decisions differ from the sketch below, each deliberate:
>
> - **`workspaceSkills` is a discriminated union, not a tag plus an optional
>   predicate.** `{ mode: "gated"; gate }` makes the compiler require the gate on
>   the branch that needs one, so "gated with no gate" — which would have to
>   default closed and could not be tested — cannot be registered at all. The
>   gate still calls through to `runner/claudeCode/settings.ts`; the registry
>   names *that* a gate exists and never restates what it is.
> - **Two Claude Code defaults moved to a new `domain/runnerDefaults.ts` leaf.**
>   `domain/schemas.ts` is now downstream of the registry, and the registry
>   reaches into the Claude Code adapter for the gate, which needs those
>   defaults — leaving them in `schemas.ts` would close a require cycle whose
>   initialization order decides whether a documented default is `undefined` at
>   module load. A module with no runtime imports cannot participate in a cycle.
>   `domain/schemas.ts` re-exports both, so no import site changed.
> - **The acceptance criterion is enforced, not asserted in prose.**
>   `apps/backend/test/runnerRegistry.test.ts` scans every backend `.ts` source
>   for an equality test or `switch` case against a runner-kind literal outside
>   `runner/` and the two Phase 2 legacy shims, and fails on one. The same suite
>   pins the rollout gate: `registeredRunnerKinds` must remain exactly `codex`
>   and `claude_code` until Phase 4 opens it.
>
> The four states are named and resolved (`runnerAvailability()`), but only
> three of them: `registered`, `configured`, and `enabled`. `ready` is the
> adapter's runtime probe and belongs to Phase 6, and `enabled` is constant-true
> until Phase 5's version-2 settings document adds a per-runner switch. Nothing
> renders any of them yet — Phase 4's `/api/runners` is what reports them, and
> the rollout gate below is why that is not this phase's job.
>
> Two-stage startup is real but currently shallow: stage 1 is the built-in
> descriptor table, built at module import, and stage 2 is
> `config/serviceConfig.ts` parsing managed settings against the schema derived
> from it. There is no tier-3 runner configuration to read in stage 1 yet;
> Phase 7 is the phase that introduces an executable path.

Introduce `runner/registry.ts` holding a `RunnerDescriptor` per runner: id,
display name, skill directories, invocation prefix, and **every policy from the
Phase 0 matrix**. `AgentRunnerKind` becomes a registered id;
`agentRunnerKindSchema` derives from the registry.

Then retire leaks 5, 6, and 7 by routing through policy:
`AgentTurnContextAssembler.ts:76` reads `promptDelivery`;
`AgentSessionService.ts:381` reads `turnDiffSource`; `workspaceRoutes.ts:237`
reads `workspaceSkills`.

**Bootstrap ordering is a real cycle and needs an explicit answer.** External
adapter definitions are tier-3 configuration, but validating the managed
`runnerKind` key requires knowing the registry. Resolve with **two-stage
startup**: stage 1 reads tier-3 environment configuration and builds the
registry; stage 2 loads managed settings and validates against it. Four distinct
states, named and reported separately:

- **registered** — the backend knows this runner id exists.
- **configured** — it has the settings it needs.
- **ready** — its readiness probe passes (Phase 6).
- **enabled** — the operator has turned it on.

A runner can be registered but not configured, or configured but not ready. The
UI needs all four; collapsing them produces the "ready in the UI, unusable by the
backend" failure Codex flagged.

**Rollout gate.** The internal registry and policy refactor may land before the
clients change, but it must not expose, select, or write a third runner id yet.
An older Mac rejects `runnerKind` outside `codex`/`claude_code`, drops the whole
file from its effective view, and coerces the displayed/default runner to Codex.
Phase 4 therefore gates the first third runner id crossing `/api/runners`,
`/api/config`, or `settings.json`; it does not block the runner-internal
deduplication in this phase.

> **Opened 2026-08-18 for `deepseek`**
> (`docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`). What the gate was protecting
> narrowed once Phases 4 and 5 landed: an unknown `runners.<id>` namespace is now
> preserved-but-never-applied by both readers, so a bundled runner's *settings*
> are safe on an older build. What remains is `global.runnerKind`, a **known**
> key whose malformed value still makes the whole file unusable — so selecting a
> bundled runner an older AgentRoom does not know drops that operator's trust
> posture onto defaults on a **downgrade**. That is the documented cost of
> opening it; the whole-file rule itself does not move.
>
> The guard is the Mac's version-1 rollback converter, and it **refuses** rather
> than converts: `ManagedSettingsFileStore.writeLegacyDocument` throws when
> `runnerKind` is outside the two ids every flat-document reader shipped
> knowing, and the Advanced pane disables the button and names the runner first.
> Refusing is the point — rewriting `runnerKind` to something convertible would
> move the operator's turns onto a different agent to save a file format. See
> `docs/clients/MACOS.md` and `docs/operations/LOCAL_MAC_SERVER.md`.
>
> **Opened 2026-08-26 for `cursor`** (`docs/engineering/CURSOR_SDK_RUNNER.md`).
> Same basis and same cost as `deepseek`: `global.runnerKind: "cursor"` is a
> known key with a value an older build rejects, so a downgrade with Cursor
> selected drops that operator's trust posture onto defaults. The guard is the
> one already in place: `ManagedSettingsDocument.legacyDocumentRunnerKinds`
> describes shipped flat-document readers and never grows, so the Mac's
> rollback converter refuses while `runnerKind` names `cursor`. Nothing new was
> built to open this one; the id, its descriptor row, and a skeleton adapter
> landed together, with the host child following.

**Acceptance criterion, corrected.** Not "no file outside `runner/` names a
runner" — that is too absolute, since presentation assets legitimately do.
Instead: **no file outside `runner/` and the registry makes a *behavioral*
decision from runner identity.** Presentation may; policy may not.

---

## Phase 4 — Compatibility bridge and client descriptor catalog

> **Done** (2026-08-16). Both strict settings readers recognize, preserve, and
> refuse to write the reserved `schemaVersion`/`global`/`runners` shape;
> `GET /api/runners` serves the safe/public descriptor projection; and both
> clients render their runner pickers from a hydrated `RunnerCatalog` instead of
> `AgentRunnerKind.allCases`, which no longer exists. Leak 9 is retired at all
> six production sites and both source-text tests, and the Mac no longer coerces
> an unknown runner id to Codex anywhere — including setup readiness, which now
> runs *no* bootstrap check for a runner it does not recognize rather than
> Codex's. `AGENTS.md` and `docs/safety/TRUST_AND_SAFETY.md` carry the
> preservation rule, as this phase required.
>
> Five implementation decisions differ from the sketch below, each deliberate:
>
> - **The version-2 address of a managed key is derived from the registry, not
>   tabulated in `config/`.** Validating a version-2 document's known paths needs
>   to know that `codexSandboxMode` is `runners.codex.sandboxMode`. A table in
>   the settings store would have been a second admission list to maintain — the
>   exact leak this plan retires — so `RunnerDescriptor` gained
>   `settingsKeyPrefix` and `managedSettingScope()` resolves the address from it.
>   The settings layer therefore still contains no runner literal, and the Phase 3
>   acceptance scan stays green without an exemption.
> - **A version-2 file is recognized *and* not applied, which is a third state.**
>   "Known but not active" cannot mean "quietly run on defaults with no
>   explanation": some defaults are more permissive than what the operator wrote
>   (`claudeCodePermissionMode`), so the file is dropped exactly like an unusable
>   one — and reported as `unsupportedSchemaVersion` beside the issue, because the
>   repairs differ. A newer file is fixed by updating AgentRoom; resetting it, the
>   fix for a broken file, would destroy a posture the operator did author. The
>   Mac's reset refuses outright on that state, and otherwise clears only the keys
>   its own schema owns.
> - **The Mac validates version-2 structure, not version-2 values.** Both readers
>   preserve and distinguish, but only the backend validates the known paths
>   against per-key schemas. Mirroring that validation on the Mac would put a
>   third copy of every managed key's constraints in the client that is furthest
>   from applying them; the backend stays the authority for a document it is the
>   only one to apply.
> - **`AgentRunnerKind` lost `CaseIterable` rather than gaining a warning.** The
>   enum survives for bespoke presentation, but withholding the conformance makes
>   an `allCases` picker a compile error instead of a convention, and
>   `managedSettingsParity.test.ts` fails the build if the conformance returns.
> - **The offline floor is identity-only.** `RunnerCatalog.builtIn` carries
>   `runnerKind` and `displayName`; `registered`/`configured`/`enabled` stay `nil`
>   there. A bundled list that answered them would be exactly the "ready in the UI,
>   unusable by the backend" failure this plan names. Phase 5 makes that floor
>   versioned and build-time; this is its seed.
>   The Mac still uses that full floor while stopped. visionOS uses the narrower
>   `RunnerCatalog.legacyBackendFallback` when the route is absent or unreadable:
>   only runners predating the route are safe to offer without live availability
>   metadata, so later additions do not silently widen an older backend.
>
> One correctness fix rode along, found by the acceptance test rather than by
> review: the visionOS catalog was cleared only when a *config* read had
> previously succeeded, so a connect where `/api/config` failed and
> `/api/runners` succeeded could leave one backend's runners in a picker aimed at
> another. The catalog now tracks its own source connection
> (`runnerCatalogClient`) and is invalidated against that.

This is the **reader-first compatibility release**. It changes readers and
clients while every writer still emits the legacy flat settings shape. No new
runner id or version-2 settings document may be emitted until this release is
the advertised compatibility floor.

**Both settings readers become future-shape aware before either writer uses the
shape.** The backend reader and the Mac's `ManagedSettingsFileStore` must:

- recognize the reserved `schemaVersion`, `global`, and `runners` top-level
  fields that Phase 5 will use;
- preserve those sections value-for-value through any legacy-key update instead
  of decoding into a struct and dropping what it does not render;
- distinguish "known but not active yet" version-2 structure from a malformed
  trust file; and
- refuse to *write* version 2 in this phase.

This does not make arbitrary unknown settings effective. Known version-2 paths
are validated against the descriptor/schema; unrecognized data is preserved but
not applied, and a malformed known trust value still makes the file unusable as
it does today. `AGENTS.md` and `TRUST_AND_SAFETY.md` must be updated with the
exact preservation rule when this lands, because it deliberately changes the
current strict whole-file seam.

The Mac's reset action becomes schema-aware before version 2 exists: it clears
the settings values the selected schema owns and never blindly writes `{}` over
a future `runners` section. A downgrade is not magic — a genuinely old backend
cannot be taught to read a future file — so the Mac also needs the Phase 5
legacy-export/rollback serializer before the version-2 writer is enabled.

**Descriptor-backed clients.** Wire DTOs already carry `runnerKind` as `String`;
the problem is enum-typed selectors and switches. Replace `AgentRunnerKind` as
the source of available choices with a descriptor-backed string-id catalog.
All six production `AgentRunnerKind.allCases` occurrences and the two
source-text tests read the catalog instead. Built-in presentation may still map
known ids to bespoke assets, but it is not the data source.

Unknown runners have defined fallbacks: a generic icon, the descriptor's display
name, the Phase 2 generic activity renderer, and no buddy asset. A runner with no
bespoke chrome must look deliberate, not broken. The Mac must display an unknown
but descriptor-backed id as itself; it must never coerce it to Codex for setup
readiness.

`/api/runners` is additive and serves the safe/public descriptor projection.
visionOS hydrates from it while connected. The Mac uses it when the backend is
running and the bundled offline floor from Phase 5 when it is not.

**Done when:** current backend and Mac readers can open, preserve, and safely
round-trip the not-yet-written version-2 fixture; both clients render a synthetic
third descriptor; and every writer still emits legacy settings only. This phase
gates both Phase 5 and the first externally visible third runner id.

---

## Phase 5 — Versioned, offline-capable settings

> **Done** (2026-08-16). The version-2 document is the shape both writers emit
> and both readers apply; version 1 is still read and migrated whole by the next
> write; and the reverse serializer is a real, offered action rather than a note.
> Leak 8 is retired at its source: each `RunnerDescriptor` now declares the
> managed settings it owns (`field`, `schema`, `tier`, `env`, `valueKind`,
> `defaultValue`), `config/settingsStore.ts` assembles the global declarations
> and every descriptor's into one table, and the settings schema, the env-name
> table, the tier table, the defaults map, and the `serviceConfig` field mapping
> are all derived from it. A registered runner's settings therefore reach the
> file, `GET /api/config`, `PATCH /api/config`, and environment resolution
> because the registry registered them.
>
> Six implementation decisions differ from the sketch below, each deliberate:
>
> - **The metadata block reports every setting at *both* addresses, and
>   `settingsSchemaVersion` says which is canonical.** The sketch had
>   `/api/config.settings` keyed by canonical paths alone, which would have blanked
>   the surface of any headset that predates them — a client and a backend upgrade
>   independently. Dual emission is the same shape Phase 2 used for the legacy
>   `codex`/`claudeCode` blocks, and it retires the same way: with the advertised
>   floor. `PATCH` accepts either address and refuses a body that names one setting
>   at both, since assigning precedence would apply a value the caller did not send.
> - **Canonical is key-sorted bytes, not declaration order.** "Both writers produce
>   the same shape" is worth little if the same settings produce different bytes
>   from the Mac and the backend, and Swift's encoder can only promise sorted keys.
>   Sorting at every level on both sides makes it the same file.
> - **A version-1 document's `global`/`runners` sections do not survive the
>   migration at a *known* address.** Those sections were never applied — the flat
>   key is what the backend resolved — so carrying one forward would silently
>   activate a trust value the running backend had been ignoring. Unknown addresses
>   are preserved; known ones are dropped.
> - **`ServiceConfig` grew `settingsValues` rather than a field per setting.** The
>   metadata projection used to read the running value from the same-named
>   `ServiceConfig` field, which meant a runner could not register a setting
>   without `domain/models.ts` growing a field for it. The resolved values now ride
>   the startup snapshot; the named fields survive for the two adapters that read
>   them.
> - **The offline floor is a backend-written override plus the bundle.**
>   `$AGENTROOM_HOME/config/runners.json` carries the same safe/public projection
>   `GET /api/runners` serves; the Mac prefers it and falls back to
>   `RunnerCatalog.builtIn` for an absent, unreadable, empty, or newer-versioned
>   file. It is a cache — the backend never reads it.
> - **The rollback is a control, not a procedure.** The Mac's Advanced pane offers
>   "Convert settings for an older AgentRoom", which writes the flat document
>   (no `schemaVersion` field, since an absent version *is* version 1) through the
>   same validation and atomic publish. A current AgentRoom converts it forward
>   again on the next change.
>
> Residual question 3 (cross-process settings contention) is unchanged: it stays
> last-write-wins between the Mac and the backend.
>
> **What is deliberately still ahead.** Leak 8 is retired on the backend, and the
> clients' *addressing* is now derived from one small prefix→id table each. What
> remains is presentation: visionOS renders managed settings through a hand-written
> `ManagedBackendSettingDescriptor` catalog (titles, sections, control shapes), and
> the Mac holds a typed field per setting, so a **third** runner's settings would
> be readable and patchable over the API while remaining unrendered in the headset
> and untyped on the Mac. Both are per-setting *presentation*, which the plan's
> acceptance criterion permits — but "a runner registers and its settings appear
> everywhere" is not true of the headset until a metadata entry with no catalog
> descriptor renders generically from its tier and value type. It is a client
> change with no backend or contract implication. Phase 7 did **not** take it on —
> it arrived there as a concrete gap rather than a hypothetical one, since a
> configured ACP adapter's tier-2 `permissionPolicy` is exactly such a setting —
> so it is Phase 1 of
> [Registered Runner Completeness](REGISTERED_RUNNER_COMPLETENESS.md).

This is the phase with a hard blocker the first draft missed.

**The blocker.** The Mac app deliberately edits `settings.json` while the backend
is stopped (`ManagedSettingsFileStore.swift:6-14` — "the panes have to work while
the backend is stopped, which is exactly when an operator is fixing why it would
not start"). So settings **cannot** render from a live `/api/runners` alone.

Worse than "it rejects unknown keys": `backendSchemaShapeIssue`
(`ManagedSettingsFileStore.swift:115-129`) preflights the **whole file** and
declares it malformed on *any* unrecognized top-level key. Adding a `runners: {}`
section would not be ignored by an older Mac app — it would break settings
loading entirely.

The backend reader is equally strict: `managedSettingsSchema.strict()` rejects
the same future fields, `parseManagedSettingsText` drops the whole file to
conservative defaults, and PATCH refuses to merge into it. Compatibility is
therefore bilateral, not merely a Mac preflight problem.

**Consequences, all mandatory:**

1. **Ordering.** Both tolerant readers and the descriptor-backed clients ship
   while writers remain legacy. Phase 4 gates Phase 5; this is not negotiable.
2. **Build-time offline floor.** The Mac bundles a versioned safe/public runner
   descriptor floor. A backend that starts successfully may atomically write a
   safe/public override beside `settings.json`; the Mac prefers a compatible
   override and falls back to its bundle. `/api/runners` serves the backend's
   effective document. The override is not the floor: the offline case includes
   "this backend has never started."
3. **Tier-3 separation.** The safe/public descriptor contains no executable
   path, environment name, Keychain account, or secret-slot value. The Mac's
   trusted bootstrap descriptors are a separate bundled/local tier-3 surface in
   Phase 6 and are never accepted from `/api/runners` or the backend-written
   override.

**The version-2 settings contract is decided here, not left to implementation.**
The file shape is:

```json
{
  "schemaVersion": 2,
  "global": {
    "runnerKind": "codex",
    "artifactsEnabled": true,
    "terminalEnabled": false
  },
  "runners": {
    "codex": {
      "model": "gpt-example",
      "approvalPolicy": "never",
      "sandboxMode": "workspace-write",
      "workspaceNetworkAccess": false
    },
    "claude_code": {
      "model": "claude-example",
      "permissionMode": "bypassPermissions",
      "loadWorkspaceSkills": true
    }
  }
}
```

The omitted existing global and runner fields follow the same grouping. Tier is
descriptor/schema metadata, never data in the file. Rules:

- `schemaVersion` absent means the existing strict legacy-flat v1 shape.
  `schemaVersion: 2` means the nested shape; a v2 document containing legacy
  top-level managed keys is rejected rather than assigned ambiguous precedence.
- The first enabled v2 write atomically migrates the **whole** valid v1 file;
  there is no prolonged dual-shape state. The converter is pure and has a
  reverse serializer. Before launching a backend below the compatibility floor,
  the Mac offers "Write legacy settings" and converts the current effective v2
  values back to v1.
- PATCH remains a partial map, but its canonical keys are dotted paths such as
  `global.runnerKind`, `runners.codex.model`, and
  `runners.claude_code.permissionMode`. `null` still clears a value. During the
  compatibility window the backend also accepts legacy flat patch keys and maps
  them to canonical paths; new clients choose the path set advertised by
  `/api/config`.
- `/api/config.settings` stays a map keyed by those canonical paths, preserving
  the existing `value`/`source`/`tier`/`editable`/`requiresRestart`/
  `pendingValue` metadata. `config_reloaded.changedKeys` uses the same dotted
  paths and still carries names only.
- Environment variables still win and lock their corresponding canonical path;
  else v2 file; else default. There is no v2-vs-v1 precedence because one file
  has exactly one schema.
- Unknown runner namespaces and fields are preserved for forward compatibility
  but are not applied unless a compatible descriptor declares and validates
  them. A malformed value for a declared trust key still invalidates the file;
  preserving an unknown future namespace must never partially apply a known bad
  trust posture.
- The flat `/api/config` fields remain as a compatibility shim until the API
  floor removes them. The current Swift `PublicServiceConfig` consumes only
  `runnerKind`, auth, terminal/scene flags, settings metadata, and remote-admin
  state, but other API consumers may rely on the runner-specific flat fields;
  removal follows the advertised floor, not an assumption about the bundled
  apps.

**Tier discipline is preserved.** Tier 3 stays absent by construction: the
descriptor names *which* keys exist and their tier, never `CODEX_EXECUTABLE`,
`CLAUDE_CODE_EXECUTABLE`, or any secret. Tier 2 runner keys stay gated by
`REMOTE_SETTINGS_ADMIN`. `GET /api/config` stays ungated and non-secret for the
same reason it is today.

**Trust posture stays per-runner.** A universal `permissionPosture` enum would
flatten Codex's network-access pin and Claude Code's `settingSources` gate into a
lossy common denominator — the payload-flattening mistake in the place it would
do real damage. `docs/safety/TRUST_AND_SAFETY.md` gains a per-runner posture
section; each runner's existing text moves under its own heading unchanged.

`runnerKind` remains a tier-1 managed global key whose value must name a
registered and enabled runner. Capability/model discovery stays lazy and cached
per runner; N descriptors must not spawn N discovery probes at startup.

**Done when:** a valid v1 file migrates byte-deterministically to v2; both
writers produce the same canonical v2 shape; reverse serialization produces a
legacy file the pre-floor backend accepts; old patch keys and flat config reads
work for the declared window; unknown undeclared runner namespaces survive a
Mac and backend round trip without becoming effective; and every tier-2 gate,
env lock, unusable-file response, and values-free change event retains its
current safety behavior.

---

## Phase 6 — Split readiness

> **Done** (2026-08-16). The two authorities are named, resolved, and reported
> separately: `ready` on `GET /api/runners` is the backend's
> (`runner/runtimeReadiness.ts`), and the Mac's is answered from a bundled
> `RunnerBootstrapDescriptor` per runner. Leaks 10 and 13 are retired —
> `SetupReadiness` has no runner switch, `BackendSecretValues` holds slots keyed
> by runner and slot id instead of typed per-runner fields, the launch
> environment is the descriptors' own allowlist, and diagnostics and redaction
> iterate what is stored rather than a hand-listed set of fields.
>
> Six implementation decisions differ from the sketch below, each deliberate:
>
> - **The runtime probe is the capability discovery the backend already
>   performs.** `getCapabilities` spawns the child, handshakes, and reads the
>   model list, so a second probe method would spawn a second child to learn what
>   the first established. Readiness is therefore *observed* rather than asked
>   for: `GET /api/runners` reports the last outcome and initiates nothing, which
>   is what answers residual question 2 — a startup regression test asserts that
>   building the server and reading that route twice probes zero runners.
> - **Unprobed is a third value, not `false`.** The field is absent until
>   something asks. Reporting `false` for "nobody has asked" would be the "ready
>   in the UI, unusable by the backend" failure with the sign flipped, and the
>   Swift DTO models it as `Bool?` for the same reason `registered`/`configured`/
>   `enabled` are optional on the offline floor.
> - **Turn outcomes are not an input.** A turn fails for reasons that say nothing
>   about whether the runner can start — a rejected prompt, a cancelled turn, a
>   workspace error — so folding them in would make `ready` a lagging judgment of
>   unrelated things. One probe, one meaning.
> - **The Codex bootstrap branch was removed by making the adapter own it**, which
>   is the "or prove the current default bootstrap makes the Mac branch
>   unnecessary" half of the sketch, plus the one hardening the proof needed:
>   `jsonRpcArgs` now refuses only the `exec` subcommand and starts the
>   app-server itself, so a stale exec-style `CODEX_ARGS` no longer surfaces as an
>   initialize timeout. `BackendLaunchConfiguration` no longer takes managed
>   settings at all — omitting the parameter is what keeps generic launch assembly
>   from reading a runner's configuration again — and it no longer overrides an
>   operator who pinned `exec` on purpose.
> - **Probe requirement is descriptor data, not a runner branch.** Codex's
>   executable and Claude Code's sign-in are `required`; Claude Code's CLI is
>   `informational`, because the Agent SDK's bundled CLI runs turns. That one
>   field is what lets the setup checklist, the status tint, and the diagnostic
>   level all follow without asking which runner they are looking at.
> - **The offline/served split is enforced by shape.** The bundled bootstrap
>   descriptors are the only place an environment name, a Keychain service, or an
>   executable search lives; `GET /api/runners` and `config/runners.json` carry
>   none of it. The two lists may legitimately disagree, and a runner with no
>   bundled descriptor contributes *no* local check rather than another runner's.
>
> What is deliberately still ahead: nothing here makes a *third* runner's
> bootstrap configurable — a new local primitive still needs scoped Swift and a
> safety review, which is Phase 7's one-time cost for the ACP adapter.

Readiness has **two authorities and must be two named concepts**, because
collapsing them lets a runner read "ready" in the UI while the backend cannot
spawn it:

- **Backend runtime readiness** — can the backend spawn the child, complete the
  handshake, and discover capabilities? Answered by the adapter, served on
  `/api/runners`. Requires a running backend.
- **Mac bootstrap readiness** — is the local prerequisite satisfied? Inspects
  Keychain and local executable configuration, and **must work while the backend
  is stopped**. Answered on the Mac from a descriptor-named *probe kind*
  (`keychain_presence`, `executable_path`; since then `file_path` for
  DeepSeek's composition and, on 2026-08-26, `file_presence` for Cursor's SDK
  sign-in file, each a scoped Swift change with its own review).

The Claude Code check stays a presence-only login Keychain lookup per
`docs/safety/TRUST_AND_SAFETY.md` — it requests no item data and never reads the
credential.

**Tier-3 bootstrap is a separate, trusted Mac contract.** The current code has
hard-coded fields and mappings for `CODEX_EXECUTABLE`, `CODEX_ARGS`, and
`CLAUDE_CODE_EXECUTABLE`, a fixed env strip list, runner-specific save/redaction
status, three locator/status families, and a Codex-only branch that derives
`CODEX_RUNNER_PROTOCOL`/`CODEX_ARGS` from the managed network toggle. A public
runner descriptor cannot replace any of that safely.

Introduce a Mac-bundled `RunnerBootstrapDescriptor` with a closed set of slot
and probe kinds, for example `executable_path` and `keychain_presence`. Slot
values live in a dictionary-shaped Keychain blob keyed by runner id and slot id;
the launch configuration iterates only env names allowlisted by the bundled
bootstrap descriptor. Backend-written or remotely served descriptors may refer
to a public readiness state but may never declare an env name, Keychain lookup,
or executable slot. Migrate the existing typed Keychain fields compatibly and
make diagnostics/redaction iterate the trusted slots.

Move Codex's managed-setting → app-server bootstrap derivation behind the Codex
adapter/backend registry (or prove the current default bootstrap makes the Mac
branch unnecessary); generic Swift launch assembly must not interpret a Codex
network setting.

Adding a runner that uses an existing trusted slot/probe kind then costs a
bootstrap descriptor resource, not Swift control flow. A genuinely new probe or
secret primitive still requires a scoped Swift implementation and safety
review. Phase 7 adds one generic external/ACP executable bootstrap surface so
subsequent ACP agents are tier-3 operator configuration rather than new Swift.

**Done when:** backend runtime readiness and Mac bootstrap readiness are reported
separately; current Codex/Claude setup behavior and presence-only Keychain
posture are unchanged; secrets and env names cannot arrive from `/api/runners`;
and a synthetic runner using an existing executable slot can pass Mac bootstrap
readiness without adding a runner-id switch.

---

## Phase 7 — External adapters

> **Landed** (2026-08-17), with one deliberate departure and one bug found by
> the smoke check. `apps/backend/src/runner/acp` holds the adapter
> (`AcpRunner`), its bounded transport (`AcpStdioClient`), process admission and
> the child-environment allowlist (`admission.ts`), the zod contracts
> (`protocol.ts`), and the tier-3 definition reader (`config.ts`).
> `apps/backend/test/acpRunner.test.ts` covers it against a synthetic agent
> (`test/support/syntheticAcpAgent.ts`), and the whole path was driven
> end-to-end against the real `@agentclientprotocol/codex-acp`: a registered
> adapter, a probed `ready`, and a turn whose assistant reply came back through
> the canonical stream.
>
> Decisions that differ from the sketch below, each deliberate:
>
> - **No `@agentclientprotocol/sdk` dependency.** The plan's preferred vehicle
>   was the SDK; Phase 0b disqualified it. It is ESM-only against a CommonJS
>   backend, it provides none of the frame/depth/volume bounds this phase
>   mandates, and external input must be zod-validated on receipt regardless of
>   what it already parsed. The adapter speaks v1 directly and takes no new
>   runtime dependency; the SDK's published `schema/schema.json` stays the
>   conformance reference.
> - **The built-in admission list stays closed to adapters.**
>   `registeredRunnerKinds` is what this build ships — `codex` and `claude_code`
>   when this phase landed, plus `deepseek` since 2026-08-18 and `cursor` since
>   2026-08-26 — and external
>   adapters join a *runtime* registry beside it rather than growing it. The Phase 4 rollout gate is about a **bundled**
>   third id reaching an older Mac's settings file and dropping the operator's
>   whole trust posture — which an id that Mac's own operator configured is not,
>   and which the "unknown runner namespace is preserved and never applied" rule
>   already covers. `AgentRunnerKind` widened to `string` because a compile-time
>   union cannot describe a set that startup decides; `RegisteredRunnerKind`
>   remains the narrow type for the two ids this build ships.
> - **`agentRunnerKindSchema` resolves against the live registry** instead of
>   being a `z.enum`, keeping "one schema, derived from the registry" true while
>   the set became a startup answer.
> - **Ids are namespaced `acp_*`.** That is what makes the registry's
>   "no settings prefix shadows another" invariant hold by construction rather
>   than by luck, and stops an operator shadowing a current or future built-in.
> - **The permission policy is a real tier-2 managed setting**, as the sketch
>   asked — which is what surfaced the bug below.
>
> **One bug, found by the smoke check rather than by review.** The managed
> setting table in `config/settingsStore.ts` was a module-level constant,
> assembled at **import** time. External adapters are admitted at **startup**
> time, so a configured adapter's settings reached the file, the metadata, the
> patch schema, and environment resolution *not at all* — silently, and
> including the tier-2 setting that decides its permission posture, which would
> have been permanently stuck at its default with no way to see why. The derived
> structures are now live bindings rebuilt by `rebuildManagedSettings()`, which
> `config/serviceConfig.ts` calls immediately after stage 1 — from there rather
> than from the registry, because the settings layer imports the registry and the
> registry must not import back. `acpRunnerTest`'s "reaches the settings layer
> once the table is rebuilt" is the regression.
>
> **What is deliberately still ahead.** Image attachments are refused for ACP
> sessions rather than negotiated per adapter through
> `promptCapabilities.image`. ACP v1 exposes no model list, so an ACP runner's
> capability descriptor is empty and clients render no model picker for it.
> Interactive permission approval still needs its own authenticated route and
> client flow. And the visionOS settings surface renders managed settings through
> a hand-written presentation catalog, so a configured adapter's
> `permissionPolicy` is readable and patchable over the API while remaining
> unrendered in the headset — the Phase 5 note about generic rendering, now with
> a concrete setting behind it.
>
> All four are carried forward as
> [Registered Runner Completeness](REGISTERED_RUNNER_COMPLETENESS.md), so this
> plan closes rather than becoming a standing backlog.
>
> **One claim above was later found wrong**, and is corrected here rather than
> quietly edited out of the record: "ACP v1 exposes no model list" is true only of
> a model-*list method*. v1 carries `configOptions` on the `session/new` response;
> its reserved `model` and `thought_level` categories map onto
> `CodingAgentCapabilities`, so an ACP runner's descriptor is **not** empty.
> Generic `model_config` does not map directly because the category is only a UX
> hint, while `mode` is excluded as the agent's sandbox posture. See Phase 4 of
> the successor plan for both decisions.

Only after 0–6. Preferred vehicle: **an ACP adapter**, per the Phase 0 spike —
one `AcpRunner` implementing `AgentRunner` over `@agentclientprotocol/sdk`, which
makes every ACP-speaking agent configurable rather than coded. An AgentRoom-native
NDJSON contract remains the fallback if the spike disqualifies ACP; they compose,
since ACP support is one adapter under this boundary either way.

The production adapter targets stable ACP v1, not the v2 draft. Conformance and
regression tests use the maintained `@agentclientprotocol/codex-acp` package as
the reference agent. The executable and any credential-bearing environment
grants come only from the trusted tier-3 bootstrap/local configuration defined
in Phase 6; neither `/api/runners`, `/api/config`, nor a safe/public descriptor
may nominate a binary or an environment variable.

### This is a new trust surface and needs a hard boundary

Executing an operator-supplied binary that receives workspace paths and drives
turns is not covered by any existing entry in `docs/safety/TRUST_AND_SAFETY.md`.
Absolute path plus `AUTH_TOKEN` scrubbing is **not sufficient** — an external
binary would otherwise inherit unrelated provider credentials and the backend's
whole developer environment. Required before any of Phase 7 ships:

**Process admission**
- Off by default, behind its own flag, in the spirit of `TERMINAL_ENABLED`.
- Executables allowlisted by absolute path, tier 3 (environment-only), never a
  managed key — an executable path is remote code execution by configuration.
- Realpath canonicalization; reject symlinks, non-files, and non-executables.
- Fixed argv assembled by the backend; no caller-supplied shell fragments, no
  shell.

**Child environment**
- **Allowlisted, not inherited.** An explicit env allowlist with opt-in
  credential grants, rather than today's inherit-minus-`AUTH_TOKEN` model.

**Protocol limits**
- Frame size, nesting depth, output volume, stderr volume, buffering caps.
- Handshake, turn, cancellation, and shutdown timeouts, each with a kill
  fallback.
- On initialization, record stable-v1 restore support. Prefer
  `sessionCapabilities.resume` and `session/resume`; otherwise accept
  `loadSession` and use `session/load` with replay suppression. A production
  agent advertising neither is rejected rather than silently beginning a new
  conversation after reap, crash, or backend restart.
- Treat `session/load` updates as reconstruction, not new AgentRoom output:
  validate and consume them to rebuild adapter state, but do not append a second
  copy to the persisted transcript or emit duplicate user-visible activity.
- Defined crash / restart / restore semantics, exercised through the Phase 1
  host for both native-resume and history-replay strategies.

**Declared posture**
- Explicit workspace, network, filesystem, and terminal posture per adapter.
- ACP `fs` and `terminal` capabilities advertised **false** initially (Phase 0).
- Permission requests default to the Phase 0 conservative response:
  `reject_once`, or cancellation when the agent provides no rejection option.
  An optional unattended auto-allow mode is a tier-2 per-adapter trust setting,
  editable remotely only behind `REMOTE_SETTINGS_ADMIN`, and documented as a
  `bypassPermissions`-class posture. It selects only a response option supplied
  for that request; it does not invent or persist an implicit `allow_always`.
  Interactive approval requires a separately designed authenticated route and
  client flow and is outside this phase.
- The adapter's capability document is zod-validated and bounded on receipt —
  **shape validation is not trust**. Zod can bound a claim's structure; it cannot
  make the executable or its claims trustworthy. The allowlist is the trust
  decision.
- Adapter-authored text passes `util/redactSecrets` before reaching a response,
  an event, or durable audit, matching the Codex stderr-tail rule.

`AGENTS.md` and `docs/safety/TRUST_AND_SAFETY.md` are updated **in the same
change** as the code, per the repository's standing rule.

**Done when:** the reference ACP agent completes initialize, prompt, cancel,
shutdown, and a supported restore path; native-resume and load-with-replay tests
prove that no transcript entry or activity is duplicated; a non-restorable
agent is rejected for production; permission-request tests cover conservative
reject, no-reject cancellation, and the gated unattended posture; fs/terminal
remain absent; and process, environment, protocol-limit, redaction, and crash
tests exercise every boundary above.

---

## Sequencing

```
0  matrix + ACP spike      ← de-risks everything; no production code   [done]
1  shared session host     ← pure dedup, independently valuable        [done]
2  canonical event union   ← the real conditional removal              [done]
3  registry + policies     ← internal refactor; no third id exposed    [done]
4  compatibility bridge + descriptor catalogs ← reader-first release   [done]
5  versioned offline settings ← writers enabled on the Phase 4 floor    [done]
6  split readiness + trusted tier-3 bootstrap                          [done]
7  external adapters       ← ACP v1 adapter, no SDK dependency          [done]
```

Phases 1 and 2 are worth doing even if no third runner ever lands. The Phase 3
registry can land internally, but Phase 4 gates the first third runner id sent
through `/api/runners`, `/api/config`, or `settings.json`. Phase 4 → 5 ordering
is a hard compatibility constraint, not a preference. Every phase is a stopping
point.

## Residual questions — not sequencing blockers

1. **Exact compatibility-floor identifiers and retirement condition.** The plan
   requires an advertised API floor for the Phase 2 legacy envelope and Phase 5
   flat-config shims; implementation still needs to choose the concrete version
   identifiers and the operational signal that permits retiring each shim. This
   is deliberately not expressed as an assumed number of releases.
2. ~~**Per-runner discovery cost verification.**~~ *Answered by Phase 6.*
   Discovery stays lazy and per runner, and readiness is recorded as a
   by-product of it rather than by a probe of its own, so no route spawns a
   child. `runnerRoutes.test.ts` is the startup regression test this asked for:
   building the server and reading `GET /api/runners` twice probes zero runners.
3. **Cross-process settings contention** stays last-write-wins between the Mac
   and the backend. Namespacing makes concurrent edits to *different* runners
   more likely; whether that justifies the optimistic-lock token already noted as
   hardening for the settings file is now a live question.

The runner-id representation, `runnerKind`'s managed tier, ACP restore policy,
and default permission response are no longer open: Phases 3–7 decide them.

## Revision notes

First draft revised 2026-08-15 after review. Corrections, all verified against
the tree:

- `AgentRunner` described as "a clean five-method contract" — it is **four
  required plus two optional**.
- **"Zero Swift changes" was not achievable** and was narrowed to baseline
  client presentation; bespoke presentation remained optional. Leak #9 added.
- **`canonicalKind` as a tag was insufficient** — replaced with a discriminated
  canonical payload union, since a tag alone relocates conditionals into content
  inspection rather than removing them.
- **The offline-settings blocker was missed entirely**, and is more severe than
  first reported: the Mac's whole-file preflight rejects any unknown top-level
  key. Phase 4 → 5 ordering and an offline descriptor floor follow from it.
- **Leaks 6 and 7 (turn-diff strategy, workspace-skill availability) were
  missed** — both capabilities, not metadata.
- **The metadata envelope was untyped**; it now carries named correlation fields
  plus a bounded native blob with explicit limits.
- **Readiness was treated as one API**; split into backend-runtime and
  Mac-bootstrap.
- **ACP promoted from open question to Phase 0 spike**, with v1 stability, the
  official TypeScript SDK, explicit restore-capability discovery, and the
  filesystem/terminal capability posture verified rather than assumed.
- **External-process hardening substantially expanded** beyond path allowlisting
  and token scrubbing.

Second revision 2026-08-16 after a bilateral compatibility, client-contract,
tier-3 bootstrap, and current ACP review:

- **Phase 4 is now a reader-first compatibility release.** Both strict settings
  readers must recognize and preserve the reserved future shape before Phase 5
  writes it; Phase 4 also gates the first externally visible third runner id.
- **Phase 2 now specifies the full client contract:** canonical correlation and
  display metadata, reuse of the existing top-level event version, a bounded
  legacy shim, unknown-event decoding, stable activity identity, generic Swift
  rendering, and correct harness attribution.
- **The Mac bootstrap claim is honest.** Public descriptors cannot name secrets,
  environment variables, Keychain items, or executables. A separate trusted,
  bundled tier-3 descriptor handles existing slot/probe primitives; a genuinely
  new primitive still requires scoped Swift and safety work.
- **The settings migration is concrete:** nested v2 shape, dotted PATCH paths,
  v1/v2 mutual exclusion, atomic whole-file conversion, preservation without
  activation of unknown namespaces, a build-time offline descriptor floor, and
  an explicit legacy rollback serializer.
- **ACP restore and permission behavior is no longer hand-waved.** Production
  requires stable-v1 `session/resume` or replay-suppressed `session/load`;
  permission requests reject by default, with unattended allow only as a gated
  tier-2 bypass-class posture. The maintained official Codex ACP package is the
  conformance reference.
- **Leaks 11–15 were added** for session metadata extraction, harness
  misattribution, tier-3 Swift bootstrap policy, native-dependent transcript
  rendering, and the closed Swift event enum.

Two citations in the review pointed at paths that do not exist
(`apps/backend/src/events/events.ts`, `apps/backend/src/runners/AgentRunner.ts`);
the correct paths are `apps/backend/src/protocol/coding/events.ts` and
`apps/backend/src/runner/AgentRunner.ts`, and this document uses those.
