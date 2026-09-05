# DeepSeek Harness runner

This is the setup and maintenance guide for AgentRoom's built-in `deepseek`
runner. Cross-runner behavior is in [RUNNERS.md](RUNNERS.md). The execution
posture is in [Trust and safety](../safety/TRUST_AND_SAFETY.md#deepseek-harness).

## Runtime contract

AgentRoom speaks the DeepSeek Harness SDK newline-delimited JSON-RPC protocol
over stdio. The executable must be the SDK-serving `dsh-jsonrpc-agent` runtime,
not the `dsh` launcher. `dsh --profile headless` is a one-shot interface without
the streaming or multi-turn contract AgentRoom needs.

The runtime requires an explicit Cordis composition. The composition chooses
plugins, tools, sandbox policy, persistence, and possible subagents. AgentRoom
cannot inspect or attest to that policy, so the runtime and composition are
tier-3 operator decisions:

- `DEEPSEEK_EXECUTABLE`: SDK runtime executable or an absolute Node executable.
- `DEEPSEEK_ARGS`: comma-separated fixed arguments, commonly the SDK entrypoint.
- `DEEPSEEK_CORDIS_CONFIG`: required composition file, falling back to an
  exported `DSH_CORDIS_CONFIG`.
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

Clarifying questions use the bounded prompt contract described in
[RUNNERS.md](RUNNERS.md#clarifying-questions). A valid question is followed by
another Harness prompt on the same live runtime while the public AgentRoom turn
remains open. This is not a permission channel.

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
Its vocabulary and enforcement belong to that composition, not AgentRoom.

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
DEEPSEEK_EXECUTABLE=/opt/homebrew/bin/node
DEEPSEEK_ARGS=<checkout>/packages/examples/jsonrpc-demo/lib/bin.js
DEEPSEEK_CORDIS_CONFIG=<checkout>/examples/jsonrpc-agent/cordis.yml
```

The checkout path must not contain a comma because `DEEPSEEK_ARGS` uses comma
separation. The macOS setup flow refuses such a path. Pointing directly at the
package bin is unreliable in a Finder-launched app because its
`#!/usr/bin/env node` shebang may not find Node on the app's minimal PATH.

The macOS executable probe validates the stored absolute Node path. It does not
validate an entrypoint stored in `DEEPSEEK_ARGS`; a typo there appears during
capability discovery as a bounded, redacted child error.

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

Still requiring deliberate live-runtime observation:

- whether a fresh process can reattach to a persisted session id;
- the exact `session.event` coverage, stable tool-call ids, and token usage;
- composed native skill discovery;
- a side-by-side comparison of live canonical events with adapter expectations.

Do not change `restoreStrategy`, canonical mappings, or workspace skill posture
from package documentation alone. Record a pinned runtime, composition, and
observed wire trace.

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
