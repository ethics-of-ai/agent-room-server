# Local Mac Server

The backend runs on the Mac and binds to `0.0.0.0` so Vision Pro can connect
over LAN.

## Run

```bash
pnpm install
pnpm --filter @agentroom/backend dev
```

The simulator uses `http://localhost:8787`. A physical Vision Pro should use
`http://<mac-hostname>.local:8787` or a LAN IP such as
`http://192.168.1.25:8787`.

## Compiled Backend

```bash
pnpm --filter @agentroom/backend build
pnpm --filter @agentroom/backend start
```

For app-managed storage:

```bash
export AGENTROOM_HOME="$HOME/Library/Application Support/AgentRoom"
node apps/backend/dist/index.js
```

With `AGENTROOM_HOME`, defaults are:

- `$AGENTROOM_HOME/workspaces`
- `$AGENTROOM_HOME/state`
- `$AGENTROOM_HOME/config/.env`
- `$AGENTROOM_HOME/config/settings.json` (the managed settings file; see below)

The macOS app normally sets `WORKSPACE_ROOT` to:

```text
~/Developer/AgentRoom/Workspaces
```

## Configuration

For repo-local development, copy `.env.example` to `.env` and fill in local
values. Do not commit `.env`.

Most of the values below are *managed* settings that normally live in
`$AGENTROOM_HOME/config/settings.json` (dev fallback
`<cwd>/.agentroom/config/settings.json`) — written by the macOS app's settings
panes and by `PATCH /api/config`. Setting one in the environment still works and
**wins, locking the key**: `/api/config` reports it as `source: "env"` and
refuses to change it, which is how an operator pins a setting beyond a client's
reach. Precedence is environment, else the file, else the code default, and
everything managed applies on the next backend restart. `AUTH_TOKEN`, the
executable paths, `CODEX_ARGS`, `CODEX_RUNNER_PROTOCOL`, `TERMINAL_SHELL`,
`REMOTE_SETTINGS_ADMIN`, and the host/port/storage variables are
environment-only and never enter that file. The macOS-only sidecar controls
`AGENTROOM_EXIT_WITH_PARENT` and `AGENTROOM_PARENT_PID` are also env-only. See
`docs/safety/TRUST_AND_SAFETY.md`.

- `HOST`: defaults to `0.0.0.0`.
- `PORT`: defaults to `8787`.
- `AGENTROOM_HOME`: optional app-managed runtime root.
- `WORKSPACE_ROOT`: default workspace root.
- `STATE_DIR`: JSON state and audit directory: `workspaces.json`,
  `audit-log.json`, `attachments/`, and `sessions/` (one document per agent
  thread, restored at startup; delete a thread through the API, not the file).
- `AUTH_TOKEN`: optional bearer token for mutating routes.
- `CODEX_EXECUTABLE`: Codex executable path.
- `CODEX_ARGS`: comma-separated Codex arguments.
- `DEEPSEEK_EXECUTABLE`: path to the DeepSeek Harness **SDK runtime**
  (`dsh-jsonrpc-agent`, or the packaged single-file build) — not the `dsh`
  launcher, which boots profiles and serves no SDK protocol.
- `DEEPSEEK_CORDIS_CONFIG`: path to the Cordis composition that runtime boots.
  Required alongside the executable: the runtime exits nonzero without one, so
  `GET /api/runners` reports `configured: false` until both are set.
- `CODEX_MODEL`: optional default Codex model.
- `CODEX_REASONING_EFFORT`: optional `none`, `minimal`, `low`, `medium`,
  `high`, or `xhigh`.
- `CODEX_SERVICE_TIER`: optional default Codex speed. Use `standard` or `fast`.
- `CODEX_RUNNER_PROTOCOL`: optional `jsonrpc` or `exec`; defaults to
  `jsonrpc`. JSON-RPC keeps one Codex app-server thread per AgentRoom session
  and streams canonical `coding_*` events. Use `exec` only as a compatibility
  fallback. If `CODEX_ARGS` is empty in JSON-RPC mode, the backend starts Codex
  with `app-server,--listen,stdio://`.
- `CODEX_APPROVAL_POLICY`: optional Codex app-server approval policy. Defaults
  to `never`, matching AgentRoom's non-interactive turn execution.
- `CODEX_SANDBOX_MODE`: optional Codex sandbox mode. Defaults to
  `workspace-write`.
- `CODEX_WORKSPACE_NETWORK_ACCESS`: optional `true` or `false`. Defaults to
  `false`. Set to `true` for trusted registered workspaces when turns need
  networked Git operations such as `git fetch`, `git pull`, or `git push`.
  The backend pins this value explicitly on Codex `thread/start`, so a
  workspace's committed `.codex/config.toml` cannot re-enable network access
  when it is off (see `docs/safety/TRUST_AND_SAFETY.md`).
  Git operations that update refs or commit also need a sandbox mode that can
  write `.git` metadata, such as `CODEX_SANDBOX_MODE=danger-full-access`.
  In the packaged Mac app, the Runner settings **Allow fetch, pull, and push**
  toggle writes sandbox mode and network access into the managed settings file
  and the JSON-RPC app-server bootstrap is derived from them at launch.
- `GIT_COMMAND_TIMEOUT_MS`: timeout for bounded git metadata reads.
- `REMOTE_SETTINGS_ADMIN`: optional `true` or `false`, defaults to `false`.
  Lets paired clients change the trust-posture settings through
  `PATCH /api/config`; preference settings are always client-editable.
  Environment-only, so this decision stays on the Mac.
- `AGENTROOM_EXIT_WITH_PARENT`: optional `true` or `false`, defaults to
  `false`. The macOS app sets it for the child sidecar; leave it off for a
  backend started by an operator.
- `AGENTROOM_PARENT_PID`: expected launcher pid used only with the preceding
  switch. The macOS app supplies it so a child reparented before Node startup is
  detected immediately; do not set it for an operator-started backend.

Generate an optional bearer token:

```bash
npx pnpm --filter @agentroom/backend auth:init
```

### Downgrading after selecting a newer runner

Running an older AgentRoom is supported, and the macOS app's Advanced pane
**Convert settings for an older AgentRoom** is how: it rewrites
`settings.json` as the flat document a pre-nested backend reads. One value does
not survive that trip, and it fails loudly rather than quietly.

A runner an older build does not know is safe in the file *as a namespace*:
`runners.deepseek.*`, `runners.cursor.*`, or a configured `runners.acp_*.*` is
preserved and never applied by every reader, so those settings ride a downgrade
untouched. But
`global.runnerKind` is a **known** key, and a malformed known value makes the
whole file unusable — which drops the operator's entire trust posture onto the
conservative defaults, not just the one setting. That rule is deliberate and is
not relaxed: a partially applied trust posture would be a worse answer than the
safe defaults.

So if the default runner is one the older build predates, change it to `codex`
or `claude_code` **before** converting. The Mac refuses the conversion in that
state and names the runner; the alternative — silently rewriting the operator's
default runner — would move their turns onto a different agent without asking.
An environment `RUNNER_KIND` is unaffected either way, since it never enters the
file.

## Workspaces

```bash
curl -sS http://127.0.0.1:8787/api/workspaces
curl -X POST http://127.0.0.1:8787/api/workspaces \
  -H 'content-type: application/json' \
  -d '{"path":"/Users/me/repos/my-app"}'
```

Registration requires an existing absolute directory and does not write files
inside the selected workspace.

## Sessions

```bash
curl -X POST http://127.0.0.1:8787/api/agent-sessions \
  -H 'content-type: application/json' \
  -d '{"workspaceId":"workspace-abc123def456","title":"Local turn"}'

curl -X POST http://127.0.0.1:8787/api/agent-sessions/<session-id>/turns \
  -H 'content-type: application/json' \
  -d '{"message":"Inspect the project and summarize the next change."}'
```

To send selected file context, use workspace-relative paths:

```bash
curl -X POST http://127.0.0.1:8787/api/agent-sessions/<session-id>/turns \
  -H 'content-type: application/json' \
  -d '{"message":"Use @README.md while answering.","context":{"paths":["README.md"]}}'
```

The backend resolves those paths inside the registered workspace, injects
bounded previews into the runner prompt, and stores the original `message`
unchanged in session history.

Clients can discover safe coding-agent controls:

```bash
curl -sS http://127.0.0.1:8787/api/coding-agent/capabilities
```

For trusted workspaces where AgentRoom turns should be able to fetch, pull, or
push with the same Git credentials available to the backend process, enable
**Allow fetch, pull, and push** in the Mac app Runner settings, then restart the
backend sidecar. For direct backend launches, set this in
`$AGENTROOM_HOME/config/.env` or the repo `.env`, then restart the backend:

```bash
CODEX_RUNNER_PROTOCOL=jsonrpc
CODEX_ARGS=app-server,--listen,stdio://
CODEX_SANDBOX_MODE=danger-full-access
CODEX_WORKSPACE_NETWORK_ACCESS=true
```

Use SSH agent or the local Git credential helper for remote authentication.
For pull request creation, install and authenticate the GitHub CLI on the Mac
host. The macOS app preserves the backend launch environment needed for SSH
agent access and adds common developer tool paths such as `/opt/homebrew/bin`
and `/usr/local/bin`. It strips only the AgentRoom-managed keys it owns, so an
inherited shell export cannot silently lock a setting the panes present as
editable; unrelated developer credentials in the operator's environment are
passed through.

Selected model, reasoning effort, and speed values can be sent with a
turn:

```bash
curl -X POST http://127.0.0.1:8787/api/agent-sessions/<session-id>/turns \
  -H 'content-type: application/json' \
  -d '{"message":"Inspect the project.","settings":{"model":"gpt-example","reasoningEffort":"high","serviceTier":"fast"}}'
```

When `AUTH_TOKEN` is configured, add the bearer token to mutating requests and
workspace tree/file-preview reads:

```bash
-H "authorization: Bearer $AUTH_TOKEN"
```

## Smoke Check

```bash
PORT=8799 pnpm --filter @agentroom/backend start
curl -sS http://127.0.0.1:8799/health
curl -sS http://127.0.0.1:8799/api/status
```
