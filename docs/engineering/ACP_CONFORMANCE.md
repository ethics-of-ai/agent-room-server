# ACP Real-Agent Conformance

Phase 5 of [Registered Runner Completeness](REGISTERED_RUNNER_COMPLETENESS.md).

The ACP adapter (`apps/backend/src/runner/acp`) is covered in CI by a synthetic
agent fixture (`apps/backend/test/acpRunner.test.ts`), which is deterministic and
needs neither network nor a provider credential. What that fixture cannot do is
prove the adapter's reading of a *real* agent is right: every mapping decision in
Phase 4 rests on the shapes `@agentclientprotocol/codex-acp` actually sends, and
a fixture asserts the shapes we transcribed rather than the ones it emits today.

This is the procedure that closes that gap. It is deliberately **not in CI** — it
needs network access and a provider credential — but it is a procedure rather
than a recollection: an operator runs it from the repository without
reconstructing the spike's setup, and writes the observations down.

Run it when the ACP adapter changes, when the reference agent releases a new
version, or before trusting a new external agent with real work.

## What a pass establishes

| Check | What it proves |
|---|---|
| C1 | An operator-configured adapter registers, and admission accepted the binary |
| C2 | Capability discovery works, and readiness is observed rather than probed |
| C3 | The `session/new` response is captured — the record every mapping rests on |
| C4 | A turn round-trips and maps onto the canonical event union |
| C5 | **A selected model is applied and honored** — the observation Phase 4 owed |
| C6 | Cancellation settles the in-flight prompt rather than orphaning it |
| C7 | A lost child is restored by `session/resume`, not silently restarted |
| C8 | Declined `fs`/`terminal` capabilities are honored by the real agent |

## Prerequisites

- A local `codex` binary. The ChatGPT app bundles one at
  `/Applications/ChatGPT.app/Contents/Resources/codex`; any installed `codex`
  works. The ACP agent finds it through `CODEX_PATH`.
- `@agentclientprotocol/codex-acp` installed. The spike drove 1.4.0. Use the
  maintained `@agentclientprotocol/*` package, **not** the retired
  `@zed-industries/codex-acp`.
- A provider credential the agent can reach — normally an existing `codex login`,
  copied into the isolated home below.
- `jq` for reading responses.

Two artifacts this procedure creates hold sensitive data and must stay outside
the repository: the **wire log** (prompts, agent output, anything else that
crossed the wire) and the **isolated agent home** (`auth.json`). Delete both when
the run is done.

## Setup

Everything below is one shell session. Nothing here is committed.

### 1. Resolve the pieces

```bash
export REPO=/Users/me/repos/agent-room                       # this checkout
export CONF=$HOME/.agentroom-acp-conformance                 # scratch, outside the repo
export CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex
export NODE_BIN="$(command -v node)"
mkdir -p "$CONF"

# The agent's entry point. Read it from the package rather than pinning a path
# that rots across releases:
ACP_PKG="$(npm root -g)/@agentclientprotocol/codex-acp"
node -p "JSON.stringify(require('$ACP_PKG/package.json').bin)"
export ACP_ENTRY="$ACP_PKG/<the bin path printed above>"

export ACP_TEE_LOG="$CONF/wire.log"
: > "$ACP_TEE_LOG"
```

### 2. Isolate the agent's home

The spike ran the agent against its own `CODEX_HOME` so the conformance run
cannot mutate the operator's real Codex state — including the durable
`projects."<path>".trust_level` entry a Codex thread writes.

```bash
export CODEX_HOME="$CONF/codex-home"
mkdir -p "$CODEX_HOME"
cp ~/.codex/auth.json "$CODEX_HOME/auth.json"     # the provider credential

# The posture the spike used when it tried to provoke a permission request.
# Keep it: C8 records that this agent resolves approvals internally even here.
cat > "$CODEX_HOME/config.toml" <<'EOF'
approval_policy = "untrusted"
sandbox_mode = "read-only"
EOF
```

### 3. Understand the two setup traps

Both cost the spike time, and both are consequences of the trust boundary rather
than bugs to work around:

- **The command may not be a symlink.** `admission.ts` requires an absolute,
  non-symlink, regular, executable file, because a symlink's target can be
  repointed after the operator reviewed it. A globally installed npm bin is
  normally a symlink, so naming `$(command -v codex-acp)` is refused.
- **The child environment is an allowlist, not an inheritance.** An ACP child
  receives only `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `USER`, `LOGNAME`
  plus the names in `envGrants`. `CODEX_PATH` and `CODEX_HOME` **must** be
  granted or the agent will not find its binary or its credential. `AUTH_TOKEN`
  can never be granted.

`scripts/acp-conformance-agent.mjs` answers the first (a real file in the repo,
nameable directly) and is what makes C3 possible: it passes the NDJSON through
byte-for-byte while recording both directions to `ACP_TEE_LOG`.

### 4. Configure and start the backend

```bash
export ACP_ADAPTERS_ENABLED=true
export ACP_ADAPTERS="$(jq -nc \
  --arg cmd "$REPO/scripts/acp-conformance-agent.mjs" \
  --arg node "$NODE_BIN" \
  --arg entry "$ACP_ENTRY" \
  '[{id:"acp_codex",displayName:"Codex ACP",command:$cmd,
     args:[$node,$entry],
     envGrants:["CODEX_PATH","CODEX_HOME","ACP_TEE_LOG"]}]')"

export BASE=http://127.0.0.1:8799
PORT=8799 pnpm --filter @agentroom/backend dev
```

Leave that running and open a second shell with the same `BASE`. These steps
assume no `AUTH_TOKEN`; if one is set, add
`-H "authorization: Bearer $AUTH_TOKEN"` to every request below.

To drive the adapter *without* the wire log, set `command` to the agent entry
itself — but only if that path is not a symlink.

## The checks

### C1 — Registration and admission

```bash
curl -sS "$BASE/api/runners" | jq '.runners[] | select(.runnerKind=="acp_codex")'
```

**Expect** `registered: true`, `configured: true`, `enabled: true`, and **no
`ready` field at all**. Absent is not `false`: nothing has asked yet, and this
route spawns nothing. `configured: false` means admission refused the path — see
troubleshooting.

The response must carry no executable path, argument, or environment name.

### C2 — Capability discovery and observed readiness

```bash
curl -sS "$BASE/api/coding-agent/capabilities?runnerKind=acp_codex" | jq
curl -sS "$BASE/api/runners" | jq '.runners[] | select(.runnerKind=="acp_codex") | .ready'
```

**Expect** a non-empty `settings.models`, no `error`, and then `ready: true` —
the discovery *is* the probe. Each model must carry `serviceTiers: []` (generic
`model_config` is deliberately unmapped) and the same `reasoningEfforts` list as
every other model (ACP scopes effort to the session, not the model).

Record the model ids; C5 needs one that is not the default.

### C3 — Capture the `session/new` response

```bash
grep -n '"configOptions"' "$ACP_TEE_LOG" | head -3
grep -m1 'session/new' -A0 "$ACP_TEE_LOG"
```

**Expect** a `session/new` request and a response carrying `configOptions`.
Copy that response into the results file — it is the record every mapping
decision rests on, and re-capturing it is the point of the run.

Then confirm the adapter's reading of it, by inspection:

- a selector with `category: "model"` → became `models` in C2;
- a selector with `category: "thought_level"` → became `reasoningEfforts`;
- any `mode` selector → reported **nowhere** in C2. That is the agent's own
  sandbox posture, and a turn setting carries none of the tier-2 gating every
  other runner posture has;
- any `collaboration_mode` or `model_config` selector → also unreported.

A category present here but absent from this list is a finding: it means the
agent grew a selector the adapter has not decided about. Note it in the results.

### C4 — One turn

```bash
WS=$(curl -sS -X POST "$BASE/api/workspaces" -H 'content-type: application/json' \
  -d "{\"path\":\"$REPO\",\"name\":\"agent-room\",\"kind\":\"user_selected\"}" \
  | jq -r '.workspace.id')

SESSION=$(curl -sS -X POST "$BASE/api/agent-sessions" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"runnerKind\":\"acp_codex\"}" | jq -r '.session.id')

curl -sS -X POST "$BASE/api/agent-sessions/$SESSION/turns" -H 'content-type: application/json' \
  -d '{"message":"Reply with exactly: conformance ok. Then remember the word marmalade."}' | jq -r '.turn.id'

sleep 20
curl -sS "$BASE/api/agent-sessions/$SESSION/messages" | jq '.messages[-1].content'
curl -sS "$BASE/api/agent-sessions/$SESSION" | jq '.session.runner'
```

**Expect** an assistant reply, and a `runner` block carrying `nativeSessionId`
(record it — C7 compares against it). In `curl -sS "$BASE/api/logs"` expect
`coding_turn_started`, `coding_assistant_message_delta`, and
`coding_turn_completed` for this session, each with a `runner` envelope and an
`activity.canonical` reading — never a native kind standing in for one.

### C5 — A selected model is applied and honored

The observation Phase 4 owed: the mapping and ordering are covered against the
synthetic agent, but no live run had driven `session/set_config_option` against
the real agent and seen the next turn use the selection.

Pick a model id from C2 that is **not** the default, then:

```bash
MODEL=<non-default model id from C2>
curl -sS -X POST "$BASE/api/agent-sessions/$SESSION/turns" -H 'content-type: application/json' \
  -d "{\"message\":\"Which model are you? Answer with the model identifier only.\",
       \"settings\":{\"model\":\"$MODEL\"}}" | jq -r '.turn.id'
sleep 20
grep -n 'set_config_option' "$ACP_TEE_LOG" | tail -5
curl -sS "$BASE/api/agent-sessions/$SESSION/messages" | jq -r '.messages[-1].content'
```

**Expect**, in order in the log: a `session/set_config_option` request carrying
the selected value, **before** the `session/prompt` for this turn; a response
whose complete `configOptions` list confirms the new `currentValue`; and an
assistant answer naming that model.

Then send the same turn again with the same `settings.model`.

**Expect no second `session/set_config_option`** — a selection is applied only
where it differs from the live value. A repeat means the live-state tracking
regressed.

### C6 — Cancellation

```bash
curl -sS -X POST "$BASE/api/agent-sessions/$SESSION/turns" -H 'content-type: application/json' \
  -d '{"message":"Count slowly from 1 to 500, one number per line."}' >/dev/null
sleep 3
curl -sS -X POST "$BASE/api/agent-sessions/$SESSION/cancel" | jq '.session.status'
grep -n 'session/cancel\|stopReason' "$ACP_TEE_LOG" | tail -5
```

**Expect** a `session/cancel` notification, the in-flight `session/prompt`
settling with `stopReason: "cancelled"` (cancellation needs no out-of-band
bookkeeping), the turn recorded `cancelled`, and the session back to `idle` with
no `activeTurnId` so a steering follow-up can continue the same thread.

### C7 — A forced restore

AgentRoom reaps idle children after 30 minutes and resumes them. Rather than
wait, kill the child and send another turn:

```bash
pkill -f acp-conformance-agent.mjs
sleep 1
curl -sS -X POST "$BASE/api/agent-sessions/$SESSION/turns" -H 'content-type: application/json' \
  -d '{"message":"What word did I ask you to remember?"}' | jq -r '.turn.id'
sleep 20
grep -n 'launch\|session/resume\|session/new\|session/load' "$ACP_TEE_LOG" | tail -8
curl -sS "$BASE/api/agent-sessions/$SESSION" | jq '.session.runner.nativeSessionId'
curl -sS "$BASE/api/agent-sessions/$SESSION/messages" | jq -r '.messages[-1].content'
```

**Expect** a second `launch` line, a fresh `initialize`, then **`session/resume`
with the same session id** — not `session/new`, and not `session/load` (the
reference agent advertises `sessionCapabilities.resume`, so resume-first is the
live path and load-replay is only the fallback). `nativeSessionId` must be
unchanged, and the agent must recall *marmalade* — a fresh conversation under the
same AgentRoom session id is precisely the failure the restore rule exists to
prevent.

### C8 — Declined capabilities, and the permission finding

```bash
curl -sS -X POST "$BASE/api/agent-sessions/$SESSION/turns" -H 'content-type: application/json' \
  -d '{"message":"Run `ls` here, then create a file named conformance-probe.txt containing hello."}' >/dev/null
sleep 30
grep -c 'fs/read_text_file\|fs/write_text_file\|terminal/' "$ACP_TEE_LOG"
grep -c 'session/request_permission' "$ACP_TEE_LOG"
```

**Expect `0` for both.**

The first is the capability posture holding: AgentRoom advertises
`fs.readTextFile: false`, `fs.writeTextFile: false`, and `terminal: false` at
`initialize`, and a conforming agent must not call them — the bounded workspace
PUT stays the only client-initiated write.

The second is a **recorded finding rather than a gap**: this agent resolves
approvals internally and issues no `session/request_permission`, even under the
`untrusted`/`read-only` posture configured in setup. The conservative responder
must still exist — the protocol has the method and other agents use it — so its
coverage belongs to the synthetic fixture, which is the better vehicle anyway:
deterministic, and it needs neither network nor a credential. **Do not read a
passing C8 as coverage of the permission path.**

## Recording the result

Write the observations somewhere durable — a PR comment or an issue. Cheap
template:

```text
ACP conformance — <date>
  codex-acp <version>, codex <version>, AgentRoom <commit>
  C1 registration/admission     pass | fail: …
  C2 discovery + readiness      pass | fail: …   models: …
  C3 session/new captured       pass | fail: …   categories seen: …
  C4 turn round-trip            pass | fail: …   nativeSessionId: …
  C5 model selection honored    pass | fail: …   selected: …  re-send suppressed: yes/no
  C6 cancellation               pass | fail: …
  C7 forced restore             pass | fail: …   resume (not new/load): yes/no
  C8 fs/terminal declined       pass | fail: …   request_permission count: 0
  Unmapped configOption categories encountered: …
```

Then clean up:

```bash
rm -rf "$CONF"        # wire log (prompts, output) and the copied credential
curl -sS -X DELETE "$BASE/api/agent-sessions/$SESSION"
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| C1 `configured: false` | Admission refused the path. It must be absolute, not a symlink, a regular file, and executable. `$(command -v codex-acp)` is normally a symlink. |
| C2 `error` mentioning "is not runnable" | Same admission rules, reported at spawn; the message names the specific reason. |
| Agent exits immediately; log shows `agent exited code=127` | The launcher could not spawn its argument — check `$NODE_BIN` and `$ACP_ENTRY` are absolute and exist. |
| Agent starts, then fails to find codex or its credential | `CODEX_PATH` / `CODEX_HOME` missing from `envGrants`. The child environment is an allowlist, not an inheritance. |
| `speaks ACP v<n>, which this backend does not` | The agent negotiated a protocol version other than v1. A v2 agent is a separate decision, not a configuration fix. |
| Adapter absent from `/api/runners` entirely | `ACP_ADAPTERS_ENABLED` unset, or `ACP_ADAPTERS` failed validation — a malformed list is dropped whole, with one bounded warning in the backend log. |
| Empty wire log | `ACP_TEE_LOG` not in `envGrants`, so the launcher fell back to `$TMPDIR/agentroom-acp-conformance.log`. |
| C7 shows `session/new` instead of `session/resume` | The agent stopped advertising `sessionCapabilities.resume`, or the resume was rejected and fell back. Both are findings worth recording. |

## What this procedure deliberately does not cover

- **Interactive permission approval.** Unreachable through this agent (C8). Its
  coverage is the synthetic fixture and
  `apps/backend/test/pendingPermissionRequests.test.ts`.
- **Image attachments.** The reference agent's `promptCapabilities.image` answer
  decides whether it can be exercised at all; the negotiation and the bounded
  per-prompt image budget are covered synthetically. Add a check here if a
  reference agent advertises image support.
- **Anything about the built-in runners.** Codex and Claude Code have their own
  postures and their own coverage; this is about an arbitrary configured agent.
