# Runner architecture and maintenance

This document owns AgentRoom's current cross-runner design. Protocol details stay
with each adapter. Trust decisions stay in
[`TRUST_AND_SAFETY.md`](../safety/TRUST_AND_SAFETY.md), and wire behavior stays
in [`API.md`](../api/API.md).

## Boundary and registry

`AgentRunner` is the only runner interface used by session code. Each adapter
maps its native protocol into `CanonicalActivity` plus `RunnerMetadata` before
an event reaches `apps/backend/src/protocol/coding`.

`apps/backend/src/runner/registry.ts` owns every cross-runner behavioral fact:

- `promptDelivery`
- `turnDiffSource`
- `clarifyingQuestions`
- `agentTools`
- `workspaceSkills`, `skillSourceDirs`, and `skillInvocationPrefix`
- `settingsKeyPrefix` and runner-owned managed settings
- `restoreStrategy`
- `isConfigured`
- `displayName`, for presentation only

Code above `apps/backend/src/runner` and the registry must use those fields. It
must not branch on a runner id. Native payloads and trust vocabularies remain
adapter-owned. In particular, an approval policy, a permission mode, and a
sandbox flag are not one universal permission enum.

`registeredRunnerKinds` is the built-in admission list. The domain runner-id
schema derives from the live registry, which also includes any admitted
`acp_*` adapter. Adding a built-in id is a compatibility decision because the
id can enter `global.runnerKind` in the managed settings file. An older build
treats an unknown value for that known key as an unusable file. Keep the Mac
downgrade guard and update its compatibility vocabulary with any new built-in.

## Current runner policies

| Runner | Prompt | Turn diff | Questions | AgentRoom tools | Workspace skills | Restore | Configured when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `codex` | Per turn | Native runner diff | Native request | App-server dynamic tools in JSON-RPC mode: plans | Always, from `.codex/skills` then `.agents/skills`; `$` invocation | `native_resume` | `CODEX_EXECUTABLE` exists in config |
| `claude_code` | Stable SDK system prompt | Settlement Git delta | Native `AskUserQuestion` | In-process SDK MCP server: plans | Gated by the adapter's workspace-settings rule; `.claude/skills`; `/` invocation | `native_resume` | Always, because the SDK resolves its CLI |
| `deepseek` | Per turn | Settlement Git delta | Native tool in managed mode; prompt contract in custom mode | Private Cordis-pipe relay: questions, plans | None advertised | `unsupported` | Executable and Cordis composition are both configured |
| `cursor` | Per turn | Settlement Git delta | Native custom tool callback | Custom-tools relay: questions, plans | Gated by project settings; all four workspace skill directories; `/` invocation | `native_resume` | Always, because the SDK is bundled |
| `acp_*` | Descriptor-owned | Descriptor-owned | None in the current external adapter | None | Descriptor-owned | A restore path is required at admission | Its admitted executable definition is present |

The registry and `apps/backend/test/runnerRegistry.test.ts` are the executable
source for this table. Update the guide when a classification changes. Do not
copy the table into client docs or shared guidance.

## Claude Code

`ClaudeCodeRunner` uses the Claude Agent SDK with one persistent SDK session
and spawned `claude` process per AgentRoom session. It streams partial message
deltas, cancels through the SDK's `interrupt()`, and resumes with the SDK's
native session id. The adapter owns SDK event mapping and the exact permission
mode vocabulary.

A turn the CLI rejects before calling the model, such as a signed-out CLI,
arrives as a `success` result with `is_error` set. The adapter fails the turn
with the result text rather than the subtype.

Capability discovery reads `accountInfo()` from the same isolated child that
answers `supportedModels()`. Neither is a model call. A first-party provider
that reports `tokenSource: "none"` and no API key source fails the
`claude_login` check as `unavailable`. A `claude auth login` subscription
omits `tokenSource`, so a missing field reads as signed in. Bedrock, Vertex, and gateway providers always pass. The probe
loads no project settings, so a workspace whose project settings supply an API
key helper can read as signed out here and still run turns.

Project settings, billing, and isolation are trust decisions rather than runner
architecture. See
[`Claude Code workspace configuration and billing`](../safety/TRUST_AND_SAFETY.md#claude-code-workspace-configuration-and-billing).

## Canonical events and compatibility

Adapters produce a discriminated canonical activity. The shared mapper dispatches
on `activity.canonical.kind`, not a native kind prefix or runner id. An
unmapped native event produces no `coding_*` event. Native detail may remain in
the bounded `native` block for diagnostics.

Clients decide what an activity is from `activity.canonical` and correlate it
with the runner envelope and stable tool id. Event types, canonical activity
kinds, and runner ids are open vocabularies in clients. Unknown values must
degrade to generic presentation.

The `codex` and `claudeCode` metadata blocks are projections built only by
`legacyMetadata.ts` and `legacySessionMetadata.ts`. Remove them only after
`codingEventContractVersion` moves past 2 and every supported client accepts
the newer floor.

## Persistent child lifecycle

`runner/shared/PersistentRunnerSessionHost.ts` owns child registration,
activity touches, idle timers, teardown, and resumable ids. Adapters supply
spawn, restore, and teardown behavior. They must not copy the host.

A restorable child may be reaped after 30 idle minutes. The next turn resumes
the recorded native conversation in a fresh child with the same explicit
runtime and isolation settings as a fresh start. Session hydration seeds the
native id through `AgentRunner.rememberResumableId`; it never reads a runner's
transcript files.

A runner with `restoreStrategy: "unsupported"` is never idle-reaped. A killed,
cancelled, crashed, or process-restored DeepSeek session cannot continue. The
next turn returns `409` instead of starting an empty conversation under the old
AgentRoom thread.

When a restorable runner reports a different native id after backend hydration,
the backend appends a system message telling the person that the new native
conversation has not seen the existing transcript.

## Readiness and discovery

Keep these states separate:

- `registered`: the registry admits the id.
- `configured`: required bootstrap configuration is present. This check starts
  no process.
- `enabled`: the operator has enabled the runner.
- `ready`: the adapter's capability discovery spawned and completed a real
  handshake in this backend process.

`GET /api/runners` serves those states and no policy or tier-3 values.
`ready` is absent until discovery has run. A failed discovery records
`ready: false` and leaves diagnostic text on the bounded capabilities response.

The Mac owns a separate bootstrap readiness answer. It checks bundled
`RunnerBootstrapDescriptor` probes while the backend may be stopped. Those
descriptors also form the child launch-environment allowlist. Never source an
executable path, environment name, Keychain slot, or probe from the backend.

Codex discovery follows `model/list` with the app-server's `account/read`
(`refreshToken: false`) in the same child. A reply with an account, or one whose
provider does not require OpenAI auth, passes the `codex_login` check. No
account where OpenAI auth is required is `unavailable`. A failed or unreadable
reply is `not_checked` and never fails discovery.

Capability discovery must remain lazy. It must not create N probe children at
startup. Current successful results are cached where the adapter's cost makes
that useful. Claude Code and DeepSeek do not cache a result with an
`unavailable` check, and Claude Code drops its cache when a turn fails, so a
repaired sign-in shows on the next read.

## Managed settings

Global settings are declared in `config/globalManagedSettings.ts`. Runner
settings are `ManagedSettingDefinition` values on the owning descriptor. The
settings file schema, environment table, tier table, defaults, patch schema, and
API metadata all derive from those declarations.

The [managed-settings trust contract](../safety/TRUST_AND_SAFETY.md#managed-settings)
owns precedence, tier separation, persistence, migration, and rollback.
[Config API](../api/API.md#config) owns metadata and compatible PATCH addresses.

## Permission requests

`PendingPermissionRequests` uses the shared `PendingRequests` core. Adapters
emit `permission_requested` events and translate selected options through
`answerPermissionRequest`. They do not add runner-specific answer routes.

[Permission approval](../safety/TRUST_AND_SAFETY.md#permission-approval) owns
the trust gate, vocabulary bounds, timeout, cleanup, and audit policy.
[Permission answers](../api/API.md#permission-answers) owns the route and
responses, including a runner without an approval channel.

## Clarifying questions

Questions collect user direction. The
[question trust contract](../safety/TRUST_AND_SAFETY.md#clarifying-questions)
owns admission, bounds, timeout, sensitive-answer storage, and the global kill
switch. [Question answers](../api/API.md#clarifying-question-answers) owns
request ids, answer shapes, and route responses.

Adapter paths:

- Codex handles `item/tool/requestUserInput`. Per-thread config enables the
  tool only while the global question setting is on. The JSON-RPC dispatcher
  refuses every other server request it does not implement.
- Claude Code handles `AskUserQuestion` through `canUseTool`. It refuses
  every other tool that reaches the callback with the CLI's headless behavior.
- DeepSeek's descriptor selects the native `questions.ask` relay in managed
  composition mode. Custom mode parses one valid, line-start, bounded
  `<agentroom-question>` block and continues through a second Harness prompt.
  The managed path omits both the prompt instruction and legacy parser.
- Cursor registers one `ask_user_question` custom tool and always disallows
  the SDK's own `askQuestion`. Since the AgentRoom tool extraction the tool is
  the catalog's `questions.ask` definition, relayed through the generic
  `tools/invoke` host request (see the next section); the original
  `question/ask` request remains as a compatibility shim for the same call.

## AgentRoom tools and dispatch

`apps/backend/src/agentTools/` owns the catalog and the bound dispatcher for
tools a runner's model calls through AgentRoom rather than the provider's own
surface. A tool is defined once as serializable data — stable logical id,
model-facing name, description, JSON-Schema input and output, unavailable text,
required capability, and feature gate — and registered statically at module
load; there is no runtime tool-definition loader. Handlers are never registered:
each turn's binding
injects them, because a handler closes over the session, the turn, and the
pending stores that own its behavior. Validators, handlers, schemas, and
results stay backend-owned; only the definitions cross to a runner host.

The external interface is four operations:

1. Compose a runner's stable catalog from its descriptor capabilities and the
   global gates (`allowedAgentToolLogicalIds`). Separately narrow the turn's
   allowed names from explicit context.
2. Bind the allowed set to the originating turn (`bindAgentTools`), with a
   turn handle whose liveness ("still the session's live turn") is revalidated
   before every dispatch.
3. Invoke a bound tool by its advertised name; the dispatcher owns the
   allowlist, unavailable-tool refusals, call correlation ids, bounded string
   results, misbehaving-handler containment, and safe-metadata telemetry.
4. Dispose the binding at turn end; late relays are answered, never run, and
   a handler that settles after its turn ended is discarded — the waiting
   transport receives the tool's unavailable text, never the stale result.

Dispatch imposes no timeout of its own — a question's human-wait clock belongs
to its handler — and emits no generic lifecycle activity: the native transport
already reports the call and the question pair reports its own resolution, so
a generic emission would double them. Telemetry carries logical id, name,
correlation id, outcome, and duration only; arguments and results never reach
it. The correlation id is observability, not a durable mutation id.

`RunnerDescriptor.agentTools` owns both transport mode and capabilities, plus
an optional `availableWhen(config)` gate for a transport that exists only under
some configuration. The gate fails closed: a caller that supplies no
configuration gets no tools from a gated descriptor. Codex declares `dynamic_tools` only in JSON-RPC mode,
because the `exec` protocol has no tool channel. Cursor uses `custom_tools`
for the question and plan capabilities. Its host registers every
advertised definition as a custom tool
whose `execute` sends one `tools/invoke` request carrying the tool's name and
the host's current run id; that run id is the generation handle, so a late
callback from a run that is no longer the live turn is answered with the
tool's unavailable text instead of dispatching into whichever turn is active.
The relay is an allowlist, not an executor: names outside the turn's bound set
never reach a handler, and the envelope cannot run a shell command or hit a
backend route. Runners that have not migrated keep their own question paths
unchanged; `mode: "none"` records exactly that.

DeepSeek uses `cordis_pipe` for managed-mode questions. The persistent Harness
child receives the descriptor/gate-derived catalog once over an inherited,
versioned, bounded pipe and registers it through Cordis's `tools` service.
Every prompt gets a new `bind`/`unbind` generation. A live child keeps the
catalog it registered, because replacing it would lose the conversation. A
turn that requires a different catalog fails, and an optional turn continues
with the shared registration notice. Missing optional tool readiness leaves ordinary turns usable and
reports a separate capability check; `AgentRunnerToolSet.required` can require
tool readiness for callers that depend on it. Sketches do not supply tools or
turn bindings. The relay never receives bearer auth or route authority. See the
[DeepSeek runner guide](DEEPSEEK_HARNESS_RUNNER.md#agentroom-cordis-tools).

Codex uses `dynamic_tools`. The adapter derives `thread/start.dynamicTools`
from the catalog and answers the app-server's `item/tool/call` request only
when its `threadId` and `turnId` name the live turn; any other call gets the
tool's unavailable text with `success: false`. Every other server request
method is still refused with `-32601`. `thread/resume` carries no tool list
and does not report the catalog it restores, so the adapter records the names
it declared at `thread/start` beside the resumable thread id. The record
survives an idle reap in the session host. `nativeToolRegistration` hands it
to the service, which persists it as `nativeToolRegistration` in the session
document, and `rememberResumableId` returns it after a backend restart when
the stored thread id still matches. A restored thread with no record (one
started before plan tools, or by a build that did not record it) has an
unknown catalog: a turn that requires tools fails, and an optional turn gets
the unconfirmed-tools notice and still dispatches whatever the thread calls.
Questions stay on native `request_user_input`. See
`runner/codex/dynamicTools.ts`.

Claude Code uses `sdk_mcp`. Each SDK child gets an in-process MCP server named
`agentroom` whose low-level `tools/list` and `tools/call` handlers serve the
catalog verbatim; the SDK's `tool()` helper is not used, because it strips
unknown keys that the strict schemas must refuse. The permission path adds the
exact `mcp__agentroom__<name>` entries to `allowedTools`, derived from the
bound catalog; there is no wildcard. `canUseTool` is supplied only while the
clarifying-question channel is enabled, and it allows exactly those names if
one reaches it. With questions disabled, `allowedTools` alone approves them. A call dispatches into the turn that owns the assistant `tool_use`
id in `_meta["claudecode/toolUseId"]`, never into whichever turn is active,
and fails closed when that id was never observed. Registration is confirmed
once per child through `mcpServerStatus()`. A live child keeps its catalog; a
change takes effect on the next child, including a resumed one. See
`runner/claudeCode/agentTools.ts`.

`runner/shared/agentToolSets.ts` holds the rules every transport shares. An
adapter's own question tool joins the session's tools through
`combineRunnerToolSets`. `promptWithRegisteredTools` compares the turn's
allowed names with what the native transport registered and returns the prompt
to send. A turn with `AgentRunnerToolSet.required` fails when any tool is
missing or cannot be confirmed. An optional turn proceeds with a shared notice
in front of the prompt: one names the missing tools, and the other says the
transport could not confirm any of them. Both tell the model not to claim a
tool's effects. The runner's display name in its errors comes from the
descriptor. Standing instructions
travel in `AgentRunnerToolSet.instructions`; a `system` delivery runner
appends them to its system prompt, and the context assembler places them in
the prompt for the others.

The minimal recipe for adding a tool:

1. Register a definition in `agentTools/` (or its owning module) with a stable
   logical id, the model-facing name, description, bounded input schema,
   unavailable text, required capability, and the feature gate that composes it.
   A parity test
   holds the advertised schema against the canonical validator.
2. Add the capability to each descriptor whose native transport has proved it,
   then inject the async handler keyed by logical id from the owning module's
   per-turn factory.
3. Nothing else: catalog advertisement, the transport relay, dispatcher, and
   lifecycle binding stay generic. `test/agentTools.test.ts`,
   `test/agentRunnerToolSet.test.ts`, and `test/deepseekToolRelay.test.ts`
   cover composition, lifecycle, and transport reuse.

The minimal recipe for adding a runner transport:

1. Record its transport mode and supported capabilities in `RunnerDescriptor`;
   code above the runner boundary must not switch on its id.
2. Adapt the native registration/call protocol to `AgentRunnerInput.tools`.
   Preserve the immutable catalog for a persistent child and correlate each
   invocation to the supplied run id and call id.
3. Reuse the shared dispatcher and owning handlers. Prove startup failure,
   cancellation, late/refused calls, replay protection, clean rebinding, and a
   second tool without adding tool-specific branches to the adapter.

### Thread plan tools

`apps/backend/src/plans/` owns thread plans. Each AgentRoom session has zero or
one plan, and every built-in descriptor declares the `plans` capability, so a
supporting runner's model sees six tools: `create_plan`, `get_plan`,
`edit_plan`, `execute_plan`, `update_plan_step`, and `finish_plan`. The owners
are:

- `planModel.ts`: statuses, bounds, the stored plan and receipt schemas, and
  structural invariants.
- `planToolContract.ts`: the six strict input schemas, error codes, and the
  result envelope.
- `planTransitions.ts` and `planReceipts.ts`: pure transitions, settlement and
  restart recovery, and the 64-receipt retry window.
- `ThreadPlanService.ts`: the per-session serialized mutation path and its
  acknowledged commits through the session store.
- `planTools.ts`: catalog definitions, the single handler, result
  serialization, the standing instruction, and the per-turn context.
- `planTurnTools.ts`: composition from descriptor capabilities, a fresh
  binding per turn, disposal before the turn-end transition, and the
  `agent_plan_changed` event. It advertises nothing without acknowledged
  storage, since every call would then report `tools_unavailable`.

Adapters translate these definitions and never restate a name, schema,
description, or instruction. `agentTools/jsonSchema.ts` converts each zod
input schema into the advertised JSON Schema and throws on anything it cannot
express. No transport branches on a plan tool name.
`test/agentToolConformance.test.ts` runs one suite against all four transports,
including a non-plan probe tool that no adapter knows about.

Creating, editing, and turn settlement never start a turn. `execute_plan`
records that work started and returns to the calling agent, which does the
work with its existing permissions. When a turn ends, fails, or is cancelled,
a running plan pauses; a later user turn resumes it. The standing instruction
treats the stored plan as authoritative and plan text as task data, not
instructions. Wire behavior is in the
[API](../api/API.md#thread-plans), and storage and trust limits are in
[trust and safety](../safety/TRUST_AND_SAFETY.md#thread-plans).

## Images and turn settings

`AgentRunner.validateInputParts` is the image boundary. Codex JSON-RPC uses
local image paths. Claude Code and Cursor inline bounded base64 content in their
SDK messages. An ACP child receives images only after its own handshake
advertises `promptCapabilities.image: true`; accepted ACP prompt images have a
16 MiB total decoded-byte cap. Unsupported images fail explicitly.

Turn model, reasoning, and speed values come from
`GET /api/coding-agent/capabilities`. A selection not advertised by the chosen
runner fails instead of being dropped. ACP maps only the reserved `model` and
`thought_level` selectors. It does not expose `mode`, since that value can
widen the agent's sandbox without the tier-2 settings gate.

## Model catalog

`apps/backend/src/runner/modelCatalog.json` holds the static model data. It has
the Codex offline fallback list with each model's effort levels and fast-mode
flag, the Claude Code effort vocabulary and offline fallback list, the Cursor
offline fallback list with each model's depth parameter name, and the whole
DeepSeek list. `runner/modelCatalog.ts` validates it with zod when the backend loads, so
a bad edit fails startup and `modelCatalog.test.ts` rather than a turn.

Live discovery wins wherever a runner has it: Codex `model/list`, Claude Code
`supportedModels()`, and Cursor `models/list`. The Codex fallback is converted
to `model/list` entries and mapped by the same code as a live reply. ACP takes
nothing from the file. An operator-configured model is always the default.
Without one, DeepSeek uses the `DEFAULT_DEEPSEEK_MODEL` constant, the Codex and
Cursor fallbacks use their `isDefault` entry (the test pins Cursor's to
`DEFAULT_CURSOR_MODEL`), and the Claude Code fallback uses its first entry. The file is hand-edited and mirrored
with the rest of `apps/backend`.

An operator's local copy at `$AGENTROOM_HOME/config/models.json` is read once
at startup. Each runner section it lists replaces the bundled section, and
omitted runners keep the bundled data. A missing copy is normal. An unreadable,
oversized, or invalid copy is logged and ignored, so a bad edit cannot stop the
backend. The macOS Models pane writes this copy; see
[`MACOS.md`](../clients/MACOS.md#model-catalog). The trust posture is in
[`TRUST_AND_SAFETY.md`](../safety/TRUST_AND_SAFETY.md#model-catalog).

## External ACP adapters

The ACP v1 adapter is off by default. `ACP_ADAPTERS_ENABLED` gates a whole
`ACP_ADAPTERS` definition list. Definitions are tier 3 and never appear in
managed settings or public runner projections.

Admission requires an absolute, non-symlink, executable regular file. The
backend builds fixed argv without a shell. The child receives a small
environment allowlist plus explicitly granted names, including credentials;
`AUTH_TOKEN` is always excluded. See the
[ACP environment policy](../safety/TRUST_AND_SAFETY.md#external-acp-adapters).
Transport frames, depth, stdout, stderr, requests, timeouts, and outbound image
bytes are bounded.
AgentRoom declines ACP filesystem and terminal capabilities, refuses permission
requests unless the adapter's tier-2 policy allows another answer, and admits
only agents with a verified restore path.

Ids use the `acp_*` namespace. Settings prefixes must be unique and
non-prefixing across external and built-in runners. A collision rejects the
whole candidate set.

Run [`ACP_CONFORMANCE.md`](ACP_CONFORMANCE.md) against a real agent after a
protocol, admission, permission, image, discovery, or restore change.

## Adding or changing a runner

1. Decide whether the runner is a built-in id or an operator-defined ACP
   configuration. Record the downgrade and client compatibility effect before
   adding a built-in id.
2. Add or update the adapter behind `AgentRunner`. Keep protocol parsing,
   native settings, native permission vocabulary, and native metadata inside
   its directory.
3. Add one descriptor row for every shared policy. Make the built-in admission
   list and its test change explicit.
4. Map native activity into the canonical union. Give unmapped events no shared
   meaning.
5. Reuse `PersistentRunnerSessionHost` and the shared pending-request stores.
   Declare restoration honestly.
6. Add descriptor-owned managed settings and a bundled Mac bootstrap descriptor
   only where the runner needs them. Keep tier-3 values out of public metadata.
7. Update the shared Swift DTOs and generic client fallbacks. Bespoke
   presentation may name the runner, but baseline operation may not depend on
   it.
8. Verify registry enforcement, settings parity and migration, capabilities,
   lifecycle, canonical events, questions or permissions, session durability,
   Mac bootstrap, unknown-runner client behavior, packaging, and downgrade
   handling.

## Current open checks

- DeepSeek restore remains `unsupported` until a fresh runtime process proves
  that it reattaches to a persisted session. Its session-event coverage and
  composed skill discovery also need deliberate real-runtime observation. See
  [`DEEPSEEK_HARNESS_RUNNER.md`](DEEPSEEK_HARNESS_RUNNER.md).
- Cursor release checks remain in
  [`CURSOR_SDK_RUNNER.md`](CURSOR_SDK_RUNNER.md), including redistribution,
  signed nested binaries, account requirements, and live SDK drift.
- Plan tools have live evidence for Codex (codex-cli 0.158.0-alpha.2.1) and
  Claude Code (SDK 0.3.283 under `bypassPermissions`) only. Still open:
  Claude Code's exact `allowedTools` entries under `default`, `acceptEdits`,
  and `dontAsk`; Codex `thread/resume` restoring the recorded dynamic tools,
  including a thread started before plan tools; and Cursor and managed DeepSeek
  model turns calling the tools. Cursor and DeepSeek advertise plan tools on
  the strength of the transport conformance suite, which is what "verified"
  means for default advertisement.
- Legacy runner metadata remains until the advertised coding-event contract
  floor moves past version 2.
