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

| Runner | Prompt | Turn diff | Questions | Workspace skills | Restore | Configured when |
| --- | --- | --- | --- | --- | --- | --- |
| `codex` | Per turn | Native runner diff | Native request | Always, from `.codex/skills` then `.agents/skills`; `$` invocation | `native_resume` | `CODEX_EXECUTABLE` exists in config |
| `claude_code` | Stable SDK system prompt | Settlement Git delta | Native `AskUserQuestion` | Gated by the adapter's workspace-settings rule; `.claude/skills`; `/` invocation | `native_resume` | Always, because the SDK resolves its CLI |
| `deepseek` | Per turn | Settlement Git delta | Bounded prompt contract | None advertised | `unsupported` | Executable and Cordis composition are both configured |
| `cursor` | Per turn | Settlement Git delta | Native custom tool callback | Gated by project settings; all four workspace skill directories; `/` invocation | `native_resume` | Always, because the SDK is bundled |
| `acp_*` | Descriptor-owned | Descriptor-owned | None in the current external adapter | Descriptor-owned | A restore path is required at admission | Its admitted executable definition is present |

The registry and `apps/backend/test/runnerRegistry.test.ts` are the executable
source for this table. Update the guide when a classification changes. Do not
copy the table into client docs or shared guidance.

## Claude Code

`ClaudeCodeRunner` uses the Claude Agent SDK with one persistent SDK session
and spawned `claude` process per AgentRoom session. It streams partial message
deltas, cancels through the SDK's `interrupt()`, and resumes with the SDK's
native session id. The adapter owns SDK event mapping and the exact permission
mode vocabulary.

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

Capability discovery must remain lazy. It must not create N probe children at
startup. Current successful results are cached where the adapter's cost makes
that useful.

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
- DeepSeek parses one valid, line-start, bounded
  `<agentroom-question>` block. It continues the same AgentRoom turn through a
  second Harness prompt.
- Cursor registers one `ask_user_question` custom tool and always disallows
  the SDK's own `askQuestion`.

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
- Legacy runner metadata remains until the advertised coding-event contract
  floor moves past version 2.
