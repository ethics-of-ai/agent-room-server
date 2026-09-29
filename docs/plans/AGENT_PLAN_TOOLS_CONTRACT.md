# Agent plan tools implementation contract

Implementation target for the [worker plan](AGENT_PLAN_TOOLS_PLAN.md),
2026-09-28. The feature is now implemented on `codex/agent-plan-tools`, and the
owning references hold current behavior:
[API](../api/API.md#thread-plans) for the route, request flag, and event,
[runners](../engineering/RUNNERS.md#thread-plan-tools) for transports, and
[trust and safety](../safety/TRUST_AND_SAFETY.md#thread-plans) for authority
and storage. Where this file and a reference differ, the reference wins.
Numeric bounds and wire spellings below are engineering defaults selected to
make the handoff executable. Product decisions live in the worker plan.
Apply its [DRY requirements](AGENT_PLAN_TOOLS_PLAN.md#dry-requirements) when
implementing every contract below; adapters translate these shared definitions
and call the shared handlers.

## Ownership and data

Store top-level optional `plan` and `planMutationReceipts` fields in the durable
session document, not inside the `session` summary returned through status.
Bump the durable document from v1 to v2. Migrate v1 in memory with no plan and
empty receipts; preserve native resume IDs and unknown runner IDs. Rewrite on
the next mutation, never solely because a document was read. Older builds must
refuse newer documents without rewriting them. Document that downgrade limit.

The plan has `id`, `revision`, `objective`, `completionCriteria`, `steps`,
`status`, `createdAt`, `updatedAt`, `lastModifiedTurnId`, `executionTurnId`,
`pauseReason`, `resumeNote`, and `summary`. Nullable values are explicit.
A step has `id`, `description`, `status`, `outcome`, and `lastBlocker`.
Plan and step IDs are backend-generated UUID-based strings. All plan, step,
and turn ID fields are bounded to 128 ASCII characters; timestamps are backend
UTC. System transitions preserve lastModifiedTurnId from the originating turn
when available, or use null on recovery without a known turn.
Revision starts at 1 for a fresh plan and increases on every accepted mutation,
including pause on settlement or restart. Replacement creates a fresh ID at
revision 1. Safe integer overflow is refused.

Plan statuses: `draft`, `running`, `blocked`, `paused`, `completed`, `cancelled`.
Step statuses: `pending`, `in_progress`, `blocked`, `completed`, `skipped`.
Resolved steps form a prefix; the first unresolved step is the current step.
At most one step is `in_progress` or `blocked`, and it must be current.
A running plan with all steps resolved is ready to finish; completion is never
automatic. Outcomes and blockers are concise agent reports, not transcripts.

## Tool input and output

All tool schemas are strict and reject unknown properties. Session and turn
identity come exclusively from the binding. Calls cannot supply another
session, runner, executable, path, or permission policy.

Every mutation requires `operationId`, generated once for that logical
mutation and reused verbatim on retries. Except first creation, every mutation
requires `planId` and `expectedRevision`. Validate both against current state.
Use one canonical zod schema per input and derive or parity-test every native
advertisement, including Claude's SDK schema. Keep aliases adapter-owned.

| Name and logical ID | Arguments beyond the mutation fields | Resulting behavior |
| --- | --- | --- |
| `create_plan`, `plans.create` | `objective`, `completionCriteria`, `steps: [{description}]`, `replace` default false. First creation omits `planId`/`expectedRevision`; replacement requires both. | Only creates when absent, or explicitly replaces the expected current plan with `replace: true`. Mint all IDs; status draft and steps pending. Existing plan plus replace false, or replace true plus absent plan, is a conflict. |
| `get_plan`, `plans.get` | Empty object; no mutation fields. | Read the current plan or explicit null. Never changes state or starts work. |
| `edit_plan`, `plans.edit` | Full desired `objective`, `completionCriteria`, and `steps: [{id?, description}]`. | Existing IDs retain status/outcome/blocker. Entries without IDs create pending steps. Omitted pending steps are removed. Resolved prefix must remain identical and ordered; retain the current in-progress/blocked step and its description. Reject duplicate/foreign IDs. Editing does not execute. |
| `execute_plan`, `plans.execute` | `resumeNote` required for paused/blocked, absent for draft. | Draft/paused/blocked becomes running; set executionTurnId to the bound turn, clear pauseReason, retain lastBlocker, and mark the current unresolved step in progress. If all steps are resolved, return readyToFinish true without creating a step. |
| `update_plan_step`, `plans.update_step` | `stepId`, `status` in in_progress/completed/blocked/skipped, and `note` required for completed/blocked/skipped. A note on in_progress is accepted and not stored. | Only the current step in a running plan may change. Pending may become in_progress or skipped. In-progress may become completed, blocked, or skipped. Completed/skipped sets outcome; blocked sets lastBlocker and blocks the plan. |
| `finish_plan`, `plans.finish` | `outcome` in completed/cancelled, `summary`. | Completion requires all steps resolved and prior execution. Cancellation is allowed from any nonterminal plan. Clear executionTurnId. Cancellation resets an in-progress step to pending, preserving notes. |

Terminal plans permit get or explicit replacement only. Editing may revise
pending work in any nonterminal state but cannot erase work already started or
resolved. To abandon or radically replace that work, use explicit replacement.
Reject no-op edits and unchanged statuses as invalid transitions. Every accepted
mutation advances revision; a duplicate receipt replay does not.

Results are JSON serialized into the existing string tool result, with
`schemaVersion: 1`, `ok`, and `plan` containing the current snapshot or null.
The catalog advertises a bounded string output; test the decoded envelope
against its own schema. Native adapters preserve that JSON text in their
ordinary text-result container.
A successful mutation also returns `operationId`, `appliedPlanId`,
`appliedRevision`, and `replayed`; the applied identity may differ from current
state when replaying a receipt after replacement. Include `readyToFinish` for
an executed plan whose steps are all resolved. Never present an old snapshot
as current state.

Errors carry a closed `code`: `invalid_input`, `limit_exceeded`,
`plan_not_found`, `plan_conflict`, `invalid_transition`, `operation_conflict`,
`tools_unavailable`, `turn_inactive`, `persistence_failed`, or `outcome_unknown`.
Provide a short safe message and current identity/revision when known, with
`plan: null` when a snapshot is unavailable. Conflict instructions say to call
get, reassess, and issue a new mutation; never automatically overwrite. A
transport refusal may use the existing catalog unavailable text. That text
must say no successful mutation was confirmed and to reread state, rather than
claiming a late call definitely made no change. Expected validation failures
return results rather than falling into generic dispatcher exception text.

## Bounds

| Value | Limit |
| --- | --- |
| Plans per thread | Zero or one, including terminal plans |
| Steps | 1–64 |
| Objective | 1–2,048 UTF-16 code units |
| Completion criteria | One nonempty string, at most 4,096 UTF-16 code units |
| Step description | 1–1,024 UTF-16 code units |
| Outcome, blocker, resume note | Nonempty when required; at most 1,024 UTF-16 code units each |
| Final summary | 1–2,048 UTF-16 code units |
| Operation ID | 1–128 ASCII characters matching `[A-Za-z0-9._:-]+` |
| Mutation input | At most 40 KiB serialized UTF-8 JSON |
| Stored plan | At most 32 KiB serialized UTF-8 JSON |
| Tool result | At most 40 KiB serialized UTF-8 JSON, below dispatch's 64 Ki-character ceiling |
| Turn plan context | At most 2 KiB UTF-8, metadata and a bounded current-step excerpt |
| Mutation receipts | Most recent 64 successful operations per session, retained across replacements |

Count text consistently with JavaScript/zod and test emoji in shared Swift.
Individual field limits and the aggregate bound both apply. Trim validation
may reject whitespace-only fields, but preserve accepted content consistently.
Reserve 1 KiB of the stored-plan allowance for backend lifecycle metadata:
model-authored candidate snapshots must fit 31 KiB. Automatic pause/recovery
uses fixed reason codes and bounded IDs, so it cannot exceed the remaining
space. Validate size before commit. Never truncate stored data or tool JSON.
Reducing a current-step excerpt for prompt context is permitted and marked as
an excerpt; `get_plan` always returns the full snapshot.

## Execution and settlement

`execute_plan` accepts draft, paused, or blocked; calling it on running is an
invalid transition unless it is a receipt replay. A resumed interrupted step
requires the resume note to explain the agent's reassessment. The backend
requires the note but cannot verify its truth. Keep the latest blocker even
when execution resumes, until replacement; it is evidence of prior difficulty.

While running, the binding's turn must match executionTurnId for progress and
completion. Blocked retains that turn identity until settlement. Completion
from paused or blocked is allowed only when all steps are resolved and a
previous execution occurred. Finish cancellation can close any nonterminal
plan. Summary must be nonempty; shared instructions require it to address the
criteria. The backend does not use a language model to judge the summary.

On normal turn end, failure, or cancellation, a running plan becomes paused
with reason `turn_ended`, `turn_failed`, or `turn_cancelled`; clear
executionTurnId. Preserve its in-progress step for reassessment. A blocked plan
remains blocked; clear its executionTurnId if set. Draft and terminal plans
remain unchanged. A running plan at hydration becomes paused with
`backend_restarted`, even if persisted turn status was already terminal.
Hydration repairs stale executionTurnId on blocked plans as well. Persist
recovery before accepting another plan mutation or execution turn. These
system transitions increment revision and emit metadata when clients are live.

Tool bindings become inactive immediately at turn end. Wait for pending plan
commit/settlement ordering before assembling the next turn's context, so it
cannot see the previous turn's plan as still running. No transition starts a
runner turn, executes a shell command, or changes existing permissions.

## Retry and persistence protocol

Receipts store operationId, logical tool ID, SHA-256 of canonical validated
arguments, applied plan ID/revision, and originating turn ID. They contain no
plan text and no old snapshots. Bound IDs as above; keep receipts under 1 KiB
each. Use deterministic key ordering for hashing; preserve array order.

Within one session's serialized mutation path, after validating liveness and
input, check retained receipts before checking expected current revision.
Matching identity and hash returns a replay acknowledgement plus the current
plan. The same operationId with changed content returns operation_conflict.
If no receipt exists, enforce all expected-ID/revision conditions before
applying. Evicted receipts have no replay guarantee: old requests safely fail
against advanced state and must never be rebased automatically. First-create
retries fail because a plan now exists; replacement retries fail because the
old plan ID is gone. Reuse after eviction is treated as a new request subject
to current preconditions; clients generate a new ID for new logical work.

Plan state and receipt must be persisted in the same session-document write.
If no acknowledged durable writer is configured, mutations return
tools_unavailable; tests may inject an explicit writer fake.
Unify plan commits, ordinary coalesced transcript/session writes, settlement,
and deletion through the store's existing per-session writer. There must be no
second writer or stale ordinary snapshot that can overwrite a committed plan.
Build each document from latest session content and the writer's committed
plan state, with an explicit candidate override only for that mutation.

Serialize mutation acceptance, check originating-turn liveness immediately
before starting its write, and publish the committed in-memory plan, events,
and success only after the write succeeds. A cancellation before acceptance
refuses the mutation. Cancellation during an already-accepted write does not
roll back a commit; suppress its stale tool result and queue the settlement
transition after it. Native-call liveness and revision checks still apply to
later invocations. This ordering must be demonstrated with controlled promises.

Failure before commit preserves the old plan and exposes persistence_failed.
If write completion is ambiguous, expose outcome_unknown, reconcile the
session file/receipt under the same writer, and prevent subsequent writes from
overwriting unresolved state. A retry uses the original operationId. A crash
after commit but before response is recovered through the durable receipt.
Deletion closes admission, waits out in-flight writes, removes the document,
and prevents resurrection. Success promises recovery after backend process
restart; power-loss durability beyond the existing file-store guarantees is
not claimed. Test failure injection around write and rename explicitly.

## Readiness, reads, and events

Plan advertisement is on by default for verified descriptors. A descriptor is
verified once its transport passes the shared tool conformance suite; live
model-turn evidence is tracked separately as an open check and does not gate
advertisement. Make `prepareAgentRunnerToolSet` accept an explicit `required`
policy. Add optional `context.planToolsRequired: boolean` to the turn request,
default false, with zod and shared DTO coverage. This flag requires tool
readiness only; it neither executes a plan nor changes permissions. Propagate
it into the bound tool set. Do not infer required readiness by parsing message
text.

Reject a request requiring an unsupported descriptor with 409 before starting
a turn. Native readiness failure after acceptance fails that turn explicitly.
Ordinary turns retain existing optional-tool behavior, and their context must
distinguish advertised capability from successful native registration. Initial
context may report readiness as unverified; only the adapter's handshake can
confirm it. An optional fallback prompt must report registration failure, or
that registration could not be confirmed, if the model turn still proceeds.
Shared instructions say that unavailable tools cannot be replaced by a claim
that a plan was saved. Preserve existing question readiness and gates when
combining tool sets.

The plan read route and the `agent_plan_changed` event are specified in
[API thread plans](../api/API.md#thread-plans), and their exposure limits in
[trust and safety](../safety/TRUST_AND_SAFETY.md#thread-plans). Add no HTTP
mutation route or generic tool-execution endpoint. Keep plan content out of
session lists, status snapshots, new audit entries, and dispatcher telemetry.

## Reference lifecycle for integration tests

Use fresh operation IDs for each mutation below. Every mutation after creation
supplies the preceding plan ID and revision. Keep the same AgentRoom thread
throughout. This scenario covers all six tools and settlement between turns.

| Action | Expected state |
| --- | --- |
| Turn A: create a two-step plan | P1 revision 1, draft, both pending |
| Edit the second pending step's description | P1 revision 2, draft, IDs retained |
| Execute | P1 revision 3, running, first step in progress |
| Complete first step with an outcome | P1 revision 4, second step pending |
| Start second step | P1 revision 5, second step in progress |
| Block second step with a reason | P1 revision 6, blocked |
| End turn A | P1 revision 7, blocked, executionTurnId cleared |
| Turn B: get | P1 revision 7, unchanged |
| Execute with a resume note | P1 revision 8, running, second step in progress |
| Complete second step | P1 revision 9, ready to finish |
| Finish completed with summary | P1 revision 10, completed |
| End turn B | P1 revision 10, unchanged |
| Turn C: explicitly replace P1 at revision 10 | P2 revision 1, draft, fresh step IDs |
| Replay the original create with its retained operationId | Acknowledge applied P1 revision 1, return current P2 revision 1, no mutation |
| Attempt to update a P1 step with a new operationId | plan_conflict; P2 unchanged |

Also interrupt a running plan, restart the backend, reread its paused state,
and resume through a fresh binding. This separate case verifies recovery rather
than treating the blocked-turn example as evidence of restart behavior.
