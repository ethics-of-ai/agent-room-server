# Registered Runner Completeness

Status: **complete** — phases 1–4 landed 2026-08-17; phase 5's procedure landed
the same day as [ACP Real-Agent Conformance](ACP_CONFORMANCE.md), whose live run
is an operator action rather than a code change. Written 2026-08-17 against
`c626c15`, immediately after
the universal runner boundary plan closed. Successor to
[Universal Runner Boundary](UNIVERSAL_RUNNER_BOUNDARY.md); read that first, since
this plan assumes its registry, canonical event union, versioned settings, split
readiness, and ACP adapter.

A plan to finish the sentence the boundary plan started. Adding a coding agent is
now a registration on the backend. It is not yet a registration *end to end*: a
runner the backend registers can carry a trust setting no client renders, and can
ask a question no client can answer.

## The problem, concretely

The boundary plan's own acceptance criterion was **zero runner-specific visionOS
changes and zero runner-identity branches above the backend registry**, with
bespoke presentation left optional. That held. What it did not cover is the
difference between *presentation* and *reachability*:

- A configured ACP adapter's `permissionPolicy` is a **tier-2 trust setting**. It
  is served at both addresses by `GET /api/config`, accepted by `PATCH`, and
  resolved from the environment or the settings file. It renders in **no client**,
  because visionOS draws managed settings from a hand-written presentation
  catalog and the Mac holds a typed field per setting. An operator can hold that
  posture only by hand-crafting a request.
- `coding_permission_requested` / `coding_permission_resolved` are **display
  only**. There is no route by which a human answers one. So a runner that asks
  permission mid-turn has exactly two postures available to it: refuse
  everything, or the unattended `auto_allow` that Phase 7 gated behind
  `REMOTE_SETTINGS_ADMIN` and documented as `bypassPermissions`-class.

Both are the same shape of gap. The backend learned to describe a runner it was
not built with; the surfaces above it still need a *bespoke entry* to show or
answer anything.

## The rule this plan is built around

The boundary plan's rule was *generalize the dispatch, never the payload*. Its
successor:

> **The backend's answer is the client's only source, and a client with no
> bespoke entry must degrade to a generic one — never to nothing.**

A missing catalog entry may cost a good title, a grouped section, or a nicer
control. It may not cost the setting itself. This is the same rule Phase 4
already applied to runner *identity* — an unknown runner renders as itself rather
than being coerced or dropped — extended to what a runner *carries*.

The corollary is worth stating because it is the trap: rendering an unknown
setting generically means rendering it **from its metadata**, not from a guess.
Tier, value kind, `editable`, and `pendingValue` are already on the wire. A
client that infers any of them locally has reintroduced the "ready in the UI,
unusable by the backend" failure in a new place.

## Non-goals

- Reopening any boundary-plan decision. The registry, canonical union, settings
  document, split readiness, and ACP posture stand as landed.
- A universal permission enum. Codex's approval policy, Claude Code's permission
  mode, and an ACP adapter's `permissionPolicy` stay distinct, exactly as
  `docs/safety/TRUST_AND_SAFETY.md` documents them. Phase 2 adds a way to
  *answer* a request, not a way to reconcile three postures into one.
- Mac bootstrap readiness for ACP adapters. The Mac answers bootstrap readiness
  from **bundled** descriptors while the backend is stopped, and an ACP adapter's
  executable is named in the backend's environment, which the Mac does not read.
  So it genuinely cannot check one, and the Phase 6 rule already gives the right
  answer: a runner this build has no descriptor for contributes *no* local check
  rather than another runner's. Making it checkable would mean either serving a
  tier-3 path to the Mac or teaching the Mac to read the backend's environment —
  the first is remote code execution by configuration, the second breaks the
  works-while-stopped property. Left unsolved deliberately.
- Reintroducing a per-runner client catalog as a *requirement*. It stays an
  enhancement.

## Gap inventory

| # | Gap | Location | Phase |
|---|---|---|---|
| 1 | ~~Managed settings render only from a hand-written catalog~~ **closed** | `apps/visionos/.../ManagedBackendSettingDescriptor+Reported.swift` | 1 |
| 2 | ~~Mac holds a typed field per managed setting~~ **closed, read-only** | `apps/macos/.../PreservedManagedSettingRow.swift` | 1 |
| 3 | ~~Permission events are display-only; no answer route~~ **closed** | `routes/agentSessionRoutes.ts`, `runner/shared/PendingPermissionRequests.ts` | 2 |
| 4 | ~~`auto_allow` is the only non-refusing posture~~ **closed** | `runner/acp/config.ts` (`ask`), `AcpRunner.decidePermission` | 2 |
| 5 | ~~Image attachments refused for every ACP adapter~~ **closed** | `runner/acp/AcpRunner.promptContent`, `protocol.agentSupportsPromptImages` | 3 |
| 6 | ~~ACP runners advertise no models~~ **closed** | `runner/acp/protocol.ts` (`readSessionSettings`) | 4 |
| 7 | Real-agent conformance is manual and undocumented as a procedure | — | 5 |

---

## Phase 1 — Generic managed-setting rendering — **landed**

The smallest change that closes the widest gap, and the one to do first: a
tier-2 trust setting an operator cannot see is a posture they cannot hold.

visionOS renders a metadata entry with no catalog descriptor from the metadata
itself — a title humanized from the final path segment, the section derived from
its scope (`global`, or the owning runner's display name from
`GET /api/runners`), and a control chosen from the value kind: a toggle for a
boolean, a stepper or field for a number, a text field for a string, and a picker
only where the client actually knows the vocabulary. `editable` and
`pendingValue` keep their current meaning and stay the backend's answer.

The Mac's typed `ManagedBackendSettings` gains the same fallback for a runner
section it has no fields for. It already *preserves* unknown sections through a
write (Phase 4's reader-first release); this is about rendering them.

**Watch for:** a generic string control must not be offered for a key whose
vocabulary is closed — writing `sudo` into `permissionPolicy` should fail at the
PATCH, not look like a valid edit. Either the metadata gains the enum (a contract
change, so weigh it) or the generic control is read-only for values the client
cannot bound. Prefer the second until the first is justified: a visible read-only
setting is strictly better than an invisible one, and it is honest.

**Done when:** a synthetic runner registered with one setting of each value kind
renders, edits, and patches at the advertised address in both clients with **no**
catalog entry added; a configured ACP adapter's `permissionPolicy` is visible and
editable under `REMOTE_SETTINGS_ADMIN`; and `managedSettingsParity.test.ts` still
passes without a new Swift mirror row.

**Verify:** backend suite; `xcodegen generate` and a build for both apps;
a settings round-trip against a backend with one ACP adapter configured.

### What landed, and where it differs from the sketch above

- **The metadata gained the vocabulary.** `PublicManagedSetting` now carries
  `valueKind` and, where the declaration's schema is a closed enum, `options` —
  both derived from the declaration in `config/settingsStore.ts`, never
  tabulated. The "weigh it" call above resolved toward the contract change
  because this phase's own acceptance criterion requires `permissionPolicy` to be
  *editable*, and a read-only string is the only honest alternative when a client
  cannot bound the value. `valueKind` turned out to be load-bearing on its own:
  a setting with no default reports no `value`, so a client inferring shape from
  the running value would have had nothing to infer from. A vocabulary the schema
  does not state is still not synthesized — `runnerKind`'s values are the live
  registry's, and `GET /api/runners` remains where a client reads them.
- **Section from tier and scope, runner name in the title.** The sketch put an
  unfamiliar setting in a section named for its scope. It lands in the section
  its *tier* implies instead — trust settings under the caption that already
  explains the `REMOTE_SETTINGS_ADMIN` refusal, tier-1 runner settings with the
  other runner defaults — and the owning runner names the **row**
  ("Gemini CLI permission policy", from `GET /api/runners`). Both inputs are
  still metadata, and this adds no dynamic sidebar pane for what is often a
  single setting.
- **The Mac renders these read-only, deliberately.** The headset edits through
  `PATCH /api/config`, where the backend validates and refuses. The Mac writes
  the settings file *directly*, so nothing would refuse it: a value outside a
  vocabulary it cannot know would make the backend drop the **whole** file onto
  defaults and take the operator's entire trust posture with it. It shows the
  file's preserved sections — which it has always carried through a write
  untouched — and leaves them alone. This is the sketch's own preference applied
  where it actually bites: a visible read-only setting is strictly better than an
  invisible one.
- **One spelling across both clients.** `ManagedSettingLabel` in
  `apps/shared/AgentRoomClient` turns `permissionPolicy` into words, so the
  headset (naming from `/api/config`) and the Mac (naming from the file) cannot
  disagree about what a setting is called.
- **The free-text control is now one view.** `ManagedSettingModelField` became
  `ManagedSettingTextField` with optional suggestions, since a model id and an
  open-vocabulary string are the same control with and without a suggestion menu.

Still true after this phase: a client renders an unknown runner id as itself, and
`managedSettingsParity.test.ts` passes with no new Swift mirror row — the generic
path deliberately needs none.

---

## Phase 2 — Interactive permission approval — **landed**

The largest phase, and a **new trust surface** in its own right: it lets a client
authorize an action *inside* a running turn. It needs its own safety review and a
`docs/safety/TRUST_AND_SAFETY.md` section in the same change, per the standing
rule.

Today `session/request_permission` is answered by the adapter from a stored
policy. This adds the third answer: ask the human.

Required before any of it ships:

- **One authenticated route**, mutating and bearer-gated like every other
  mutation, answering a specific outstanding request id for a specific session.
  Not a general "run this" endpoint by another name.
- **Only an option the adapter supplied.** The route accepts an option id the
  backend is currently holding for that request, and nothing else. It never
  invents `allow_always`, and it cannot express an option the agent did not offer
  — the same constraint the conservative responder already honors.
- **A bounded wait with a conservative default.** An unanswered request must not
  hang a turn forever: after a timeout the backend answers as the configured
  policy would have, and says so on the resolved event. A turn that blocks
  indefinitely on an absent operator is a worse failure than a refusal.
- **Outstanding requests are per session, bounded, and in memory**, released on
  session deletion like every other per-session state.
- **Audit records the decision, not the payload.** Which option was selected, by
  which authority (human, policy, timeout) — never the tool input, which can
  carry anything the agent was about to run.
- **The posture stays per-runner.** This adds an answer channel; it does not
  reconcile Codex's approval policy, Claude Code's permission mode, and an ACP
  adapter's `permissionPolicy` into one enum.

The client half is a transcript surface: the request, its options, and what
happened — including when the answer came from a policy or a timeout rather than
from a person, since "who decided this" is the whole point.

**Done when:** a human answer, a policy answer, and a timeout answer are each
tested end to end against the synthetic agent; an option id the adapter did not
offer is refused; a deleted session releases outstanding requests; and the
`auto_allow` setting's documentation is updated to say what it now means in the
presence of a connected client.

**Verify:** backend suite plus new route tests; both apps built; a manual run
against a real agent that asks (the reference `codex-acp` does **not** — see the
Phase 0b findings — so this needs an agent that does, or the synthetic one).

### What landed, and where it differs from the sketch above

- **The third answer is a posture, not a presence.** The sketch's "done when"
  spoke of what `auto_allow` means "in the presence of a connected client", which
  reads as though a connected client is what makes the backend ask. It is not:
  `permissionPolicy` gained a third value, `ask`, and only that opens the
  channel. A connected client changes nothing about any posture — `auto_allow`
  still never asks, and `reject` still refuses immediately. The alternative was
  briefly tempting and is wrong twice over: a posture that changed with who
  happened to be listening would be no posture at all, and every turn under the
  default would have stalled for the timeout before refusing.
- **The wait is shared, not adapter-owned.** `runner/shared/PendingPermissionRequests.ts`
  holds outstanding requests for the same reason `PersistentRunnerSessionHost`
  holds children: a bounded per-session wait is not protocol. An adapter supplies
  the options and applies its own fallback; the store owns the id table, the
  clock, the cap, and the release.
- **Every request is announced, not only the ones a person will answer.** The
  adapter now emits `permission_requested` under all three postures. "The agent
  asked to run this and was refused" is the operator's own posture taking effect,
  and the transcript is where they see it happen; before this phase the ACP
  adapter emitted only the resolution, so a refusal looked like nothing at all.
- **Audit is a separate sanitized event, not a field on the canonical stream.**
  `agent_permission_resolved` carries the decision (request id, option,
  authority, status) and is what durable audit keeps, while
  `coding_permission_requested` keeps the tool call a client needs in order to
  offer the choice. Putting an `audit` block on the canonical payload would have
  mixed a durable-log concern into the client contract and, worse, invited the
  request itself into the log — exactly what the plan said not to persist.
- **Request ids are AgentRoom's, not the agent's.** The route addresses
  `permission-<uuid>` minted per request; an agent's own id space stays its
  business, and nothing a client sends is interpreted by the agent as an id.
- **One route, deliberately, with no pending-requests read beside it.** The
  artifact channel needed a REST re-seed because its deltas are dropped from the
  WebSocket greeting; permission events are not delta-class and are never
  dropped, so a reconnecting client re-derives an outstanding request from the
  same replayed stream it renders. A second route would have been surface with no
  gap under it.
- **The route reads no runner identity.** It calls an optional `AgentRunner`
  hook; a runner without one has no outstanding request either, which is the same
  `404`. That is what keeps the phase inside the boundary plan's standing rule
  rather than reintroducing a runner-identity branch above the registry.

**Not verified by this change:** a manual run against a real agent that actually
asks. The reference `codex-acp` resolves permissions internally (Phase 0b), so
the three authorities are covered against the synthetic agent and the real-agent
conformance run stays Phase 5's business.

---

## Phase 3 — Per-adapter prompt capability negotiation — **landed**

ACP advertises `promptCapabilities.image`. Accept image attachments for an
adapter that advertises it and keep refusing — explicitly, as now — for one that
does not. Small, self-contained, and it removes a blanket refusal that is
currently correct only because it is conservative.

**Done when:** an advertising synthetic agent receives image content blocks and a
non-advertising one still gets the explicit `AgentRunnerInputError`.

### What landed, and where it differs from the sketch above

- **The advertisement is a recording, not a question, so there is a third
  state.** `validateInputParts` is synchronous and runs *before* a turn exists,
  while `promptCapabilities.image` is only knowable from a handshake — so a
  fresh backend that has spawned this agent zero times has no answer, and the
  sketch's two outcomes are three. Treating unknown as "no" would have been the
  "not probed is not not-ready" mistake `runner/runtimeReadiness.ts` already
  names, and it would have refused a *capable* agent's first attachment for a
  reason that was about AgentRoom. So the adapter records the exact boolean each
  successful handshake advertised (the probe's included — it is the cheapest
  one, and every client reads `/api/coding-agent/capabilities` anyway) on that
  child. Synchronous turn-start validation refuses early only when all recorded
  answers agree on `false`; no observations or mixed answers defer to `run`,
  where the selected child's own handshake is authoritative. That can cost a
  failed turn instead of a `400`, but it is the honest failure: the answer for
  that child genuinely was not known when the request arrived, and one retained
  child's advertisement can never govern another.
- **Accepting images added an outbound bound, because it is the first thing
  AgentRoom sends that it did not compose.** ACP has no local-file image source,
  so an attachment is inlined as base64 on one line; the upload's 10 MB per-file
  cap times the turn's 8-attachment cap is ~107 MB of frame into an arbitrary
  child. `AcpLimits` gained `maxPromptImageBytes` (16 MB decoded per prompt) —
  the transport's only outbound limit, and the same reflex as its inbound ones.
- **A missing content type is its own refusal.** ACP requires `mimeType` on an
  image block, so the adapter checks it exactly as the Claude Code adapter checks
  `media_type`, rather than defaulting one and sending something the agent did
  not receive.
- **Nothing else on the boundary moved.** No `AgentRunner` signature change, no
  new route, event, or capability field, and no client change: an adapter that
  takes no images is still the same explicit `AgentRunnerInputError` a client
  already renders.

**Not verified by this change:** conformance against a real image-advertising
agent. The five paths (advertised, refused, the unknown window, mixed persistent
children, and the byte bound) are covered against the synthetic agent; a real
one stays Phase 5's business.

---

## Phase 4 — Model and mode discovery for ACP runners — **landed**

ACP v1 has no model-list method, so an ACP runner's capability descriptor is
empty and the clients render no model picker. The reference agent does expose
session modes and an `available_commands_update`, and there is a legacy
set-session-model extension method.

Decide — with evidence, as Phase 0b did — whether any of that maps onto
`CodingAgentCapabilities` honestly, or whether an empty descriptor is the correct
answer for v1. **An empty descriptor is an acceptable outcome for this phase.**
Inventing a model catalog an agent did not advertise would be the payload-
flattening mistake in a new place, and a picker that lists models the agent will
not honor is worse than no picker.

**Done when:** either a mapping exists with the reference agent honoring a
selection, or this document records why v1 cannot support one.

### The evidence, and why the premise above was wrong

The sketch's premise — "ACP v1 has no model-list method, so the descriptor is
empty" — is **true in its first clause and wrong in its conclusion**, which is
exactly the sort of thing the phase existed to check. Verified against the SDK's
published v1 `schema/schema.json` (`@agentclientprotocol/sdk` 1.3.0, the
conformance reference Phase 0b named) and against the wire log the Phase 0b spike
captured from the real `@agentclientprotocol/codex-acp`:

- There is indeed **no `session/set_model` and no `models` field** anywhere in the
  v1 schema. Searching it for "model" returns only prose and the two category
  constants below.
- But `NewSessionResponse` and `LoadSessionResponse` both carry
  **`configOptions`**: a list of `SessionConfigOption` selectors, each
  `{ id, name, description?, category?, type }` where `type: "select"` adds
  `{ currentValue, options: [{ value, name, description? }] }`. The setter is
  `session/set_config_option { sessionId, configId, value }`, which answers with
  the whole refreshed list, and `ConfigOptionUpdate` reports a change.
- `SessionConfigOptionCategory` is a **reserved, spec-level vocabulary**:
  `mode`, `model`, `model_config`, `thought_level`. The spec calls it "UX only",
  says it "MUST NOT be required for correctness", and requires clients to handle
  a missing or unknown category gracefully.
- The reference agent returns five selectors on `session/new`: `mode`
  (read-only / agent / agent-full-access), `collaboration_mode` (default / plan,
  under an off-spec category name), `model` (7 models), `reasoning_effort`
  (`thought_level`: low / medium / high / xhigh / max / ultra), and `fast-mode`
  (`model_config`: off / on). It **also** sends a non-schema top-level
  `models: { availableModels, currentModelId }` — the legacy extension the sketch
  half-remembered — which is the 33-entry model×effort cross product
  (`gpt-5.6-sol[low]`, …). That legacy field is deliberately **not** read: it is
  the same information the split selectors carry, pre-flattened, and preferring it
  would be the payload-flattening mistake handed to us ready-made.

So two spec categories map precisely to fields `CodingAgentTurnSettings` already
holds. The reference agent's `model_config` happens to be fast mode, but the
category itself is only a UX hint and may also name context size or several
independent controls. **A partial mapping exists**, and the honest answer for v1
is neither an empty descriptor nor a generic control mislabeled as speed.

### What landed, and where it differs from the sketch above

- **`model` → `models`, `thought_level` → `reasoningEfforts`; generic
  `model_config` stays unmapped** (`runner/acp/protocol.ts`,
  `readSessionSettings`). Category alone cannot distinguish the reference
  agent's fast mode from another compliant agent's context-size selector, and
  the protocol permits several controls in the category. Mapping the first one
  to `serviceTiers` would label all of those as "Speed" and hide the rest.
- **`mode` is excluded, and that is a safety decision rather than a missing
  shape.** It is the agent's own sandbox/approval posture — the reference agent's
  third value is described as "edit files outside this workspace and run commands
  with network access". A turn setting is chosen per turn by **any client holding
  the bearer token**, while every other runner trust posture (the Codex sandbox
  mode and network pin, the Claude Code permission mode, this adapter's own
  `permissionPolicy`) is a tier-2 managed setting a paired client can only change
  behind `REMOTE_SETTINGS_ADMIN`. Projecting `mode` into the model picker would
  put a sandbox-widening control on the composer with no such gate. It is the one
  finding of this phase that changes a boundary rather than filling one in, so it
  is written into `docs/safety/TRUST_AND_SAFETY.md` in the same change.
  `collaboration_mode` is excluded for the plainer reason: not a trust posture,
  but not a model setting either, and there is no field it belongs in.
- **Discovery still spawns nothing extra.** `configOptions` rides the
  `session/new` response the readiness probe already performs, so this phase
  added no protocol round trip, no second child, and no new route — the same
  "readiness is observed, not asked for" property Phase 6 of the boundary plan
  established.
- **The reasoning-effort vocabulary had to stop being a closed enum, and only for
  turns.** The agent offers `max` and `ultra`, which are outside
  `CodingAgentReasoningEffort`. Filtering them out hides a real capability;
  listing them under the old schema would have made a control that looks valid and
  fails at `POST /turns` — the trap Phase 1 named in a new place. So
  `codingAgentReasoningEffortIdSchema` bounds a **turn's** effort by shape, exactly
  as `model` and `serviceTier` already were, and the vocabulary is the advertising
  runner's. The closed enum stays where it is load-bearing: the
  `codexReasoningEffort` / `claudeCodeReasoningEffort` **managed settings**, whose
  vocabulary `/api/config` reports as their `options`. No Swift changed —
  `CodingAgentTurnSettings.reasoningEffort` was already `String?` on the client,
  which is itself a sign the backend enum was the outlier. `claudeCodeEffort`
  rejects an effort it does not recognize before a child is acquired, rather
  than silently running the turn at the CLI's default.
- **Application is session-scoped, because ACP is.** `session/prompt` takes
  content and nothing else, so a selection is applied with
  `session/set_config_option` before the prompt, and only where the requested
  value differs from the live one. A value the agent did not list is refused
  rather than forwarded, and so is a selection made against an agent that offers
  no such selector — silently dropping either would run the turn on something the
  operator did not choose and then report success. The agent's required complete
  reply replaces the whole record, since setting one option can move another,
  and must confirm that the requested value became current before the prompt is
  sent. An agent-initiated `config_option_update` is the same complete-state
  replacement even while the session is idle, preventing a later turn from
  skipping a necessary set against stale state.
- **A value AgentRoom cannot carry back exactly is dropped from the list**, not
  listed and then refused: the reference agent's ids are all representable, but
  the mapper filters each value through the same schema a turn is validated
  against and rejects any token that schema would normalize before sending it
  back.
- **Only `select` maps.** ACP also defines a `boolean` toggle;
  `CodingAgentCapabilities` has no shape for one, and inventing a two-value picker
  would be a projection the agent did not advertise.
- **An agent with no model selector still yields an empty descriptor**, which is
  the sketch's acceptable outcome, reached for the right agents rather than for
  all of them. The effort list is dropped with it, because
  `CodingAgentModelOption` is the only place the contract can hang them.

**Not verified by this change:** the sketch's "with the reference agent honoring a
selection". The mapping, the exclusions, the refusals, and the set-before-prompt
ordering are covered against the synthetic agent
(`test/acpRunner.test.ts`, "ACP session config discovery" and "ACP session config
application"), and the *shapes* they assert are the reference agent's own,
transcribed from the Phase 0b wire log. A live run against `codex-acp` needs
network and a provider credential, so it stays Phase 5's business — where the
first item on the procedure is now "select a model and confirm the agent honors
it".

---

## Phase 5 — Documented real-agent conformance — **landed**

Conformance against `@agentclientprotocol/codex-acp` is currently a manual check
that lives in one session's memory. It needs network and a provider credential,
so it must not be in CI — but it should be a **procedure**, not a recollection:
a documented script that registers the reference agent, probes readiness, runs a
turn, cancels one, and forces a restore, with the expected observations written
down.

**Done when:** an operator can run the conformance check from the repo without
reconstructing the setup, and the `CODEX_PATH` and isolated-`CODEX_HOME` details
the spike needed are recorded.

Phase 4 added a concrete observation to that list, and it is the one this plan
still owes: **select a model and confirm the reference agent honors it.** The
mapping, the `mode` exclusion, and the set-before-prompt ordering are covered
against the synthetic agent, and the shapes those tests assert were transcribed
from the Phase 0b wire log — but no live run has yet driven
`session/set_config_option` against `codex-acp` and seen the following turn use
the selected model. The procedure should also re-capture that `session/new`
response, since it is the record every mapping decision rests on.

### What landed, and where it differs from the sketch above

[ACP Real-Agent Conformance](ACP_CONFORMANCE.md) is the procedure, as eight
checks with their expected observations, a results template, and a
troubleshooting table. `session/set_config_option` is check C5 and re-capturing
`session/new` is C3, so both of the debts named above have a home. The setup the
spike had to reconstruct — `CODEX_PATH`, an isolated `CODEX_HOME`, and the
provider credential copied into it — is recorded as step-by-step setup rather
than prose.

Two things differ from the sketch:

- **It is a procedure with a launcher, not a single script.** A script that ran
  all eight checks end to end could not be exercised in CI or by its author (it
  needs network and a credential), so shipping several hundred untested lines
  would put the least trustworthy code on the path meant to establish trust.
  Every check is instead a command an operator runs and reads. The one piece
  that *is* code is `scripts/acp-conformance-agent.mjs`, a pass-through launcher
  that tees the NDJSON wire to a log — and it exists because C3 is otherwise
  impossible through the product path: the backend bounds and redacts the child's
  stderr, and deliberately never logs frames.
- **The launcher also answers the admission trap**, which is the setup failure
  most likely to cost the next operator an hour. `admission.ts` refuses a
  symlink, and a globally installed npm bin is one, so `$(command -v codex-acp)`
  is rejected by design. A real file in the repository is nameable directly.

What is *not* claimed: no live run has happened yet. The procedure's own
mechanics were verified against a stand-in agent — C1's admission and
availability projection, C2's "the capabilities read is the probe" readiness
observation, the launcher's byte-exact pass-through and signal forwarding, and
each documented admission outcome — but C3 through C8 assert things only the real
agent can prove. Recording that run is the operator action this phase hands over,
and the results template is where it goes.

---

## Sequencing

```
1  generic settings rendering   ← landed; smallest change, widest gap
2  interactive permission       ← landed; new trust surface, own safety section
3  prompt capability (images)   ← landed; small, independent
4  model/mode discovery         ← landed; concluded "yes", via configOptions
5  documented conformance       ← landed; the run is an operator action
```

Only Phase 2 had a hard prerequisite (its own safety review, landed as the
**Interactive permission approval** section of
`docs/safety/TRUST_AND_SAFETY.md`). Phases 3 and 5 are independent of each other
and of everything above; every phase is a stopping point.

## Questions with a home elsewhere

These belong to [Universal Runner Boundary](UNIVERSAL_RUNNER_BOUNDARY.md) and are
**not** restated here, because one question with two homes is how the two drift:

- **Residual question 1** — the concrete identifiers and retirement signal for the
  advertised compatibility floor, which governs both the legacy `codex` /
  `claudeCode` event blocks and the dual-address settings emission.
- **Residual question 3** — cross-process settings contention between the Mac and
  the backend, still last-write-wins. Phase 7 made concurrent edits to *different*
  runners more likely by giving each its own namespace, which strengthens the case
  for the optimistic-lock token already noted as hardening.
