# Cursor SDK runner

This is the integration and maintenance guide for AgentRoom's built-in
`cursor` runner. Cross-runner behavior is in [RUNNERS.md](RUNNERS.md). Trust
posture is in [Trust and safety](../safety/TRUST_AND_SAFETY.md#cursor).

The integration was measured on 2026-08-26 against `@cursor/sdk@1.0.28` on a
Cursor Pro account. Treat vendor and runtime facts as versioned evidence and
repeat the checks when the pin changes.

## Runtime choice

AgentRoom uses local SDK agents. The agent loop and tools run on the operator's
Mac while model inference uses Cursor's hosted backend. Cloud agents are out of
scope because they operate on a remote checkout. The `cursor-agent` headless
CLI is also a different one-shot protocol and is not a fallback under the same
runner id.

The SDK runs inline in the importing process. AgentRoom therefore imports it
only inside `apps/backend/src/runner/cursor/host.ts`, a dedicated child process
with a scrubbed environment and workspace cwd. The backend talks to that host
over bounded newline JSON-RPC. This keeps SDK failures, network clients, shell
children, and `AUTH_TOKEN` isolation outside Fastify while reusing
`PersistentRunnerSessionHost` and the common cancel ladder.

One host serves one AgentRoom session. `Agent.create` starts an SDK agent;
`Agent.resume` uses its persisted agent id; `agent.send` starts a run;
`run.stream` supplies activity; `run.cancel` stops it; and disposal releases
the host. The SDK store is pinned under `STATE_DIR/cursor/agents`.

## SDK and package pins

The backend pins these packages to one exact version:

- `@cursor/sdk`;
- `@cursor/sdk-darwin-arm64`;
- `@cursor/sdk-darwin-x64`.

The two platform packages must be direct optional dependencies. SDK 1.0.28
locates `node_modules/@cursor/sdk-darwin-<arch>` literally rather than through
normal package resolution, so a helper present only in pnpm's virtual store
breaks the first sandboxed turn.

The SDK requires Node 22.13 or later and uses built-in `node:sqlite`. Its
platform package contains `rg`, `cursorsandbox`, and tree-sitter native
bindings. macOS packaging must:

- copy the JavaScript and active platform package;
- retain Anysphere's signatures on publisher-signed nested binaries;
- avoid re-signing those binaries with AgentRoom's identity;
- assert the active architecture helper exists in the final app;
- omit inactive platform packages;
- verify the final bundle and DMG under the distribution tests.

The unsigned packaged-app test proved that the rebuilt helper retained its
Anysphere designated requirement and completed a sandboxed turn. A real
release-signed, notarized build remains an explicit check.

## Credentials and billing

Credential precedence is explicit `apiKey`, then `CURSOR_API_KEY`, then the
SDK sign-in at `~/.cursor/sdk/auth.json`. The web login creates a named user API
key, with a 90-day default lifetime in the measured SDK, and writes it mode
`0600`. `Cursor.auth.logout()` deletes the local file but does not revoke the
key. Dashboard revocation remains separate.

The `cursor-agent` CLI login does not satisfy the SDK. From a checkout, sign in
with:

```bash
pnpm --filter @agentroom/backend cursor:login
```

From an installed default app location:

```bash
"/Applications/AgentRoom.app/Contents/Resources/node/bin/node" \
  "/Applications/AgentRoom.app/Contents/Resources/backend/dist/runner/cursor/login.js"
```

The macOS bootstrap probe only stats the sign-in file; it never opens or logs
it. Presence cannot prove the key is live, so a real capability request remains
the backend readiness authority. `CURSOR_API_KEY` and `CURSOR_BACKEND_URL` are
tier 3 and never enter managed settings or public API responses.

The measured SDK required Cursor Pro or better. A free account returned
`plan_required` from model listing and local agent creation. Turns bill the
signed-in account or the explicit key.

## Managed settings

The descriptor owns six settings:

| Field | Tier | Environment | Meaning |
| --- | --- | --- | --- |
| `model` | 1 | `CURSOR_MODEL` | SDK model id; defaults from the catalog |
| `reasoningEffort` | 1 | `CURSOR_REASONING_EFFORT` | Selected model's `effort` or `reasoning` value |
| `serviceTier` | 1 | `CURSOR_SERVICE_TIER` | Selected model's `fast` boolean as `fast` or `standard` |
| `sandbox` | 2 | `CURSOR_SANDBOX` | Local sandbox, default true |
| `autoReview` | 2 | `CURSOR_AUTO_REVIEW` | Server-side tool review, default false |
| `loadWorkspaceSettings` | 2 | `CURSOR_LOAD_WORKSPACE_SETTINGS` | Project settings source, default true |

Mode is not exposed. The adapter maps only values advertised for the selected
model. It does not pass arbitrary client strings to the SDK.

## Measured behavior

The following checks used `composer-2.5`, a disposable workspace, a pinned
SQLite store, and separate host processes:

1. A fresh process listed and resumed the stored agent, and it recalled prior
   turn content. Resume must pass the model again. This supports
   `restoreStrategy: "native_resume"`.
2. Shell tools inherited the host environment in both sandbox modes. The host
   environment is therefore the only effective scrub.
3. Built-in `askQuestion` was absent from the headless catalog. A custom async
   tool remained open and returned its result to the model. AgentRoom always
   disallows `askQuestion` and registers its custom tool only while questions
   are enabled.
4. A sandboxed run succeeded through the unsigned packaged app after adding the
   direct platform dependency described above.
5. Model parameters used `effort` or `reasoning` for depth and `fast` for speed.
   Other parameters, such as `thinking`, are not exposed as AgentRoom turn
   settings. The default variant's bounded context value may inform the context
   window without becoming a picker.
6. `settingSources: ["project"]` loaded workspace `AGENTS.md`, Cursor rules,
   and skills from `.cursor/skills`, `.agents/skills`, `.claude/skills`, and
   `.codex/skills`. It did not load the user's Cursor skills. An empty settings
   source loaded none of those. Ancestor lookup was not tested.
7. Sandbox mode blocked writes outside the workspace and blocked DNS, while
   allowing workspace and `/private/tmp` writes. It still read files under the
   operator's home directory. The vendor's stronger read-isolation statement
   did not match this run.
8. `run.cancel()` settled within milliseconds and removed a sleeping shell
   child, then produced a known post-cancel unhandled `AbortError`. The host
   suppresses only that recognized rejection; every other unhandled rejection
   fails loudly.

The unsandboxed shell used the host process cwd rather than `local.cwd`, so the
backend starts the host in the registered workspace. `run.stream()` was already
token-granular for text and reasoning; delta hooks remain useful for shell
output and lifecycle detail.

## Questions and permissions

The SDK has no interactive approval callback. Sandbox and auto-review are the
complete configured permission posture; the AgentRoom permission route has no
pending request to answer.

While clarifying questions are enabled, the host registers exactly one
`ask_user_question` custom tool. Its schema is AgentRoom's bounded question
vocabulary. Execution sends one `question/ask` request to the backend and waits
for the shared answer or timeout. The model sees labels and invited text, never
AgentRoom ids. Sensitive text is removed from shared events, transcript, logs,
and audit. When the setting is off, the custom tool and prompt text are absent.

## Capability discovery

Discovery starts a throwaway host, initializes the SDK, lists models, then
shuts it down. It uses the backend cwd, `settingSources: []`, and no question
tool. Success or failure records runtime readiness. Results are cached for five
minutes; fallback results are not cached so the next request retries.

Each model supplies its own reasoning and speed vocabularies. A model declaring
neither receives empty option lists. The static fallback stays small and open;
it does not make a failed runtime ready.

## Distribution and redistribution

AgentRoom ships the SDK and its platform binaries unmodified. Each operator
authenticates with their own Cursor account or key and pays for their own usage.
AgentRoom does not resell Cursor access, use Cursor output to train a competing
model, or claim regulated-data coverage. The Cursor name appears only as the
runner identity. These conditions belong in `THIRD_PARTY_NOTICES.md` and the
public README.

Before the first public DMG containing the SDK, obtain written confirmation
from Cursor that redistributing the unmodified npm package inside the installer
is covered. If not, the fallback is an operator-installed SDK behind a deliberate
build-time opt-in. See [Open-source mirror](../operations/OPEN_SOURCE_MIRROR.md).

## Verification

Run the repository checks plus the Cursor-specific suites covering host
protocol, events, questions, settings, registry, catalog, and distribution.
Then use a disposable workspace and a real signed-in account to verify:

- live capability discovery and readiness;
- a streamed turn with tool activity and usage;
- cancellation and same-session continuation;
- idle reap followed by resume;
- workspace settings both on and off;
- the custom question round trip and kill switch;
- sandbox write, read, and network behavior;
- final packaged helper discovery and signatures.

## Open checks

- Repeat a sandboxed turn after full Developer ID signing and notarization.
- Decide per-runner scrubbing of other providers' secrets across all built-ins.
- Decide whether subagent activity needs a canonical kind shared with other
  runners.
- Revisit the undocumented SDK `request` message only if a later SDK defines it
  as a permission callback.
- Add a telemetry opt-out unconditionally if the SDK exposes one.
- Add first-class macOS API-key setup or an in-app sign-in only when requested.
- Record Cursor's written redistribution answer before public distribution.
