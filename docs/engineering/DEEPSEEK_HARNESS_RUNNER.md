# DeepSeek Harness runner

This is the setup and maintenance guide for AgentRoom's built-in `deepseek`
runner. Cross-runner behavior is in [RUNNERS.md](RUNNERS.md). The execution
posture is in [Trust and safety](../safety/TRUST_AND_SAFETY.md#deepseek-harness).

## Runtime contract

AgentRoom speaks the DeepSeek Harness SDK newline-delimited JSON-RPC protocol
over stdio. The executable must be the SDK-serving `dsh-jsonrpc-agent` runtime,
not the `dsh` launcher. `dsh --profile headless` is a one-shot interface without
the streaming or multi-turn contract AgentRoom needs.

The runtime requires a Cordis composition. Choose AgentRoom managed setup for
its fixed graph, or custom setup for an operator-owned graph. The runtime,
composition mode, and source path are local tier-3 decisions:

- `DEEPSEEK_EXECUTABLE`: SDK runtime executable or an absolute Node executable.
- `DEEPSEEK_ARGS`: comma-separated fixed arguments, commonly the SDK entrypoint.
- `DEEPSEEK_CORDIS_CONFIG`: required composition file, falling back to an
  exported `DSH_CORDIS_CONFIG`.
- `DEEPSEEK_COMPOSITION_MODE`: `custom` by default; explicitly select `managed`
  to generate the standard graph.
- `DEEPSEEK_API_KEY`: provider credential, supplied to the child and never
  returned.

The backend reports `configured: true` only when executable and composition are
both present. It builds argv without a shell, verifies the JSON-RPC server
identity at handshake, pins `DSH_CWD` to the registered workspace, and pins
`DSH_SESSION_ROOT` under `STATE_DIR`.

The wire exposes `initialize`, `session/prompt`, streamed `session.event` and
status notifications, and `shutdown`. It has no verified prompt-cancel request,
resume method, or server-to-client permission request. Cancellation kills the
runtime. `restoreStrategy` remains `unsupported`, so a cancelled or lost
runtime makes that AgentRoom session uncontinuable.

Managed setup registers the shared `ask_user_question` tool through the Cordis
relay. Custom setup retains the bounded prompt contract described in
[RUNNERS.md](RUNNERS.md#clarifying-questions). Each session uses one question
path. Questions collect direction and confer no execution permission.

## Managed setup and readiness

Select **AgentRoom managed** in the Mac runner settings, or set
`DEEPSEEK_COMPOSITION_MODE=managed` for a source backend. The selected
`DEEPSEEK_CORDIS_CONFIG` file locates the installed package tree. Its YAML is
neither evaluated nor copied. Packages must resolve from that file's directory,
usually `<checkout>/examples/jsonrpc-agent`, rather than the SDK entrypoint's
package directory. Existing custom files are never modified or migrated implicitly.

The backend resolves package entrypoints and its compiled tool plugin to
absolute paths. It writes immutable v1 compositions under
`STATE_DIR/deepseek/compositions/v1-<sha256>.yml` with directory mode 0700 and
file mode 0600. Exclusive temporary files and atomic rename publish complete
generations. An interrupted write cannot replace a live generation. Changed
installation paths create a new generation on the next launch; old files do
not change beneath resident children. Modified or symlinked generations are
refused with a repair message. No credential values enter generated YAML.

The fixed graph loads the SDK server, DeepSeek provider, subprocess and sandbox
services, workspace-write policy, sandbox filesystem and shell tools, agent
spine, file tools, and JSONL persistence. Shell calls have a 60-second timeout;
background jobs, subagents, workspace-context discovery, and skill discovery
are disabled. Roots use `DSH_CWD` and `DSH_SESSION_ROOT`. It adds the AgentRoom
tool plugin only when needed. This is configured policy, not independent proof
of sandbox enforcement. The trust classification remains unchanged.

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

Managed native questions use a Cordis entry named `agentroom-tools`. Managed
mode generates it when questions are enabled. A custom composition can supply
it explicitly for the shared relay. The entry loads AgentRoom's compiled
function plugin, which declares the Harness `tools` service and relays only the
catalog supplied by the backend. The plugin and backend communicate over
inherited file descriptor 3 with bounded newline-delimited envelopes:
`hello`, `catalog`, `ready`, `bind`, `invoke`, `result`, `cancel`, and `unbind`.
The child receives neither `AUTH_TOKEN` nor a backend callback URL.

The plugin is emitted at
`dist/runner/deepseek/cordis/agentRoomToolsPlugin.js`. Use its absolute path in
a custom composition:

```yaml
- id: agentroom-tools
  name: /absolute/path/to/agent-room/apps/backend/dist/runner/deepseek/cordis/agentRoomToolsPlugin.js
```

The backend also exports that resolved path as
`AGENTROOM_DEEPSEEK_CORDIS_PLUGIN`, but the pinned loader verified for B06 does
not evaluate `!!js` in a plugin `name`: it passes the value through until the
loader attempts `name.startsWith`, which fails because the value is not a
string. Therefore the environment-expression form is not supported for the
recorded runtime. Custom setup validates the explicit entry without executing YAML tags and never
edits the composition. Managed setup generates the entry from installed paths. The macOS package asserts that this compiled plugin is present as
a regular, non-symlinked backend resource.

The catalog is fixed for a live Harness child. Each turn separately binds its
run id and allowed names. Sketch tools are no longer registered. Replayed call
ids, stale runs, unknown names, and calls after unbind are refused before they
reach a handler. Cancellation aborts in-flight dispatch.

## Composition is the sandbox

Upstream has shipped both `danger-full-access` and `workspace-write`
compositions. AgentRoom treats the runner as `bypassPermissions`-class because
the SDK handshake does not reveal which graph is mounted. Read every
composition before configuring it.

A safe review checks that:

- the JSON-RPC server plugin is present;
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

Use absolute paths for all three bootstrap values:

```bash
DEEPSEEK_COMPOSITION_MODE=managed
DEEPSEEK_EXECUTABLE=/opt/homebrew/bin/node
DEEPSEEK_ARGS=<checkout>/packages/examples/jsonrpc-demo/lib/bin.js
DEEPSEEK_CORDIS_CONFIG=<checkout>/examples/jsonrpc-agent/cordis.yml
```

The checkout path must not contain a comma because `DEEPSEEK_ARGS` uses comma
separation. The macOS setup flow refuses such a path. Pointing directly at the
package bin is unreliable in a Finder-launched app because its
`#!/usr/bin/env node` shebang may not find Node on the app's minimal PATH.

The Mac checks executable, composition source, and the first Node SDK argument
locally while the backend is stopped. The entrypoint must be an absolute readable
file. Backend discovery repeats that validation before starting the runtime.

## Pinned npm installation

The last verified npm setup used a self-contained project at
`~/.dsh/agentroom` and an executable shim at
`~/.local/bin/dsh-jsonrpc-agent`. It was measured on 2026-08-18 against the
0.1.0 release-candidate family. Treat the pins as a reproducible snapshot, not a
support guarantee.

Three real-runtime findings matter:

1. The package bin's env-based Node shebang fails under the packaged app unless
   an absolute interpreter shim is used.
2. The local credential plugin publishes credentials after `initialize`.
   AgentRoom prompts too quickly for that path, so `DEEPSEEK_API_KEY` must be in
   the backend environment. Keep the credential plugin only as a slower fallback.
3. `workspace-write` was available and worked in the verified composition, but
   the backend still cannot inspect or guarantee it.

Create this executable shim and make it executable:

```sh
#!/bin/sh
exec /opt/homebrew/bin/node "$HOME/.dsh/agentroom/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/bin.js" "$@"
```

Use this package closure in `~/.dsh/agentroom/package.json`, then run
`npm install` in that directory:

```json
{
  "name": "agentroom-dsh-runtime",
  "private": true,
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

One verified `cordis.yml` is:

```yaml
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'

- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()

- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()

- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    workspaceContext: false
    skills:
      enabled: false
    toolJobs: false

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
```

This graph deliberately disables Harness workspace context and skills because
AgentRoom supplies explicit context and the runner descriptor currently
advertises no skills.

## What has been verified

The recorded live installation proved:

- bootstrap configuration and handshake succeed;
- the session root lands under backend state rather than the workspace;
- the child remains resident while idle;
- registered scratch workspaces can run turns;
- the credential timing behavior above is real.

B06 additionally verified commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` from a source checkout with the
real Cordis loader, tools service, JSON-RPC server, and a deterministic local
LLM adapter. It proved absolute-path plugin loading, both sketch schemas,
native invocation/result correlation, cancellation and unbind, and a clean
second turn. This is transport evidence, not a real-provider or headset test.

The managed-v1 probe on 2026-09-22 used the same pinned commit and real package
closure with a deterministic provider. It loaded generated YAML from an
Application Support path containing spaces, answered native questions across
two turns, cancelled a pending question, and tested the tool-free provider-check
graph. The restart probe retained a marker across live turns but lost it after
graceful shutdown and a fresh same-id prompt. The SDK calls `agents.create`,
not the core's native resume operation. Same-id success is therefore not resume.
AgentRoom keeps restoration unsupported and its durable-session refusal intact.
The fixture is `test/deepseekManagedRuntime.integration.test.ts`.

Still requiring deliberate live-runtime observation:

- the exact `session.event` coverage, stable tool-call ids, and token usage;
- composed native skill discovery;
- a side-by-side comparison of live canonical events with adapter expectations.

Do not change `restoreStrategy`, canonical mappings, or workspace skill posture
from package documentation alone. Record a pinned runtime, composition, and
observed wire trace.

Native resume needs an upstream SDK resume operation or a separately verified
Cordis extension around the core resume API. Crash persistence, replay
prevention for completed mutations, and cross-provider restoration are
unproven. Automated runtime installation or bundling, arbitrary plugin
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
