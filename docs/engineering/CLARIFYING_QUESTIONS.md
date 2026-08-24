# Clarifying Questions

Status: **Phases 1–4 landed for the three bundled runners** (backend channel +
Claude Code adapter, the Codex adapter, the shared client + visionOS deck, then
the DeepSeek Harness prompt-contract adapter, 2026-08-23). ACP remains
explicitly `none`. Written after
[Registered Runner Completeness](REGISTERED_RUNNER_COMPLETENESS.md) closed, and
it assumes that plan's answer channel for permissions: the shared waiting store,
the optional `AgentRunner` hook, the one bearer-gated route, audit of the
decision alone.

A plan to let a coding agent ask for direction. When a turn is ambiguous,
today's agents either guess or write prose questions the user answers in free
text. AgentRoom had no typed channel for "the agent wants a decision": no event
a client can render as choices, no route that carries the answer back, no
runner hook that delivers it.

## The feature

Mid-turn, the agent raises one *batch*: one or more *sets*. A set is one
question — a prompt, the options the agent offers, whether one or several may
be chosen, and whether free text ("discuss further") is accepted beside a
choice, instead of one, or not at all. The person answers the sets they can
and submits the batch once; the turn continues with the answers. visionOS
renders the batch as spatial options in a deck beside the thread.

Three decisions were taken with the operator before any code:

- **A set is one question.** n sets = n questions. This maps one-to-one onto
  both native mechanisms (Claude Code's `AskUserQuestion`, Codex's
  `request_user_input`), and the deck tabs over sets.
- **The answerable deck is a trailing ornament on the visionOS workspace
  window and an upright deck on the workspace scene base.** The volume's runner
  buddy signals while that scene deck takes priority over the live sketch.
- **Submit is allowed once at least one set is answered.** Skipped sets are
  reported to the agent as unanswered, the way both native tools already allow;
  a set whose discussion is `required` is not answered until that text is
  nonblank, even when it also offers options.

## The rule this plan is built around

> **Answering a question authorizes nothing, and the channel never puts words
> in the person's mouth.**

The first half is what keeps this a tier-1 preference rather than a tier-2
trust setting: a question answer is the person's own choices and words going
back to an agent that asked for them — the same class of input as the turn
message — where a permission answer lets an agent *act*. The second half is
what shapes every fallback: a timeout is reported as a timeout (the agent is
told nobody answered and to proceed on its best judgment), a cancelled turn
resolves the batch as cancelled, and no path ever selects a default option on
the person's behalf.

Everything else follows the boundary plan's standing rules: generalize the
dispatch, never the payload (two canonical kinds, the mapper reads
`canonical.kind`, no file outside `runner/` reads a runner id); one route; ids
minted by AgentRoom so nothing a client sends is a string the agent interprets
as an id; bounded like everything else on the stream; audit the decision, not
the words.

## Non-goals

- A universal "ask the user" enum across runners. Claude Code's tool and
  Codex's request stay their own protocols inside their adapters; what crosses
  the boundary is the canonical pair and the shared wait.
- Routing Claude Code's other permission prompts through the same callback
  into the permission `ask` channel. The callback is now in place and the
  posture note in `docs/safety/TRUST_AND_SAFETY.md` anticipates it, but it is a
  separate trust decision and stays out of this plan.
- A bump of `CODING_EVENT_CONTRACT_VERSION`. Both event types and both
  canonical kinds are additive, their fields optional or self-contained, and
  the Swift event/kind types are lossless `RawRepresentable`; a client that
  predates them ignores them.

## Phase 0 — spikes (throwaway, never in the repo) — **done**

Two scripts in the session scratchpad, against the bundled SDK/CLI and the
ChatGPT-bundled Codex, to pin the facts the adapters would be built on.

**Claude Code** (SDK 0.3.172, bundled CLI 2.1.172, `bypassPermissions`):

- `AskUserQuestion` reaches the SDK `canUseTool` callback with
  `{ questions: [{ question, header, options: [{ label, description }],
  multiSelect }] }` and `toolUseID`; `title`/`decisionReason` are unset. Under
  `bypassPermissions` no other tool reaches the callback (read-only and
  mutating tools were both exercised); under `default`, a mutating `Write` does,
  and a `deny` from the callback is relayed to the model as the tool error with
  nothing written — so refusing every other tool preserves today's headless
  posture exactly.
- Answer shapes and what the model then reads:
  `updatedInput.answers[question] = "Label"` or `"L1, L2"` plus
  `annotations[question].notes` → `Your questions have been answered: "Q"="L"
  notes: …, "Q2"="L1, L2" notes: …`; `"(notes only)"` → `"Q"=(no option
  selected) notes: …`; an omitted question is simply absent; `response: text`
  → `The user responded: text`; `answers: {}` with `afkTimeoutMs` → `The user
  did not answer the questions.` — after which the model re-asked. The timeout
  fallback therefore uses `response` with an explicit away message rather than
  `afkTimeoutMs`.
- `query.interrupt()` aborts the callback's `signal`; a `deny` returned then
  yields an `is_error` tool result and an `error_during_execution` result.

**Codex** (`codex-cli 0.149.0-alpha.4.1`, `app-server --listen stdio://`):

- With `thread/start.config = { tools: { experimental_request_user_input:
  { enabled: true } }, features: { default_mode_request_user_input: true } }`
  the agent raises the server→client request `item/tool/requestUserInput`
  (`questions[{ id, header, question, isOther: true, isSecret: false,
  options[{ label, description }] }]`, `isBlocking: false`,
  `autoResolutionMs: null`; the first option's label carries a
  `(Recommended)` suffix). Without the flags the model reports the tool is
  "unavailable in Default mode".
- The response `{ answers: { [question.id]: { answers: ["Label"] } } }` is
  accepted; a free-text string in place of a label reads to the model as
  "Other — text"; an omitted id reads as unanswered; a `serverRequest/resolved`
  notification follows. The turn waits for the response despite
  `isBlocking: false`.
- `thread/resume` with the same `config` keeps the tool. A `-32601` error reply
  does not wedge the thread: the turn completes with every question reported
  unanswered.
- The model-facing tool requires non-empty options per question and the model
  declined to mark a question secret, so `isSecret` and `options: null` are
  defensive mappings rather than observed shapes.

## Phase 1 — backend channel + Claude Code adapter — **landed**

- `runner/shared/PendingRequests.ts`: the id-table/clock/cap/release core
  extracted from the permission store; `PendingPermissionRequests` delegates to
  it with its public API and tests unchanged.
- `runner/shared/PendingQuestionRequests.ts`: bounds (8 sets × 8 options,
  header ≤ 24, prompt ≤ 1000, label ≤ 200, description ≤ 500, discussion
  ≤ 4000, 10-minute clock), `wait`/`answer`/`cancel`/`releaseSession`, and the
  pure `validateQuestionAnswers` the route's refusals come from.
- `runner/AgentRunner.ts`: `question_requested { requestId?, questionSets }` /
  `question_resolved { requestId?, status?, decidedBy?, questionAnswers? }` on
  the canonical union; the optional `answerQuestionRequest` hook.
- `protocol/coding`: schemas, mapper cases, bounded helpers (text clamped, ids
  exact, a batch outside its bounds produces no event).
- `events/eventTypes.ts` + `state/FileAuditLogStore.ts`:
  `agent_question_resolved`, durable, audit without free text.
- `agent/AgentTurnEventApplier.ts`: the per-session outstanding map, the
  durable decision, and the rendered answer appended to the thread as a
  `role: "user"` message (`agent/questionTranscript.ts`,
  `context.questionRequestId`).
- `agent/AgentSessionService.ts` + `routes/agentSessionRoutes.ts`:
  `POST /api/agent-sessions/:sessionId/questions/:requestId` (global bearer
  preHandler; 400 per refusal, 404 not outstanding) and the bearer-gated
  `GET …/questions` re-seed.
- `clarifyingQuestionsEnabled` (tier 1, env `CLARIFYING_QUESTIONS_ENABLED`,
  default on) declared in `config/settingsStore.ts`, mirrored in the Mac and
  visionOS key enums (parity-pinned), documented in `.env.example`.
- Claude Code: `claudeCode/askUserQuestion.ts` (pure mapping),
  `claudeCodeQueryOptions` takes `canUseTool` (only while enabled, never for the
  probe), `ClaudeCodeRunner.decideToolUse` holds the batch open, pushes the
  canonical pair onto the turn's queue, cancels on `signal`, and refuses every
  other tool with the CLI's own headless wording.
- Docs: `docs/api/API.md`, `docs/safety/TRUST_AND_SAFETY.md` (*Clarifying
  questions*), `docs/architecture/MOVING_PARTS.md`, `ARCHITECTURE.md`,
  `AGENTS.md`, `CLAUDE.md`, `RUNNER_CAPABILITY_MATRIX.md`.
- Tests: `pendingQuestionRequests`, `askUserQuestion`, `claudeCodeQuestions`,
  the mapper cases in `canonicalCodingEvents`, the HTTP flow in
  `agentSessions` (route statuses, re-seed read, thread record, audit without
  free text), parity.

### What landed, and where it differs from the sketch

- **The re-seed read exists here and not for permissions.** A permission
  request settles in minutes and is re-derived from the replayed stream; a
  question batch can stay outstanding for ten while the turn is stuck on it,
  which is long enough for the 200-event replay to roll over. The read is
  gated like `/messages` because question text is model-authored.
- **No registry descriptor field yet.** Nothing above the adapters decides
  anything from how a runner asks; the field arrives with Phase 4, when the
  assembler first has to.
- **The timeout answer is a `response`, not the CLI's AFK marker** — Phase 0's
  finding above.
- **Codex's `discussion` defaults to `optional`**, because the observed
  `isOther: true` on every question and the tool's own description ("the
  client will add a free-form Other") say free text is always on offer; only an
  optionless question maps to `required`.

## Phase 2 — Codex adapter — **landed**

- `runner/shared/JsonRpcLineClient.ts`: `onRequest(handler)` + `respond(id,
  {result}|{error})`; a server→client request with no handler, or a method the
  handler refuses (`JsonRpcMethodNotFoundError`), gets `-32601 Method not
  found` plus a warn log — a change from the silent drop that hung a turn;
  DeepSeek (same client) sends none.
- `runner/codex/userInput.ts`: the pure mapping (zod-validated request; minted
  ids; `selection: "single"`; `discussion` `optional` because the tool's own
  contract adds a free-form Other, `required` for an optionless or secret
  question; `isSecret` ⇒ `sensitive`) and the response keyed by the agent's
  question ids (labels plus free text; unanswered ids omitted; anything but a
  human answer is an empty map).
- `CodexAppServerRunner.decideUserInput`: holds the batch open, announces the
  canonical pair on the turn's queue, strips a sensitive set's text from the
  resolved event, and releases the wait with the turn, the child, and the
  session; `handleJsonRpcRequest` refuses every other method.
- `runner/codex/settings.ts`: the two flags ride the thread `config` (with the
  network pin) on `thread/start` and `thread/resume`, pinned true while
  `clarifyingQuestionsEnabled` is on and false while it is off so global Codex
  config cannot re-enable the tool.
- Tests: `codexQuestions` (round trip against a fake app-server, secret kept
  off the stream, timeout, `-32601` for an approval request, false pins and an
  empty defensive response when disabled), `jsonRpcLineClient`, the narrowed sandbox assertion in
  `codexJsonRpcRunner`. Smoke: the real ChatGPT-bundled codex 0.149 through the
  compiled backend — request mapped (two single-select sets), a second pick on
  a single set refused with 400, answer accepted, turn completed with the
  agent echoing the choices and the note.

### What landed, and where it differs from the sketch

- **A Codex set is always single-select.** The tool offers "mutually
  exclusive" options and the response is a list only because free text can
  ride beside a label; the client renders it as a single choice plus the
  discuss-further field.
- **Nothing about the approval family changed except the silence.** Under the
  default `approvalPolicy: never` no approval request arrives; under a
  prompting policy one used to hang the turn and now gets `-32601`, which the
  app-server treats as a refused request. Routing those requests to the
  permission channel remains a separate decision.

## Phase 3 — shared client + visionOS — **landed**

Preflight: ornament, not sheet or inline (10076 t=1047, t=1141; t=1232 and
t=1177 rejected); two-tier picker like `SpatialSceneRolePaletteView` (10076
t=979/t=1035); 60-pt targets (t=636/t=676); rounded, alike option cards with
system hover (10073 t=312/t=548, 10076 t=724); text entry (10073 t=639).

- Shared client: `CodingQuestionSet/Option/Answer`, the event-type and kind
  statics, `CodingAgentEventPayload.questionSets/questionAnswers`,
  `AgentSessionMessageContext.questionRequestId`,
  `APIClient.answerQuestionRequest` and `outstandingQuestions`.
- visionOS: `CodingQuestionRequestState` and the reducer cases (a terminal
  record is never reopened by a late request), `CodingQuestionDraft` +
  `CodingQuestionDraftStore` on the window model, `AppAction
  .answerQuestionRequest`, the `CodingQuestionDeckView` family as a trailing
  ornament on `WorkspaceChatColumn` (segmented over set headers for ≤ 4 sets,
  menu beyond; option cards; discuss field; "k of n answered" + Submit), the
  compact `CodingQuestionRequestView` record, buddy attention, a "needs your
  answer" badge/notification, the re-seed on session select.
- Optional slice 3b: lift drafts to `AppStore` and mount the same deck on the
  workspace scene volume.

### What landed, and where it differs from the sketch

- **The deck is one file per view, as the SwiftUI standards ask**:
  `CodingQuestionDeckView`, `CodingQuestionSetView`, `CodingQuestionOptionCard`,
  `CodingQuestionDiscussionField`, `CodingQuestionDeckFooter`, and the
  `CodingQuestionDeckPresentation` bundle the chat column threads through; the
  record is `CodingQuestionRequestView`. `swiftModelStructure.test.ts` pins one
  owning file per type and `visionosProject.test.ts` pins the deck to the chat
  column's trailing ornament.
- **A property named `set` is a parse hazard in a computed property body** (it
  reads as the setter keyword); the views name it `questionSet`.
- **Attention reuses the settle machinery but not its gate**: a batch is not a
  settlement, so `handleQuestionAttention` runs on every socket event, dedupes
  per request id, and adds `Outcome.needsAnswer` to the one badge vocabulary
  rather than a second badge.
- **The re-seed runs on session selection and on the status-snapshot
  reconnect**, beside the artifact re-seed, through
  `AppStore.refreshOutstandingQuestions`; reconnect reads every active session
  and every session with a locally outstanding deck, reconciles requests that
  disappeared without racing a newer live event, and records a seeded batch's
  turn as running when the replay lost its start. Including the local set lets
  a missed terminal resolution clear a deck even after the refreshed session
  is no longer active.
- **The deck is found on the turn that asked.** The window and the buddy
  locate a batch through the session's latest turn, and `latestTurnId` now
  takes the latest *started* turn, falling back to assistant text only when
  no turn events are known. The first field test (2026-08-23) had it the
  other way round: a turn that asks before it says anything — both runners'
  usual order — left the lookup on the previous turn, and the deck never
  appeared while the batch ran to its timeout.
- **The deck can be closed without answering.** A close control in the
  header hides the deck for that batch in this window; the batch stays open,
  the draft is kept, and the transcript card's Answer button brings the deck
  back. Dismissal lives on `CodingQuestionDraftStore` beside the drafts, as
  its own observed property so keystrokes in a draft do not re-render the
  window. Nothing is sent: the channel still never answers for the person.
- Tests: the reducer cases (answerable batch through to its answer, no id ⇒
  not answerable, timeout and an unknown status, a resolution that outran its
  request, re-seed without duplicates), `CodingQuestionDraftTests` (single
  replace/clear, multi toggle, omitted sets and uninvited free text dropped,
  the 4000-character clip, offered-id filtering, the bounded store, the
  segment target floor), `QuestionAttentionTests` (badge for a thread off
  screen, none for a visible one, once per request id, none without an id,
  cleared by the resolution and leaving a settle badge alone).
- **The workspace scene deck is built.** An upright, single-column deck replaces
  the live artifact base while a batch is answerable, keeps its command row
  fixed, uses 60-point question controls, and shares the same answer route and
  validation while retaining a presentation-local draft.

## Phase 4 — DeepSeek Harness prompt contract — **landed**

- `RunnerDescriptor.clarifyingQuestions` is the dispatch policy:
  `{ mode: "native" }`, `{ mode: "prompt_contract", instruction }`, or
  `{ mode: "none" }`. Codex and Claude Code are native; DeepSeek owns its
  prompt instruction on the prompt-contract row; external ACP adapters remain
  `none`. The field and instruction are deliberately absent from
  `GET /api/runners`' safe/public projection.
- `AgentTurnContextAssembler` injects the descriptor-owned instruction only for
  a prompt-contract runner and only while `clarifyingQuestionsEnabled` is on.
  No file outside `runner/` branches on DeepSeek's id, and another prompt-
  contract runner cannot inherit DeepSeek's grammar by accident.
- `deepseek/promptQuestions.ts` recognizes one line-start
  `<agentroom-question>` JSON block per Harness protocol turn. The parser holds
  at most 64 KiB, zod-validates the same 8-set × 8-option vocabulary and text
  caps as the shared store, mints every set and option id, and removes only a
  complete valid block from assistant prose. Inline, malformed, incomplete,
  oversized, and later blocks remain visible prose rather than disappearing.
- `DeepSeekHarnessRunner` maps a valid block into the same canonical
  `question_requested` event and `PendingQuestionRequests` wait as the native
  adapters. The first Harness protocol turn may finish, but the AgentRoom turn
  stays running. A human answer, timeout, or unavailable wait becomes a second
  `session/prompt` on the live Harness session; only the continuation's final
  `turn/end` settles the AgentRoom turn. Answers sent to Harness contain the
  option labels and the person's discussion, never AgentRoom ids. Timeout and
  unavailable paths name the absence and ask the model to use its best judgment
  without selecting an option.
- A `sensitive` set's discussion reaches that continuation prompt but is
  removed from the canonical resolution before the shared transcript and audit
  paths see it. Cancellation, child loss, session close, and disposal release
  the pending wait with the same lifecycle as the native adapters.
- Tests cover the streaming parser, invalid-control passthrough, minted ids,
  timeout, the kill switch, a fake SDK runtime's two-prompt continuation, and
  the complete HTTP flow: request event, re-seed read, answer route, sensitive
  transcript redaction, durable decision, and completed turn.

### What landed, and where it differs from the sketch

- **The continuation stays inside the original AgentRoom turn.** The sketch's
  `next_turn` design would have ended the asking turn and called
  `AgentSessionService.startTurn` from the answer route. That would have made a
  private adapter concern alter the core service, split one user-visible action
  into two transcript turns, and lost the existing mid-turn request semantics.
  Keeping the runner's async iterator open across two Harness protocol turns
  lets the existing route, canonical events, visionOS deck, message record,
  audit, cancellation, and timeout behavior work unchanged.
- **ACP did not inherit the convention.** ACP v1 has no portable user-question
  request, and an operator-defined agent has not agreed to AgentRoom's prompt
  syntax. Its descriptor stays `none` until a separate rollout proves a
  contract.

## Verification

Backend: `pnpm typecheck`, `pnpm --filter @agentroom/backend build`,
`pnpm test`; the smoke in `docs/operations/LOCAL_MAC_SERVER.md` plus: create a
`claude_code` session, send "Use AskUserQuestion to ask me which of two colors
I prefer, then say which I chose", watch `WS /api/events` for
`coding_question_requested`, answer with `POST …/questions/$R`, expect
`coding_question_resolved { decidedBy: "human" }`, the turn completing, the
user message in `/messages`, and `agent_question_resolved` in `/api/audit`
without the free text; repeat with Codex. For DeepSeek, use a trusted scratch
workspace and ask it to use its AgentRoom clarification block before proceeding;
expect one AgentRoom turn to remain running across the request and the follow-up
Harness prompt, then complete after the answer. Repeat with
`CLARIFYING_QUESTIONS_ENABLED=false` and confirm no question block is requested
or intercepted.
