# DeepSeek Harness Runner

Status: **steps 1–9 landed, then step 10 corrected the launch contract** —
written and executed 2026-08-18 on branch
`feature/add-dedicated-deepseek-harness`. The runner registers, serves
capabilities, streams a mapped session log, cancels by terminating its
non-restorable runtime, and both clients name it and render its settings.
The adapter is written to the vendor's published protocol and covered by a fake
one, **and it has since been run against a real runtime** — see *Setting up a
runtime* for both install paths, the composition, and the three operational
findings that only a real runtime produced. Fact 1 remains closed
conservatively as `unsupported`; facts 2 and 3 under *Three facts to confirm*
were not settled by that run and still need deliberate observation.

> **Step 10 — the launch contract, corrected against the upstream repository**
> (2026-08-18, `master` at `0.1.0-rc.7`). Steps 1–9 were written from the SDK
> package docs and assumed `dsh` could be made to serve the protocol. It cannot.
> Reading `apps/cli/README.md`, `apps/cli/reference/README.md`,
> `packages/bundle/*`, `packages/examples/jsonrpc-demo`, `examples/jsonrpc-agent`,
> and `python/sdk-runtime` established the real contract, and five things changed:
>
> 1. **The executable is `dsh-jsonrpc-agent`, not `dsh`.** The launcher has four
>    entry modes — `--profile <name>`, `--profile headless "task"`, `web`,
>    `plugin` — and none serves the SDK wire. The in-box bundles are
>    `dsh-base`, `dsh-web-app`, and `dsh-headless`; the JSON-RPC server is a
>    plugin no shipped bundle mounts. The serving bin ships from
>    `@deepseek-ai/dsh-sdk-jsonrpc-demo`, or as the packaged single-file
>    `dsh-jsonrpc-agent-pkg-<platform>-<arch>` in the Python runtime wheel (whose
>    macOS build must keep its sibling `-spawn-helper`). The Mac probe searched
>    for `dsh` and would have saved a path that can never handshake.
> 2. **The Cordis composition is mandatory**, and is now a tier-3 setting
>    (`DEEPSEEK_CORDIS_CONFIG`, falling back to an exported `DSH_CORDIS_CONFIG`)
>    with a bundled Mac slot of the new `filePath` kind. The runtime takes it from
>    `$DSH_CORDIS_CONFIG` or an argv positional and *exits nonzero with neither* —
>    no cwd search, no built-in default. `isConfigured` now requires both halves.
> 3. **`DSH_SESSION_ROOT` is pinned under `STATE_DIR`.** The stock compositions
>    resolve persistence as `process.env.DSH_SESSION_ROOT ?? './.sessions'`, and
>    that relative default is taken against the child's cwd — the registered
>    workspace. Unpinned, the harness writes its JSONL session log into the
>    operator's repository.
> 4. **`DSH_CWD` is pinned** to the registered workspace. A hardening rather than
>    a fix: the child's cwd already is that directory, so the fallback agreed.
>    Stating it keeps a composition that reads the variable from relocating the
>    agent's tools, the same reflex as the Codex `network_access` pin.
> 5. **Teardown walks the documented ladder** — `shutdown` → stdin EOF →
>    `SIGTERM` → `SIGKILL` — instead of `dispose()` plus a bare `SIGTERM`, which
>    ended a persistence-mounting composition mid-flush and never escalated.
>    Cancellation enters below the first rung, because `shutdown` drains to
>    quiescence and a stop request is not a request to finish.
>
> The trust entry was corrected in the same pass. It had said flatly that turns
> are "not filesystem-bounded to the registered workspace"; the accurate
> statement is that **the bound is a property of the operator's composition**,
> which AgentRoom cannot inspect — upstream ships both a `danger-full-access`
> minimal config and a `workspace-write` CLI default — so the runner is treated
> as `bypassPermissions`-class because that is the safe reading, not because the
> harness has no sandbox.
>
> **`dsh --profile headless "task"` remains a deliberate non-goal.** It is the
> only zero-setup path (`npx @deepseek-ai/dsh`), and it is one-shot: a fresh
> persisted session per invocation, the last assistant text on stdout, status in
> the exit code, no listening port and no follow-up surface. It can carry no
> streaming assistant deltas, no tool activity, no plan, no usage, and no
> multi-turn thread — so a runner backed by it would answer every AgentRoom turn
> with a single message and misrepresent itself in every client that renders
> canonical activity. Supporting it would mean one runner id behaving two
> incompatible ways; the honest answer is that this runner speaks the SDK
> protocol and needs a composition that serves it.

Adds `deepseek` as a **built-in runner kind** beside `codex` and `claude_code`:
one `RunnerDescriptor` row, one adapter behind `AgentRunner`, one persistent
child per AgentRoom session on the shared session host, and the same managed
settings / bootstrap / capability surfaces the other two have. Nothing above the
`AgentRunner` boundary learns a new name, and no documented bound moves.

This is deliberately **not** the ACP path. An operator can already run DeepSeek
Harness as a configured `acp_*` adapter — `docs/engineering/ACP_DEEPSEEK_ENABLEMENT.md`
on the unmerged `feat/acp-deepseek-harness` branch records a full conformance run
against this exact commit, and it passed. That path stays exactly as it is; this
one exists because a bundled runner gets what a tier-3 adapter cannot: a
first-party binary in the turn path instead of a third-party bridge, a bundled Mac
bootstrap descriptor with a Keychain slot and a readiness probe, and an approval
posture that is a tier-2 managed setting rather than an environment variable
smuggled through `envGrants`. Workspace skills were on that list when this was
written and are not yet claimed: the descriptor reports `none` until fact 3 below
is confirmed against a real runtime.

Read that run's findings before starting. Two of them constrain this adapter:
DeepSeek Harness is **not** filesystem-bounded to the registered workspace (it
wrote outside one, unasked, at its own default posture), and one short turn can
emit ~94 reasoning activities — enough to flush the recent-event buffer to a
sub-second window.

## What it speaks

DeepSeek Harness ships two first-party out-of-process surfaces as of
`@deepseek-ai/dsh@0.1.0-rc.7`. Only one is usable here.

| Surface | Verdict |
|---|---|
| `@deepseek-ai/dsh-sdk-jsonrpc-server` + `-sdk-protocol` (`packages/sdk`) | **This is the one.** Newline-delimited JSON-RPC 2.0 over stdio — structurally identical to the Codex app-server transport. `initialize` (absolute cwd, provider, model, optional `maxTokens`) → `session/prompt` → `{ messageId }` receipt → `shutdown`. The server streams `session.event` (**full durable session-log envelopes**), `session.status` (whole-agent `running`/`idle`), and `subagent.started`/`subagent.finished`. The session-log stream is what makes a real canonical mapping possible. |
| `@deepseek-ai/dsh-acp` (`packages/acp/acp`) | Not usable. Its own README: *"Fresh sessions only — load, list, resume, delete, and fork are unsupported"*, which `AcpRunner` refuses by the restore rule, and *"committed answers only — live progress, reasoning, tool activity, plans, titles, and usage stay off the wire"*, which would reduce a turn to a single message. It also advertises no `configOptions`, so there is no model picker. |

Two properties of the SDK wire shape this adapter, and neither is worked around:

- **No prompt-cancel or verified restore method.** `AgentRunner.cancel()` kills
  the child. The turn still records as `cancelled` and the session returns to
  `idle` with no `activeTurnId`, but later turns on that AgentRoom session are
  refused with an instruction to create a new session. This avoids silently
  starting a fresh conversation under the old id.
- **No server→client requests** (documented as a dead capability). So the adapter
  implements no `answerPermissionRequest` hook, and
  `POST /api/agent-sessions/:id/permissions/:requestId` correctly `404`s for it —
  exactly as it does for Codex and Claude Code, reading the absence of an approval
  channel rather than which runner this is.

## Three facts to confirm against a real `dsh` before the adapter is finished

Each has a named fallback, so none of them blocks starting. Confirm them with a
throwaway script against a pinned install, not through AgentRoom.

| # | Question | If yes | If no |
|---|---|---|---|
| 1 | Does a **fresh runtime process** re-attach to a persisted session id? (`session-persistence-jsonl`/`-sqlite` exist and the server "gets or creates one agent per `sessionId`", but nothing published says a new process re-attaches.) | `restoreStrategy: "native_resume"`; idle reaping and cancel-by-kill both work. | **Selected conservatively:** `restoreStrategy: "unsupported"`. The handshake cannot prove persistence, so the host never arms an idle timer and `cancel()` ends the usable thread rather than pretending to steer it. |
| 2 | What does `session.event` carry — reasoning deltas, tool call start/output/complete with a **stable per-call id**, plans, token usage? | Map each to its `CanonicalActivity` kind. | Each missing kind simply produces no `coding_*` event; the transcript degrades to a generic rendering, which is the designed behavior. A missing usage envelope means no `contextWindowUsedTokens` for this runner. |
| 3 | Which directories does `skill-filesystem` discover, and does the composed runtime load them? | `workspaceSkills: { mode: "native" }` with real `skillSourceDirs`. | `{ mode: "none" }`, and the `/` picker reports skills unavailable — the honest answer rather than advertising invocations the session would ignore. |

A fourth was a scoping question rather than a fact, and step 10 answered it: the
SDK runtime is a plugin graph the caller composes (`cordis.yml`), and the hope
was to name a **shipped profile** instead of authoring one. There is none —
`dsh`'s in-box bundles are `dsh-base`, `dsh-web-app`, and `dsh-headless`, and
none mounts the JSON-RPC server plugin. The resolution is neither: AgentRoom
requires the operator to *name* a composition (`DEEPSEEK_CORDIS_CONFIG`) and
ships none, so it never chooses which tools the agent has. Ready-made graphs
exist upstream — the `runtime/cordis.yml` in the Python runtime wheel, and
`examples/jsonrpc-agent/{cordis,minimal.cordis}.yml` — and pointing at one is
the operator's trust decision, which is why the composition is tier 3.

## Non-goals

- **`runner/acp/` is not touched.** `acp_deepseek` and `deepseek` coexist.
- **No npm dependency on `dsh`.** The runtime is an operator-installed executable
  like `codex`; the protocol is spoken directly and zod-validated on receipt.
- **No universal permission enum.** DeepSeek's posture stays its own
  `{ label, value }` beside the Codex approval policy and the Claude Code
  permission mode.
- **No new legacy metadata block.** `codex`/`claudeCode` are shims scheduled for
  deletion when `codingEventContractVersion` passes 2; a third would recreate the
  thing they retire. Clients read `runner` and `activity.canonical`.
- **No new execution surface**, no route, no event type, no widening of any
  documented bound.
- **No generic buddy fallback.** An unknown runner still renders without a buddy
  rather than borrowing another runner's identity. The dedicated DeepSeek whale
  landed later as a separately grounded asset-pipeline change; it does not give
  `acp_deepseek` or any other external adapter the built-in runner's face.

## Step 1 — Open the rollout gate — **done**

> **Done** (2026-08-18). `registeredRunnerKinds` is
> `["codex", "claude_code", "deepseek"]`; `runnerRegistry.test.ts` pins the new
> list and the reason; and the gate's opening is recorded in
> [Universal Runner Boundary](UNIVERSAL_RUNNER_BOUNDARY.md), `AGENTS.md`,
> `CLAUDE.md`, `docs/safety/TRUST_AND_SAFETY.md`, `docs/api/API.md`, `README.md`,
> and `.env.example`.
>
> The Mac-side rollback guard closed last. It **refuses** the conversion rather
> than warning through it: `ManagedSettingsDocument.legacyDocumentRunnerKinds`
> names the two ids every flat-document reader shipped knowing — a list that can
> never grow, because it describes builds that already shipped rather than
> claiming which runners exist — and `writeLegacyDocument` throws
> `unconvertibleRunnerKind` for anything else, which covers an operator's own
> `acp_*` default as well as `deepseek`. The Advanced pane disables the button
> and names the runner before it is pressed, and the store refuses independently
> because it is what writes. Silently rewriting `runnerKind` to something
> convertible was rejected: it would move the operator's turns onto a different
> agent to save a file format. Documented in `docs/clients/MACOS.md` and
> `docs/operations/LOCAL_MAC_SERVER.md`.


`registeredRunnerKinds` was closed at `["codex", "claude_code"]`, with
`apps/backend/test/runnerRegistry.test.ts` failing the build on a third entry.
The gate is Phase 4 of [Universal Runner Boundary](UNIVERSAL_RUNNER_BOUNDARY.md),
and everything that pinned it moved in one commit:

| File | Change |
|---|---|
| `apps/backend/src/runner/registry.ts` | `registeredRunnerKinds` gains `"deepseek"`; the compiler then demands the descriptor row (Step 3). |
| `apps/backend/test/runnerRegistry.test.ts` | `it("registers exactly the two runner ids Phase 4 gates a third one behind")` becomes the three-id pin, with the reason. |
| `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` | Record that the gate opened, when, and on what basis. |
| `AGENTS.md`, `CLAUDE.md` | Both state the list "stays exactly `codex` and `claude_code`". Both change. |
| `docs/api/API.md`, `README.md`, `.env.example` | Accepted `runnerKind` values and `RUNNER_KIND`. |

**The id.** `deepseek`, display name "DeepSeek Harness", `settingsKeyPrefix:
"deepseek"`, environment prefix `DEEPSEEK_`. The registry refuses a settings
prefix that prefixes or is prefixed by another runner's; `deepseek` is clean
against `codex` and `claudeCode`, and — checked explicitly, because an operator
may run both — clean against a configured `acp_deepseek`, whose derived prefix is
`acpDeepseek` (neither string prefixes the other).

**The one hazard the gate protects against, and its mitigation.** With Phases 4
and 5 landed the exposure is narrow and precise:

- `runners.deepseek.*` in `settings.json` — **safe**. An unknown runner namespace
  is preserved verbatim and never applied, and the Mac surfaces it read-only
  (`PreservedManagedSettingRow`).
- `global.runnerKind: "deepseek"` — **the sharp edge**. It is a *known* key, and a
  malformed known value makes the whole file unusable, dropping the operator's
  entire trust posture onto defaults on any build that lacks the id. This is a
  **downgrade** hazard: it bites whoever selects DeepSeek as their default runner
  and then runs an older AgentRoom.

Mitigate by teaching the Mac's version-1 rollback converter to refuse or warn when
`global.runnerKind` names a runner the target build will not know — the same
reflex as its refusal to reset an `unsupportedSchemaVersion` file — and by
documenting the consequence in `docs/operations/LOCAL_MAC_SERVER.md`. Do **not**
relax "a malformed known value makes the file unusable": that rule is what keeps a
partially applied trust posture impossible.

## Step 2 — Lift the JSON-RPC line client to `shared/` — **done**

> **Done** (2026-08-18). `runner/codex/jsonRpcLineClient.ts` moved verbatim to
> `runner/shared/JsonRpcLineClient.ts` with one addition: a required `label`
> constructor argument naming the child in the client's two errors
> (`"Codex app-server connection closed"`, `"… client disposed"`), so a rejected
> request says which runner's process went away. Required rather than defaulted —
> a caller that forgot it would otherwise report another runner's name.
> `CodexAppServerRunner` passes `CODEX_CLIENT_LABEL` at both construction sites
> and is the only caller so far. No behavior changed; the existing Codex suites
> are the guard.
>
> Two comments moved with it, because both named the old path: the header of
> `runner/acp/AcpStdioClient.ts`, which records why the ACP transport is
> deliberately **not** a caller of this client (its child is an arbitrary
> operator-supplied binary, so frame, depth, volume, and duration are all
> bounded), and the Phase 0 spike record in
> [Universal Runner Boundary](UNIVERSAL_RUNNER_BOUNDARY.md).

The transport this adapter needs already existed — newline-framed JSON-RPC over a
child's stdio, pending-request map, notification fan-out, EPIPE swallowed, pending
rejected on close. Two runners arriving at the same shape is the precedent that
produced `PersistentRunnerSessionHost`, so it moved rather than being copied.

## Step 3 — The descriptor row — **done**


```ts
deepseek: {
  id: "deepseek",
  displayName: "DeepSeek Harness",
  // No system-prompt surface on this wire; the persona is the runtime's
  // composition, so the standing contract rides each turn prompt like Codex's.
  promptDelivery: "turn",
  // The SDK wire has no diff notification, so AgentTurnGitDiffTracker derives
  // the turn's diff at settlement, as it does for Claude Code.
  turnDiffSource: "settle_time_git",
  workspaceSkills: { mode: "none" },        // → "native" once fact 3 is confirmed
  skillSourceDirs: [],                      // → the discovered dirs
  skillInvocationPrefix: "/",                // → whatever dsh actually uses
  settingsKeyPrefix: "deepseek",
  settings: [ /* Step 5 */ ],
  restoreStrategy: "unsupported",            // no protocol-proven resume path
  isConfigured: (config) => Boolean(config.deepseekExecutable)
}
```

Every row is a policy the rest of the backend already reads through the registry;
none of it is a new mechanism. `RUNNER_CAPABILITY_MATRIX.md` gains a DeepSeek
column in the same commit.

## Step 4 — The adapter — **done**

> **Done** (2026-08-18). Five files under `apps/backend/src/runner/deepseek`, on
> the shared session host and the shared line client, plus the wiring in
> `server.ts`. Covered by `deepseekRunner.test.ts` (handshake, turn interval,
> terminal cancellation, idle backstop, initialization cleanup, wrong-server
> refusal, child death,
> sub-agent log filtering), `deepseekEvents.test.ts` (the canonical mapping,
> including what deliberately maps to nothing), and `deepseekSettings.test.ts`.
> One deviation from the sketch below: `session/prompt` carries the receipt only
> as a correlation handle for the log, since claiming the turn from the first
> `turn/start` after the prompt is what actually brackets the interval.


`apps/backend/src/runner/deepseek/`, mirroring the file split both existing
adapters use. The directory already exists, empty and untracked, from an earlier
false start; it arrives with content or is removed.

| File | Mirrors | Role |
|---|---|---|
| `DeepSeekHarnessRunner.ts` | `ClaudeCodeRunner.ts` | The `AgentRunner`: capabilities cache, `run()`, `cancel()`, `closeSession()`, `dispose()`, and the `PersistentRunnerSessionHost` wiring. |
| `protocol.ts` | `runner/acp/protocol.ts` | zod schemas for `InitializeParams`/`Result`, `SessionPromptParams`/`Result`, and the four notifications. Validated on receipt — validation is not trust, it is what stops a malformed frame reaching the mapper as an unchecked shape. |
| `sessionEventMapper.ts` | `claudeCode/messageMapper.ts`, `codex/notificationMapper.ts` | `session.event` → `AgentRunnerActivity` + `CanonicalActivity` + `RunnerMetadata`. |
| `settings.ts` | `claudeCode/settings.ts` | Effective turn settings, `initialize` parameters, child environment, command audit. |
| `capabilities.ts` | `claudeCode/capabilities.ts` | Model catalog and defaults. |

**Session host.** One child per AgentRoom session, `restoreStrategy` read from the
registry (never a local constant). The shared 30-minute timeout is supplied, but
the host deliberately does not arm it for this `unsupported` strategy:

```ts
this.sessions = new PersistentRunnerSessionHost<DeepSeekRunnerSession>({
  runnerKind: "deepseek",
  restoreStrategy: runnerDescriptor("deepseek").restoreStrategy,
  idleSessionTimeoutMs: deps.idleSessionTimeoutMs ?? IDLE_SESSION_TIMEOUT_MS,
  teardown: (session) => { session.client.dispose(); session.child.kill("SIGTERM"); },
  isBusy: (session) => session.activeTurn !== undefined,
  describe: (session) => (session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {})
});
```

**The turn interval** is the one genuinely new piece, because `session/prompt`
returns an enqueue receipt and the protocol explicitly does not assign an
assistant message or a turn ending to a prompt. A turn is:

1. send `session/prompt`, keep the returned `messageId`;
2. wait for that id in a durable inbox receipt on the `session.event` stream;
3. collect events until the next whole-agent `session.status: idle`;
4. settle — `run_succeeded` with the last committed assistant text in the
   interval, or `run_failed` with a bounded, redacted reason.

This is the same interval the first-party `DeepSeekHarness.run()` owns, and it
carries the same caveat, which must reach `docs/api/API.md`: **steering or injected
work may contribute to a turn's output**, so a turn's final text is the last
committed one in the interval rather than a response causally assigned to the
prompt.

**stdout is the protocol.** The runtime's own docs warn that a surrounding
composition can load a stdout logger and corrupt the channel. Treat a non-frame
line as a bounded diagnostic rather than a parse failure — the existing client
already ignores unparseable lines; keep a bounded tail of them for the error path.

**Audit and timing** come from the shared helpers (`createRunnerStreamTiming`,
`observeRunnerStreamEvent`, `runnerStreamTimingAudit`, `commandAudit`) so
`runner_audit` rows look like every other runner's.

## Step 5 — Settings, environment, and trust posture — **done**

> **Done** (2026-08-18), with two changes from the table below. `profile` is
> **not** a managed setting: which composition serves the protocol is selected by
> the tier-3 `DEEPSEEK_ARGS`, exactly as `CODEX_ARGS` selects Codex's, which
> keeps argv assembly in one place and invents no mechanism. And
> `reasoningEffort` is omitted rather than declared, because the SDK wire exposes
> no per-request effort lever and advertising a control that does nothing is
> worse than its absence.


**Managed settings**, declared on the descriptor so they reach `/api/config`,
`PATCH`, the settings file, and env resolution by derivation rather than by a
table learning the name:

| Field | Tier | Env | Notes |
|---|---|---|---|
| `model` | 1 | `DEEPSEEK_MODEL` | `codingAgentModelIdSchema`, like the other runners. |
| `provider` | 1 | `DEEPSEEK_PROVIDER` | The `initialize` route; the runtime's own fallback is `deepseek-official`. |
| `maxTokens` | 1 | `DEEPSEEK_MAX_TOKENS` | Optional positive integer; omission lets the adapter default apply. |
| `reasoningEffort` | 1 | `DEEPSEEK_REASONING_EFFORT` | Only if the runtime exposes a real lever. Omit rather than advertise a control that does nothing. |
| `permissionMode` | **2** | `DEEPSEEK_PERMISSION_MODE` | The agent's own posture, as a closed vocabulary. Tier 2 means a paired client can change it only behind `REMOTE_SETTINGS_ADMIN`. |
| `profile` | **2** | `DEEPSEEK_PROFILE` | Which composition runs is a trust decision, not a preference. |

New vocabularies go in `domain/settingValueSchemas.ts` (the import-free leaf), not
`domain/schemas.ts` — reaching back into schemas from the registry closes a require
cycle.

**Tier 3 — environment-only, never in the settings file, the metadata, or the
PATCH schema**: `DEEPSEEK_EXECUTABLE`, `DEEPSEEK_CORDIS_CONFIG`,
`DEEPSEEK_ARGS`,
`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`. They join the never-managed list in
`config/env.ts` and `serviceConfigSchema` beside `CODEX_EXECUTABLE`. This exclusion
is what keeps the ungated `GET /api/config` non-secret, and
`managedSettingsParity.test.ts` fails the build if one reaches the Swift mirror.

**Child environment.** Inherit the operator's environment minus `AUTH_TOKEN`, like
Codex and Claude Code — a first-party runtime needs it to find its own credentials,
and the ACP allowlist exists because an ACP child is an arbitrary binary. Mirror
`claudeCodeChildEnv`/`codexChildEnv`, and scrub `AUTH_TOKEN` unconditionally.

**A new entry in `docs/safety/TRUST_AND_SAFETY.md`**, beside the Codex and Claude
Code entries, stating at minimum:

- Turns are **not filesystem-bounded to the registered workspace** — observed
  directly in the ACP run. This runner is `bypassPermissions`-class like the Claude
  Code default and the terminal, and the entry says so in those words rather than
  leaving it to inference.
- There is **no interactive approval channel** on this wire, so the configured
  posture is the only answer and the permissions route's `404` is honest.
- `dsh` can drive **sub-agents**, including other coding agents. Those
  grandchildren inherit the child environment and are processes AgentRoom neither
  bounds nor observes. State it; do not build a mechanism for it.
- Whether registering a workspace trusts its committed `dsh` configuration — the
  Codex `.codex/config.toml` clause either has an analog here or it does not, and
  the entry has to say which.

Changing that entry means changing `AGENTS.md`, `CLAUDE.md`, and the test that pins
it, together.

## Step 6 — Capabilities and readiness — **done**


`getCapabilities()` follows `ClaudeCodeRunner`'s shape: a per-process cache with a
TTL, a bounded `error` string on failure, fallback responses deliberately not
cached so the next request retries. The SDK wire has no `model/list` analog, so:

- **The catalog is static plus an open model id.** Seed it from what the ACP run
  observed (`deepseek-v4-flash` default, `deepseek-v4-pro`; efforts `off`/`high`/`max`)
  and keep the field open, exactly as `fallbackClaudeCodeModels` does.
- **Discovery is spawn → `initialize` → `shutdown`.** That still makes the
  capabilities read the readiness probe, so `runner/runtimeReadiness.ts` stays
  honest: nothing spawns at startup, `ready` is absent until something asks, and a
  failed probe reports `ready: false` with no text (the child's diagnostic stays on
  the capabilities `error`, through `util/redactSecrets`).

`serviceTiers` is `[]` — DeepSeek has no speed-tier analog, same as Claude Code.

## Step 7 — Mac bootstrap — **done**

> **Done** (2026-08-18). The bundled descriptor holds four DeepSeek bootstrap
> values in the existing Keychain-backed slot model: `DEEPSEEK_EXECUTABLE`,
> comma-separated `DEEPSEEK_ARGS`, `DEEPSEEK_CORDIS_CONFIG`, and the masked
> `DEEPSEEK_API_KEY`. It probes the SDK runtime and composition and injects only
> those descriptor-allowlisted names at backend launch. The key is runner-local,
> not a generic provider field: a real run showed the harness credential store
> publishes too late for AgentRoom's first prompt, while Codex and Claude Code
> still need no app-held provider credential.

A third bundled `RunnerBootstrapDescriptor` in
`apps/macos/AgentRoomMac/Supervision/RunnerBootstrap/RunnerBootstrapCatalog.swift`:

- an `executablePath` slot injected as `DEEPSEEK_EXECUTABLE`, with an
  `ExecutableSearch` for `dsh-jsonrpc-agent` across the usual prefixes
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.npm-global/bin`,
  `~/.bun/bin`, …) — **corrected in step 10 from `dsh`**, which would have
  resolved the launcher and reported a runner that can never handshake;
- a `filePath` slot injected as `DEEPSEEK_CORDIS_CONFIG` (step 10). This is the
  one new tier-3 primitive the plan cost: `RunnerBootstrapSlot.Kind` is a closed
  set, and a data file the backend *hands* a child is neither an executable it
  spawns nor a comma-separated argument list. The safety properties are
  unchanged — bundled-declared, Keychain-held, never from the backend;
- a required `filePath` probe for that slot, which validates and normalizes the
  operator-chosen data file without searching for or executing anything;
- an arguments slot injected as `DEEPSEEK_ARGS`, which carries the built
  entrypoint on the preferred source-checkout path and is empty only when the
  executable slot names a runtime binary;
- `requirement: .required` for both the executable and composition probes.

Bundled is the safety property: the descriptors *are* the launch-environment
allowlist, and nothing in them may arrive from the backend. This is the half of
readiness the Mac answers with the backend stopped, and it is the single largest
thing a tier-3 ACP adapter cannot have.

## Step 8 — Clients — **done**

> The parity half landed with step 5, because the test that pins it demands it:
> both `ManagedBackendSettingKey.swift` mirrors and the macOS
> `ManagedBackendSettings.swift` carry the four DeepSeek keys and the
> `deepseek` runner namespace.
>
> The presentation half followed. `AgentRunnerKind` gained the case (still not
> `CaseIterable`), `RunnerCatalog.builtIn` gained the identity-only row, and the
> headset's presentation catalog gained the four rows — model, provider, and max
> tokens under Runner Defaults, `permissionMode` under Trust, where
> `ManagedBackendSettingCatalogTests` requires it to be. Two of those are the
> catalog's first deliberate free-text rows: the provider and the permission mode
> have open vocabularies the *profile* owns, and the backend reports no `options`
> for them, so a picker would be this client inventing an enum. `ManagedSettingLabel`
> needed nothing — it is purely typographic, and the titles live in the catalog.
>
> Two consequences were worth naming at this step. Initially,
> `WorkspaceRunnerBuddyAsset` gained a `case .deepseek: return nil` branch,
> making the no-generic-fallback rule structural rather than leaving a gap. A
> later, separately grounded asset-pipeline change replaced that branch with the
> dedicated DeepSeek whale while preserving `nil` for unknown runner ids. The
> four tests that asserted a two-runner
> catalog now assert *the floor itself* (`XCTAssertEqual(store.runnerCatalog,
> .builtIn)`) rather than restating its contents, since what they were checking
> was the fallback, not the list — one place pins the list, and it is the floor's
> own test.
>
> `RunnerCatalog.builtIn` remains the Mac's full stopped-backend floor. The
> headset does not use it when `/api/runners` is absent or unreadable: its
> `legacyBackendFallback` contains only Codex and Claude Code, because a backend
> old enough to lack the route cannot confirm DeepSeek's admission or
> availability.


Most of this is free and was traced in Swift at this commit during the ACP run:
pickers hydrate from `GET /api/runners`, an unknown id renders as itself,
capabilities are fetched and cached per runner, the transcript dispatches on
canonical kinds with no allowlist, and a setting no client was built with renders
from `/api/config` metadata alone. What is not free:

| Surface | Work |
|---|---|
| `apps/shared/.../RunnerCatalog.swift` | Add the row to `builtIn` — the offline floor, identity only (`registered`/`configured`/`enabled` stay `nil`). |
| `apps/shared/.../AgentRunnerKind.swift` | Add the case **only** for bespoke presentation. It must stay non-`CaseIterable`. |
| `ManagedBackendSettingKey.swift` (macOS **and** visionOS) and `ManagedBackendSettings.swift` (macOS) | `managedSettingsParity.test.ts` fails the build unless the mirrors list exactly the backend's managed keys, and separately if a tier-3 key reaches the mirror. |
| `ManagedSettingLabel.swift` | Titles for the new keys. Presentation, not admission — an unlabelled key still renders. |

`swiftModelStructure.test.ts` and the no-Swift-source-enumerates-runner-kinds check
stay green: nothing here re-closes the list.

## Tests

New, named after the existing per-runner suites:

- `deepseekRunner.test.ts` — handshake, turn interval settling on `idle` rather
  than on the receipt, cancellation and child death refusing a silently fresh
  same-session continuation, failed-initialize cleanup, and `closeSession`
  releasing the child.
- `deepseekEvents.test.ts` — `session.event` → canonical activity kinds, including
  an envelope with no canonical reading producing no `coding_*` event.
- `deepseekSettings.test.ts` — effective settings, `initialize` parameters, child
  env scrubbing `AUTH_TOKEN`.

Updated: `runnerRegistry.test.ts` (the pin, the descriptor policies, the prefix
non-shadowing), `managedSettingsParity.test.ts`, `settingsStore.test.ts`,
`runnerRoutes.test.ts`, `codingAgentSettings.test.ts`,
`codexJsonRpcRunner.test.ts` (guarding the Step 2 lift).

## Setting up a runtime

There are two ways to give this runner a runtime, and they trade the same thing
against each other in both directions.

**Prefer a source checkout** of
<https://github.com/deepseek-ai/deepseek-harness>.
The reason is not the build — it is that the checkout *ships compositions*
(`examples/` holds `jsonrpc-agent` beside `acp-agent`, `headless-agent`,
`mcp-memory`, `web-cordis`, `web-schedule`). Authoring one from scratch was the
hardest part of the npm path below, and it is the part the trust posture cares
about most, since that file — not this backend — decides whether a turn is
bounded. A checkout also makes "read the composition before you point at it"
literal: the plugins it names are right there to read. The cost is drift, since
a checkout tracks `master`, which carries no compatibility promise and no
protocol version negotiation, so **record the commit you built** the way the
*Risks* section says to record a runtime version, and expect that record to
expire.

**The npm closure is the pinned alternative**, and it is what actually ran here.
Take it when you want versions that hold still more than plugins you can read.

Everything below was recorded 2026-08-18 from the working install on the
author's Mac. **Those artifacts were deliberately deleted the same day** to
rehearse a cold start, so this section is the only remaining copy — a
reconstruction recipe, not a pointer to something on disk. The npm layout was a
self-contained project at `~/.dsh/agentroom` (83 MB installed) with a launcher
on `PATH` at `~/.local/bin/dsh-jsonrpc-agent`.

### Three findings a fake runtime cannot produce

They apply to both paths — the first is what makes the source form's two-slot
shape the *simpler* one rather than a workaround.

1. **The npm bin cannot be `DEEPSEEK_EXECUTABLE` directly under the packaged
   app.** `lib/bin.js` carries a `#!/usr/bin/env node` shebang, and a
   Finder-launched AgentRoom hands its backend a minimal `PATH` with no `node`
   on it, so the shebang does not resolve and the child dies before the
   handshake. The fix is the shim below, which names the interpreter
   absolutely. It is deliberately *named* `dsh-jsonrpc-agent` and placed in a
   prefix the bundled Mac probe already searches (`ExecutableSearch`, Step 7),
   so the Check button resolves it without the operator typing a path.
2. **The credential store loses a race with AgentRoom's first prompt.**
   `@deepseek-ai/dsh-credentials-local` publishes its entries *asynchronously,
   after `initialize` is already answerable*. Measured directly: a prompt sent
   50 ms after the handshake fails `MISSING_CREDENTIAL`, the same prompt at 5 s
   succeeds, and `watch: false` changes nothing. AgentRoom prompts within
   ~200 ms, so it loses every time. The key therefore has to be
   `DEEPSEEK_API_KEY` in the **backend's own environment**
   (`$AGENTROOM_HOME/config/.env`), which `dsh-llm-deepseek` resolves
   synchronously. Keep the credentials row anyway — it costs nothing and
   covers a slower caller.
3. **The `workspace-write` posture is available and was what actually ran** —
   not the `danger-full-access` of upstream's `minimal.cordis.yml`. The safety
   entry's reading still stands (AgentRoom cannot inspect the graph, so it
   treats the runner as `bypassPermissions`-class), but the permissive case is
   a property of the example config rather than of the harness.

### From source (preferred)

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
git rev-parse HEAD     # record this next to your slot values
```

`pnpm dsh web` is upstream's front door and is **not** the way in here: `dsh` is
the launcher, and no entry mode of it serves this protocol (step 10). The
serving package is `packages/examples/jsonrpc-demo`
(`@deepseek-ai/dsh-sdk-jsonrpc-demo`, bin `dsh-jsonrpc-agent`), a bin-only app
that bootstraps an external `cordis.yml`; it is TypeScript built with tsdown, so
its entrypoint appears under `lib/` after the build above.

Then fill the three tier-3 slots — **no wrapper script needed**, because the
executable slot and the argument list already express "this interpreter, that
entrypoint":

```bash
DEEPSEEK_EXECUTABLE=/opt/homebrew/bin/node
DEEPSEEK_ARGS=<checkout>/packages/examples/jsonrpc-demo/lib/bin.js
DEEPSEEK_CORDIS_CONFIG=<checkout>/examples/jsonrpc-agent/cordis.yml
```

The backend spawns `(executable, ...args)` with no shell
(`DeepSeekHarnessRunner.ts`), and `DEEPSEEK_ARGS` splits on commas only
(`config/env.ts`). The source checkout therefore must not contain a comma; the
Mac setup flow refuses such a path before saving it. Naming `node`
absolutely is what sidesteps finding 1 by construction, which is why this form
is preferable to pointing at `<checkout>/node_modules/.bin/dsh-jsonrpc-agent` —
that symlink is a `#!/usr/bin/env node` shebang script and hits the same trap
under a Finder-launched app.

Two consequences of this shape worth knowing:

- **The Mac's Check button still works.** The `executablePath` probe validates a
  stored value before it searches (`RunnerBootstrapProber`), so a hand-typed
  `/opt/homebrew/bin/node` reports satisfied; the `dsh-jsonrpc-agent` search is
  a convenience fallback for the npm path that simply stops firing.
- **The entrypoint path is not checked by anything.** It lives in the
  unprobed `arguments` slot, so a typo there surfaces at the capabilities probe
  — node's own `cannot find module …` on the bounded, redacted stderr tail —
  rather than at the Check button. Validating it would need a probe kind for
  "an argument that is a file", which is a new tier-3 primitive for a typo.

Read the composition you point at before you point at it. In an upstream
example, check three things: that nothing mounts a console/stdout logger or a
terminal UI (**stdout is the protocol** — the runtime's own docs warn a
composition can corrupt it), what `sandbox-policy` sets `mode` to, and that
`session-persistence-jsonl` is given an explicit `root` (the plugin has no
default). The annotated composition below is a worked example of all three.

### `~/.local/bin/dsh-jsonrpc-agent`

Only needed for the npm path, where the executable slot points at a shebang
script rather than at `node`.

```sh
#!/bin/sh
# AgentRoom launcher for the DeepSeek Harness SDK runtime.
#
# The npm bin is a Node script with a '#!/usr/bin/env node' shebang, and a
# Finder-launched AgentRoom hands its backend a minimal PATH with no node on
# it, so that shebang would not resolve. Naming the interpreter absolutely
# makes the runtime independent of whatever PATH the app inherited.
exec /opt/homebrew/bin/node "$HOME/.dsh/agentroom/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js" "$@"
```

`chmod +x` it. The interpreter path is this machine's Homebrew node; on a
different install, point it at whatever `which node` reports.

### `~/.dsh/agentroom/package.json`

The plugin closure the composition names, pinned. Run `npm install` in that
directory.

```json
{
  "name": "agentroom-dsh-runtime",
  "private": true,
  "description": "AgentRoom's DeepSeek Harness SDK runtime: the jsonrpc bin plus the plugin closure its cordis.yml names.",
  "dependencies": {
    "@deepseek-ai/cordis": "^4.0.1-rc.4",
    "@deepseek-ai/dsh-agent": "0.0.1-rc.5",
    "@deepseek-ai/dsh-agent-spine-demo": "0.0.1-rc.5",
    "@deepseek-ai/dsh-app-boot": "0.0.1-rc.5",
    "@deepseek-ai/dsh-credentials-local": "^0.0.1-rc.5",
    "@deepseek-ai/dsh-fs-local": "0.0.1-rc.5",
    "@deepseek-ai/dsh-invariants": "0.0.1-rc.5",
    "@deepseek-ai/dsh-llm": "0.0.1-rc.5",
    "@deepseek-ai/dsh-llm-deepseek": "0.0.1-rc.5",
    "@deepseek-ai/dsh-sandbox-local": "0.0.1-rc.5",
    "@deepseek-ai/dsh-sandbox-policy": "0.0.1-rc.5",
    "@deepseek-ai/dsh-scope": "0.0.1-rc.5",
    "@deepseek-ai/dsh-sdk-jsonrpc-demo": "^0.0.1-rc.5",
    "@deepseek-ai/dsh-sdk-jsonrpc-server": "0.0.1-rc.5",
    "@deepseek-ai/dsh-sdk-protocol": "0.0.1-rc.5",
    "@deepseek-ai/dsh-session": "0.0.1-rc.5",
    "@deepseek-ai/dsh-session-persistence-jsonl": "0.0.1-rc.5",
    "@deepseek-ai/dsh-subagent": "0.0.1-rc.5",
    "@deepseek-ai/dsh-subprocess-local": "0.0.1-rc.5",
    "@deepseek-ai/dsh-tool-bash": "0.0.1-rc.5",
    "@deepseek-ai/dsh-tool-fs": "0.0.1-rc.5",
    "@deepseek-ai/dsh-tool-str-replace-editor": "0.0.1-rc.5"
  }
}
```

Note `dsh-tool-bash` and `dsh-tool-str-replace-editor` are in the closure
without their own composition rows: `agent-spine-demo` mounts the model-facing
bash tool itself. The pins are a developer preview at `0.0.1-rc.5` (cordis
`4.0.1-rc.4`) and the protocol carries no version negotiation, so treat this
list as a snapshot that expires rather than a supported matrix — the *Risks*
section already says so.

### `~/.dsh/agentroom/cordis.yml`

The value of `DEEPSEEK_CORDIS_CONFIG`.

```yaml
# AgentRoom's DeepSeek Harness SDK runtime composition.
#
# Minimal and workspace-bounded: the JSON-RPC serving plugin, the DeepSeek
# adapter, JSONL persistence, and a bash + read/write/edit toolset confined to
# the session's own working directory. No terminal UI, console logger, approval
# UI, or user-questions tool — stdout belongs to the JSON-RPC protocol and turns
# are driven by AgentRoom.
#
# AgentRoom pins DSH_CWD (the registered workspace) and DSH_SESSION_ROOT (under
# its STATE_DIR) when it spawns this runtime; the `?? process.cwd()` fallbacks
# are only for running it by hand.

# The serving interface. Without this row the runtime boots and serves nothing.
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'

# Reads ~/.dsh/.credentials.yaml, the document the Harness web UI writes.
#
# It is the *fallback* here, not the primary path, because it publishes its
# entries asynchronously after `initialize` is already answerable — measured
# directly: a prompt sent 50 ms after the handshake fails MISSING_CREDENTIAL,
# the same prompt at 5 s succeeds, and `watch: false` changes nothing. AgentRoom
# prompts within ~200 ms of the handshake, so it loses that race every time.
# The key therefore lives in DEEPSEEK_API_KEY in the backend's environment
# (`$AGENTROOM_HOME/config/.env`), which the adapter resolves synchronously.
# This row stays because it costs nothing and covers a slower caller.
- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

# Resolves DEEPSEEK_API_KEY from the environment first, then the credentials
# service above, and falls back to $DEEPSEEK_BASE_URL for the endpoint. Its
# advisory model catalog already defaults to V4 Flash and V4 Pro, which is what
# AgentRoom's own picker offers.
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

# The bound. `workspace-write` confines file and shell mutations to the calling
# session's own cwd — which is the registered workspace AgentRoom passes as
# `initialize.cwd` — with `workspaceRoot` serving only as the fallback for
# agentless calls. Reads, network access, and process visibility are not
# confined; see docs/safety/TRUST_AND_SAFETY.md.
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()

- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()

# Agent loop, system prompt, tool registry, and the model-facing bash tool.
# Workspace context and skills are off: AgentRoom composes its own turn context
# from explicit `@` mentions, so a second loader would duplicate it.
- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    workspaceContext: false
    skills:
      enabled: false
    toolJobs: false

# read / write / edit.
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

# Durable session log. `root` is required — the plugin deliberately has no
# default, since process cwd moves under bash calls and subprocesses.
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
```

`skills.enabled: false` here is also why the descriptor's
`workspaceSkills: { mode: "none" }` was never contradicted: this composition
loads none, so fact 3 stayed unanswered rather than being answered "no".

### What that install proved, and what it did not

Proved: the runner reaches `configured: true`, the runtime spawns and completes
the handshake under the bundled Mac bootstrap, `DSH_SESSION_ROOT` pinning works
(the harness's JSONL log landed under `STATE_DIR`, not in the workspace), the
child stays resident while idle exactly as `restoreStrategy: "unsupported"`
requires, and AgentRoom sessions ran against a registered scratch workspace
(`~/repos/amazon-nova-samples`) as well as this repository.

Not proved, and still open: fact 2 (which `session.event` kinds arrive, whether
tool calls carry a stable per-call id, whether a usage envelope exists) and
fact 3 (skills). Neither was observed deliberately, and the composition above
disables skills outright. The `coding_*` stream a real turn produces has not
been compared against the mapper's expectations, which is the next thing worth
doing with a live runtime.

## Verification

```bash
pnpm typecheck
pnpm --filter @agentroom/backend build
pnpm test
```

Then the runtime smoke check, stopping the server afterwards:

```bash
PORT=8799 pnpm --filter @agentroom/backend start
curl -sS http://127.0.0.1:8799/health
curl -sS http://127.0.0.1:8799/api/runners
curl -sS 'http://127.0.0.1:8799/api/coding-agent/capabilities?runnerKind=deepseek'
curl -sS http://127.0.0.1:8799/api/config   # no DEEPSEEK_EXECUTABLE / API key anywhere
```

For the Mac bootstrap descriptor: `cd apps/macos && xcodegen generate`, then the
split `build-for-testing` / `-only-testing:` run. Do not run a Swift suite and
vitest concurrently — concurrent runs produce failures that vanish on a serial
re-run.

End to end, against a registered scratch workspace (not this repository, since a
turn may write): create a `deepseek` session, send a turn, watch
`WS /api/events` for `coding_session_started` → `coding_turn_started` → assistant
deltas and tool activity → `coding_diff_updated` → `coding_turn_completed`; stop a
turn mid-flight, confirm a same-session follow-up is refused, then create a new
session; delete it and confirm the child is gone.

## Sequencing

```
1  open the gate            ← registry + test + three docs, one commit
2  lift JsonRpcLineClient   ← standalone refactor, guarded by the codex tests
3  descriptor row           ← compiler-demanded once step 1 lands
4  adapter                  ← the bulk
5  settings + trust + env
6  capabilities + readiness
7  Mac bootstrap
8  clients (mirrors)
9  docs
```

Steps 1 and 3–4 should land close together: a registered id with no adapter is a
runner that appears in every picker and fails every turn. Steps 5 and 8 are coupled
by the parity test — the Swift mirrors and the backend declarations must land
together or `pnpm test` is red.

## Docs that move with the code

`docs/architecture/ARCHITECTURE.md` and `MOVING_PARTS.md` (`src/runner`),
`RUNNER_CAPABILITY_MATRIX.md` (a DeepSeek value in every policy row),
`docs/api/API.md` (Runners, Capabilities, Agent Sessions, and the cancel caveat),
`docs/safety/TRUST_AND_SAFETY.md`, `docs/clients/MACOS.md` (bootstrap),
`docs/operations/LOCAL_MAC_SERVER.md` (the downgrade note), `README.md`,
`.env.example`, `AGENTS.md`, `CLAUDE.md`, and this file's status line.

## Risks

- **`dsh` is a developer preview.** Its SDK protocol has no version negotiation
  and reports `serverInfo.version` `0.0.1`, unvalidated, with an explicit
  no-compatibility-promise stance. Pin the runtime version, record it here, and
  expect the record to expire. A bundled runner ages worse than a configured one.
- **Restoration is deliberately unsupported.** This runner cannot be idle-reaped
  and cannot be steered after a stop until a pinned runtime proves a portable
  persistence contract. That is worse ergonomically than the other two runners,
  but it is explicit `restoreStrategy: "unsupported"` behavior rather than
  hidden conversation loss.
- **Setup is not one path but two, and neither is `npx`.** There is no shipped
  profile that serves this protocol, so an operator must install the SDK runtime
  *and* point at a composition. That is a materially higher bar than Codex or
  Claude Code, and it is upstream's shape rather than something AgentRoom can
  smooth over without choosing the agent's tools for them.
- **The gate opens once.** After `deepseek`, the settings-file downgrade hazard is
  a standing cost of every future bundled id. Worth deciding now whether this is
  the last one or the first of several.
