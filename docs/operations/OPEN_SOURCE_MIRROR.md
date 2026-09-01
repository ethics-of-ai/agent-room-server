# Open source mirror: macOS app and backend

Status, 2026-08-23: Phase 1 is implemented on `feat/open-source-mirror`;
Phase 2 began the same day with the repository created and the first manual
sync pushed (`ethics-of-ai/agent-room-server` `main` at `83b6e24`, from source
commit `52a082c`). Still to do in Phase 2: the deploy key and
`MIRROR_DEPLOY_KEY`, the Apple signing secrets, and `MIRROR_ENABLED`. Decisions
marked **Decided** were answered on 2026-08-23; the ones still marked
**Decide** need an answer before the phase that depends on them.

## Goal

Publish the backend, the macOS operator app, and the shared Swift client as a
public GitHub repository that tracks this private one. For some time this repo
stays the place where development happens, and CI pushes the public subset
outward. People who find the public repo can clone it and build and run
AgentRoom on their own Mac, or download a DMG from the repo's Releases page.

The visionOS app stays private. Everything else that makes up a working Mac
install is in scope.

## What the public repo is

One read-only mirror, named by the sync job. Its tree is an allowlisted subset
of this repo's `main` plus a small overlay of public-only files (license,
public README, CI workflows). Its commit history is one commit per sync, each
carrying a `Source-Commit:` trailer pointing at the commit here it was cut
from. Issues are open; pull requests are accepted as proposals and ported here
by a maintainer, because the sync overwrites the public tree.

What someone gets from it today: the Fastify backend with its REST and
WebSocket API, the debug page at `http://localhost:8787`, and the Mac app that
configures runners, stores secrets in Keychain, registers workspaces, and
supervises the backend. The Mac app's Threads view is supervision only; it does
not send prompts. Without the visionOS client, a person drives turns through
the API (the `curl` walkthrough in `LOCAL_MAC_SERVER.md`) or their own client.
The public README has to say that plainly, because it is the first question a
visitor will have.

## Decisions

Each one changes what gets built. Recommendations are mine; the call is the
owner's.

1. **Repository name.** **Decided:** `ethics-of-ai/agent-room-server`.
2. **License.** **Decide.** Constraints found: every production npm dependency
   is permissive (MIT, BSD, ISC, BlueOak-1.0.0, Unlicense), the Node runtime
   is MIT, and there is no third-party Swift code. The one non-permissive
   piece is `@anthropic-ai/claude-agent-sdk` and its `darwin-arm64` platform
   package, which are "© Anthropic PBC, all rights reserved" under Anthropic's
   commercial terms. That does not constrain the repo's license, because the
   SDK is fetched from npm at install time and is not in the tree, but it
   does make the DMG a redistribution of Claude Code; see item 9. Two facts
   specific to this project weigh on the choice: `apps/shared/AgentRoomClient`
   is compiled into the private visionOS app, so a copyleft license on the
   public repo would require a CLA before any outside contribution to that
   directory could be used there; and the product name is shipped in the
   bundle, so an explicit trademark carve-out has value. Recommendation:
   Apache-2.0. Until a `LICENSE` file exists the repo cannot go public.
3. **History.** **Decided:** snapshots, one commit per sync. Nothing in 697
   commits across 40 branches has to be audited before day one; the 163 MB
   `.git` with its visionOS assets never travels; workflow files push without
   rewriting anything; and opening the full history later is a one-time
   `git filter-repo` job that stays available, while closing it again is not.
4. **Code signing and notarization.** **Decided:** an Apple Developer Program
   team exists and the app is not going to the Mac App Store, so releases are
   signed with a Developer ID Application certificate and notarized. The
   release workflow gets the certificate as a base64 `.p12` plus password and
   an App Store Connect API key (`.p8`, key id, issuer id) as secrets, imports
   the certificate into a temporary keychain, runs
   `xcrun notarytool store-credentials` to turn the API key into a keychain
   profile, and sets `AGENTROOM_CODESIGN_IDENTITY` and
   `AGENTROOM_NOTARY_PROFILE`, both of which `package-macos.mjs` already
   reads. Sparkle update archives use a separate Ed25519 key: the private seed
   is the public repo's `SPARKLE_PRIVATE_ED_KEY` secret and the matching public
   half is its `SPARKLE_PUBLIC_ED_KEY` Actions variable. The workflow injects
   them only when its source-controlled update channel is `rc` or `stable`.
   No unsigned public DMG is planned.
5. **Contribution model.** **Decided:** issues on, PRs accepted as proposals
   and ported here by hand, stated in `CONTRIBUTING.md` and a PR template.
6. **Identities.** **Decided** with defaults: sync commits are authored as
   `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`,
   and `SECURITY.md` points at GitHub's private vulnerability reporting on
   the public repo (enabled in Phase 2) rather than an email address. Either
   can be changed in `mirror/manifest.json` and the overlay later.
7. **Apple-derived reference indexes.** **Decided:** `docs/reference/` is
   excluded.
8. **Docs scope.** **Decided:** strip the visionOS documents. Read as: the
   visionOS-specific files go (`docs/clients/VISIONOS.md`,
   `docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md`,
   `docs/engineering/VISIONOS_PROFILE_SELECTION.md`, and `docs/reference/`);
   shared documents that mention the visionOS client in passing (the API,
   architecture, trust, and orchestration records) travel whole, because a
   second hand-maintained copy of `TRUST_AND_SAFETY.md` would rot within a
   week. Kept documents that link to the stripped ones dangle in the mirror
   and the public README says so. `README.md` and `docs/README.md` are not
   mirrored; the overlay carries public versions of both, written for the
   public tree. `AGENTS.md` and `CLAUDE.md` are not mirrored and have no
   public counterpart (decided 2026-08-23, after a first version of the overlay
   carried trimmed copies): the public docs are the rules for anyone working
   there, and a hand-maintained second copy of the agent guidance was the most
   drift-prone file in the overlay. The exclude list names
   `VISIONOS_PROFILE_SELECTION.md` although `main` does not hold it yet; it
   arrives with the orchestration engine branch and is excluded from that
   day on.
9. **Claude Code inside the DMG.** **Decide.** The DMG today carries the Agent
   SDK and, through its `darwin-arm64` platform package, the Claude Code
   binary. Anthropic's published terms allow preinstalling Claude Code in a
   product under the Commercial Terms of Service provided the binary is
   unmodified and each end user authenticates with their own credentials,
   which is how AgentRoom already works (the Mac user's own `claude login`,
   no intermediated usage); they also forbid using the Claude or Anthropic
   name in the product name, which `AgentRoom` does not do. Two options:
   keep bundling and state it in `THIRD_PARTY_NOTICES.md` and the README
   ("ships with Claude Code preinstalled"), or stop bundling the platform
   package and resolve the user's own `claude` install. I recommend keeping
   the bundle, since the Claude Code runner is advertised as working out of
   the box with `claude login`, and recording the terms it ships under.
10. **Cursor SDK inside the DMG.** **Decided 2026-08-26:** bundle, on the same
    conditions as Claude Code, and say so. The backend pins both Darwin
    platform packages as direct optional dependencies because Cursor 1.0.28
    looks for `node_modules/@cursor/sdk-darwin-${arch}` rather than resolving
    the package from pnpm's virtual store. The package step copies the store and
    that direct link, then refuses to build if `cursorsandbox` is not executable
    or resolves outside the app bundle. The DMG therefore ships `@cursor/sdk`
    and the matching platform package with Anysphere's signed `cursorsandbox`,
    `rg`, and tree-sitter binaries. Each package's whole license file is "©
    Anysphere Inc. All rights reserved. Use is subject to Cursor's Terms of
    Service."
    Three surfaces, three answers. The dependency reference in `package.json`
    and the lockfile is not a redistribution: whoever runs `pnpm install`
    fetches from npm under Cursor's terms, as for the Anthropic SDK. The
    operator's use is one Cursor staff have called, on the record, "a
    supported and explicitly intended use of the Cursor SDK"; what they name
    as prohibited (reselling access, training a competing model, regulated
    data without a separate arrangement) is nothing this runner does. The DMG
    is the one place the Claude Code precedent does not fully carry, because
    Cursor publishes no sentence saying the package may ship inside an
    installer. What supports bundling is that the package is on public npm for
    installation into products and that the embedding statement covers
    AgentRoom's shape: each person signs in with their own account on their
    own plan (Cursor Pro or better), AgentRoom holds no Cursor credential and
    intermediates nothing. The alternative, an operator-installed SDK the host
    resolves from a tier-3 directory, would be the only runner whose runtime
    the Mac cannot set up and would trade a licensing question for a bootstrap
    surface with its own review. The conditions are in
    `THIRD_PARTY_NOTICES.md`, and the signing pass leaves the Anysphere
    binaries as published (`isPublisherSignedBinary`, pinned by
    `macosDistribution.test.ts`). **Open item:** before the first public DMG
    that carries the SDK, ask Cursor support for written confirmation that
    shipping the unmodified package inside an installer is covered, and file
    the answer here. If the answer is no, the fallback is the
    operator-installed SDK above, and bundling becomes a build-time opt-in
    until then. `docs/engineering/CURSOR_SDK_RUNNER.md` (*Licensing and
    redistribution*) is the full record.

## What is mirrored

Allowlist, read from the source commit with `git archive` so only tracked files
at that commit travel (never the working tree, so `.env`, `.agentroom/`,
`build/`, and editor state cannot leak by accident):

| Path | Why |
| --- | --- |
| `apps/backend/` | The backend. `dist/` and `node_modules/` are untracked already. |
| `apps/macos/` | The Mac app and its tests. Generated `.xcodeproj` is untracked already. |
| `apps/shared/AgentRoomClient/` | Compiled into the Mac app by `project.yml`. |
| `scripts/package-macos.mjs`, `scripts/macos-sparkle.mjs`, `scripts/macos-distribution-security.mjs`, `scripts/verify-sparkle-key-pair.mjs`, `scripts/install-macos.mjs` | `pnpm dist:macos` / `install:macos`, including the updater policy, signing order, and release key-pair check. |
| `scripts/generate-app-icons.swift` | `macosDistribution.test.ts` reads its source. It also writes visionOS icon paths, so it cannot *run* in the mirror; see Phase 1. |
| `scripts/acp-conformance-agent.mjs` | Referenced by `ACP_CONFORMANCE.md`; harmless. |
| `assets/branding/` | Inputs to the icon generator (two PNGs plus a README). Licensing note below. |
| `docs/` minus `docs/README.md`, `docs/reference/`, the three visionOS documents in Decision 8, and the `*-check.diagram.json` dogfood files | Decisions 7 and 8. |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.env.example`, `.gitignore`, `tests/README.md` | Root build files. `pnpm-workspace.yaml` says `apps/*`; only `apps/backend` has a `package.json`, so the lockfile is unchanged by dropping visionOS. |

Overlay, kept in this repo under `mirror/overlay/` and copied on top of the
allowlisted tree (overlay wins):

| File | Purpose |
| --- | --- |
| `README.md` | Public README: what this is, what is and is not included, clone-and-build, download-the-DMG, trust posture summary, link back to the docs. Replaces this repo's README, which documents the whole monorepo. |
| `docs/README.md` | Public docs index without the visionOS entries. |
| `LICENSE` | Decision 2. |
| `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `SECURITY.md` | Decisions 5 and 6. |
| `.github/workflows/ci.yml` | Public CI (below). |
| `.github/workflows/release.yml` | DMG build and GitHub Release (below). |
| `THIRD_PARTY_NOTICES.md` | Sources and licenses of what the DMG bundles: Node.js, the production npm tree, the catalog grammars and themes, the Claude Agent SDK and Claude Code binary under Anthropic's terms (Decision 9), and the Cursor SDK with its signed helper binaries under Cursor's terms (Decision 10). |

Never mirrored: `apps/visionos/`, `docs/reference/`, `docs/clients/VISIONOS.md`,
`docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md`,
`docs/engineering/VISIONOS_PROFILE_SELECTION.md`, this repo's `README.md` and
`docs/README.md` (overlay versions replace them), `AGENTS.md` and `CLAUDE.md`
(no public counterpart), `.agents/`, `.codex/`, `.claude/`,
`skills-lock.json` (third-party skills with their own licenses; revisit
later), `mirror/` itself, and this repo's private `mirror.yml`,
`release-candidate.yml`, and `release-please.yml` workflows.

## How the sync works

One script, runnable locally and in CI: `scripts/mirror-public.mjs`.

```text
mirror-public.mjs --source-ref <sha> --target <public checkout> [--push] [--tag vX.Y.Z[-suffix]] [--dry-run]
```

1. Reads `mirror/manifest.json`: `include` prefixes, `exclude` globs, overlay
   directory, deny patterns.
2. `git archive <ref> -- <include paths> | tar -x` into a staging directory,
   removes `exclude` matches, copies the overlay on top.
3. Refuses to continue if any staged path matches a deny pattern (`.env`,
   `.env.*` except `.env.example`, `*.p12`, `*.pem`, `*.mobileprovision`,
   `.agentroom/`, `apps/visionos/`), if any overlay file is missing, or if
   `LICENSE` is absent.
4. `rsync -a --delete --exclude .git staging/ target/`, `git add -A`.
5. If there is a diff: commits as the bot identity with subject
   `Sync agent-room@<short sha>`, a body listing the source subjects since the
   last `Source-Commit` trailer found on the target's HEAD, and the trailer
   `Source-Commit: <full sha>`. With `--tag`, tags that commit. With `--push`,
   pushes branch and tag. `--dry-run` prints the file list and the diffstat
   and stops.

The job that runs it, `.github/workflows/mirror.yml` in this repo:

- Triggers: push to `main` and `workflow_dispatch` from `main`. It accepts no
  tag event and creates no tag.
- `runs-on: ubuntu-latest`, `concurrency: mirror` without cancellation so two
  pushes serialize.
- Checkout with full depth (the body lists source commits), load an SSH deploy
  key from the `MIRROR_DEPLOY_KEY` secret, clone the public repo, run gitleaks
  over the staging tree, and push the staged commit to public `main`. A deploy
  key rather than a PAT can push `.github/workflows/*` without the `workflow`
  scope dance and is scoped to that one repo. The mirror, RC, and stable
  publishers load it through the same private
  `.github/actions/load-mirror-deploy-key` composite action.
- Fails closed: any refusal in step 3 or a gitleaks hit stops the push.

Release candidates take one narrower path through the same script.
`.github/workflows/release-candidate.yml` is a manual private-repository
workflow. It publishes a public RC tag from the open Release Please candidate
without pushing that candidate to public `main`; the stable publisher below
remains the only path that moves public `main` for a release.

The source is `main`, and this work lands there through a normal pull request
from `feat/open-source-mirror`. The overlay describes the tree it ships with,
so a branch that changes a mirrored rule, route, or document (the agent
orchestration engine branch, for one) refreshes the overlay in the same merge;
`mirrorManifest.test.ts` catches a link into a file that is not there, and
nothing else, so content drift is a review item.

## Public CI

`ci.yml`, on push and pull request. Both jobs on `macos-26` (arm64, Xcode 26.x;
Actions minutes are free for public repositories on standard runners, and macOS
is where the product has been verified, so Linux portability of the test suite
is not something the first cut has to prove):

- backend: pnpm 9.15.4, Node 24, `pnpm install --frozen-lockfile`,
  `pnpm typecheck`, `pnpm --filter @agentroom/backend build`, `pnpm test`.
- mac: `brew install xcodegen`, `xcodegen generate` in `apps/macos`, then
  `xcodebuild ... build-for-testing` followed by
  `test-without-building -only-testing:AgentRoomMacTests` with
  `CODE_SIGNING_ALLOWED=NO`. Split rather than one `xcodebuild test` because
  the single-shot form has hung on this project.
- optional: `swift test` in `apps/shared/AgentRoomClient`.

Pin the Xcode major with `xcode-select` and record which 26.x minor the image
shipped; the app has only ever been built with Xcode 26.6 locally.

## Versioning

One version covers the backend, the macOS app, and the shared client, because
they ship as one DMG. It is written in four places, and `release.yml` refuses a
tag that disagrees with three of them.

`release-please` owns all four. It reads the conventional commits landing on
`main`, keeps one release pull request open that bumps the version and writes
`CHANGELOG.md`, and tags `vX.Y.Z` when a person merges that pull request. A
`feat` gives a minor, a `fix` gives a patch, a `!` or a `BREAKING CHANGE`
footer gives a major. So the version moves when the team decides to ship rather
than on every merge, which matters here because a tag builds and notarizes a
public artifact.

Two of the four files update through a JSON updater and two through an
`x-release-please-version` comment on the line itself
(`apps/macos/project.yml`, `apps/backend/src/releaseInfo.ts`). The
`minimumVersion` fields beside `backendVersion` are deliberately not annotated:
they say which client this backend still talks to, and moving them with the
release would cut off older clients.
`apps/backend/test/versionParity.test.ts` pins that the four agree, that each
is a semantic version, and that exactly one line in `releaseInfo.ts` carries
the annotation.

The one wrinkle is that GitHub starts no workflow run from a `GITHUB_TOKEN`
event, so the tag release-please creates would never reach `mirror.yml`.
`.github/workflows/release-please.yml` therefore publishes that tag itself,
with the same script, the same gitleaks scan, and the same deploy key, under
the same `mirror` concurrency group so it cannot race the tree sync the merge
also triggers. Handing release-please a personal access token would have worked
too and was rejected: the deploy key can write to one repository and nothing
else, and it belongs to no person.

The RC wrinkle is that the next version exists only in the open Release Please
PR until the stable release decision. The ordinary mirror accepts no tag event,
so it cannot represent or publish the candidate. `release-candidate.yml` resolves the fixed
`release-please--branches--main--components--agentroom` PR and fetches GitHub's
synthetic merge of its head with current `main`. It refuses a stale merge,
another repository or branch, any changed path outside the six generated
release files, a package-file change beyond `version`, or an annotated source
change beyond its release version. It then runs the ordinary mirror staging
and gitleaks scan, creates the exact public `vX.Y.Z-rc.N` tag, and pushes that
tag only. RC tags therefore exist in the public repository, not this one.
They are immutable. The workflow accepts no branch, SHA, tag, or feed URL from
the operator and shares the `mirror` concurrency group with normal sync and
stable publication.

The config, the manifest, and `CHANGELOG.md` stay private. The changelog's
entries link to pull requests in this repository, which a public reader cannot
open, so the public release notes come from the release workflow instead.
Improving those notes is the open follow-up, since `--generate-notes` on the
public side sees only `Sync agent-room@...` commits.

## Releases and the DMG

`release.yml`, triggered by a `v*` tag on the public repo or by
`workflow_dispatch`, runs on `macos-26` with `contents: write`. Release Please
publishes stable tags through its private workflow; `release-candidate.yml`
publishes RC tags. Both tags point at an allowlisted, scanned public snapshot.

1. Checkout, pnpm and Node 24, `pnpm install --frozen-lockfile`, and
   `brew install xcodegen`. For an update-enabled channel, download the pinned
   Sparkle 2.9.6 release tools after verifying their archive against the
   checksum held in the workflow.
2. Check the tag against `MARKETING_VERSION` in `apps/macos/project.yml`,
   `version` in `apps/backend/package.json`, and `backendVersion` in
   `apps/backend/src/releaseInfo.ts`. A mismatch fails the run; bumping those
   three is a commit here before tagging. Stable tags use `vX.Y.Z`; the only
   admitted prerelease shape is `vX.Y.Z-rc.N`.
3. Download the official Node 24 LTS `darwin-arm64` tarball from
   `nodejs.org/dist`, verify it against `SHASUMS256.txt`, extract, and pass it
   as `AGENTROOM_NODE_RUNTIME_DIR`. The script already supports that variable;
   without it, it copies the builder's own Node install, which on this machine
   is a Homebrew tree. `node-pty` 1.1.0 ships N-API prebuilds for
   `darwin-arm64` and `darwin-x64`, so the bundled Node major does not have to
   match the installer's.
4. Decode the Developer ID Application `.p12` into a temporary keychain
   (created with a random password, added to the search list, deleted in an
   `always()` cleanup step), set `AGENTROOM_CODESIGN_IDENTITY` to the
   certificate's common name, write the App Store Connect `.p8` to a temp
   file, run `xcrun notarytool store-credentials agentroom-ci --key ... --key-id
   ... --issuer ...`, and set `AGENTROOM_NOTARY_PROFILE=agentroom-ci`. For an
   update-enabled channel, a separate step requires both Sparkle keys, derives
   the public key from the private seed, and refuses a mismatch before injecting
   `SPARKLE_PUBLIC_ED_KEY` into the app's Info.plist. The package script then
   signs, notarizes, and staples without modification. A
   `workflow_dispatch` input `unsigned: true` skips this step for a smoke
   build that is never attached to a release.
5. `node scripts/package-macos.mjs`. Rename the output to
   `AgentRoom-<version>-arm64.dmg`, then run
   `scripts/generate-release-manifest.mjs`. The generator imports the compiled
   backend compatibility record used by `/health`, refuses a mismatched tag or
   DMG name, and writes `AgentRoom-<version>-release.json` with schema version
   1. A prerelease tag keeps its full suffix in the tag, DMG, and manifest file
   names, while its `X.Y.Z` marketing base must match the backend compatibility
   version. A disabled stable release writes checksums over the DMG and manifest
   and publishes those files with `SHA256SUMS.txt`; it has no appcast. An
   update-enabled release runs Sparkle's `generate_appcast` with the private key
   over the notarized DMG, fails if its enclosure has no Ed25519 signature, and
   writes an `appcast.xml` whose download URL names this exact release tag. Its
   checksums and GitHub release include all four files. An RC build receives
   `releases/download/rc/appcast.xml` at build time. After publishing the
   versioned RC, the serialized workflow creates or advances that moving `rc`
   prerelease with only the signed appcast; its enclosure still downloads the
   immutable versioned RC DMG. A signed rerun of any published RC is refused;
   only the moving `rc` release's appcast may be replaced. The implemented but
   currently unselected `stable` channel uses
   `releases/latest/download/appcast.xml`, which follows stable releases and
   ignores prereleases.

### RC update validation and stable promotion

The release workflow pins `STABLE_SPARKLE_UPDATE_CHANNEL: disabled` in source.
A GitHub setting cannot turn it on. Stable releases remain signed and notarized,
but their app bundles contain no Sparkle key or feed and their releases contain
no appcast.

Before the first RC, the public repository must have the
`SPARKLE_PRIVATE_ED_KEY` Actions secret and matching `SPARKLE_PUBLIC_ED_KEY`
Actions variable. `scripts/setup-release-credentials.sh` configures both.

Keep the Release Please PR open during this test. Do not create or push a
private `vX.Y.Z-rc.N` tag. From this repository, dispatch the reviewed workflow
from `main`:

```bash
gh workflow run release-candidate.yml --ref main \
  -f version=X.Y.Z \
  -f rc_number=1
```

The run resolves the open Release Please PR itself and publishes only the
public `vX.Y.Z-rc.1` tag. Wait for the public versioned release and moving `rc`
release, then manually install the DMG. Dispatch the same workflow with
`rc_number=2`. Its later public release run supplies a larger
`CFBundleVersion` and advances the alias. In RC.1 choose **Check for
Updates…**, accept the RC.2 prompt, and confirm that the app and app-owned
backend relaunch. Confirm that registered workspaces, Keychain-backed values,
managed settings, and durable sessions are unchanged. Public `main` and the
stable tag remain untouched throughout.

After the RC path passes, promote stable updates in a separate reviewed change:

1. Change `STABLE_SPARKLE_UPDATE_CHANNEL` in `release.yml` from `disabled` to
   `stable`.
2. Update the distribution test, this runbook, `docs/clients/MACOS.md`, the
   trust entry, `AGENTS.md`, and `CLAUDE.md` in the same change.
3. Merge that promotion into `main`, run the full release verification, then
   merge the Release Please PR. Release Please publishes the stable `vX.Y.Z`
   tag through the existing stable path. Its release must include the signed
   appcast and its app must embed the public key plus
   `releases/latest/download/appcast.xml`.
4. Tell existing stable users to install that release manually once. Their
   current updater-disabled build cannot discover it. Releases after that use
   the normal Sparkle prompt.

Apple Silicon only at first. The Xcode build is universal but the bundled Node
and the `node-pty` binary are single-architecture, so an Intel DMG is a second
matrix entry on `macos-26-intel`, added only if someone asks.

What the signing pass touches, from a packaging run of the public tree:
Sparkle's `Installer.xpc`, `Downloader.xpc`, `Autoupdate`, `Updater.app`, and
framework in its documented inside-out order; the bundled `node` (and, from a
Homebrew runtime, `libnode`); the `node-pty` addon
and `spawn-helper` for both Darwin architectures, and, because the package
step copies the whole pnpm store, dev tooling binaries that have no business
in the bundle (`esbuild`, `rolldown`, `lightningcss`, `fsevents`). Every
Mach-O gets signed inside-out with the hardened runtime; `node` additionally
gets `scripts/codesign/node-runtime.entitlements` (JIT, unsigned executable
memory, no library validation). The exceptions are the publisher-signed
binaries (`isPublisherSignedBinary`): the Claude Code binary inside
`@anthropic-ai/claude-agent-sdk-darwin-*`, left exactly as Anthropic signed it
since the terms in Decision 9 require the binary to run as published, and,
since 2026-08-26, the `cursorsandbox`, `rg`, and tree-sitter `binding.node`
files inside `@cursor/sdk-darwin-*`, left as Anysphere signed them for the same
reason (Decision 10). Both already carry what notarization asks of a nested
executable (a Developer ID Application identity, hardened runtime, secure
timestamp; checked on the 0.3.172 and 1.0.28 packages), so leaving them alone
costs nothing. The `node-pty` prebuilds and the dev tooling
binaries are only ad-hoc linker-signed as shipped, which is why the pass has
to sign them.

The bundled Node executable keeps the JIT entitlements in
`scripts/codesign/node-runtime.entitlements`. `--deep` is used only to verify
the result; signing is explicit and inside-out.

Optional size work, not blocking: the current DMG is 231 MB and the app 516 MB
because `package-macos.mjs` copies the whole `node_modules/.pnpm` virtual store
(408 MB, dev dependencies included). Building a production-only tree with
`pnpm deploy --prod --filter @agentroom/backend` would roughly halve the
download.

## Phase 1: make this tree mirror-safe

Source changes here, all small, all verified by `pnpm test` with and without
`apps/visionos` present:

- Six backend test files read trees the mirror does not carry and would fail
  there: `visionosProject.test.ts`, `swiftModelStructure.test.ts`,
  `managedSettingsParity.test.ts`, `diagramCompose.test.ts` (reads three
  visionOS Swift files), `catalogSyncParity.test.ts` (reads
  `apps/visionos/AgentRoom/Resources` through the sync script), and
  `referenceIndexes.test.ts` (reads `docs/reference`). Gate each with
  `describe.skipIf(...)` on the tree's presence and a comment naming why, so
  the same file runs in both repos and parity stays enforced here, where the
  trees are. `harness.test.ts` only compares path strings and is fine. The
  mirror manifest suite itself skips where `mirror/manifest.json` is absent,
  which is the public tree.
- `apps/macos/AgentRoomMacTests/RunnerBootstrapTests.swift` used an
  `sk-live-...` string as its fake provider secret, which gitleaks flags as a
  generic API key and would block every sync. The fixture is now a plain
  placeholder; the sync job's scan stays strict.
- `scripts/generate-app-icons.swift`: skip the visionOS outputs when
  `apps/visionos` is absent instead of crashing, so `swift
  scripts/generate-app-icons.swift` still regenerates the Mac icon in the
  mirror.
- `apps/backend/test/codexRunner.test.ts:174` carries a personal absolute path
  in a fixture string. Replace it with a neutral one.
- `scripts/package-macos.mjs`: pass `MARKETING_VERSION` and
  `CURRENT_PROJECT_VERSION` through from `AGENTROOM_MARKETING_VERSION` /
  `AGENTROOM_BUILD_NUMBER` when set, and skip the Launch Services cleanup when
  `CI` is set (it only matters on a developer's Mac).
- New: `scripts/mirror-public.mjs`, `mirror/manifest.json`,
  `mirror/overlay/**` (Decisions 1, 2, 5, 6, 7, 8, 9 decide their contents),
  a `pnpm mirror:public` script, and `apps/backend/test/mirrorManifest.test.ts`
  pinning that the manifest never includes `apps/visionos` or the stripped
  documents, that every include path exists at HEAD, that every overlay file
  exists, that the deny list contains the entries above, and that every
  relative link in an overlay Markdown file resolves inside the staged tree
  (so the public README, docs index, and agent guidance cannot rot silently;
  links from mirrored shared docs to stripped ones are expected and not
  checked).
- Docs: this file, a line in `docs/README.md`, and one sentence in `AGENTS.md`
  and `CLAUDE.md` under the documentation rules saying that `mirror/` and the
  public overlay are part of the product surface and change when a public
  path, rule, or workflow changes.

Acceptance: `pnpm typecheck`, build, and `pnpm test` green here; the same three
green after `node scripts/mirror-public.mjs --dry-run --target /tmp/x` and a
`pnpm install` inside the staged tree; `xcodegen generate` and an
`xcodebuild build` of `AgentRoomMac` green inside the staged tree; `pnpm
dist:macos` inside the staged tree produces a DMG that installs and starts the
backend.

## Phase 2: create the public repo and sync once by hand

- Create `ethics-of-ai/agent-room-server` (the account here is an org admin),
  public, default branch `main`, issues on, private vulnerability reporting
  on, wiki and projects off, description and topics set.
- In the Apple Developer account: a Developer ID Application certificate
  exported as `.p12`, and an App Store Connect API key with the Developer
  role. Store the Apple credentials and Sparkle private signing seed on the
  public repo, and the mirror deploy private key on the private repo: seven
  secrets in total, plus the public Sparkle key as a public-repo Actions
  variable. They never enter this repo.
  `scripts/setup-release-credentials.sh` walks all six stages, including
  the deploy key and Sparkle keypair, and is the fastest way to do it: it opens
  each portal page, verifies
  the exported `.p12` really carries a Developer ID Application identity with
  its private key, asks Apple to confirm the API key with
  `xcrun notarytool history`, and writes each secret to the repository that
  needs it. Two constraints it surfaces because they stop the job dead: only
  the Apple team's **Account Holder** can create a Developer ID certificate,
  and the API key must be a **team** key, since `notarytool` takes
  `--issuer` only for those and `release.yml` always passes it. The Sparkle
  stage downloads checksum-pinned release tools, keeps the private key in the
  operator's login Keychain, and sends its exported seed directly to GitHub.
  That script
  is operator tooling for this org's own accounts and is deliberately not
  mirrored.
- Generate an ed25519 keypair. Public half: deploy key with write access on the
  public repo. Private half: `MIRROR_DEPLOY_KEY` secret on this repo. Nothing
  else gets push access.
- Run the script locally with `--dry-run`, read the file list end to end, then
  run it with `--push`. Run gitleaks over the staged tree before the push.
- Clone the public repo fresh on this Mac and repeat the Phase 1 acceptance
  checks from that clone. This is the first time the README's instructions are
  followed literally; fix them here, not there.

## Phase 3: automate the sync

- Add `.github/workflows/mirror.yml` here. Push to `main`; confirm the public
  repo gains one commit with the trailer and the expected diff.
- Branch protection on the public `main`: no force pushes, linear history.
  Leave the deploy key as the only writer.

## Phase 4: public CI

- `ci.yml` lands through the overlay. Confirm both jobs pass on the runner, not
  only locally, and record the Xcode minor the image provided.
- Add the CI badge to the overlay README.

## Phase 5: first release

- Merge the Release Please PR for `0.1.0`. Its stable publisher stages the
  allowlisted public tree and pushes `v0.1.0`; `release.yml` builds
  `AgentRoom-0.1.0-arm64.dmg` and publishes the release. The ordinary mirror
  never accepts or propagates a private tag.
- Download the DMG from the Releases page on a Mac that never built AgentRoom,
  install it by drag, launch it without clearing quarantine, and confirm
  Gatekeeper accepts it (`spctl -a -vv /Applications/AgentRoom.app` reports
  `Notarized Developer ID`), then start the backend and hit `/health`.

## Later, if wanted

- A rolling `latest` prerelease rebuilt by every sync, for people who want
  today's build without waiting for a tag.
- An Intel DMG via `macos-26-intel`.
- A Homebrew cask once releases are signed.
- Opening the full filtered history with `git filter-repo --paths-from-file`,
  after a gitleaks pass over every branch.
- The exit: when "for some time" ends, the public repo becomes canonical, the
  mirror job is retired, and the visionOS app either joins it or keeps living
  here. Snapshot history makes that flip a decision about where to work, not a
  migration.

## Risks and things checked

- `.env` was never committed; only `.env.example` was. No `.p12`, `.pem`, or
  keychain export has ever been added on any branch. The snapshot design means
  the history question is moot for the first release anyway.
- `assets/branding/` came from a Meshy workspace render. Confirm the plan's
  terms grant ownership of outputs before publishing the two PNGs; if not, the
  committed icon PNGs in the asset catalogs are enough and the generator inputs
  stay private.
- The Mac app has only been built with Xcode 26.6. If the `macos-26` image
  lags behind a language feature the app uses, the mac CI job is what finds
  out.
- On `main` as of 2026-08-23 one Mac unit test failed before any of this
  work: `BackendSupervisorManagedSettingsTests.testAdvancedPaneNamesTheRollbackBlockerBeforeCallingAFileAlreadyLegacy`
  expected the Advanced pane's old wording while the pane already carried the
  new one. The orchestration engine branch had updated the expectation; the
  same one-line change is ported here, so the public mac CI job is green and
  the later merge has nothing to reconcile.
- The first public CI run (2026-08-23) proved the `macos-26` image: Xcode 26
  selected, XcodeGen from Homebrew, the backend suite, the Mac app build and
  tests, and `swift test` on the shared client all ran. Its one warning was
  the Node 20 deprecation on `actions/*@v4`; the workflows now pin checkout
  v7, setup-node v7, pnpm/action-setup v6, and upload-artifact v7.
- Dev tooling binaries ride along in the bundle because `package-macos.mjs`
  copies the whole pnpm virtual store. Each is a notarization surface and a
  download-size cost; the production-only tree (`pnpm deploy --prod`) listed
  under "Later" is worth pulling forward to the first release.
- The backend advertises `docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md` in
  `GET /api/harness`. With Decision 8 that file is not in the mirror, so the
  public build advertises a path its own checkout does not hold. It is a
  metadata string about a registered workspace, not a file the backend reads;
  acceptable, and covered by the public README's note that some links point
  at visionOS documents kept private.
- `apps/backend/scripts/sync-catalog-assets.mjs` reads the visionOS tree, but
  `apps/backend/catalog-assets` is committed, so nothing at runtime or in the
  package step depends on it. The parity test skips; the script is a dev tool.
- Third-party content the DMG ships: the Node runtime (its `LICENSE` is in the
  tarball and must not be stripped when the runtime directory is copied), the
  production npm tree, the catalog grammars and themes, the Claude Agent SDK
  with the Claude Code binary (Decision 9), and the Cursor SDK with its signed
  helper binaries (Decision 10). The `THIRD_PARTY_NOTICES.md` overlay file
  lists them. `pnpm licenses list --prod` is the source for the npm portion;
  the Anthropic SDK's `package.json` says `SEE LICENSE IN README.md`, and that
  README points at Anthropic's Commercial Terms of Service; the Cursor SDK's
  says `SEE LICENSE IN LICENSE.md`, one line pointing at Cursor's Terms of
  Service.
