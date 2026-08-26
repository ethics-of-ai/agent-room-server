# Cursor SDK Runner

Status: **implemented. Step 0 (the fact checks) done 2026-08-26; sequencing
item 1 (the gate, the descriptor row, and the adapter skeleton) landed
2026-08-26; sequencing item 2 (the dependency and packaging assertions, and the
host child, protocol, message mapper, question tool, and real adapter with four
suites) landed 2026-08-26; sequencing item 3 (the six managed settings, the
two tier-3 env keys, the model parameter mapping, the Swift key mirrors, and
the trust entry) landed 2026-08-26; sequencing item 4 (the Mac descriptor with
the `filePresence` probe kind, the client mirrors, and the sign-in command)
landed 2026-08-26; sequencing item 5 (the document pass, the stale-reference
check, and the mirror dry run) landed 2026-08-26. Every sequencing item has
landed; this document is the record.**
Written 2026-08-26 against `8670794` on branch `feature/cursor-sdk-runner`. Every SDK fact below was read from the
published `@cursor/sdk@1.0.28` type declarations and the vendor's TypeScript
SDK reference, or verified on this Mac with a throwaway script; each is marked.
Facts that only a real run can settle are listed under *Facts to confirm* with a
named fallback, so none of them blocks starting.

> **Precondition, found 2026-08-26: `@cursor/sdk` needs a Cursor Pro plan or
> better, local agents included.** After a successful web sign-in on a free
> account, `Cursor.models.list()` (`GET /v1/models`), `Cursor.me()`
> (`GET /v1/me`), and `Agent.create({ local })` all fail with HTTP 403
> `[plan_required] Cloud Agent is not available for free users`. The local
> create fails because the SDK validates the model against `/v1/models` before
> it runs anything, so there is no free-tier path through this SDK. The
> `cursor-agent` CLI on the same account lists models and runs, so the CLI's
> headless mode is the only free-tier route; this plan deliberately does not
> take it (see *What it speaks*). The account was upgraded the same day and
> every check below ran against it; the requirement stays here because it is
> a setup fact for every other operator and belongs in `docs/clients/MACOS.md`
> beside the sign-in command.

Adds `cursor` as a **built-in runner kind** beside `codex`, `claude_code`, and
`deepseek`: one `RunnerDescriptor` row, one adapter behind `AgentRunner`, one
child per AgentRoom session on the shared session host, and the same managed
settings, bootstrap, and capability surfaces the other three have. Nothing above
the `AgentRunner` boundary learns a new name, and no documented bound moves.

This is deliberately **not** the ACP path. Cursor's CLI has an ACP mode
(`~/.cursor/acp-config.json` is on this Mac), and an operator can already run it
as a configured `acp_*` adapter. That path stays as it is. This one exists
because a bundled runner gets what a tier-3 adapter cannot: the vendor's own
stream with reasoning, per-call tool state, and usage; a sign-in the Mac can
check with the backend stopped, as it checks `claude login`; a sandbox posture
that is a tier-2 managed setting; and a clarifying-question channel that is a
real callback rather than an in-band grammar.

## What it speaks

`@cursor/sdk` is Cursor's TypeScript SDK for driving agents. It has two
runtimes; only one is usable here.

| Surface | Verdict |
|---|---|
| **Local agents** (`Agent.create({ local: { cwd } })`) | **This is the one.** The agent loop runs inside the Node process that imports the SDK. Files come from disk; model inference goes to Cursor's hosted backend over Connect RPC (`api2.cursor.sh`, `CURSOR_BACKEND_URL`). Tools (`shell`, `read`, `edit`, `write`, `grep`, `glob`, `task`, `mcp`, …) execute on this machine. |
| **Cloud agents** (`cloud: { repos }`) | Never. Turns would run on a Cursor VM against a GitHub checkout, which is the opposite of a Mac-hosted bridge over registered local workspaces. |
| `cursor-agent -p --output-format stream-json` (the CLI's headless mode) | Not this plan. It is a one-shot process per prompt with a `--resume <chatId>` whose continuation semantics the CLI does not document, and the SDK is the vendor's supported embedding. Recorded so the choice is visible. |

What the SDK gives an embedder, from the 1.0.28 declarations:

- **Package shape.** `type: module`, but it ships `dist/cjs`, and
  `require("@cursor/sdk")` from a CommonJS host works (verified: 76 exports,
  `Agent` and `Cursor` are functions). Engines `node >= 22.13`. Persistence uses
  `node:sqlite`, which is built into that Node floor, so there is no native
  addon to build. Installed size is 28 MB plus a 9.9 MB per-platform optional
  package (`@cursor/sdk-darwin-arm64`, and `-darwin-x64`, `-linux-*`,
  `-win32-x64`) carrying `bin/rg`, `bin/cursorsandbox`, and tree-sitter
  `binding.node` files. License is "SEE LICENSE IN LICENSE.md", whose one line
  points at Cursor's Terms of Service.
- **Credential precedence.** Explicit `apiKey` → `CURSOR_API_KEY` → the key
  minted by `Cursor.auth.login()` and stored at `~/.cursor/sdk/auth.json`.
  That login is a web flow: the SDK opens the browser (or hands the URL to an
  `onLoginUrl` callback, and skips the browser under `NO_OPEN_BROWSER` or an
  SSH session), polls until the person completes sign-in, mints a named user
  API key with a 90-day default lifetime, drops the session token, and writes
  the key to a `0600` file. `Cursor.auth.status()` reports logged-in/out plus
  the expiry and never returns the key; `Cursor.auth.logout()` forgets the
  file without revoking the key. This is the runner's primary credential path.
  The `cursor-agent` CLI's own login does **not** feed the SDK (verified: the
  CLI reports logged in on this Mac, `Cursor.auth.status()` reports
  `logged-out`). User and service-account keys work; team admin keys do not.
- **Agent lifecycle.** `Agent.create(options)` → `SDKAgent`;
  `Agent.resume(agentId, options)` reattaches to a persisted agent (the model
  must be passed again; inline MCP servers are not persisted);
  `agent.send(text | { text, images }, { model, mode, onDelta, onStep, local: { force } })`
  → `Run`; `run.stream()` yields `SDKMessage`; `run.wait()` → `RunResult`
  (`status`, `result`, `error`, `usage`, `durationMs`); `run.cancel()` aborts
  the stream and in-flight tool calls; `agent.close()` /
  `agent[Symbol.asyncDispose]()` release. A second `send` while a run is active
  throws `AgentBusyError` (409).
- **Stream vocabulary** (`SDKMessage`): `system` (`init`: `agent_id`, `run_id`,
  `model`, `tools`), `assistant` (text and `tool_use` blocks), `user`,
  `tool_call` (`call_id`, `name`, `status: running | completed | error`, `args`,
  `result`, `truncated`), `thinking` (`text`, `thinking_duration_ms`), `status`
  (`CREATING | RUNNING | FINISHED | ERROR | CANCELLED | EXPIRED`), `task`
  (sub-agent), `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheWriteTokens`, `totalTokens`, `reasoningTokens`), and an undocumented
  `request` (`request_id`). Finer deltas arrive through `onDelta`
  (`InteractionUpdate`): `text-delta`, `thinking-delta`, `thinking-completed`,
  `tool-call-started`, `tool-call-delta`, `partial-tool-call`,
  `tool-call-completed`, `shell-output-delta`, `token-delta`, `turn-ended`
  (with usage), `step-started/completed`, `summary-*`, `nested-task`,
  `user-message-appended`. The typed tool-call union covers `shell`, `read`,
  `write`, `edit`, `delete`, `glob`, `grep`, `ls`, `semSearch`, `readLints`,
  `updateTodos`, `createPlan`, `task`, `mcp`, `generateImage`, `recordScreen`.
- **Posture.** The vendor's reference is explicit: the default local agent
  "runs tool calls (shell, edit, write, etc.) without asking for approval;
  there's no human-in-the-loop prompt in headless mode." Three levers exist,
  none of them a callback: `local.sandboxOptions.enabled` (writes limited to the
  working directory and a small set of allowed paths, reads outside the
  workspace blocked, network egress only to hosts a workspace
  `.cursor/sandbox.json` lists), `local.autoReview` (a server-side classifier
  that denies a blocked call rather than escalating it), and file-based
  `.cursor/hooks.json` loaded through `settingSources`. `tools` /
  `disallowedTools` restrict the toolset (`"task"` gates sub-agents, `"mcp"`
  the whole MCP family).
- **Questions.** `askQuestion` is in the `ToolName` vocabulary but absent from
  the typed tool-call union and from the headless reference. Separately,
  `local.customTools` are **in-process callbacks** exposed to the model as the
  `custom-user-tools` MCP server; their `execute` may be asynchronous, and they
  "never require interactive approval." That is the channel this plan uses.
- **Persistence.** Without a `store`, the SDK writes SQLite state under
  `~/.cursor/projects/<workspace-slug>/sdk-agent-store/<hash>` (verified with
  `getDefaultSdkStateRoot`). `SqliteLocalAgentStore({ stateRoot })` and
  `JsonlLocalAgentStore(dir)` relocate it.
- **Models.** `Cursor.models.list()` is a cloud call returning `{ id,
  displayName, description, aliases, parameters: [{ id, values }], variants }`.
  A local agent requires an explicit `model`.
- **Telemetry.** The SDK reports run created/completed, send latency, executor
  startup, and operation failures to Cursor's analytics under the API key's
  identity, and bootstraps a Statsig feature-gate client per key. Repo identity
  in analytics is gated by the account's privacy mode. No opt-out environment
  variable appears among the `process.env` names the bundle reads.
- **Environment the SDK reads** (from the bundle): `CURSOR_API_KEY`,
  `CURSOR_BACKEND_URL`, `CURSOR_WEBSITE_URL`, `CURSOR_DATA_DIR`,
  `CURSOR_RIPGREP_PATH`, `CURSOR_SANDBOX_POLICY_DIR`,
  `CURSOR_TREE_SITTER_VENDOR_DIR`, `CURSOR_FORCED_SHELL_EGRESS`,
  `CURSOR_RIPWALK_CACHE_TTL_MS`, `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`,
  `NODE_TLS_REJECT_UNAUTHORIZED`, `HOME`, `PATH`, `SHELL`, `USER`.

## The decision this plan is built around: a process boundary

The SDK runs the agent loop **inline in the importing process**. Every other
runner AgentRoom has is a child: Codex and DeepSeek over stdio JSON-RPC, Claude
Code through an SDK that itself spawns a CLI. The trust document's wording is
built on that: "`AUTH_TOKEN` is removed from the environment of **every child
the backend spawns** for a session." In-process, the shell tool's children are
the backend's own children, and `AUTH_TOKEN`, `DEEPSEEK_API_KEY`, and the rest
of the backend's environment reach `pnpm test` inside a turn unless the SDK
curates the environment it hands `spawn`, which is minified code this
repository cannot pin.

So the adapter runs the SDK in a **dedicated host child**, one per AgentRoom
session, spawned by the backend with a scrubbed environment and speaking
newline-framed JSON-RPC over stdio to the backend. What that buys:

1. The scrub stays literal. The host's environment is built by the adapter, and
   the SDK's shell tool inherits only that.
2. `PersistentRunnerSessionHost`, `commandAudit`, `streamTiming`, and the
   cancel ladder (`run/cancel` → `SIGTERM` → `SIGKILL`) all assume a child.
   Nothing is reimplemented.
3. A hung SDK, a leaked socket, or a Statsig client is a process the backend
   can kill, not a slow leak inside Fastify.
4. The ESM-versus-CommonJS question stops mattering: the host can be whatever
   the SDK prefers, and the backend never imports `@cursor/sdk` at all.

What in-process would save is the host script and its protocol, roughly the
size of one DeepSeek adapter. It would also let `customTools` call straight
into `PendingQuestionRequests` instead of through one request over the wire.
Rejected because the trust entry would then have to say "the environment a
Cursor turn's shell sees is whatever the SDK decides," and the two clarifying
question channels already cross a wire for Codex.

The transport is the existing `runner/shared/JsonRpcLineClient.ts` (label
`"Cursor SDK host"`), the same client Codex and DeepSeek use, and its
`onRequest` dispatcher already carries a server→client request for Codex's
`requestUserInput`, which is the shape the question tool needs.

## Non-goals

- **`runner/acp/` is not touched.** `acp_cursor` and `cursor` coexist.
- **No cloud agents**, ever, for the reason in the table above.
- **No login route.** `Cursor.auth.login()` runs where the browser is, as an
  operator command (Step 7), never behind the bearer-gated API: a route that
  mints a 90-day key on the operator's Cursor account would be a new trust
  surface, and the rule is no new route. The login is the credential path; it
  is the *route* that is the non-goal.
- **No universal permission enum.** Cursor's sandbox/auto-review posture stays
  its own `{ label, value }` beside the Codex approval policy, the Claude Code
  permission mode, and the DeepSeek permission mode.
- **No new legacy metadata block.** Clients read `runner` and
  `activity.canonical`.
- **No new route, event kind, or authorization.** Questions reuse the
  bearer-gated question route, the canonical pair, and the shared bounds.
- **No generic buddy fallback.** An unknown runner still renders without a
  buddy. Cursor receives only its dedicated bundled asset.
- **No `--resume`-style CLI path** under the same runner id. One id, one
  protocol.

## Facts confirmed against the real SDK

All eight were run on 2026-08-26 against `@cursor/sdk@1.0.28` with the web
sign-in on a Pro account, using `composer-2.5` and a throwaway workspace laid
out with `AGENTS.md`, a `.cursor/rules` rule, one skill in each of the four
skill directories, and marker files outside the workspace. The scripts live in
the session scratchpad (`cursor-sdk/f*.cjs`), not the repository.

| # | Question | Answer | Consequence |
|---|---|---|---|
| 1 | Does `Agent.resume(agentId)` in a fresh process, with a custom store under a pinned `stateRoot`, continue the conversation? | **Yes.** `SqliteLocalAgentStore.open({ workspaceRef, stateRoot })` (a static `open`, not a constructor) wrote `index.db` plus `agents/` under the pinned root; a second process listed the agent through `Agent.list({ runtime: "local", cwd, store })`, resumed it, and recalled the word from the first process's turn. `model` must be passed again on resume. | `restoreStrategy: "native_resume"` stands. |
| 2 | Does a shell tool's child inherit the host's environment verbatim? | **Yes**, sandboxed or not: `env` inside a turn printed the `AUTH_TOKEN` and probe values set on the host process, and `HOME`/`USER` unchanged. | The host child's environment is the scrub, and it is the only one. |
| 3 | What does the built-in `askQuestion` tool do headless? | **It does not exist in the headless catalog.** Asked to use it, the model reported it was absent from the dynamic tool catalog and asked in prose instead. The `request` message never appeared. The custom tool path worked end to end: the model called it, `execute` was awaited for four seconds, and the returned text became the answer. | `disallowedTools: ["askQuestion"]` is belt-and-braces; the custom tool is the channel. |
| 4 | Does `cursorsandbox` survive packaging? | **Yes for the local unsigned package; release signing remains to be checked.** The first packaged run failed before Seatbelt because Cursor's literal package lookup could not see the helper inside pnpm's virtual store. Direct optional Darwin dependencies created the link it expects. After rebuilding, the helper still satisfied its Anysphere designated requirement and a sandbox-enabled turn finished through the bundled Node and host. The outer app was not release-signed or notarized in that run. | Keep the `@cursor/sdk-darwin-*` publisher-signature exception, direct helper dependencies, and final-bundle assertion. Repeat the turn on the first release-signed build. |
| 5 | What does `Cursor.models.list()` return? | 36 models. Depth is `effort` (Anthropic, Grok, Gemini: `low`…`xhigh`/`max`, Gemini adds `minimal`) or `reasoning` (OpenAI, Kimi, GLM: `none`…`extra-high`/`max`); speed is `fast: true \| false`; extras are `thinking`, `context` (`200k`/`300k`/`1m`), and a `cyber` flag that appears only inside variants. `default` (alias `auto`) has no parameters. Each model marks one variant `isDefault`. | `reasoningEffort` maps to whichever of `effort`/`reasoning` the model declares, `serviceTier` maps to `fast`; `thinking` stays unmapped, while the default variant's bounded `context` value is projected as `contextWindowTokens` but is not offered as a turn setting. |
| 6 | With `settingSources: ["project"]`, what loads? | `AGENTS.md`, `.cursor/rules/*.mdc`, and skills from **all four** directories (`.cursor/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`), and **only** the workspace's: the session's `<available_skills>` block listed the four workspace skills while 19 skills under `~/.cursor/skills-cursor` stayed on disk. With `settingSources: []` nothing loaded (no `AGENTS.md`, no rule, no rules/skills service log line). Ancestor directories were not tested. | `workspaceSkills: { mode: "gated" }` with the four directories stands. |
| 7 | What does `sandboxOptions.enabled` bound? | **Writes and network, not reads.** A write into `~/agentroom-sandbox-probe` failed `operation not permitted`; writes inside the workspace and under `/private/tmp` succeeded; a read of a file in the home directory succeeded, and so did `ls ~/.cursor/sdk`; `curl https://example.com` failed at DNS (`Could not resolve host`), and `git status` in the workspace worked. Unsandboxed, everything succeeded and `curl` returned 200. The vendor's "reads outside the workspace are blocked" did not hold here. | The tier-2 default of `sandbox: true` stands; the trust entry states the real bound, including that a sandboxed shell can read the operator's own credential file. |
| 8 | Does `run.cancel()` settle promptly mid-shell? | **Yes**: `cancel()` resolved in 4 to 9 ms, `run.wait()` returned `cancelled` at once, and the `sleep 45` child was gone. The SDK then leaves one **unhandled `AbortError` rejection** behind, which Node's default policy turns into a process exit. | The host installs an `unhandledRejection` handler that recognises the post-cancel `AbortError` and logs it; anything else still fails loud. |

Two more things the runs showed that no question had asked:

- **The unsandboxed shell tool runs in the host process's cwd, not `local.cwd`.**
  `pwd` returned the script's directory unsandboxed and the workspace
  sandboxed. The host is therefore spawned with `cwd` set to the registered
  workspace, so the answer is the same either way.
- **`run.stream()` is already token-granular.** `thinking` arrived as many
  small fragments followed by one empty message carrying
  `thinking_duration_ms`, and `assistant` as word-level fragments, so the
  mapper does not need `onDelta` for text or reasoning. `onDelta` observed
  `thinking-delta`, `thinking-completed`, `text-delta`, `token-delta`,
  `tool-call-started`, `tool-call-completed`, `step-completed`, and
  `turn-ended`; `shell-output-delta` did not occur for short commands, and it
  is the one delta worth forwarding.

## Step 1. Open the rollout gate

`registeredRunnerKinds` is closed at `["codex", "claude_code", "deepseek"]`,
and `apps/backend/test/runnerRegistry.test.ts` fails the build on a fourth
entry. Opening it is the rollout-gate decision from [Universal Runner
Boundary](UNIVERSAL_RUNNER_BOUNDARY.md), and everything that pins it moves in
one commit:

| File | Change |
|---|---|
| `apps/backend/src/runner/registry.ts` | `registeredRunnerKinds` gains `"cursor"`; the compiler then demands the descriptor row (Step 3). The header comment's "currently `codex`, `claude_code`, and `deepseek`" changes. |
| `apps/backend/test/runnerRegistry.test.ts` | The pin becomes the four-id list, the projection test gains the `cursor` row (`configured: true` with no bootstrap value, the Claude Code precedent), and the policy test gains the row's fields. |
| `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` | Record that the gate opened, when, and on what basis. |
| `docs/engineering/RUNNER_CAPABILITY_MATRIX.md` | A Cursor block beside the DeepSeek one. |
| `AGENTS.md`, `CLAUDE.md` | Both state the built-in list. Both change. |
| `docs/api/API.md`, `README.md`, `.env.example` | Accepted `runnerKind` values, the runner table, `RUNNER_KIND`. |

**The id.** `cursor`, display name "Cursor", `settingsKeyPrefix: "cursor"`,
environment prefix `CURSOR_`. The registry refuses a settings prefix that
prefixes or is prefixed by another runner's; `cursor` is clean against `codex`,
`claudeCode`, and `deepseek`, and against a configured `acp_cursor`, whose
derived prefix is `acpCursor`.

**The downgrade hazard is already mitigated.** `global.runnerKind: "cursor"` in
`settings.json` is a known key with a value an older build rejects, which drops
that operator's whole trust posture onto defaults on a downgrade. The Mac's
version-1 rollback converter already refuses any runner outside
`ManagedSettingsDocument.legacyDocumentRunnerKinds`, a list that describes
shipped builds and never grows. Nothing new to build; the consequence goes in
`docs/operations/LOCAL_MAC_SERVER.md` beside DeepSeek's.

## Step 2. The dependency and packaging

- **Pin exact.** `"@cursor/sdk": "1.0.28"` in `apps/backend/package.json`,
  like the Claude Agent SDK's `0.3.172`. The backend also declares
  `@cursor/sdk-darwin-arm64` and `@cursor/sdk-darwin-x64` as direct optional
  dependencies at the same version. Cursor 1.0.28 does not use Node's package
  resolver for `cursorsandbox`; it walks up from the host entrypoint looking
  for a literal `node_modules/@cursor/sdk-darwin-${arch}` path. A transitive
  package present only inside pnpm's virtual store therefore fails the first
  sandboxed turn. The direct declarations create the path Cursor expects on
  each build architecture. The SDK is a 1.0.x with a private repository and a
  Terms-of-Service license, so drift is expected; the pins make a breaking
  change a deliberate bump.
- **Only the host imports it.** `runner/cursor/host.ts` is the one file that
  imports `@cursor/sdk`. The backend-side adapter imports the protocol schemas
  it shares with the host and nothing from the SDK, including types: the same
  loose structural coupling `runner/claudeCode/sdk.ts` chose, so version drift
  surfaces in the host's test suite rather than the build.
- **Licensing is settled in its own section below**, because the DMG
  redistributes the SDK and its signed binaries and the public mirror
  references the dependency. No `mirror/manifest.json` change is needed for
  the new source directory or this document, since `apps/backend` and `docs`
  are already included; the overlay's `THIRD_PARTY_NOTICES.md` and `README.md`
  do change.
- **Packaging copies and checks the discoverable helper.**
  `copyBackendDependencies` in `scripts/package-macos.mjs` copies
  `node_modules/.pnpm` and the backend's direct dependency links, then relocates
  those links into the bundle. `assertPackagedCursorSandboxHelper` fails the
  build unless the architecture-specific `cursorsandbox` link is executable
  and resolves inside `Contents/Resources`. `signAppBundle` then re-signs every
  Mach-O under `Contents/Resources` (here `rg`, `cursorsandbox`, and the two
  tree-sitter `binding.node` files) with the hardened runtime, except
  publisher-signed Anthropic binaries. Cursor's three arrive signed by
  Anysphere with the hardened runtime and no entitlements (fact 4), so
  `isPublisherSignedBinary` gains a `@cursor/sdk-darwin-*` pattern and leaves
  them alone. `macosDistribution.test.ts` pins the signature exception, direct
  dependency version parity, and the rule that the helper link stays inside
  the bundle.
- **Node floor.** The DMG copies the running Node unless
  `AGENTROOM_NODE_RUNTIME_DIR` names one. `package-macos.mjs` asserts the copied
  runtime is `>= 22.13`, because `node:sqlite` is not there below it and the
  failure would otherwise be a first-turn stack trace.

## Licensing and redistribution

`@cursor/sdk` and `@cursor/sdk-darwin-arm64` are "© Anysphere Inc. All rights
reserved. Use is subject to Cursor's Terms of Service." That is the whole
license file. There are no SDK-specific developer terms: the Terms of Service
(read 2026-08-26) have no clause about the SDK, and the SDK reference, the
launch post, and the npm README link to none. `pnpm licenses list --prod`
reports the pair as `Unknown`, exactly as it reports the Anthropic pair today.

The repository's own license is MIT (`mirror/overlay/LICENSE`), and the
precedent for a proprietary SDK inside it is Decision 9 of
`docs/operations/OPEN_SOURCE_MIRROR.md`: the DMG ships the Claude Agent SDK
and the Claude Code binary under Anthropic's commercial terms, recorded in
`mirror/overlay/THIRD_PARTY_NOTICES.md` with the conditions AgentRoom follows.
Cursor's SDK takes the same shape, with one difference that has to be stated
rather than papered over.

**Three surfaces, three answers.**

1. **The dependency reference** in `apps/backend/package.json` and
   `pnpm-lock.yaml`, which the mirror publishes. This is not a redistribution:
   the public repository carries a version string, and whoever runs
   `pnpm install` fetches the package from npm under Cursor's terms, the same
   way the Anthropic SDK is referenced today. No decision needed.
2. **The operator's use of the SDK** through AgentRoom. Cursor has answered
   this on the record. Its staff reply in the forum thread "API / SDK - Terms
   of use - Question" reads: "Embedding Cursor as a backend AI service in your
   product's tech stack is a supported and explicitly intended use of the
   Cursor SDK," and places clause 1.5(iii) (no renting, lending, or selling
   the Service) on resale of Cursor access itself. The launch post says
   customers are "embedding Cursor directly into customer-facing products."
   AgentRoom is the easier case: every turn bills the signed-in person's own
   plan, AgentRoom holds no Cursor credential and resells nothing. The reply
   also names what stays prohibited: reselling access, using outputs to train
   a competing model, and regulated data without a separate arrangement. None
   of those is something this runner does.
3. **The DMG**, which copies the pnpm store and so ships the SDK's JavaScript
   and Anysphere's signed `cursorsandbox`, `rg`, and tree-sitter binaries
   inside `AgentRoom.app`. This is the one place the precedent does not fully
   carry: Anthropic publishes an explicit permission to preinstall Claude Code
   in a product, and Cursor publishes no equivalent sentence. What supports
   bundling is that the package is published on public npm for installation
   into products, that the staff statement covers embedding, and that
   AgentRoom changes nothing about it. What is missing is a sentence from
   Cursor that says "you may ship it inside your installer."

**Decision: bundle, on the same conditions as Claude Code, and say so.** The
alternative, an operator-installed SDK the host resolves from a tier-3
directory, would be the only runner whose runtime the Mac cannot set up
(the `cursor-agent` CLI install carries no copy of the SDK to point at, checked
on this Mac), and it would trade a licensing uncertainty for a bootstrap
surface with its own review. The conditions AgentRoom binds itself to, which
go into `THIRD_PARTY_NOTICES.md` as a Cursor section beside the Anthropic one:

- The SDK and its platform binaries ship unmodified. The signing pass leaves
  Anysphere's signatures in place (`isPublisherSignedBinary`, Step 2), so the
  bundle runs what Cursor published.
- Each person authenticates with their own Cursor account, through the SDK's
  own web sign-in or their own API key, on their own plan. AgentRoom holds no
  Cursor credential, pays for no usage, and neither resells nor intermediates
  Cursor access. Usage appears in that person's or team's Cursor dashboard
  under the SDK tag, and Cursor's Privacy Mode rules apply as they do to the
  IDE.
- AgentRoom does not use the Cursor or Anysphere names or logos in its own
  name or branding; "Cursor" appears only as the runner's display name.
- AgentRoom uses no output of the runner to train a model and makes no claim
  about regulated data.

Two consequences go beyond the notices file:

- **The README and `docs/clients/MACOS.md`** state that the DMG ships with the
  Cursor SDK preinstalled, that a Cursor Pro plan or better is required (the
  `plan_required` finding under *Precondition*; the launch post's "available
  to all users" did not hold for a free account), and that turns bill the
  signed-in Cursor account.
- **`docs/operations/OPEN_SOURCE_MIRROR.md` gains a decision beside Decision
  9** recording this, including the one open item: before the first public
  DMG that carries the SDK, ask Cursor support for a written confirmation that
  shipping the unmodified package inside an installer is covered, and file the
  answer with the decision. If the answer is no, the fallback is the
  operator-installed SDK above, and the bundling step becomes a build-time
  opt-in until then. That question is the only licensing item left open, and
  it does not block the runner from being built or run from a checkout.

## Step 3. The descriptor row

```ts
cursor: {
  id: "cursor",
  displayName: "Cursor",
  // `AgentOptions` has no system-prompt parameter, so the standing contract
  // rides each turn prompt, as it does for Codex and DeepSeek.
  promptDelivery: "turn",
  // The stream carries per-call tool results but no turn-level diff, so
  // AgentTurnGitDiffTracker derives the turn's diff at settlement.
  turnDiffSource: "settle_time_git",
  // A real callback: the adapter registers one custom tool whose execute()
  // holds the SDK's tool call open on the shared question wait.
  clarifyingQuestions: { mode: "native" },
  workspaceSkills: {
    mode: "gated",
    gate: (config) => loadsCursorWorkspaceSettings(config)   // runner/cursor/settings.ts
  },
  // Cursor loads all four under the `project` source and none of the
  // user-level directories (fact 6); the order is the vendor's documented
  // precedence.
  skillSourceDirs: [".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills"],
  skillInvocationPrefix: "/",
  settingsKeyPrefix: "cursor",
  settings: [ /* Step 5 */ ],
  // Agent.resume(agentId) continues a persisted agent from a fresh process
  // when the store is pinned (fact 1).
  restoreStrategy: "native_resume",
  // The SDK is bundled and resolves its own credential (CURSOR_API_KEY, else
  // the stored web sign-in), so there is no bootstrap value the backend must
  // hold: the same answer as Claude Code's. Whether the operator is signed in
  // is Mac bootstrap readiness, and the backend learns it from runtime
  // capability discovery (an expired or absent key fails `models/list` with
  // an AuthenticationError, which is `ready: false`).
  isConfigured: () => true
}
```

Every row is a policy the rest of the backend already reads through the
registry. None of it is a new mechanism.

## Step 4. The adapter

`apps/backend/src/runner/cursor/`, mirroring the file split the other adapters
use, plus the one file that is new in kind:

| File | Mirrors | Role |
|---|---|---|
| `CursorSdkRunner.ts` | `DeepSeekHarnessRunner.ts` | The `AgentRunner`: capabilities cache, `run()`, `cancel()`, `closeSession()`, `dispose()`, `answerQuestionRequest()`, and the `PersistentRunnerSessionHost` wiring. Spawns one host per session. |
| `host.ts` | *(new)* | The child. Imports `@cursor/sdk`, holds one `SDKAgent`, serves the protocol below over its stdio. Compiled to `dist/runner/cursor/host.js`. Takes an injectable `Agent`/`Cursor` pair so `cursorHost.test.ts` drives it against a fake SDK. |
| `protocol.ts` | `deepseek/protocol.ts`, `acp/protocol.ts` | zod schemas for every request, response, and notification, imported by both sides and validated on receipt. Validation is not trust; it is what stops a malformed frame reaching the mapper as an unchecked shape. |
| `messageMapper.ts` | `claudeCode/messageMapper.ts` | `SDKMessage` and the forwarded deltas → `AgentRunnerActivity` + `CanonicalActivity` + `RunnerMetadata`. |
| `settings.ts` | `claudeCode/settings.ts` | Effective turn settings, the `AgentOptions` the host builds, the host's environment, `commandAudit`, and the `loadsCursorWorkspaceSettings` gate. |
| `capabilities.ts` | `claudeCode/capabilities.ts` | `models/list` → `CodingAgentCapabilities`; static fallback. |
| `questions.ts` | `claudeCode/askUserQuestion.ts` | The custom tool's input schema, the mapping into canonical question sets with AgentRoom-minted ids, and the rendering of answers back into the tool result. |
| `login.ts` | `scripts/initAuthToken.ts` (the `auth:init` precedent) | The operator's sign-in command: calls `Cursor.auth.login()` with the browser opener, prints the URL as well so an SSH or `NO_OPEN_BROWSER` session can complete it by hand, and reports `Cursor.auth.status()` afterwards. Compiled to `dist/runner/cursor/login.js`; `pnpm --filter @agentroom/backend cursor:login` runs it from a checkout. It never prints the key. |

**Spawning the host.** `process.execPath` with `process.execArgv` and the host
entry, with `cwd` set to the registered workspace: the unsandboxed shell tool
runs in the host process's cwd rather than `local.cwd`, so the host's cwd is
what makes the two postures agree. The argv carries `tsx`'s loader under
`pnpm dev` and nothing extra under the packaged runtime, so one spawn line
serves both. `commandAudit` records `executableName: "node"` and the argument
count, like every other runner's row. The host installs an
`unhandledRejection` handler for the `AbortError` the SDK leaves behind after
`run.cancel()` (fact 8); every other rejection still fails loud.

**Session host.** One host child per AgentRoom session, `restoreStrategy` read
from the registry, never a local constant:

```ts
this.sessions = new PersistentRunnerSessionHost<CursorRunnerSession>({
  runnerKind: "cursor",
  restoreStrategy: runnerDescriptor("cursor").restoreStrategy,
  idleSessionTimeoutMs: deps.idleSessionTimeoutMs ?? IDLE_SESSION_TIMEOUT_MS,
  teardown: (session) => {
    this.questions.releaseSession(session.key);
    session.client.dispose();
    session.child.kill("SIGTERM");
  },
  isBusy: (session) => session.activeTurn !== undefined,
  describe: (session) => (session.agentId ? { agentId: session.agentId } : {})
});
```

An idle-reaped session keeps its `agentId`; the next turn spawns a fresh host
and sends `agent/start` with it, which the host answers with `Agent.resume`.

**The protocol** (JSON-RPC 2.0, one frame per line, over the host's stdio).
Requests, backend → host:

| Method | Params | Result |
|---|---|---|
| `initialize` | `{ apiKey, stateRoot, backendUrl? }` | `{ sdkVersion }` |
| `agent/start` | `{ cwd, agentId?, model, settingSources, sandbox, autoReview, disallowedTools, questionTool }` | `{ agentId, resumed }` |
| `agent/send` | `{ text, images?, model?, mode?, force? }` | `{ runId }` |
| `run/cancel` | `{ runId }` | `{}` |
| `models/list` | `{}` | `{ models }` |
| `shutdown` | `{}` | `{}` |

Notifications, host → backend: `run/message { runId, message }` (one
`SDKMessage`, passed through zod with unknown fields preserved; `thinking` and
`assistant` already arrive as token-level fragments on this stream), `run/delta
{ runId, update }` (only `shell-output-delta`; the host drops every other
delta, so the wire never carries the 30k-line tool-call union), and
`run/result { runId, status, result?, error?, usage?, durationMs? }`.

One request, host → backend: `question/ask { input }` → `{ result }`.
It is what the custom tool's `execute` awaits.

Bounds are the transport's: `JsonRpcLineClient`'s frame handling, plus a
256 KiB host-side cap on forwarded shell-output bytes per run so a tool that
streams a gigabyte of stdout does not become a gigabyte of WebSocket events.

**The turn interval.** `agent/send` returns the run id; the turn is everything
tagged with it until `run/result`. `result` is the assistant's committed final
text; `error.message` passes through `util/redactSecrets` before it becomes a
`run_failed`. The SDK's `AgentBusyError` cannot happen in normal operation
because AgentRoom already sends one turn at a time per session; a steering
send is cancel-then-send, and `local.force` is reserved for the recovery path
after a host crash left a run wedged in the store.

**Cancellation** is a ladder: `run/cancel` (the SDK's `run.cancel()`) with a
bounded wait for `run/result: cancelled`, then `SIGTERM`, then `SIGKILL`. Past
the first rung the session is still restorable through `Agent.resume` (fact 1).

**Persistence** is pinned. The host opens
`SqliteLocalAgentStore({ stateRoot: <STATE_DIR>/cursor/agents })`, so agent
state lives under `$AGENTROOM_HOME` and never under `~/.cursor/projects` or the
registered workspace. The same reflex as `DSH_SESSION_ROOT`.

**Canonical mapping**, the `session.event` table's equivalent:

| SDK message / delta | Canonical | Notes |
|---|---|---|
| `system` `init` | `session_started` | `runner.nativeSessionId = agent_id`, `runner.model`, `posture` = the sandbox/auto-review label from Step 5. |
| first message of a run | `turn_started` | `runner.nativeTurnId = run_id`. |
| `text-delta` | *(none)* → `agent_update` | The assistant's streaming text. The trailing `assistant` message is the committed form and is not re-emitted as a delta. |
| `thinking` | `reasoning` | Each fragment is a `delta`; the empty fragment carrying `thinking_duration_ms` closes the block. |
| `tool_call` `running` | `tool_started` | `toolId = call_id`; `content` keeps `name` and bounded `args`. |
| `tool_call` `mcp` with `args.providerIdentifier === "custom-user-tools"` and `toolName === "ask_user_question"` | `question_requested` / `question_resolved` | The question channel's wire form (fact 3). Not rendered as a generic tool call; the canonical pair is emitted from the `question/ask` request and its settlement instead. |
| `shell-output-delta` | `tool_output` | `toolId = call_id`. |
| `tool_call` `completed` / `error` | `tool_completed` | Bounded `result`; `truncated` preserved. |
| `tool_call` for `updateTodos` / `createPlan` | `plan_updated` | Todos become steps with their status; also a `tool_*` pair like any call. |
| `usage`, `turn-ended.usage` | `token_usage_updated` | `cacheReadTokens` → `cachedInputTokens`, `reasoningTokens` → `reasoningOutputTokens`. No context-window figure on this wire. |
| `task` | *(none)* | A sub-agent's progress rides the legacy activity event and produces no `coding_*` event until a canonical home exists. |
| `request` | *(none)* | Undocumented and never observed (fact 3); logged at debug, dropped. |
| `status` `FINISHED` / `ERROR` / `CANCELLED` / `EXPIRED` | settlement | `run/result` is authoritative; `status` alone does not settle. |

Every activity also carries the native `kind` and `content`, and
`runner.native` keeps `run_id` and `call_id`, so generalizing the dispatch
costs no payload.

### Clarifying questions over a custom tool

`disallowedTools` always includes `"askQuestion"`. Fact 3 showed the built-in
tool is absent from the headless catalog already, so this is belt-and-braces
against a future SDK adding it without an answer path. When
`clarifyingQuestionsEnabled` is on, `agent/start` sets
`questionTool: true` and the host registers one custom tool,
`ask_user_question`, whose input schema is the shared question vocabulary (up
to 8 sets of up to 8 options, `single`/`multiple`, free text
`none`/`optional`/`required`, `sensitive`). Its `execute` sends
`question/ask` to the backend and awaits the answer. The backend mints every
id, opens `PendingQuestionRequests`, and emits the same canonical
`question_requested` the other adapters do; the answer route settles it; the
tool result the model sees is the person's labels and invited text, never an
AgentRoom id. Timeout returns a tool result saying nobody answered and asking
the model to continue on its best judgment. The kill switch off means no tool
is registered and no prompt mentions one. Sensitive text enters the tool result
(that is the point) and is absent from the canonical resolution, transcript,
audit, and logs.

This is `mode: "native"` in the registry because the model calls a real tool
and the adapter receives a real callback; the fact that the callback rides
AgentRoom's own wire is adapter-internal. It differs from DeepSeek's prompt
contract in the way that matters: no parser, no grammar the model can get
wrong, and a question that arrives mid-turn as a tool call the SDK itself
sequences.

### Permission approval

None. The SDK has no callback the adapter could hold open, so the runner
implements no `answerPermissionRequest` hook and
`POST /api/agent-sessions/:id/permissions/:requestId` returns `404` for it,
reading the absence of a channel rather than which runner this is. The posture
is the sandbox, the classifier, and the workspace's hooks, all declared in
Step 5.

## Step 5. Settings, environment, and trust posture

**Managed settings**, declared on the descriptor so they reach `/api/config`,
`PATCH`, the settings file, and env resolution by derivation:

| Field | Tier | Env | Notes |
|---|---|---|---|
| `model` | 1 | `CURSOR_MODEL` | `codingAgentModelIdSchema`. Required by the SDK for a local agent; the adapter falls back to the catalog's default when unset. |
| `reasoningEffort` | 1 | `CURSOR_REASONING_EFFORT` | The model's `effort` or `reasoning` parameter (fact 5), sent as `model.params`. |
| `serviceTier` | 1 | `CURSOR_SERVICE_TIER` | The model's `fast` parameter (fact 5): `fast` or `standard`, sent as `model.params`. |
| `sandbox` | **2** | `CURSOR_SANDBOX` | Boolean, **default `true`**: `local.sandboxOptions.enabled`. The Codex default is `workspace-write`; this is the nearest thing Cursor has, so the two bundled runners with a sandbox default to it. |
| `autoReview` | **2** | `CURSOR_AUTO_REVIEW` | Boolean, default `false`: `local.autoReview`. A server-side classifier is a trust decision, not a preference. |
| `loadWorkspaceSettings` | **2** | `CURSOR_LOAD_WORKSPACE_SETTINGS` | Boolean, default `true`: `settingSources: ["project"]`, else `[]`. Gate for `workspaceSkills`. |

`mode` (`agent` | `plan`) is deliberately not a managed setting in this pass:
`plan` is a per-turn choice the composer might offer later, not a posture.

New vocabularies, if any, go in `domain/settingValueSchemas.ts`, the
import-free leaf.

**Tier 3, environment-only, never in the settings file, the metadata, or the
PATCH schema:** `CURSOR_API_KEY` (optional, for an operator who prefers a
dashboard-minted or service-account key over the sign-in) and
`CURSOR_BACKEND_URL`. They join the never-managed list in `config/env.ts` and
`serviceConfigSchema` (`cursorApiKey`, `cursorBackendUrl`) beside
`CODEX_EXECUTABLE`; `managedSettingsParity.test.ts` fails the build if one
reaches a Swift mirror. `cursorApiKey` is never logged, never returned, and
never appears in a `commandAudit` row. On a packaged Mac it is set in
`$AGENTROOM_HOME/config/.env`, which the backend loads itself, exactly as
`DEEPSEEK_API_KEY` was first supplied.

**Credential resolution** mirrors Claude Code's: the sign-in is the default,
an environment key wins when set. The host passes `apiKey` to the SDK only
when `CURSOR_API_KEY` is configured; otherwise it passes nothing and the SDK
resolves the stored web sign-in from `~/.cursor/sdk/auth.json`. So the host's
`HOME` stays the operator's, and a turn bills the signed-in Cursor account, or
the explicit key when there is one. There is no third path: the `cursor-agent`
CLI's login is not read, and the trust entry says so.

**Host environment.** Inherit the operator's environment minus `AUTH_TOKEN`,
exactly `codexChildEnv`'s rule, then set `CURSOR_API_KEY` from config when
present. Whether a bundled runner's host should also drop *other* runners'
provider secrets (`DEEPSEEK_API_KEY`, `ANTHROPIC_*`) is a question every
existing runner shares and is listed under residuals rather than answered
here.

**A new entry in `docs/safety/TRUST_AND_SAFETY.md`**, beside the DeepSeek
entry, stating at minimum:

- Turns are **sandboxed by default**, and the bound is **writes and network,
  not reads** (fact 7): writes are confined to the registered workspace and
  `/private/tmp`, network egress is refused at DNS unless the workspace's own
  `.cursor/sandbox.json` lists a host, and reads are not bounded at all, so a
  sandboxed shell can read any file the operator can, the SDK's own
  `~/.cursor/sdk/auth.json` included. The vendor's reference says reads
  outside the workspace are blocked; the run said otherwise, and the entry
  reports the run. `.cursor/sandbox.json` is workspace-controlled and AgentRoom
  cannot pin it, the same class of clause as Codex's `.codex/config.toml`,
  except that Codex's network pin has no analog here. With `sandbox: false`
  the runner is `bypassPermissions`-class like the Claude Code default and the
  terminal, in those words, and the unsandboxed shell's cwd is the host's,
  which the adapter sets to the workspace.
- There is **no interactive approval channel**, so the configured posture is
  the only answer and the permissions route's `404` is honest. `autoReview`
  denies, it never escalates.
- Loading the `project` settings source means the workspace's
  `.cursor/hooks.json` hooks, `.cursor/mcp.json` MCP servers, rules, and
  skills (from four directories) take effect inside the turn. This is the same
  class of trust decision as Claude Code's `project` source, gated by
  `loadWorkspaceSettings`, and the capability-discovery probe always forces
  `settingSources: []` in the backend's own cwd.
- The SDK runs in a **host child the backend spawns**, with `AUTH_TOKEN`
  scrubbed; the agent's persisted state lives under `$AGENTROOM_HOME/state`.
- **Billing follows the sign-in.** Turns bill the Cursor account signed in
  through the SDK's web login (`~/.cursor/sdk/auth.json`, a minted user API
  key with a 90-day default lifetime, written `0600`), or `CURSOR_API_KEY`
  when set, which wins. The Mac app never reads that file's contents: its
  probe checks presence only. An expired key surfaces as `ready: false` on
  `GET /api/runners` and an `AuthenticationError` on the first turn, and the
  remedy is running the sign-in again. `Cursor.auth.logout()` forgets the file
  but does not revoke the key; revocation is the dashboard's.
- **Telemetry.** The SDK reports run lifecycle, latency, and failure events
  and feature-gate checks to Cursor under the API key's identity, with no
  opt-out the bundle exposes; repo identity in those events follows the Cursor
  account's privacy mode. Model inference leaves the Mac, as it does for every
  runner.
- Sub-agents launched through the `task` tool are processes inside the host
  that AgentRoom neither bounds separately nor observes beyond the `task`
  message. State it; build nothing for it.

Changing that entry means changing `AGENTS.md`, `CLAUDE.md`, and the test that
pins it, together.

## Step 6. Capabilities and readiness

`getCapabilities()` follows `ClaudeCodeRunner`'s shape: a per-process cache
with a five-minute TTL, a bounded redacted `error` on failure, and fallback
responses deliberately not cached so the next request retries.

- **Discovery is spawn → `initialize` → `models/list` → `shutdown`.** That
  makes the capabilities read the readiness probe, so
  `runner/runtimeReadiness.ts` stays honest: nothing spawns at startup, `ready`
  is absent until something asks, and a failed probe reports `ready: false`
  with the child's diagnostic on the capabilities `error` only.
- **The catalog is live plus a static fallback.** `models/list` is the primary
  path; the fallback list is seeded from fact 5 (`default`/`auto`,
  `composer-2.5`, `claude-opus-5`, `claude-sonnet-5`, `gpt-5.6-sol`,
  `gpt-5.3-codex`) and kept open, as `fallbackClaudeCodeModels` is. Per model,
  `reasoningEffort` is the `effort` parameter's values, or `reasoning`'s when
  that is the one declared, and `serviceTier` is `fast` (`true` → `fast`,
  `false` → `standard`); a model that declares neither carries empty lists
  rather than borrowed ones, and the `isDefault` variant supplies the default
  selection. `thinking` and `context` are not turn settings and are not
  advertised.
- The discovery host uses `settingSources: []`, the backend's own cwd, and no
  question tool.

## Step 7. Mac bootstrap

A fourth bundled `RunnerBootstrapDescriptor` in
`apps/macos/AgentRoomMac/Supervision/RunnerBootstrap/RunnerBootstrapCatalog.swift`:

- **no slots.** The SDK is bundled with the backend, so there is no executable
  to find on `PATH` and no argument list; the credential is the SDK's own
  sign-in, which lives in a file the SDK owns, not in this app's Keychain.
- one `signIn` probe, `requirement: .required`, of a **new presence-only
  kind**: `.filePresence(path: "~/.cursor/sdk/auth.json")`. It is the file
  analog of `.keychainPresence`, and carries the same rule: it stats the path
  and never opens, reads, returns, or logs it, because the file *is* the
  credential. Presence cannot tell an expired key from a live one; that is the
  backend's authority (`ready`, Step 6), and keeping the two apart is the
  two-authorities rule. Messages: satisfied "Cursor is signed in. Turns bill
  your Cursor account."; absent "No Cursor sign-in found. Run the Cursor
  sign-in command, then rerun this check." with the command in
  `docs/clients/MACOS.md`, since install recipes belong in docs the app cannot
  ship stale.
- **the sign-in command itself.** From a checkout it is
  `pnpm --filter @agentroom/backend cursor:login`. From the packaged app it is
  the bundled runtime running the bundled script:
  `"/Applications/AgentRoom.app/Contents/Resources/node/bin/node" "/Applications/AgentRoom.app/Contents/Resources/backend/dist/runner/cursor/login.js"`.
  That is the same posture as "run `claude login` in Terminal": the app names
  the step and the person performs it. A "Sign in" button that spawns the
  helper from the app and relays the URL is a second new probe primitive
  (`.signInCommand`) with its own review; it is deferred, and the Terminal
  command is the v1 path.

Bundled is the safety property: the descriptor is the launch-environment
allowlist, and this one adds no environment name to it. The new probe kind is
the one scoped Swift change the plan costs, and it is the honest half of "no
more Swift": a runner that reuses an existing primitive costs a descriptor, and
a presence check on a file is a primitive nothing here had. `RunnerBootstrapTests`
covers the new row and the new kind's never-reads property.

`CURSOR_API_KEY` deliberately has no Keychain slot in this pass. Making a
required sign-in probe satisfiable by a filled secret slot is a small
composition the probe model does not have today, and an operator who wants
the key path sets it in `$AGENTROOM_HOME/config/.env`, where the presence
probe's blocking line is the one cost. Listed under residuals.

## Step 8. Clients

Most of this is free, as it was for DeepSeek: pickers hydrate from
`GET /api/runners`, an unknown id renders as itself, capabilities are cached per
runner, the transcript dispatches on canonical kinds, and a setting no client
was built with renders from `/api/config` metadata. What is not free:

| Surface | Work |
|---|---|
| `apps/shared/.../RunnerCatalog.swift` | Add the row to `builtIn`, identity only. `legacyBackendFallback` is unchanged: a backend old enough to lack the route cannot confirm Cursor's admission. |
| `apps/shared/.../AgentRunnerKind.swift` | Add `case cursor` for bespoke presentation only. Still not `CaseIterable`. |
| `ManagedBackendSettingKey.swift` (macOS **and** visionOS), `ManagedBackendSettings.swift` (macOS) | `managedSettingsParity.test.ts` fails the build unless the mirrors list exactly the backend's managed keys. |
| visionOS `ManagedBackendSettingDescriptor` catalog | `model`, `reasoningEffort`, `serviceTier` under Runner Defaults; `sandbox`, `autoReview`, `loadWorkspaceSettings` under Trust, where `ManagedBackendSettingCatalogTests` requires them. All three trust rows are booleans, so no free-text row is added. |
| `ManagedSettingLabel.swift` | Titles for the new keys. |
| `WorkspaceRunnerBuddyAsset` | Maps Cursor to its dedicated `CursorBuddy.usdz`; unknown and ACP runner ids still resolve to no buddy. |

`swiftModelStructure.test.ts` and the no-Swift-source-enumerates-runner-kinds
check stay green: nothing here re-closes the list.

## Tests

New, named after the existing per-runner suites:

- `cursorRunner.test.ts`: host spawn and handshake (against a fake host
  injected through a `spawn` dependency, the way `deepseekRunner.test.ts`
  fakes its server), the turn interval settling on `run/result`, the cancel
  ladder through all three rungs, idle reap followed by `agent/start` with the
  kept `agentId`, host death mid-turn, `closeSession` releasing the child, the
  question round trip through `question/ask`, its timeout, the kill switch, a
  sensitive resolution, and an HTTP end-to-end flow through re-seed, answer,
  transcript, audit, and turn completion.
- `cursorHost.test.ts`: the host against a fake `Agent`/`Cursor`: `initialize`
  pins the store root, passes `apiKey` only when configured and otherwise
  leaves the SDK to its stored sign-in, `agent/start` resumes
  when given an id, `disallowedTools` always carries `askQuestion`, the
  question tool is registered only when asked for, deltas are filtered and
  capped, `run/cancel` calls `run.cancel()`, `shutdown` disposes.
- `cursorEvents.test.ts`: `SDKMessage` and delta → canonical kinds, including
  a message with no canonical reading producing no `coding_*` event, and
  `updateTodos` becoming `plan_updated`.
- `cursorQuestions.test.ts`: the custom tool advertises and maps the complete
  shared selection, discussion, free-text-only, and sensitive vocabulary.
- `cursorSettings.test.ts`: effective settings, the `AgentOptions` shape for
  each posture, `settingSources` under the gate, host env scrubbing
  `AUTH_TOKEN` and setting `CURSOR_API_KEY` only when configured, and no
  secret in the audit row.

Updated: `runnerRegistry.test.ts` (the pin, the policies, the prefix
non-shadowing, the projection), `managedSettingsParity.test.ts`,
`settingsStore.test.ts`, `runnerRoutes.test.ts`, `runnerCatalogFile.test.ts`,
`codingAgentSettings.test.ts`, `macosDistribution.test.ts` (the platform
package and its signing).

## Documents and rules that move together

`AGENTS.md`, `CLAUDE.md`, `README.md`, `.env.example`,
`docs/safety/TRUST_AND_SAFETY.md`, `docs/api/API.md` (Runners: "three" becomes
"four"; Capabilities: the parameter mapping), `docs/architecture/MOVING_PARTS.md`
(`src/runner/cursor`), `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`,
`docs/engineering/RUNNER_CAPABILITY_MATRIX.md`,
`docs/engineering/CLARIFYING_QUESTIONS.md` (the custom-tool channel),
`docs/clients/MACOS.md` (the bootstrap section, the sign-in command for a
checkout and for the packaged app, and the 90-day renewal),
`docs/operations/LOCAL_MAC_SERVER.md` (the downgrade consequence),
`mirror/overlay/THIRD_PARTY_NOTICES.md` and `mirror/overlay/README.md` (the
Cursor section and the "ships with the Cursor SDK preinstalled" line),
`docs/operations/OPEN_SOURCE_MIRROR.md` (the bundling decision beside
Decision 9), and this document, which turns from a plan into a record as
steps land.

## Sequencing

0. **Done 2026-08-26.** Signed in once with `Cursor.auth.login()` and confirmed
   the eight facts with throwaway scripts; the answers above are what the
   descriptor, the mapper, and the trust entry are written from.
1. **Done 2026-08-26.** Step 1 (gate) and Step 3 (descriptor) in one commit,
   with the registry tests, plus the adapter skeleton `server.ts` wires:
   `CursorSdkRunner.ts` reports the static fallback catalog with a bounded
   error (so a probe records `ready: false`) and fails a turn with the same
   message; `settings.ts` carries the skills gate and the audit row;
   `capabilities.ts` carries the fallback catalog seeded from fact 5. One
   deviation from Step 3 as written: the descriptor's `settings` list stays
   empty until item 3, because `managedSettingsParity.test.ts` holds the Swift
   key mirrors to the backend's managed keys, so the six declarations land
   with those mirrors rather than ahead of them.
2. **Done 2026-08-26.** Step 2 (`@cursor/sdk@1.0.28` and its two Darwin helper
   packages pinned exact; the discoverable-helper packaging assertion, the
   `@cursor/sdk-darwin-*` publisher-signed pattern, and the `>= 22.13` Node
   floor in `scripts/package-macos.mjs`, pinned by `macosDistribution.test.ts`)
   and Step 4 (`host.ts` importing the SDK through a require-based structural
   loader, `protocol.ts`, `messageMapper.ts`, `questions.ts`, `settings.ts`, and
   the real `CursorSdkRunner.ts` on `PersistentRunnerSessionHost`) with the four
   suites `cursorRunner`, `cursorHost`, `cursorEvents`, `cursorSettings`. A live
   probe against the signed-in account returned the 36-model catalog and flipped
   `GET /api/runners` `ready` to true. Two deviations from the plan as written,
   both deferred to item 3 where their wiring belongs:
   - **Model parameters are not sent yet.** `agent/send` carries `model: { id }`
     only, running each model's `isDefault` variant. Mapping a turn's
     `reasoningEffort`/`serviceTier` onto `ModelSelection.params` needs the live
     catalog's parameter names (`effort` vs `reasoning`), which is Step 6; the
     model id is honored end to end today.
   - **The Cursor `ServiceConfig` fields exist but are not wired to env or the
     managed-settings surface.** `cursorModel`, `cursorSandbox`, `cursorAutoReview`,
     `cursorLoadWorkspaceSettings`, `cursorApiKey`, `cursorBackendUrl`, and the
     effort/tier fields are declared on the interface (with defaults in
     `domain/runnerDefaults.ts`) so the host and `settings.ts` read a real
     posture; `config/env.ts`, `serviceConfigSchema`, the descriptor's `settings`
     list, and the Swift mirrors land together in item 3 under the parity test.
3. **Done 2026-08-26.** Step 5 (the six declarations on the descriptor with
   `cursorReasoningEffortSchema` and `cursorServiceTierSchema` in
   `domain/settingValueSchemas.ts`, `CURSOR_API_KEY`/`CURSOR_BACKEND_URL` read
   in `config/serviceConfig.ts`, the `.env.example` block, the
   `ManagedBackendSettingKey`/`ManagedBackendSettings` mirrors on both apps and
   the visionOS descriptor catalog under the parity and catalog tests, and the
   trust entry) and Step 6 (the catalog keeps each model's parameter *name*,
   `cursorModelSelection` in `runner/cursor/settings.ts` maps a turn's
   `reasoningEffort`/`serviceTier` onto `ModelSelection.params`, and both
   `agent/start` and `agent/send` carry it). Three deviations from the plan as
   written:
   - **`reasoningEffort` is an open id, not a closed enum.** Each Cursor model
     declares its own depth vocabulary, so an enum reported as `options` would
     offer values the selected model refuses. A *turn's* selection the model
     does not offer fails the turn; the *operator's* managed default applies
     only where the model offers it, since one default for every model would
     otherwise fail every turn on `composer-2.5` and `default`. `serviceTier`
     stays the closed `standard`/`fast` pair.
   - **A session's own host answers `models/list` once at start**, so the
     mapping runs against the live catalog without a throwaway probe and the
     result primes the capability cache. The catalog the adapter maps against
     has no TTL: parameter names change with the catalog, not with time, and a
     stale one costs one refused turn. A failed read at start keeps the last
     known catalog (the fallback until then) and is logged, not raised.
   - The visionOS model row names the runner by its wire id (`"cursor"`) until
     `AgentRunnerKind` gains its case in item 4, and `WorkspaceRunnerBuddyAsset`
     and `RunnerCatalog.builtIn` move with it there.
4. **Done 2026-08-26.** Step 7 (the bundled `cursor` descriptor with no slots
   and one required `signIn` probe of the new presence-only
   `.filePresence(path:)` kind, `FilePresenceProbe` beside
   `KeychainPresenceProbe`, `RunnerBootstrapTests` holding it to never opening
   the file by satisfying it with a 0000-mode file, and the sign-in recipe in
   `docs/clients/MACOS.md`) and Step 8 (`AgentRunnerKind.cursor`,
   `RunnerCatalog.builtIn`, `WorkspaceRunnerBuddyAsset` returning `nil` for it,
   and the visionOS model row named by the case), with XcodeGen runs. Three
   deviations from the plan as written:
   - **`login.ts` and `cursor:login` landed here, not in item 2.** Step 4 lists
     them and item 2 did not build them; Step 7's probe message points at the
     command, so it had to exist before the probe shipped. From a checkout the
     script runs the source through `tsx`, the `auth:init` precedent, so no
     build is needed first; the packaged path is the compiled
     `dist/runner/cursor/login.js`. `cursorLogin.test.ts` pins that the key is
     never printed and the browser decision stays the SDK's.
   - **`ManagedSettingLabel.swift` needed nothing.** It is a generic
     humanizer with no per-key titles; the visionOS descriptor catalog from
     item 3 already carries the six titles, and the Mac renders preserved
     sections through the humanizer.
   - **`RunnerBootstrapTestSupport.prober` points the file probe at a home
     that does not exist**, so the suite reads the same on a Mac whose
     developer is signed in to Cursor and on one whose developer is not.
5. **Done 2026-08-26.** The document pass found the surfaces items 1 through 4
   had not reached and closed them: the README's in-progress wording and runner
   row, both READMEs' diagram and trust bullets, the public overlay's README (a
   Cursor paragraph beside the Claude Code preinstall notice) and docs index,
   `THIRD_PARTY_NOTICES.md` (the Cursor section, and the license rows the SDK's
   dependency tree added: the Connect RPC client under Apache-2.0,
   `@bufbuild/protobuf`, the Statsig client), Decision 10 in
   `docs/operations/OPEN_SOURCE_MIRROR.md` with the bundling record and the
   open written-confirmation item, Phase 5 of
   `docs/engineering/CLARIFYING_QUESTIONS.md`, a Cursor sub-entry under the
   clarifying-questions trust entry, the question and restore rules in
   `AGENTS.md` and `CLAUDE.md`, and every "Codex and Claude Code" pair that is
   now a triple (native resume, idle reap, commit hooks, the artifact stream,
   the question wait) in the architecture, moving-parts, API, matrix, and trust
   documents. The stale-reference check returned nothing, and
   `pnpm mirror:public --dry-run` staged the tree with the nine overlay files
   and no denied path.

Verification, as for every backend change: `pnpm typecheck`,
`pnpm --filter @agentroom/backend build`, `pnpm test`, then the compiled
backend smoke (`PORT=8799 pnpm --filter @agentroom/backend start`, `/health`,
`/api/status`, `/api/runners` showing the `cursor` row, stopped afterward), and
`xcodegen generate` in both app directories.

## Residual questions

- **The sandbox under a release-signed app's entitled Node** (fact 4) remains
  unproved. The rebuilt unsigned app retained Anysphere's valid helper signature
  and completed a sandboxed turn through its bundled runtime. Repeat that turn
  after release signing and notarization.
- **Other runners' secrets in the host environment.** Every bundled runner
  inherits the operator's environment minus `AUTH_TOKEN`, so a Cursor turn's
  shell can read `DEEPSEEK_API_KEY` today just as a DeepSeek turn can read
  `CURSOR_API_KEY` tomorrow. A per-runner scrub of the *other* runners' tier-3
  names is one descriptor-derived list away, and it is a change to all four
  runners, not this one.
- **`task` sub-agents** have no canonical activity kind. A `nested-task`
  delta stream exists; whether it deserves a canonical home is a mapper
  question shared with Claude Code's sub-agents.
- **The `request` message.** Undocumented in 1.0.28. If a later SDK makes it
  an approval request, that is the moment to revisit `answerPermissionRequest`,
  under the existing tier-2 `ask` posture and the existing route.
- **Telemetry opt-out.** None found. If Cursor adds one, it belongs in the
  host environment, set unconditionally.
- **An API-key slot on the Mac.** A Keychain `secret` slot for
  `CURSOR_API_KEY` plus a probe that a filled slot satisfies would give the
  service-account path first-class setup. Two small Swift changes; deferred
  until someone needs it rather than built on speculation.
- **A "Sign in" button.** Spawning the login helper from the app and relaying
  its URL is the second deferred probe primitive. The Terminal command is v1.
- **Written confirmation from Cursor** that shipping the unmodified SDK inside
  the DMG is covered (*Licensing and redistribution*). Everything else in
  that section is decided; this is the one question only Cursor can answer.
