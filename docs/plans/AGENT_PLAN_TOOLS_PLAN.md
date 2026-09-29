# Agent plan tools implementation plan

Status: implementation complete with live verification outstanding, 2026-09-28.
See the [Stage 5 record](#stage-5-record) for the open checks.
Branch: `codex/agent-plan-tools`, based on `main` at
`dd3fba171e31e216e8e69256a22128679b53a779`.

## Worker entry point

Continue on the named branch. Inspect its status and commits before editing;
preserve any later work. Read `AGENTS.md`, use `$prime-context`, then read this
file and the [implementation contract](AGENT_PLAN_TOOLS_CONTRACT.md). The
contract contains the tool arguments, transitions, bounds, and persistence
rules. No preceding chat is required to implement the feature.

Use these owning references when crossing their respective interfaces:

- [Runners](../engineering/RUNNERS.md#agentroom-tools-and-dispatch) for catalog,
  descriptors, transport, native resume, and question handling.
- [API](../api/API.md#agent-sessions) and
  [trust and safety](../safety/TRUST_AND_SAFETY.md#session-persistence) for
  session content, authentication, events, and persistence.
- [Local Mac server](../operations/LOCAL_MAC_SERVER.md) for runtime checks and
  [open-source mirror](../operations/OPEN_SOURCE_MIRROR.md) for public docs.
- For shared Swift contracts, use `$swiftui-pro` and
  [SwiftUI standards](../engineering/SWIFTUI_STANDARDS.md), plus
  [macOS](../clients/MACOS.md). UI design is outside this task.

Work through the stages below in order. Record implementation commits, checks,
transport versions, and unresolved failures in the progress table. Check boxes
only when the stage's completion criterion is met. A missing real-runner check
is an open check, not evidence that a runner works. Do not install credentials,
change provider permissions, publish, or merge as part of this handoff.

## Product decisions

Each thread, represented by an AgentRoom session, owns zero or one plan.
Creating a replacement wipes the old plan state; editing revises it in place.
Thread history remains. Plans and progress survive backend restart.

The conversation model applies equally to Codex, Claude Code, Cursor, and
managed DeepSeek. A turn is one user request and the work that follows. One
turn may execute several steps or finish the whole plan; a plan may span turns.
A step has no separate thread or runner turn.

Creating and editing do not start execution. `execute_plan` records the start
or resumption of work and returns to the calling agent, which performs the
work using its existing permissions. If the user requests both planning and
implementation, the agent can create and execute in the same turn. A request
to discuss the plan alone does not resume work. Ending a turn does not start
another; later execution uses a user-initiated turn in the same thread.

Plan tools are enabled by default on supported built-in runners. Steps are
sequential, with at most one in progress. Finishing the plan leaves the thread
open. Completion is agent-reported, with outcome notes and a final summary;
the backend validates state, not the truth of arbitrary work claims.

Out of scope: ACP integration, custom DeepSeek compositions, automatic
continuation, schedulers, subagent delegation, parallel steps, dependency
graphs, provider-native goal management, plan archives, and client plan UI.
This task includes shared Apple DTOs and read support, but no client mutation
controls. There is no new human approval flow for plan tools.

## Current code and integration hazards

These observations are from the branch base. Recheck them if the base changes.

| Owner | Finding and implementation consequence |
| --- | --- |
| `apps/backend/src/agentTools/catalog.ts` | Shared definitions already exist. Add a `plans` capability and six definitions. Keep one canonical schema per tool. |
| `apps/backend/src/agentTools/dispatch.ts` | Dispatcher bounds strings to 64 Ki characters and refuses late results. It does not validate arguments or undo writes. Plan handlers must return bounded results and check authority before committing. |
| `apps/backend/src/agentTools/runnerToolSet.ts` | Factory currently requires tools whenever any are allowed. Make required readiness explicit; default advertisement must not make ordinary turns fail. |
| `apps/backend/src/agent/AgentSessionService.ts` | `runner.run` currently receives no tool set. Hydration, snapshot, cancellation, settlement, and deletion also need plan integration. The file is budget-exempt and cannot grow. Extract coherent work instead of enlarging its exception. |
| `apps/backend/src/agent/AgentTurnContextAssembler.ts` | Owns changing turn context and descriptor-based instruction delivery. Add current-plan context without altering the stored user message. |
| `apps/backend/src/state/DurableAgentSessionStore.ts` | Coalesces whole-session writes and catches errors. Its `schedule` promise can resolve after failure. It is not an acknowledged mutation commit. |
| `apps/backend/src/domain/models.ts`, `schemas.ts` | Durable schema is v1 and strips unknown fields. Add plan state at the document level, bump the version, and migrate v1. Keep plan text out of the public session summary. |
| `apps/backend/src/runner/registry.ts`, `AgentRunner.ts` | Descriptor owns policy; `AgentRunnerInput.tools` already carries definitions and a bound invoker. Application code must not branch on runner IDs. |
| `apps/backend/src/runner/claudeCode/sdk.ts` | SDK loader exposes only `query`. Its injectable loader must also support the selected tool-registration facilities for tests. |
| `apps/backend/src/runner/claudeCode/ClaudeCodeRunner.ts` | `canUseTool` refuses every non-question callback. Exact AgentRoom plan tools need a narrow path under stricter postures; wildcard MCP approval would widen permissions. |

The existing `coding_plan_updated` event reports provider-native checklists.
Keep it unchanged. Native checklists cannot mutate or replace the stored plan.
`/api/status` exposes session summaries and `/api/events` is currently ungated;
new plan state must not be embedded in either summary payload. Existing native
tool activity may expose tool text under the recorded broadcast limitation;
this task does not claim to close that pre-existing gap.

## Runner inheritance

The shared plans module owns state and behavior. Session setup composes the
catalog from descriptor capabilities, binds it to the live session and turn,
and supplies it through `AgentRunnerInput.tools`. Every tool invocation ends
at the same module interface. Adapters own registration, native names, call
correlation, and return formatting. They do not maintain separate plan stores.

## DRY requirements

DRY is a completion requirement for this feature. A change to a plan rule,
limit, tool description, or result must have one implementation owner and flow
through to every runner. Follow these rules throughout the implementation:

- Define plan schemas, limits, logical IDs, and tool descriptions once. Derive
  native advertisements from the shared definitions. Where an SDK needs a
  different schema representation, use a reusable conversion and parity tests;
  do not hand-maintain six tool schemas in each adapter.
- Keep transitions, validation, revision checks, retries, result envelopes,
  and persistence decisions in the plans module. Thin handlers call that
  interface. Reuse the existing catalog, dispatcher, turn binding, and session
  writer instead of copying their logic into plan-specific alternatives.
- Keep lifecycle instructions and current-plan context formatting in shared
  code. Adapters choose the native delivery mechanism, not their own wording
  or interpretation of plan behavior.
- Keep runner registration and dispatch generic. Adapters consume the supplied
  catalog and binding without switches or conditionals for `plans.*` or the six
  plan tool names. Derive exact permission allowlists from the bound catalog;
  the narrow Claude permission path must not become a handwritten plan list.
- Implement shared runner conformance scenarios once, parameterized by adapter
  fixtures. Keep native protocol setup and adapter-specific assertions local.
  The plan module's behavior tests remain separate from transport conformance.
- Reuse shared Apple DTOs across clients. Keep implemented wire, trust, and
  runner documentation in their owning references; link instead of copying
  the same contract into several guides.

Share repeated policy, not unrelated protocol mechanics. Native permissions,
request envelopes, and call correlation remain adapter-owned when they differ.
Use existing seams before adding abstractions; do not introduce a general
workflow framework or rewrite unrelated runner behavior for this feature.
If a native constraint forces a duplicated representation, record its reason,
authoritative source, and drift-prevention test in the handoff evidence.

## Shared instructions and native transports

One shared instruction describes the lifecycle and treats AgentRoom plan tools
as authoritative. Deliver stable instructions according to `promptDelivery`;
dynamic plan context accompanies every turn, including Claude's cached system
prompt path. Context reports availability plus current plan ID, revision,
status, and current step, or explicit absence. The agent calls `get_plan` before
resuming and after conflicts. Plan contents are task data, not instructions
that may override the user's latest direction.

| Runner | Candidate implementation | Required proof |
| --- | --- | --- |
| Codex | App-server dynamic definitions and `item/tool/call`, translated into the supplied binding. | Supported executable/version, experimental negotiation, correct thread and originating-turn correlation, allowed request methods, native questions, thread resume and tool catalog restoration. |
| Claude Code | In-process SDK MCP server using the installed SDK's `createSdkMcpServer` and `tool`, with exact names mapped to catalog logical IDs. | Canonical schema conversion, injectable SDK loader, permission behavior under every supported mode, origin-turn correlation, cancellation, native resume, question coexistence. |
| Cursor | Feed session-supplied definitions and calls through its existing custom-tool relay alongside questions. | Preserve native run-generation checks, stable child catalog, resume, and question behavior. |
| Managed DeepSeek | Merge supplied tools through `nativeTools.ts` and its Cordis-pipe relay alongside questions. | Catalog readiness and frame bounds, bind/unbind generation, consecutive live-child turns, and optional tool failure. Native resume remains unsupported. |

The [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)
records an experimental transport. Installed Claude SDK declarations expose
in-process MCP facilities. Neither is proof of behavior in AgentRoom.

A persistent callback must identify its originating turn before dispatch. Simply
looking up whichever turn is currently active is unsafe. Investigate the native
call ID, turn metadata, or a provably isolated per-turn transport during stage 1.
If a transport cannot prove this property, record the concrete blocker and
leave that adapter unsupported; do not broaden authority to finish the task.

Catalog changes follow the existing restart/resume contract. Never destroy an
unresumable DeepSeek conversation to refresh tools. Its saved plan remains
readable after process loss, but continuing that thread still returns the
existing refusal. Sessions remain pinned to their runner; this feature does
not introduce runner switching or rebuild conversations from transcripts.

## Implementation stages

### 1. Establish baseline and prove transport feasibility

Run baseline backend checks and record existing failures separately. Inspect
installed Codex and SDK versions; use primary protocol documentation to resolve
uncertainties. Build focused transport fixtures for Codex and Claude that
register a second tool alongside existing questions, invoke it, cancel, then
attempt a delayed call after the next turn begins. Do not use production plan
storage for this proof. Check Cursor and DeepSeek catalog limits against the
six plan definitions plus the existing question tool.

Complete when each candidate has an explicit registration, invocation,
origin-turn, permission, and restoration design backed by fixtures. Record
native features still requiring real-runner evidence. A version incompatibility
must be resolved or recorded as a blocker before claiming universal support.

### 2. Implement the plan module and acknowledged storage

Implement the companion contract through a focused `apps/backend/src/plans`
module. Keep transitions, schema validation, retry receipts, and revision
checks there. Add a serialization/commit facility to the session store rather
than a competing writer of the same file. Integrate snapshot, migration,
hydration, pause-on-settlement, and deletion. Respect existing file-size limits.

Complete when contract tests cover every transition and refusal, duplicates,
replacement, receipt eviction, concurrent mutations, write failures, ordinary
session writes racing plan commits, restart, and deletion. Prove that a
successful response survives process restart and that failed candidates cannot
be saved by a later ordinary session write.

### 3. Bind tools and expose the read contract

Add six catalog definitions, shared instructions, per-turn context, and fresh
bindings with disposal on all exit paths. Add the read route, change event,
and explicit required-tool context described in the companion contract. Wire
composition into server startup and session setup. Preserve question tools.

Complete when a test runner executes multiple steps in one turn and one plan
across turns. Creation, edits, and turn settlement must not start another turn.
Check authorization, absence, conflict recovery, old-plan references, changed
plan context, and both optional and required tool unavailability. Audit the
shared definitions, instructions, handlers, and result builders against the
[DRY requirements](#dry-requirements) before adding adapter integrations.

### 4. Integrate all four built-in adapters

Apply the proven transport designs using the shared definitions and handlers.
Keep transport-specific details behind `AgentRunner` and publish capability
support through descriptors only. Run one reusable conformance suite against
all four adapter fixtures; native naming differences must not alter plan
semantics. Register an additional non-plan test tool through the supplied
catalog and prove that every adapter can advertise and invoke it without any
adapter implementation change. This is the check against plan-specific relay
branches and copied tool lists.

Complete when automated adapter tests cover all six tools, questions,
cancellation, delayed calls, rebinding, and native resume where supported.
Run attended real-runner checks in a disposable workspace and state directory
when configured credentials/runtimes are available. Record versions and
results, including missing checks, without claiming mocks prove live support.

### 5. Shared client contracts, documentation, and final verification

Add shared Swift plan DTOs and the authenticated read method. Unknown statuses
must decode through a generic fallback. Keep native app UI unchanged. Update
API for wire behavior, safety for bounds/storage/trust, Runners for descriptor
policy and transport, and Local Mac server for migration/recovery implications.
Update public overlay guidance when an implemented contract changes its scope.

Run backend typecheck, build, and the full test suite. Smoke the compiled
backend on port 8799 using disposable state, checking `/health` and
`/api/status`, then stop only the process started for this check. Run shared
Swift tests. Follow AGENTS.md for XcodeGen and affected app builds if project
files change. Run documentation-contract tests and a mirror dry run against
the actual candidate commit. Record unavailable tools or attended checks.

Complete only when required automated checks pass and the evidence below is
accounted for. Review the final diff for duplicated schemas, constants,
instructions, handlers, and conformance scenarios. Record their shared owners
and any justified native representations in the final handoff. If live
verification is missing, report implementation complete
with verification outstanding; the feature is not fully verified.

## Acceptance evidence

| Area | Required scenarios |
| --- | --- |
| DRY | One owner for each shared rule/schema/limit/instruction/result; one parameterized runner conformance suite; additional non-plan tool works without adapter changes; any native duplicate representation has a source and parity test. |
| Tool contracts | All six tools; strict schemas and JSON-Schema parity; every count/text/byte limit; atomic oversized rejection; valid JSON results below dispatch limits. |
| Lifecycle | Draft create/edit; sequential execution; skip/block reasons; resume note; multi-step turn; multi-turn plan; terminal refusal; cancellation; no implicit execution or automatic continuation. |
| Replacement/retry | Explicit replacement, fresh IDs, old-call refusal, duplicate replay across restart/replacement, changed payload under same operation ID, evicted receipt with stale revision, simultaneous same-revision mutations. |
| Storage | v1 migration without rewrite on read, v2 round trip, future-version preservation, unknown runner preservation, write failure, lost response after commit, concurrent transcript saves, delete during write, pause recovery before the next turn. |
| Authority | Cross-session IDs, cancellation before commit, cancellation during write, stale native callbacks after rebinding, scoped Claude permission handling, unchanged shell/provider permissions. |
| Delivery | Default advertisement versus explicit required readiness, stable instructions versus fresh context, catalog changes, native checklist coexistence, resume/disconnect/reconnect. |
| Exposure | Authenticated plan reads, metadata-only change events, no plan text in status/session lists, no tool arguments/results in new telemetry or receipts. |
| Apple contracts | Decode/encode fixtures, unknown statuses, no app-local DTO shadows, old server response handling for the new read method. |

Existing suites to extend include `agentTools.test.ts`,
`agentRunnerToolSet.test.ts`, `durableAgentSessionStore.test.ts`,
`durableAgentSessions.test.ts`, `agentSessionRequests.test.ts`,
`agentTurnContextAssembler.test.ts`, `runnerRegistry.test.ts`,
`codexJsonRpcRunner.test.ts`, `codexQuestions.test.ts`,
`claudeCodeRunner.test.ts`, `claudeCodeQuestions.test.ts`,
`cursorHost.test.ts`, `cursorRunner.test.ts`, `deepseekToolRelay.test.ts`,
and `deepseekManagedRuntime.integration.test.ts`, under `apps/backend/test`.
Use new focused suites for plan behavior rather than exceeding test budgets.

Backend commands are `pnpm typecheck`,
`pnpm --filter @agentroom/backend build`, and `pnpm test`.
Run `swift test` in `apps/shared/AgentRoomClient`. For docs, run
`pnpm --filter @agentroom/backend exec vitest run test/mirrorManifest.test.ts`
and `pnpm mirror:public --dry-run --source-ref <candidate-commit>`.
The mirror reads a commit, so a default-HEAD run cannot validate uncommitted
files. These plan documents are covered by the existing `docs` inclusion.

## Progress and handoff record

| Stage | Status | Commit and evidence |
| --- | --- | --- |
| 1. Baseline and transport proof | Complete, live evidence outstanding | `7c420fc3`. See [Stage 1 record](#stage-1-record). |
| 2. Plan module and storage | Complete | `66dcbff2`. See [Stage 2 record](#stage-2-record). |
| 3. Tools and read contract | Complete | `e186a97d`. See [Stage 3 record](#stage-3-record). |
| 4. Runner integration | Complete, Cursor and DeepSeek live checks outstanding | `dc05ea8f`. See [Stage 4 record](#stage-4-record). |
| 5. Contracts and verification | Complete, live evidence outstanding | `69bbf8ae`. See [Stage 5 record](#stage-5-record). |
| Review follow-up | Complete, live evidence outstanding | See [Review follow-up record](#review-follow-up-record). |

Product scope is settled. Implementation defaults are in the companion
contract. A worker may refine internal design without changing those contracts;
if a measured transport limit forces a contract change, record the evidence
and update the contract and tests together. Ask only when a change would alter
the agreed thread, execution, replacement, or permission behavior.

### Stage 1 record

Recorded 2026-09-28 on `codex/agent-plan-tools` at `8933c095`. No runtime code
changed. The fixtures are test-only and use no plan storage.

Baseline: `pnpm typecheck`, `pnpm --filter @agentroom/backend build`, and
`pnpm test` passed with 128 files, 1,402 tests passed, and 3 files and 10 tests
skipped. There were no pre-existing failures.

Versions inspected: Claude Agent SDK 0.3.283 with bundled CLI 2.1.283 (the
PATH `claude` is 2.1.261), Cursor SDK 1.0.28, and codex-cli 0.158.0-alpha.2.1
from `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`.
`codex` is not on PATH, so live Codex runs need `CODEX_EXECUTABLE`. The Codex
runner comments cite verification against 0.146 and 0.149.

Fixtures:
`apps/backend/test/codexDynamicToolsTransport.test.ts` (5 tests) and
`apps/backend/test/claudeSdkToolTransport.test.ts` (5 tests, run against the
installed SDK's MCP server). Each registers a second catalog tool beside
`questions.ask`, dispatches through `prepareAgentRunnerToolSet`, cancels, and
sends a delayed call after the next turn is bound.

#### Codex

- Registration: the Stage 4 adapter passes `thread/start.dynamicTools`,
  derived from the shared advertisements as `{type: "function", name,
  description, inputSchema}`. The field exists only under
  `experimentalApi: true`, which the runner already negotiates. A model-free
  probe against 0.158 in a scratch `CODEX_HOME` accepted seven strict specs,
  and refused a duplicate name and a name outside `^[a-zA-Z0-9_-]+$` with
  `-32600`. All six plan names match.
- Invocation: the server request is `item/tool/call` with `threadId`,
  `turnId`, `callId`, `tool`, `arguments`, and optional `namespace`. The
  response is `{success, contentItems: [{type: "inputText", text}]}`. The
  runner currently answers only `item/tool/requestUserInput` and refuses
  every other method with `-32601`. Stage 4 adds `item/tool/call` and keeps
  that refusal for everything else.
- Origin turn: bindings are keyed by the native turn id, set from the
  `turn/start` response or `turn/started`, whichever arrives first. A call
  dispatches only into the binding for its own `turnId` and `threadId`. An
  unknown, ended, or foreign turn gets the tool's unavailable text with
  `success: false`. The fixture proves a late call from a cancelled turn
  cannot reach its successor.
- Questions: Codex keeps native `request_user_input`. Its catalog does not
  carry `questions.ask`.
- Permissions: dynamic tools run in the backend, so the Codex sandbox and
  approval posture are unchanged.
- Restoration: `thread/resume` has no `dynamicTools` field. 0.158 stores
  specs per thread in the `thread_dynamic_tools` state table, which suggests
  resume restores the thread's original catalog. Threads started before this
  feature, or with a different catalog, would keep their stored set. The
  adapter must report plan tools as unavailable for such threads, and fail a
  turn that requires them, rather than start a fresh thread.

#### Claude Code

- Registration: `createSdkMcpServer({name: "agentroom", tools: []})` goes in
  `mcpServers` at child spawn. The adapter then sets the low-level
  `tools/list` and `tools/call` handlers on `instance.server` to serve the
  shared catalog verbatim. The SDK's `tool()` helper was rejected. It
  advertised `additionalProperties: false` but silently stripped unknown keys
  before the handler ran, and its own `-32602` validation text would
  pre-empt the shared result envelope. A `.strict()` zod object passed to
  `tool()` does reject unknown keys and stays the fallback if the low-level
  override breaks on an SDK update. `sdk.ts` must expose
  `createSdkMcpServer` through the injectable loader.
- Invocation: the handler receives raw arguments, `extra.signal`, and
  `extra._meta["claudecode/toolUseId"]`. The bundled CLI binary contains that
  key next to its `tools/call` request construction; live runs must confirm it.
  MCP `notifications/cancelled` aborts `extra.signal`, and the fixture shows
  that abort reaching the bound call.
- Origin turn: the stream consumer records each assistant `tool_use` id
  against the oldest turn still owed a result (the head of
  `turnsAwaitingResult`), not `activeTurn`. The handler waits a bounded time
  for that observation, because the call can be served before the consumer
  has read the matching message off the SDK queue, then dispatches into that turn's binding. A missing id, an
  id never observed, or an ended turn fails closed.
- Questions: `AskUserQuestion` stays on `canUseTool`. The catalog does not
  carry `questions.ask`.
- Permissions: pass exact `allowedTools` entries
  `mcp__agentroom__<name>`, derived from the bound catalog names, and let
  `canUseTool` allow exactly those names if one reaches it. No wildcard. The
  supported modes are `default`, `acceptEdits`, `dontAsk`, and
  `bypassPermissions`.
- Restoration: the MCP server is rebuilt with the query options on every
  child spawn, including `resume`. A catalog change takes effect on the next
  child; a live child keeps its catalog.

#### Cursor and managed DeepSeek

- Cursor: the host protocol allows 16 catalog tools with names up to 200
  characters. Seven fit. Custom tools run host callbacks without interactive
  approval, so permissions are unchanged. `tools/invoke` already carries the
  host `runId` generation handle. Cursor keeps `questions.ask` in its
  catalog. SDK 1.0.28 also accepts a per-send `customTools` override; Stage 4
  keeps the existing per-child catalog.
- DeepSeek: `ready` allows 64 names and frames are capped at 512 KiB. Seven
  definitions fit. Mutation inputs and results are capped at 40 KiB, so they
  fit a frame. `invoke` carries `runId`. Stage 3 should assert the serialized
  catalog frame size once the definitions exist.

#### Still requiring real-runner evidence

- Codex: a model turn that calls a dynamic tool on 0.158; `thread/resume`
  restoring `thread_dynamic_tools`; behavior when the stored catalog differs
  from the current one; the minimum supported codex version.
- Claude: the CLI emits the assistant `tool_use` message before the matching
  MCP `tools/call`; `_meta["claudecode/toolUseId"]` equals that block's id;
  exact `allowedTools` entries allow the call under `default`, `acceptEdits`,
  and `dontAsk` without widening other permissions; interrupt cancels an
  in-flight MCP call.
- Cursor and DeepSeek: none for the limits above. Stage 4's live checks cover
  them.

No live model turn ran in Stage 1. Credential status was not inspected.

### Stage 2 record

Recorded 2026-09-28 on `codex/agent-plan-tools`. The plan tools are not yet
advertised to any runner, so nothing outside tests can call the plan service.

Owners:

- `apps/backend/src/plans/planModel.ts` owns statuses, bounds, the stored
  plan and receipt schemas, and the structural invariants.
- `planToolContract.ts` owns the six strict zod input schemas, the closed
  error codes, and the result envelope schema.
- `planTransitions.ts` holds the pure transitions, including settlement and
  restart recovery. `planReceipts.ts` holds canonical hashing, receipt
  matching, and the 64-receipt window.
- `ThreadPlanService.ts` owns the per-session serialized path: input and
  size checks, liveness, receipts before revision checks, commits, pending
  system transitions, reads, and deletion. `invoke` is the single handler
  Stage 3 binds to all six tools.

Storage: the session document is now v2, with top-level `plan` and
`planMutationReceipts` beside `session`. v1 migrates in memory to an empty
plan and is rewritten only by its next change. `DurableAgentSessionStore`
gained `commit`, which runs through the same per-session chain as ordinary
writes and reports `committed`, `not_committed`, `unknown`, or `removed`. A
failed rename triggers a read-back of the file. If the read-back also fails,
the session's later writes stall until `reconcile` settles the commit.
Ordinary writes always snapshot the service's committed plan, never a
candidate. File operations are injectable for fault tests.

Session integration: `AgentSessionService` builds the plan service with the
store's writer, adds plan state to every snapshot, hydrates it, settles it
wherever a turn leaves `running`, waits for `prepareForTurn` before
accepting a turn (503 when plan state is unrecorded), and closes it before
deleting the document. The service dropped from 851 to 849 lines by moving
`AgentSessionError`, the two input types, and the restart constant to
`agentSessionTypes.ts`, and re-exporting them.

Tests: `threadPlanLifecycle.test.ts` (14) runs the contract's reference
table and every transition and bound. `threadPlanStorage.test.ts` (16) covers
duplicates, changed payloads, receipt eviction, simultaneous mutations,
write failure before and after rename, unknown outcomes and reconciliation,
cancellation before acceptance and during a write, a failed settlement,
racing ordinary writes, deletion during a write, restart survival, a lost
response, and restart recovery. `threadPlanSessions.test.ts` (2) checks
settlement, restart recovery, deletion, and plan text staying out of
`/api/status` and session lists through `buildServer`.
`durableAgentSessionStore.test.ts` now covers v2 and the v1 migration.

Checks: `pnpm typecheck`, `pnpm --filter @agentroom/backend build`, and
`pnpm test` passed with 133 files and 1,445 tests passed, and 3 files and 10
tests skipped.

Left for later stages: the `agent_plan_changed` event is an `onChanged`
callback with no subscriber yet (Stage 3). The downgrade limit, since older
builds refuse v2 documents, and the storage bounds still need to go into the
Local Mac server and trust references (Stage 5).

### Stage 3 record

Recorded 2026-09-28 on `codex/agent-plan-tools`. No built-in descriptor
declares the `plans` capability yet, so the tools reach no real runner until
Stage 4 opts each adapter in.

Owners:

- `apps/backend/src/plans/planTools.ts` owns the six catalog definitions
  (names, descriptions, the unavailable text), the one handler factory, the
  result serializer, the standing instruction, and the per-turn context. The
  tool id list is the key list of `planToolInputSchemas`.
- `apps/backend/src/agentTools/jsonSchema.ts` converts each canonical zod
  input schema into its advertised JSON Schema. It throws on any construct it
  cannot express and requires strict objects, so a schema change cannot
  silently advertise a looser contract. Refinements stay with the validator.
- `apps/backend/src/plans/planTurnTools.ts` connects plans to turns. It
  composes the advertised ids from the descriptor's capabilities through the
  catalog, binds a fresh tool set per turn through
  `prepareAgentRunnerToolSet`, disposes it before queuing the turn-end
  transition, refuses a required-but-unsupported turn with 409, and builds the
  plan prompt. `createSessionPlans` wires the metadata-only
  `agent_plan_changed` event.
- `prepareAgentRunnerToolSet` now takes an explicit `required`. The DeepSeek
  question tool passes `true`, which keeps its previous value.

Session integration: `AgentSessionService` passes the bound set as
`AgentRunnerInput.tools`. Liveness requires the turn to be the session's
active running turn and not cancelled. Every settlement path releases the
binding, and `consumeTurn`'s `finally` releases it again. The service fell from
849 to 835 lines because the two turn-timing log blocks moved into
`AgentTurnTelemetryStore`. `AgentTurnContextAssembler` places the standing
instruction by `promptDelivery` and adds the context to every turn. It reads
the plan through the plan service's queue, after `prepareForTurn`.

Wire: `context.planToolsRequired` (zod, optional boolean) and
`GET /api/agent-sessions/:sessionId/plan` returning `{schemaVersion: 1, plan}`,
bearer-gated, 404 for an unknown session, 503 while a write's outcome is
unresolved, receipts excluded. `agent_plan_changed` carries `schemaVersion`,
`sessionId`, `planId`, and `revision`, and is not in the durable audit set.

Tests: `threadPlanTools.test.ts` (12) covers the definitions and schema
parity, the converter's refusals, the result envelope, the seven-tool catalog
against the Cursor, DeepSeek, and Codex limits, the context's 2 KiB excerpt
with emoji, and the reference lifecycle through a fixture runner: several
steps in turn A, resume and finish in turn B, replacement, receipt replay, and
an old-plan conflict in turn C. It also checks that only posted turns ran,
that a stale binding answers with the unavailable text, the context changing
between turns, metadata-only events, read auth and absence, required versus
optional readiness, `system` delivery, and a call arriving after
cancellation. `agentRunnerToolSet.test.ts` asserts the explicit `required`.

Checks: `pnpm typecheck`, `pnpm --filter @agentroom/backend build`, and
`pnpm test` passed with 134 files and 1,457 tests passed, and 3 files and 10
tests skipped. The compiled backend on 8799 with scratch state answered
`/health` 200 and `/api/status` 200. The plan route answered 401 without a
bearer and 404 for an unknown session.

Left for later stages: the adapters' native registration, the `system`
delivery of the standing instruction for Claude Code, and a registration
failure notice for an optional turn that proceeds (Stage 4). The shared Swift
`planToolsRequired` field, plan DTOs, and the API, safety, and runner
references for the new route, event, and flag (Stage 5).

### Stage 4 record

Recorded 2026-09-28 on `codex/agent-plan-tools`. Every built-in descriptor
now declares the `plans` capability, so plan tools reach all four runners.

Shared owners:

- `apps/backend/src/runner/shared/agentToolSets.ts` joins a session's tools
  with an adapter's own question tool (`combineRunnerToolSets`,
  `combinedToolCatalog`) and decides what a missing registration means
  (`checkToolRegistration`). A required turn fails when a tool is missing or
  its registration cannot be confirmed. An optional turn proceeds, and a
  known gap puts one shared notice in front of the prompt.
- `AgentRunnerToolSet.instructions` carries the standing plan instruction.
  Claude Code, the one `system` delivery runner, appends it to the SDK system
  prompt; the assembler already put it in the prompt for the others.
- `RunnerAgentTools` gained the `dynamic_tools` and `sdk_mcp` modes and an
  optional `availableWhen(config)` gate. Codex uses it because its legacy
  exec protocol has no tool channel. The session passes its config to
  `ThreadPlanTurnTools`, so exec-mode Codex turns are offered no plan tools.

Per runner:

- Codex (`dynamic_tools`): `runner/codex/dynamicTools.ts` derives
  `thread/start.dynamicTools` from the catalog and serves `item/tool/call`
  only when the call's thread and turn ids name the live turn. A resumed
  thread's catalog is unknown to the adapter, so a required turn on it fails
  and an optional one still dispatches what the thread calls.
  `decideCodexUserInput` and the session types moved to
  `questionWait.ts` and `types.ts`; the runner fell from 844 to 750 lines.
- Claude Code (`sdk_mcp`): `runner/claudeCode/agentTools.ts` holds
  `ClaudeSessionTools`, one per child: the in-process MCP server with
  low-level `tools/list` and `tools/call` handlers, exact
  `mcp__agentroom__<name>` entries in `allowedTools`, a `canUseTool` allow
  for exactly those names, and the tool-use origins read off the stream.
  Registration is confirmed once per child through `mcpServerStatus()`,
  which lists nothing until the child has initialized.
  `sdk.ts` now exposes `createSdkMcpServer` through an injectable loader.
- Cursor (`custom_tools`): the host registers the combined catalog at
  `agent/start`, and the relay dispatches through the combined set. The
  `toolHandlers` constructor seam is gone; the session's tool set replaced it.
- Managed DeepSeek (`cordis_pipe`): the question merge now uses the shared
  combiner. An optional turn on a live child with a different catalog
  continues with the notice instead of failing, because replacing the child
  would lose the conversation. `DeepSeekToolRelay.registeredNames` reports
  what the plugin confirmed.

Tests: `agentToolConformance.test.ts` runs one parameterized suite against
fake native agents for all four transports (`test/support/toolConformanceFakes.ts`).
It covers a whole plan through native calls in one turn, a non-plan probe
tool no adapter knows, per-turn rebinding with a late call stamped with the
previous turn's native identity, required and optional turns on a child
that never registered the tools, cancellation of an in-flight call, and
restored conversations (Cursor and Claude Code re-register; Codex cannot
confirm; DeepSeek has no restore). That is 19 tests with one skip. The Stage 1
proof files now exercise the production relay and `ClaudeSessionTools`
instead of fixture copies.

Checks: `pnpm typecheck`, `pnpm --filter @agentroom/backend build`, and
`pnpm test` passed with 135 files and 1,477 tests passed, and 3 files and 11
tests skipped.

Attended live checks, each in a scratch workspace and state directory on
port 8799, with `planToolsRequired: true` and one prompt asking the model to
create, execute, step through, and finish a two-step plan:

| Runner | Version | Result |
| --- | --- | --- |
| Codex | codex-cli 0.158.0-alpha.2.1, approval `never`, `workspace-write` | Passed. The model finished the plan; `GET …/plan` returned revision 6, completed. One `update_plan_step` start with a note was refused and retried without it. |
| Claude Code | SDK 0.3.283, bundled CLI 2.1.283, `bypassPermissions` | Passed after a fix. The first run failed the required turn because the status read treated a not-yet-listed server as failed. After the fix, revision 6, completed. |
| Cursor | SDK 1.0.28 | Not run. Capability discovery reported that Cloud Agent is unavailable on this account's free plan. |
| Managed DeepSeek | none | Not run. No runtime or composition is configured on this Mac. |

Still requiring real-runner evidence:

- Claude Code under `default`, `acceptEdits`, and `dontAsk`: exact
  `allowedTools` entries approving the tools without widening others. The
  live run used `bypassPermissions`.
- Codex `thread/resume` restoring `thread_dynamic_tools`, and a thread
  started before this feature.
- Cursor and managed DeepSeek model turns calling the tools.

Observed during the Claude Code check and outside this task: the SDK child
listed the operator's claude.ai connectors (scope `claudeai`) as connected
MCP servers although `settingSources` was empty. The live model mentioned
them in its reply. The trust reference does not describe that exposure.

### Stage 5 record

Recorded 2026-09-28 on `codex/agent-plan-tools` at `69bbf8ae`. Native app UI
is unchanged.

Shared Swift contracts, under
`apps/shared/AgentRoomClient/Sources/AgentRoomClient/Contracts/ThreadPlan/`:
`ThreadPlan`, `ThreadPlanStep`, `AgentSessionPlanResponse`, and the open
`ThreadPlanStatus`, `ThreadPlanStepStatus`, and `ThreadPlanPauseReason`
types. An unknown value decodes through its raw value. `APIClient` gained
`fetchAgentSessionPlan(sessionId:)` in `APIClient+AgentSessionPlan.swift`, and
`sendAgentTurn` gained `planToolsRequired`. `AgentTurnContext.forTurn` now
builds the optional context, which took `APIClient.swift` from 817 to 816
lines; the ledger records the new size. The client plan work later typed the
read failures: an older backend's route miss throws
`AgentSessionPlanReadError.unsupportedBackend`, any other `404`
`.sessionNotFound`, and a `503` `.unavailable`. None is an absent plan.

References: API owns the plan read, `context.planToolsRequired`, and
`agent_plan_changed` ([Thread plans](../api/API.md#thread-plans)). Runners
owns the transports, the shared tool-set rules, the plan module owners, and
the open live checks ([Thread plan tools](../engineering/RUNNERS.md#thread-plan-tools)).
Trust and safety owns authority, the Claude allowlist, bounds, receipts,
commit ordering, and exposure ([Thread plans](../safety/TRUST_AND_SAFETY.md#thread-plans)),
plus the v2 document and its downgrade effect under session persistence. Local
Mac server owns the plan read, `503` recovery, and the downgrade procedure.
Both documentation indexes route plan work to those sections. The public
index no longer says implementation has not started.

DRY audit of the final diff. Each shared rule has one owner:

- Statuses, bounds, and stored shapes: `plans/planModel.ts`.
- Tool input schemas, error codes, and the result envelope:
  `plans/planToolContract.ts`. `agentTools/jsonSchema.ts` derives every
  advertised JSON Schema, and `threadPlanTools.test.ts` checks parity.
- Names, descriptions, the unavailable text, the single handler, the standing
  instruction, and the turn context: `plans/planTools.ts`.
- Registration outcomes, the optional-turn notice, and combining an adapter's
  question tool: `runner/shared/agentToolSets.ts`.
- Transport conformance: `agentToolConformance.test.ts`, one suite
  parameterized over four adapter fixtures, including a non-plan probe tool.
- Apple DTOs: the shared package only; no app declares a plan type.

One native duplicate remains. The Swift status, step status, and pause reason
constants restate `PLAN_STATUSES`, `PLAN_STEP_STATUSES`, and
`PLAN_PAUSE_REASONS`, because Swift cannot import the TypeScript source.
`threadPlanSwiftContract.test.ts` holds them equal and validates the Swift
decode fixture against `threadPlanSchema`, including its UTF-16 emoji counts.
API.md lists the same spellings as the wire description.

Checks:

- `pnpm typecheck` and `pnpm --filter @agentroom/backend build` passed.
- `pnpm test` passed with 136 files and 1,479 tests passed, and 3 files and 11
  tests skipped.
- `swift test` in `apps/shared/AgentRoomClient` passed 104 tests, including 9
  in `ThreadPlanContractTests`.
- `xcodegen generate` ran for both apps. `AgentRoomMac` built for macOS and
  `AgentRoom` built for the generic visionOS Simulator, both unsigned.
- The compiled backend on 8799 with scratch state answered `/health` 200 and
  `/api/status` 200. The plan route answered 401 without a bearer and 404 for
  an unknown session with one. Only that process was stopped.
- `mirrorManifest.test.ts` passed 7 tests. `pnpm mirror:public --dry-run
  --source-ref 69bbf8ae` staged 963 files with no refusals.
- A link and anchor check over the changed docs found no broken links.

Verification outstanding, so the feature is implemented but not fully
verified:

- Claude Code under `default`, `acceptEdits`, and `dontAsk`, where the exact
  `allowedTools` entries must approve the plan tools without widening others.
- Codex `thread/resume` restoring a thread's dynamic tools, and a thread
  started before plan tools.
- Cursor model turns, blocked by the account's free plan, and managed DeepSeek
  model turns, blocked by no configured runtime.

The client read is verified: on 2026-09-29 the visionOS plan card read a live
plan from a compiled backend and followed `agent_plan_changed`. The client UI
plan, which stays out of the public mirror, records the check.

Outside this task: the Stage 4 Claude Code run showed the SDK child listing
the operator's claude.ai connectors although `settingSources` was empty. The
trust reference still does not describe that exposure.

### Review follow-up record

Recorded 2026-09-28 on `codex/agent-plan-tools` after a two-axis review
(standards and spec) of `main...HEAD`. Every finding was addressed:

- Codex restored threads. The session host keeps the tool names a thread
  declared beside its resumable id, so an idle reap no longer loses them.
  `AgentRunner.nativeToolRegistration` hands them to the service, which writes
  an optional `nativeToolRegistration` field in the v2 session document, and
  `rememberResumableId` passes them back after a restart when the stored
  thread id matches. The field sits beside the plan, outside the session
  summary. A thread with no record still has an unknown catalog.
- Unknown registration on an optional turn now puts the shared
  unconfirmed-tools notice in front of the prompt. `promptWithRegisteredTools`
  replaced the `checkToolRegistration` and `promptWithToolNotice` pair at all
  five adapter call sites and takes the runner's display name from its
  descriptor.
- Verified descriptors. The contract now defines "verified" as passing the
  shared transport conformance suite, so Cursor and DeepSeek keep advertising
  plan tools; their live model turns stay open checks. This was the user's
  decision.
- Advertisement fails closed. A config-gated descriptor advertises nothing
  when no configuration was supplied, and nothing is advertised without
  acknowledged storage.
- Liveness before the write. The session store asks a commit's `proceed`
  immediately before the write starts, after any earlier write; a refusal
  resolves `withdrawn` and the call reports `turn_inactive`.
- The plan read answers `503` while a turn-end pause or restart recovery is
  unsaved, not only while a commit outcome is unknown.
- Revision overflow. A mutation cannot take the last safe revision, which is
  kept for the system pause, so a running plan always pauses.
- `AgentSessionService` settles questions and plan bindings through one
  `endTurnTools` hook on every outcome path. Codex and Claude Code share
  `agentToolInputSpec` for the `{name, description, inputSchema}` projection.
- Docs. TRUST_AND_SAFETY and RUNNERS now say `canUseTool` exists only while
  clarifying questions are enabled. API.md no longer claims every optional
  turn is told its tools are unavailable. The contract points at the owning
  references for the route and event.
- Ledger entries for `DeepSeekHarnessRunner.ts`, `CodexAppServerRunner.ts`,
  `CursorSdkRunner.ts`, and `domain/models.ts` now match current sizes.

Two changes the review flagged as scope creep stay, with their reasons. The
DeepSeek adapter lets an optional turn continue with a notice when the
catalog changes on a live child, because this plan forbids destroying an
unresumable DeepSeek conversation to refresh tools. Cursor lost its
test-only `toolHandlers` constructor seam, because the session-supplied tool
set now reaches the relay through `combineRunnerToolSets`, as the DRY
requirements ask.

The live checks listed in the Stage 5 record remain open.
