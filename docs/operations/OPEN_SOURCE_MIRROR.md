# Open-source mirror and releases

The private AgentRoom monorepo is the current development authority. A workflow
publishes an allowlisted snapshot of its backend, macOS app, shared Swift
client, documentation, build scripts, and public overlay to
`ethics-of-ai/agent-room-server`. The visionOS app remains private.

This document owns the private/public boundary, sync procedure, public CI,
versioning, packaging, signing, and remaining release decisions.

## Public repository model

The public repository is a read-only snapshot mirror of private `main`, one
commit per sync. Each generated commit contains a `Source-Commit:` trailer.
Public issues are accepted. Pull requests are proposals that a maintainer ports
to the private authority because the next sync replaces the public tree.

The public product includes the Fastify backend, debug page, macOS operator app,
shared client contracts, and DMG packaging. The Mac Threads view is supervision
only. Without the private visionOS app, a user drives turns through the API or
their own client.

The public tree uses the MIT license from `mirror/overlay/LICENSE`. Sync commits
use the GitHub Actions bot identity. Security reports use GitHub private
vulnerability reporting.

## What is published

`mirror/manifest.json` is the machine-readable authority. Its allowlist includes:

- `apps/backend`, `apps/macos`, and `apps/shared/AgentRoomClient`;
- macOS package, signing, install, release-manifest, and conformance scripts;
- branding inputs;
- shared documentation;
- root package, lock, workspace, environment-example, ignore, and test files.

`mirror/overlay` wins over the staged snapshot and supplies the public README,
docs index, MIT license, contribution and security policy, third-party notices,
pull-request template, public CI, and public release workflow.

The mirror excludes:

- `apps/visionos` and private visionOS design, client, language, and generated
  evidence documents;
- Apple reference indexes;
- private agent guidance and skills;
- private mirror, Release Please, and RC workflows;
- private changelog and release configuration;
- developer-only language import and evidence scripts tied to visionOS;
- all secrets, local state, build output, and generated projects.

Private `README.md` and `docs/README.md` are replaced by overlay versions.
`AGENTS.md` and `CLAUDE.md` have no public duplicate. Shared references may
mention private visionOS behavior, but the public index explains that those
sources are not included. Links in shared documentation and the overlay must
resolve inside the public tree; use plain paths for private-only references.
`mirrorManifest.test.ts` checks both sets of document links.

## Synchronization

Run the sync script with a committed source ref:

```text
scripts/mirror-public.mjs --source-ref <sha> --target <public-checkout> [--push] [--tag vX.Y.Z[-suffix]] [--dry-run]
```

It:

1. reads the manifest;
2. uses `git archive` to stage tracked allowlisted paths from the source ref;
3. applies excludes and the overlay;
4. refuses denied paths, missing overlay files, or a missing license;
5. replaces the target working tree except `.git`;
6. commits a changed snapshot with source subjects and the full source trailer;
7. optionally tags or pushes.

Deny patterns include `.env*` except `.env.example`, private keys,
certificates, provisioning profiles, `.agentroom`, and `apps/visionos`. A
gitleaks scan runs on the staged public tree before every workflow push.

The normal private `mirror.yml` runs on private `main` and manual dispatch,
serializes through the shared mirror concurrency group, loads a repository-
scoped SSH deploy key, and pushes public `main`. It accepts no tag event.

An ordinary dry run reads a commit through `git archive`; it does not inspect
uncommitted changes. Validate a candidate commit or isolated snapshot before
merging a manifest or mirrored-document change.

## Public CI

The public workflow runs on push and pull request using a macOS 26 arm64 image:

- Node 24, pnpm 9.15.4, frozen install, typecheck, backend build, and all tests;
- XcodeGen, macOS `build-for-testing`, then targeted
  `test-without-building` with signing disabled;
- shared Swift package tests.

The split Xcode build and test avoids the single-command hang observed for this
project. Pin the selected Xcode 26 minor and update it deliberately.

`editorGrammarCorpus.test.ts` uses the exact TextMate engines bundled in the
private visionOS app. The public tree omits those engines, so that suite skips
there while backend catalog validation still runs. Keep engine initialization
in `beforeAll`: Vitest collects even skipped suite callbacks, so loading it
during collection would fail public CI before the skip can take effect.

## Versioning

One semantic version covers backend, macOS app, and shared client because they
ship together. Release Please owns the package versions, macOS marketing
version, backend release record, and private changelog. A feature, fix, or
breaking conventional commit selects minor, patch, or major. Merging the
Release Please PR is the stable-release decision.

Compatibility floors in `releaseInfo.ts` are not release-version fields and do
not move automatically. `versionParity.test.ts` verifies all release versions
and the one annotated source line.

GitHub does not start downstream workflow runs from a `GITHUB_TOKEN` tag.
The private Release Please workflow therefore publishes the public stable tag
itself through the same allowlist, scan, deploy key, and concurrency group.

Public release notes cannot safely reuse the private changelog because it links
private pull requests. Better public release-note generation remains open.

## Release candidates

The private manual `release-candidate.yml` accepts only a version and positive
RC number. It resolves the fixed open Release Please PR, verifies that GitHub's
synthetic merge contains current private `main` and current PR head, and accepts
changes only to the generated release set. Package files may change only their
versions; annotated sources may change only annotated release values.

It stages and scans the normal public mirror, then pushes only an immutable
public `vX.Y.Z-rc.N` tag. It never moves public `main`. RC tags exist only in
the public repository and share serialization with normal sync and stable
publication.

To publish a reviewed candidate:

```bash
gh workflow run release-candidate.yml --ref main \
  -f version=X.Y.Z \
  -f rc_number=1
```

Keep the Release Please PR open. Do not create a private RC tag. Test an update
by installing RC.1, publishing RC.2, choosing **Check for Updates**, accepting
the prompt, and verifying app and owned-backend relaunch plus retained
workspaces, Keychain, settings, and sessions.

## Public release workflow

The public `release.yml` handles stable and RC `v*` tags on macOS 26 arm64.
It performs the following closed procedure:

1. Install pinned build tools. For enabled Sparkle channels, download the pinned
   Sparkle tools and verify their archive checksum.
2. Check tag, macOS marketing version, backend package version, and backend
   release record. Stable tags are `vX.Y.Z`; the only prerelease form is
   `vX.Y.Z-rc.N`.
3. Download official Node 24 arm64, verify it against Node's published SHA-256
   list, and pass it as `AGENTROOM_NODE_RUNTIME_DIR`.
4. Import the Developer ID `.p12` into a temporary keychain, create a temporary
   notary profile from the App Store Connect `.p8`, and configure package
   signing. Cleanup always deletes temporary credentials.
5. For an update-enabled channel, derive the Sparkle public key from the private
   seed and require it to match the configured public value.
6. Build, sign inside-out, notarize, staple, and package the app and DMG.
7. Generate a schema-1 release manifest from the compiled compatibility record,
   refusing any version or filename mismatch.
8. For enabled updates, generate and validate a signed appcast whose enclosure
   points to the immutable versioned DMG.
9. Publish checksums and assets. Stable publication fetches the fixed latest feed
   and requires a byte-for-byte match.

Manual unsigned workflow dispatch exists for smoke builds only and attaches
nothing to a release.

## Sparkle channels

The project default is `disabled`. Source and unsigned builds embed no public
key or feed and make no scheduled update request. The release workflow selects
source-controlled `stable`; an exact RC tag overrides it with `rc`. Callers
cannot provide an arbitrary feed.

Stable uses `releases/latest/download/appcast.xml`. RC uses the moving `rc`
prerelease's sole appcast asset, whose enclosure still downloads the immutable
versioned RC DMG. Versioned RC releases cannot be replaced. Only the moving RC
appcast may change.

Before an enabled build, the workflow requires matched Sparkle keys. Packaging
rejects a disabled build with metadata and any enabled build missing its fixed
feed, public key, or signing identity. Existing updater-disabled users must
manually install the first enabled stable version; later versions use Sparkle's
normal prompt.

## Signing and bundle contents

Every mutable Mach-O is signed inside-out with hardened runtime. Bundled Node
receives the JIT and unsigned-executable-memory entitlements in
`scripts/codesign/node-runtime.entitlements`. `--deep` is verification only.

The package leaves already publisher-signed binaries unchanged:

- Anthropic's Claude Code binary from the Claude Agent SDK platform package;
- Anysphere's Cursor `cursorsandbox`, `rg`, and tree-sitter bindings.

They retain their original Developer ID, hardened runtime, and timestamp.
AgentRoom signs ad-hoc or unsigned native dependencies such as node-pty and
included build-tool binaries with its own identity.

The DMG ships Node, the production npm tree, TypeScript and Pyright language
services, editor grammars and WASM, the Claude Agent SDK and Claude Code, and
the Cursor SDK and helpers. `mirror/overlay/THIRD_PARTY_NOTICES.md` must cover
all of them. Grammar provenance and license tables plus `pnpm licenses
list --prod` are the evidence sources.

The current package copies the whole pnpm virtual store, which increases size
and notarization surface. Moving to a production-only deployed tree remains
worthwhile but is not a release-policy change.

## Runner redistribution decisions

Claude Code ships unmodified and every user authenticates with their own
credentials under Anthropic's commercial terms. AgentRoom neither intermediates
usage nor uses Anthropic branding in the product name.

Cursor also ships unmodified. Every user authenticates with their own Cursor
account or API key and must satisfy the SDK's plan requirement. AgentRoom does
not resell access, train a competing model from outputs, or claim regulated-
data coverage. The public notices state those conditions.

Before the first public DMG containing Cursor SDK, obtain written confirmation
from Cursor that shipping the unmodified package inside an installer is covered.
If the answer is no, switch to an operator-installed SDK behind a deliberate
build-time opt-in. File the answer with this decision.

## Operational prerequisites

Private publication requires:

- a write-enabled public-repository deploy key stored as
  `MIRROR_DEPLOY_KEY`;
- Developer ID certificate and password;
- App Store Connect key, id, and issuer;
- Sparkle private seed and matching public value for enabled channels;
- the repository's mirror enablement switch where the private workflow expects
  it;
- GitHub private vulnerability reporting enabled on the public repository.

Use `scripts/setup-release-credentials.sh` for the operator-only credential
walkthrough. Credentials never enter the mirror.

## Remaining decisions and checks

- Confirm Cursor redistribution in writing before its first public DMG.
- Confirm the terms for the Meshy-derived branding source PNGs before
  publication; otherwise publish the committed app-catalog icons without the
  generator inputs.
- Repeat a complete signed RC update and a subsequent stable-to-stable update.
- Add an Intel artifact only if requested; the first public matrix is arm64.
- Improve public release notes without exposing private pull-request links.
- Consider a production-only dependency tree to reduce size and signing scope.
- Recheck Xcode image compatibility when the pinned minor changes.
- A future change of repository authority must explicitly retire the mirror and
  decide whether visionOS joins the public tree.
