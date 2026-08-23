## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem this solves or the behavior it adds. -->

## Verification

<!-- Paste the commands you ran and their result. For backend changes:
     pnpm typecheck, pnpm --filter @agentroom/backend build, pnpm test.
     For apps/macos or apps/shared changes: xcodegen generate and an
     AgentRoomMac build. -->

## Checklist

- [ ] Docs updated where a route, event, config variable, safety posture,
      packaging step, or client responsibility changed.
- [ ] No documented trust default relaxed without its document, rule, and test
      changing together (see `AGENTS.md`).
- [ ] No generated `.xcodeproj` edited; `apps/macos/project.yml` is the source.

---

This repository is a mirror. A maintainer ports accepted changes into the
private repository; they appear here in a later sync, and this PR is closed
with a reference to that sync commit. See [CONTRIBUTING.md](../CONTRIBUTING.md).
