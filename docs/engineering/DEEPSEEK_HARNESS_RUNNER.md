# DeepSeek Harness runner

This is the setup and maintenance guide for AgentRoom's built-in `deepseek`
runner. Cross-runner behavior is in [RUNNERS.md](RUNNERS.md). The execution
posture is in [Trust and safety](../safety/TRUST_AND_SAFETY.md#deepseek-harness).

## Runtime contract

AgentRoom speaks the DeepSeek Harness SDK newline-delimited JSON-RPC protocol
over stdio. The verified runtime is commit
`86a402200d95fecef4529d969836f1fe13c6cb0d` (release dsh 0.2.1-alpha.4,
2026-10-15). At that commit every application starts through the `dsh` launcher
and a named profile, and the SDK wire is served by whichever profile mounts the
SDK server. The standalone `dsh-jsonrpc-agent` bin and complete `cordis.yml`
files are gone upstream.

AgentRoom owns one profile, `agentroom`, in a Harness home it pins at
`STATE_DIR/deepseek/home`. Its bundle list and its own patch layer are empty,
and AgentRoom also empties the home-level patch layer on every launch. The
composition is passed as `--patch <file>`, so that file is the whole graph. The
backend builds argv as `DEEPSEEK_ARGS` followed by
`--profile agentroom --patch <composition>`, with no shell. The runtime,
composition mode, and patch path are local tier-3 decisions:

- `DEEPSEEK_EXECUTABLE`: the `dsh` launcher, or an absolute Node executable.
- `DEEPSEEK_ARGS`: comma-separated fixed arguments, commonly the built CLI
  entrypoint. Launcher flags placed here, such as another `--patch`, come
  before AgentRoom's own.
- `DEEPSEEK_CORDIS_CONFIG`: the custom-mode patch file. Managed setup does not
  read it.
- `DEEPSEEK_COMPOSITION_MODE`: `custom` by default; explicitly select `managed`
  to generate the standard graph.
- `DEEPSEEK_API_KEY`: provider credential, supplied to the child and never
  returned.

The backend reports `configured: true` when the executable is present and, in
custom mode, the patch file too. It verifies the JSON-RPC server identity at
handshake, pins `DSH_HOME`, pins `DSH_CWD` to the registered workspace, pins
`DSH_SESSION_ROOT` under `STATE_DIR`, and removes any inherited
`DSH_CORDIS_CONFIG`, which the launcher no longer reads. The child's cwd is the
pinned home, never the workspace: the launcher loads a `.env` file from its cwd
into the child's environment, and refuses to start when that file names a
launch-only variable. The workspace reaches the graph only through `DSH_CWD`
and the `initialize` cwd.

`DSH_SESSION_ROOT` is `STATE_DIR/deepseek/sessions-v2/managed` in managed setup
and `STATE_DIR/deepseek/sessions-v2/custom/<hash>` in custom setup, where the
hash is of the patch file's contents. The session store scans its whole root on
first use and refuses it when any log there uses the other encoding. Managed
setup writes plain `.jsonl`, and a custom patch keeps upstream's `.jsonl.zstd`
unless it says otherwise, so the modes do not share a root. Two custom patches
do not share one either, and editing a patch moves it to a new root, so a
patch switched to the other encoding starts clean. A custom patch's
`session-persistence-jsonl` row should read its root from
`DSH_SESSION_ROOT`, as the managed graph does
(`root: !!js process.env.DSH_SESSION_ROOT`). A root or encoding the patch
hard-codes overrides this, and keeping that root to one encoding is then the
patch author's job. The earlier root, `STATE_DIR/deepseek/sessions`, holds zstd logs from the
0.1.0 runtime beside plain logs from the first managed graph. At this commit it
failed every new session with `uses .jsonl.zstd, but this backend is configured
for compression "none"`. AgentRoom no longer reads it. Restore is unsupported,
so nothing in it can continue, and you can delete it.

The wire exposes `initialize`, `session/prompt`, `session/resume`,
`session/wait`, `session/working-directory/get|set`, and `shutdown`, plus the
`session.event`, `session.status`, `subagent.started`, and `subagent.finished`
notifications. AgentRoom calls `initialize`, `session/prompt`, and `shutdown`.
There is no prompt-cancel request and no server-to-client permission request.
Cancellation kills the runtime. `restoreStrategy` remains `unsupported`, so a
cancelled or lost runtime makes that AgentRoom session uncontinuable. See
[What has been verified](#what-has-been-verified) for how `session/resume`
behaved.

The runtime streams no text deltas over this wire. Each model message arrives
once as `assistant/message`, with its text and reasoning blocks assembled and
the timed stream that built it in a `stream` field AgentRoom does not read. A
turn's prose therefore reaches clients one message at a time.

Managed setup registers the shared `ask_user_question` tool through the Cordis
relay. Custom setup retains the bounded prompt contract described in
[RUNNERS.md](RUNNERS.md#clarifying-questions). Each session uses one question
path. Questions collect direction and confer no execution permission.

## Managed setup and readiness

Select **AgentRoom managed** in the Mac runner settings, or set
`DEEPSEEK_COMPOSITION_MODE=managed` for a source backend. The generated patch
names packages by bare `@deepseek-ai/*` name. The launcher resolves them from
the installation that boots the overlay, so in-box packages always come from
the same `dsh` that runs. Existing custom files are never modified or migrated
implicitly.

The backend resolves its compiled tool plugin to an absolute path. It writes
immutable v2 compositions under
`STATE_DIR/deepseek/compositions/v2-<sha256>.yml` with directory mode 0700 and
file mode 0600. Exclusive temporary files and atomic rename publish complete
generations. An interrupted write cannot replace a live generation. A changed
plugin path creates a new generation on the next launch; old files do not change
beneath resident children. Modified or symlinked generations are refused with a
repair message. No credential values enter generated YAML.

The fixed graph is one `insert` patch. It replaces the removed
`agent-spine-demo` bundle with its rows stated one by one: the SDK app startup
and JSON-RPC server, timer, LLM runtime, API-key DeepSeek provider, LLM retry,
session store, session title, session projections, system prompt, tool
registry, agent registry, agent loop with no startup agents, working-directory
service, subprocess and sandbox services, workspace-write policy, sandbox
filesystem and shell services, the `bash` tool, the `read`, `write`, and `edit`
tools, the local job registry and job tools, in-process spawn subagents behind
one `subagent` tool, and JSONL persistence. Shell calls have a 60-second
timeout and `run_in_background` is on. Job completions wake the agent
(`completionDelivery: wakeup`) at most three times in a row
(`maxConsecutiveWakes: 3`); see [Background work](#background-work). The
graph mounts no forked subagents, workspace instructions, skills,
`read_image`, compaction, or DeepSeek session-log upload. Roots use `DSH_CWD` and `DSH_SESSION_ROOT`. Every
session graph adds the AgentRoom tool plugin; the provider connection test's
graph does not. This is configured policy, not
independent proof of sandbox enforcement. The trust classification remains
unchanged.

Capabilities report separate runtime, provider, and AgentRoom-tool checks.
Runtime readiness proves the SDK handshake; provider access remains
`not_checked`. Missing optional tool registration leaves ordinary turns usable.
An unloadable custom graph still prevents startup; choose managed setup or
repair the custom graph.
Sketch editing has no dependency on runtime or tool readiness.
**Test provider connection** makes an explicit provider call using a temporary,
tool-free graph, a fixed prompt, and a 32-token output cap, bounded to 30 seconds.
It may incur provider usage. Neither passive discovery nor local setup checks
send model prompts. See [the API contract](../api/API.md#coding-agent-capabilities).

## AgentRoom Cordis tools

Managed native questions, background-work stops and the subagent pause use a
Cordis entry named `agentroom-tools`. Managed mode generates it for every
session. A custom composition can supply it explicitly, and AgentRoom then
attaches it to every session, with or without tools. A session without tools
does not wait for the plugin to answer `ready`. The entry loads AgentRoom's compiled
function plugin, which declares the Harness `tools` service and relays only the
catalog supplied by the backend. The plugin and backend communicate over
inherited file descriptor 3 with bounded newline-delimited envelopes:
`hello`, `catalog`, `ready`, `bind`, `invoke`, `result`, `cancel`, `unbind`,
`stop`, `stopped`, and `subagents`.
The child receives neither `AUTH_TOKEN` nor a backend callback URL.

The plugin is emitted at
`dist/runner/deepseek/cordis/agentRoomToolsPlugin.js`. A custom patch inserts
it with its absolute path. A top-level row in a patch only targets an existing
row, so the entry must sit inside an `insert` list:

```yaml
- insert:
    - id: agentroom-tools
      name: /absolute/path/to/agent-room/apps/backend/dist/runner/deepseek/cordis/agentRoomToolsPlugin.js
```

The backend also exports that resolved path as
`AGENTROOM_DEEPSEEK_CORDIS_PLUGIN`, but the loader verified for B06 did not
evaluate `!!js` in a plugin `name`, so the environment-expression form is not
supported. Custom setup validates the explicit entry without executing YAML
tags and never edits the composition. Managed setup generates the entry from
installed paths. The macOS package asserts that this compiled plugin is present
as a regular, non-symlinked backend resource.

The catalog is fixed for a live Harness child. Each turn separately binds its
run id and allowed names. Sketch tools are no longer registered. Replayed call
ids, stale runs, unknown names, and calls after unbind are refused before they
reach a handler. Cancellation aborts in-flight dispatch.

## Background work

The runner lists the session's background shell jobs and subagents and opens
the turns the runtime starts when one ends. The wire is the only source: the
stdio protocol has no list or stop method. The behavior below was probed
against the pinned runtime with a live model on 2026-10-15, and a gated test
replays it with a scripted model route
(`apps/backend/test/deepseekBackgroundWork.integration.test.ts`).

- **Jobs.** The job registry records every shell call as a job, so
  `job/registered` alone does not mean background work. A job is listed when
  the `tool/call` it names asked for `run_in_background`, or when that call's
  `tool/result` arrives while the job still runs (a foreground call promoted
  on timeout). `job/settled` removes it. A route may record call arguments as
  JSON text or as an object; the runner reads both.
- **Subagents.** `subagent.started` lists a child, named after the
  `subagent` call that started it. The child's own `turn/end` removes it,
  because `subagent.finished` can arrive after the parent's turn that reports
  it has begun. The child's last assistant text becomes the finished task's
  summary. A subagent's background jobs list under it. Subagent depth stays at
  the host default of 1.
- **Agent-started turns.** When a job or subagent ends with the session idle,
  the runtime splices a notice into the inbox (`source.kind` `tool-jobs` or
  `subagent-settled`) and starts a turn. A root `turn/start` that no AgentRoom
  turn owns is that turn, and the runner offers it to the service with the
  tasks that ended since a turn last took them. A notice that arrives during
  any turn, a person's or the agent's, is folded into it, so every turn takes
  the held tasks when it settles. The runner drops a refused turn's events
  through its `turn/end` and the idle status after it, or until the next root
  `turn/start`. A person's turn that opens while a refused turn runs gets only
  its own events and does not end on the refused turn's `turn/end`.
- **What a turn names.** Only endings the runtime reports to the session's own
  agent are held: its own background jobs and the subagents it started. A job
  the model killed with `job_kill` is left out, because that call's result
  already told the model and the runtime sends no notice. A subagent's own
  jobs report to the subagent, so they never name a turn. A job the model
  waited on with `job_output` keeps its turn busy, so its ending is folded
  into that turn.
- **Stop.** The plugin stops a listed job with `ctx.jobs.kill` as its owning
  session, or a subagent with `ctx.subagents.interrupt` for its parent. The
  runtime then tells the agent, which spends one turn on it. A session whose
  graph has no AgentRoom plugin, or whose plugin has not answered `ready`,
  lists work but answers a stop with `unavailable`, which the route returns
  as `409`.
- **Subagent wake budget.** Upstream caps job wakes at three in a row, but a
  subagent's ending wakes its idle parent with no cap, and a woken turn can
  start another subagent. The runner counts the turns the runtime starts in a
  row. When the third opens, it sends `subagents` with `paused: true` and the
  plugin registers a Cordis tool guard that refuses the `subagent` tool. A
  person's next turn sends `paused: false`. The pause can land after the
  third turn's first call, but every later turn in the streak is refused. The
  guard matches the managed graph's tool name, so a custom graph that names
  its delegation tool otherwise, or mounts no plugin, gets no cap.
- **Lifetime.** Jobs and subagents live in the runtime process. The list
  empties when the child exits, and a cancelled turn kills the child.
- **Known gap.** The wire does not say which prompt a protocol turn answers.
  If a person's turn starts in the instant between a job settling and the
  runtime's own `turn/start` reaching the backend, that runtime turn's events
  land in the person's turn and the person's reply opens as an agent-started
  turn. Nothing is lost, but the labels swap. Telling them apart would mean
  modelling the runtime inbox's claims.

## Composition is the sandbox

Upstream ships both `danger-full-access` (`sdk-minimal`) and `workspace-write`
(the base-backed profiles) graphs. AgentRoom treats the runner as
`bypassPermissions`-class because the SDK handshake does not reveal which graph
is mounted. Read every composition before configuring it.

A custom composition is a patch list whose `insert` rows form the whole graph.
`packages/bundle/sdk-minimal/cordis.patch.yml` in a checkout has that shape and
is a useful reference, but it pins `danger-full-access` and uploads session
logs to DeepSeek, so do not point custom setup at it unchanged. A safe review
checks that:

- the SDK app startup row and the JSON-RPC server row are present;
- stdout has no console logger or terminal UI because stdout carries protocol;
- the selected sandbox mode matches the operator's intent;
- filesystem and shell roots use `DSH_CWD`;
- session persistence uses an explicit `DSH_SESSION_ROOT`;
- every tool and subagent plugin is expected.

The tier-2 `runners.deepseek.permissionMode` value is passed to the composition.
Its vocabulary and enforcement belong to that custom composition. The managed
graph fixes workspace-write policy and does not use this setting to widen it.

## Preferred source installation

A source checkout is easiest to audit because it contains the compositions it
can run. Record the exact commit because the protocol has no version
negotiation.

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
git rev-parse HEAD
```

Use absolute paths for the bootstrap values. Managed setup needs no
composition file:

```bash
DEEPSEEK_COMPOSITION_MODE=managed
DEEPSEEK_EXECUTABLE=/opt/homebrew/bin/node
DEEPSEEK_ARGS=<checkout>/apps/cli/lib/bin.js
```

On the Mac, **Use a source checkout** fills Node and the `apps/cli` entrypoint
from the checkout's `dsh` bin entry. It fills no composition, because the
checkout has none AgentRoom should run unchanged. It selects **AgentRoom
managed** unless you already keep a readable custom patch. The composition
check blocks setup only in custom mode. When the checkout's dsh version is
older than the pin, or its build is missing or older than its package manifest,
the pane offers to update or build it in Terminal. A source change that leaves
`apps/cli/package.json` alone does not show, so rebuild after pulling.

The Mac app bundles the pin as `dshPackage` in
`apps/macos/AgentRoomMac/Supervision/RunnerBootstrap/RunnerBootstrapCatalog.swift`.
Move its version and revision with the commit above.

The checkout path must not contain a comma because `DEEPSEEK_ARGS` uses comma
separation. The macOS setup flow refuses such a path. Pointing directly at the
package bin is unreliable in a Finder-launched app because its
`#!/usr/bin/env node` shebang may not find Node on the app's minimal PATH.

The Mac checks the executable, the first Node argument, and, in custom setup,
the composition locally while the backend is stopped. A `dsh` the executable
check finds on its own still depends on that shebang, so prefer Node plus the
entrypoint. The entrypoint must be an absolute readable
file. Backend discovery repeats that validation before starting the runtime.

## Pinned npm installation

The npm form needs one package. `@deepseek-ai/dsh` carries the launcher and
every in-box package the managed graph names. It was measured on 2026-10-15
against 0.2.1-alpha.4, published under the `alpha` dist-tag while `latest`
still pointed at 0.2.0-rc.2. Treat the pin as a reproducible snapshot, not a
support guarantee.

Use this `~/.dsh-agentroom/package.json`, then run `npm install` in that
directory. Keep it outside `~/.dsh`, which the launcher treats as a Harness
home:

```json
{
  "name": "agentroom-dsh-runtime",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh": "0.2.1-alpha.4"
  }
}
```

npm 11 reports that it skipped dependency install scripts. The managed graph
booted and ran sandboxed tools without approving them.

Then set:

```bash
DEEPSEEK_COMPOSITION_MODE=managed
DEEPSEEK_EXECUTABLE=/opt/homebrew/bin/node
DEEPSEEK_ARGS=/Users/you/.dsh-agentroom/node_modules/@deepseek-ai/dsh/lib/bin.js
```

The package bin's `#!/usr/bin/env node` shebang fails under the packaged app's
minimal PATH, so name Node explicitly as above rather than pointing
`DEEPSEEK_EXECUTABLE` at `node_modules/.bin/dsh`.

The managed graph mounts no credential store. The provider reads
`DEEPSEEK_API_KEY` from the environment AgentRoom launches it with, so the key
must be in the backend environment. The 0.1.0-era finding that a credential
plugin published its key too late for the first prompt no longer applies to the
managed graph.

## What has been verified

The 2026-08-18 live installation of the 0.1.0 release-candidate family proved:

- bootstrap configuration and handshake succeed;
- the session root lands under backend state rather than the workspace;
- the child remains resident while idle;
- registered scratch workspaces can run turns;
- a credential plugin published its key after `initialize`, too late for the
  first prompt.

None of that has been repeated with a real provider at the current commit.

B06 verified commit `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` from a source
checkout with the real Cordis loader, tools service, JSON-RPC server, and a
deterministic local LLM adapter. It proved absolute-path plugin loading, both
sketch schemas, native invocation/result correlation, cancellation and unbind,
and a clean second turn. This is transport evidence, not a real-provider or
headset test. The managed-v1 probe on 2026-09-22 used the same commit.

The 2026-10-15 bump re-ran both real-runtime fixtures against
`86a402200d95fecef4529d969836f1fe13c6cb0d` (dsh 0.2.1-alpha.4) with the same
deterministic provider. `test/deepseekCordisProbe.integration.test.ts` loaded
the tools plugin from a custom patch, correlated invocations, cancelled and
unbound a call, and ran a clean second turn.
`test/deepseekManagedRuntime.integration.test.ts` booted the generated v2
patch, answered native questions across two turns, cancelled a pending
question, shared one catalog between question and probe tools, and ran the
tool-free provider check. A manual probe of the managed graph saw the tools
`bash`, `edit`, `read`, and `write`; `bash` ran in the workspace although the
child's cwd was the pinned home; and a write to `$HOME` failed with
`Operation not permitted` under workspace-write. The same graph booted from a
fresh `npm install` of `@deepseek-ai/dsh@0.2.1-alpha.4`.

Background work was probed on 2026-10-15 at the same commit with
`deepseek-flash` and a live provider key, from a stdio driver and a probe
Cordis plugin outside the repository. Background jobs, subagents, runtime-started
turns, a job kill, and a subagent interrupt all behaved as
[Background work](#background-work) describes. The wake budget running out, a
notice during a person's turn, promotion on timeout, and nested subagents were
not exercised. `test/deepseekBackgroundWork.integration.test.ts` replays the
job, kill and interrupt paths on the real runtime with a scripted model route,
and shows the subagent pause ending a chain of agent turns.

Restart behavior changed at this commit. Before, a fresh child given the same
session id started an empty conversation, because the SDK called
`agents.create` and ignored the persisted log. Now that child refuses the
prompt with `session "persisted" already exists`, so loss can no longer turn
into a silent fresh start. A manual probe then called `session/resume` after a
graceful shutdown and a new process. The next prompt saw the earlier history,
and its `request/header` reason was `resume`. Native resume therefore looks
feasible on this wire. AgentRoom still keeps restoration unsupported: crash
recovery, a resume after cancellation, and replay of completed mutations are
untested, and the adapter does not call `session/resume`.

Still requiring deliberate live-runtime observation:

- the exact `session.event` coverage with a real provider, stable tool-call
  ids, and token usage;
- composed native skill discovery;
- a side-by-side comparison of live canonical events with adapter expectations.

Do not change `restoreStrategy`, canonical mappings, or workspace skill posture
from package documentation alone. Record a pinned runtime, composition, and
observed wire trace.

Native resume needs an adapter change that calls `session/resume` and proof
that it survives a crash, not only a graceful shutdown. Replay prevention for
completed mutations and cross-provider restoration are unproven. Automated runtime installation or bundling, arbitrary plugin
management, new skill discovery, and more model controls wait until setup and
continuity have live evidence.

Nobody has yet run an attended check with a real provider. It should cover:

- a fresh packaged install reaching an ordinary turn without YAML edits, then
  turns with file changes and settlement diffs;
- one clarifying-question round trip;
- cancellation during a tool call, and crash and restart recovery;
- moving or updating the app, then confirming that Keychain entries, custom
  config, and sessions survive;
- native activity compared with displayed tool progress and token usage,
  checking for duplicates and leaks.

Record the app, runtime, composition, provider, and model versions with the
result.

## Verification

Run the repository checks, then start a backend with the configured runtime and
inspect:

```bash
curl -sS http://127.0.0.1:8799/health
curl -sS http://127.0.0.1:8799/api/runners
curl -sS 'http://127.0.0.1:8799/api/coding-agent/capabilities?runnerKind=deepseek'
curl -sS http://127.0.0.1:8799/api/config
```

The config response must contain no executable, composition path, or provider
credential. Use a disposable registered workspace for an end-to-end turn. Check
streaming, settlement diff, cancellation followed by same-session refusal,
session deletion, and one clarifying-question continuation. With
`CLARIFYING_QUESTIONS_ENABLED=false`, the question contract and parser must both
be absent.

For bootstrap changes, generate the macOS project and run the relevant Swift
tests serially with the backend tests.
