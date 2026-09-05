# Contributing

Thanks for looking at AgentRoom. This repository is a public mirror, so the
workflow differs a little from a repo where `main` is edited directly.

## How the mirror works

Development happens in a private monorepo that also holds the visionOS app. A
workflow there publishes the backend, the macOS app, the shared Swift client,
the packaging scripts, and the docs to this repository after each change to its
`main`. Every sync is one commit whose `Source-Commit:` trailer names the
upstream commit. Nothing is pushed here by hand, and nothing merged here stays
merged on its own: the next sync replaces the tree.

What that means for you:

- Open an issue first for anything beyond a typo or a one-line fix. It saves
  you from building something the maintainers cannot take.
- Pull requests are welcome as proposals. A maintainer reviews the PR here,
  ports the change into the private repository, and closes the PR with a
  reference to the sync commit it arrived in. Your change is credited in that
  upstream commit.
- Contributions are accepted under the repository's MIT license
  ([`LICENSE`](LICENSE)). By opening a PR you agree to that.

## Before you open a PR

Build and verify locally:

```bash
pnpm install
pnpm typecheck
pnpm --filter @agentroom/backend build
pnpm test
```

For a change under `apps/macos` or `apps/shared/AgentRoomClient`:

```bash
cd apps/macos
xcodegen generate
```

then build the `AgentRoomMac` scheme in Xcode or with `xcodebuild`. Edit
[`apps/macos/project.yml`](apps/macos/project.yml), never the generated
`.xcodeproj`, which is not committed.

Read [Architecture](docs/architecture/ARCHITECTURE.md), [API](docs/api/API.md),
and
[Trust and safety](docs/safety/TRUST_AND_SAFETY.md) before touching the
backend, the runners, the configuration layer, or the workspace routes. Most
documented defaults are pinned by a test. A PR that relaxes a documented trust
default without updating the document and the test together will not be
ported.

Keep the docs in step with the code: routes, event names, config variables,
safety posture, packaging behavior, and client responsibilities are all
documented under [`docs/`](docs/README.md).

## Reporting problems

Bugs and feature requests: open an issue. Security vulnerabilities: see
[`SECURITY.md`](SECURITY.md); do not open a public issue for those.
