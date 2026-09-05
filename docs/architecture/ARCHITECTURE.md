# Architecture

AgentRoom is a Mac-hosted bridge between local coding-agent runtimes and Apple
clients. The backend is the source of truth. macOS and visionOS select
workspaces, send requests, and render backend state.

```text
macOS and visionOS clients
        | REST and scoped WebSockets
        v
Fastify backend on the Mac
  workspaces, sessions, runners, config, events, audit
  editor, terminal, artifact, and spatial services
        | native protocol or SDK host
        v
Codex | Claude Code | DeepSeek | Cursor | admitted ACP agents
```

## Ownership map

| Concern | Entry points |
| --- | --- |
| Startup and route assembly | `apps/backend/src/server.ts`, `apps/backend/src/index.ts` |
| Config and managed settings | `apps/backend/src/config`, `apps/backend/src/routes/configRoutes.ts` |
| External contracts | `apps/backend/src/domain` |
| Workspace files, search, and Git | `apps/backend/src/workspace`, `apps/backend/src/routes/workspaceRoutes.ts` |
| Sessions and turns | `apps/backend/src/agent/AgentSessionService.ts`, `apps/backend/src/routes/agentSessionRoutes.ts` |
| Durable sessions and audit | `apps/backend/src/state` |
| Runner admission and execution | `apps/backend/src/runner/registry.ts`, `apps/backend/src/runner` |
| Canonical coding activity | `apps/backend/src/protocol/coding` |
| Broadcast events | `apps/backend/src/events` |
| Editor, terminal, and spatial services | `apps/backend/src/editor`, `apps/backend/src/terminal`, `apps/backend/src/scene` |
| Shared Apple API contracts | `apps/shared/AgentRoomClient/Sources` |
| Backend setup and supervision | `apps/macos/AgentRoomMac` |
| Session and spatial interaction | `apps/visionos/AgentRoom` |

## File-size budgets

Keep source files within 600 lines and test files within 900. Split a larger
file or record its current size in the
[exception ledger](../../apps/backend/test/sourceFileBudget.test.ts) in the
same change. A recorded file may shrink but must not grow. Remove its entry
when the file is deleted or returns within the limit. The ledger defines the
checked source roots and generated-file exclusions for both repository trees.

## Runtime flow

1. A client registers an existing absolute local directory.
2. It creates an AgentRoom session that pins one registered runner kind.
3. It submits one turn at a time, optionally naming bounded relative context
   paths and session attachment ids.
4. The backend preserves the original message, resolves context, and gives the
   adapter runner-specific input.
5. The adapter maps native activity into the canonical coding contract. The
   backend persists session state and publishes live events.
6. Clients render canonical activity and use generic fallbacks for unknown
   runners, event types, and activity kinds.

Sessions retain turns, messages, and native resume ids across backend restart.
Resume uses the runner's native mechanism, never provider transcript parsing. A
runner without restoration support cannot silently start a new conversation
under an old AgentRoom session.

## Boundaries

`AgentRunner` isolates native protocols. `RunnerDescriptor` and the live
registry own admission, shared behavior, settings, restoration, skills, diff
authority, and the safe public runner projection. Code above that package must
not infer policy from a runner id. See [Runners](../engineering/RUNNERS.md).

Workspace operations start from a registered workspace and bounded relative
path. The backend enforces containment, symlink refusal, protected-name filters,
and route-specific limits. Clients have no general filesystem or shell API.
Attachments, artifacts, config, and sessions remain under backend state rather
than a registered workspace.

REST carries reads and mutations. `/api/events` is the only broadcast
WebSocket. Terminal and language-service sockets are authenticated,
workspace-scoped protocols that exist only when their execution gates are on.

The Apple apps are clients, not alternate backends. Shared DTOs and REST
behavior compile from `apps/shared/AgentRoomClient`. macOS additionally owns
local setup, supervision, runner bootstrap, and updates. visionOS owns
device-local interaction and presentation state.

Use the [API](../api/API.md) for wire behavior,
[Trust and safety](../safety/TRUST_AND_SAFETY.md) for gates and bounds,
[macOS](../clients/MACOS.md) for operator-client ownership, and
[Local Mac server](../operations/LOCAL_MAC_SERVER.md) for setup. visionOS
client ownership is documented in `docs/clients/VISIONOS.md`, available only
in the private source repository.
