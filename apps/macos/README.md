# AgentRoom macOS

The macOS app configures and supervises the AgentRoom backend. It stores
secrets in Keychain, registers local workspaces, manages runner setup, starts
the backend, and reports diagnostics.

## Build the app

Build the backend before opening the Mac project:

```bash
pnpm --filter @agentroom/backend build
cd apps/macos
xcodegen generate
open AgentRoomMac.xcodeproj
```

The Xcode project is generated from `project.yml`. Do not edit or commit the
generated `.xcodeproj`.

## What the app can do

- Start, stop, restart, and monitor the backend.
- Create LAN connection details for a simulator or physical Vision Pro.
- Register existing local folders as workspaces.
- Configure built-in runners and detect their local executables.
- Store the AgentRoom bearer token and runner bootstrap values in Keychain.
- Edit backend-managed preferences and trust settings.
- Import editor language packs and notify connected visionOS editors.
- Inspect backend sessions, stored messages, metadata, and recent events.
- Export redacted diagnostics and supervise app-owned backend crashes.

The Threads view is for supervision. It can stop an active turn, but it does
not send prompts or act as another chat client. Stopping a DeepSeek turn ends
its non-restorable runtime, so that AgentRoom session cannot continue.

## Locate the backend

Packaged builds load Node.js and the compiled backend from the app bundle.
Development builds can also use `apps/backend/dist/index.js` in this checkout.

Set these process variables to override runtime discovery:

```text
AGENTROOM_NODE_EXECUTABLE
AGENTROOM_BACKEND_ENTRYPOINT
```

The app starts the backend on `0.0.0.0` and adds common developer-tool folders
to `PATH`. This lets tools such as `gh` use the Mac user's existing login and
SSH agent.

## Configure runners and the backend

Bootstrap values and secrets stay in Keychain. These include the bearer token,
runner executable paths, DeepSeek provider credentials, and Cordis setup.
Managed preferences live in:

```text
$HOME/Library/Application Support/AgentRoom/config/settings.json
```

The Mac app and paired clients edit that same settings file through backend
APIs. Environment values take precedence and make the corresponding controls
read-only. Managed changes apply after the next backend restart.

Settings without a Mac control can go in:

```text
$HOME/Library/Application Support/AgentRoom/config/.env
```

Examples include `CODEX_APPROVAL_POLICY` and `CODEX_RUNNER_PROTOCOL`.

For all launch variables and their defaults, read
[`docs/operations/LOCAL_MAC_SERVER.md`](../../docs/operations/LOCAL_MAC_SERVER.md).
Runner-specific setup is documented in
[`docs/clients/MACOS.md`](../../docs/clients/MACOS.md).

## Terminal access

Client terminal access is off by default. Enabling it lets a connected client
open a real, unsandboxed shell inside any registered workspace on this Mac.
Configure an `AUTH_TOKEN` first. Without one, anyone who can reach the backend
on the local network can open a terminal.

Leave terminal access off unless every connected client should have shell
access to the Mac.

## Package the app

Run the distribution script from the repository root:

```bash
npx pnpm dist:macos
```

It writes:

```text
build/distribution/macos/AgentRoom.app
build/distribution/macos/AgentRoom.dmg
```

The app bundle contains the Node.js runtime, compiled backend, public assets,
and production dependencies under `AgentRoom.app/Contents/Resources`.
