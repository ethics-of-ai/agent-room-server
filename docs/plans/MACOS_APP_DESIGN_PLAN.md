# macOS app design plan

Status: Implementation and automated verification complete. Overall acceptance
remains pending the runtime and visual checks listed below.

## Worker handoff

Work on `codex/macos-app-design`. Check `git status --short --branch` before
editing and preserve unrelated changes. Read this plan from the current checkout;
its progress record is the handoff between sessions.

Read repository guidance, use prime-context and SwiftUI Pro, then resume the
first incomplete batch below. Implement batches sequentially. No separate
worker chats or parallel agents are required. Update the progress record with
changed files, validation evidence, and unresolved issues after each batch.
Mark a batch complete only when its acceptance checks pass. Track implementation
and visual acceptance separately. If visual tools are unavailable, record the
missing checks and continue later implementation batches once their code and
build prerequisites pass. Leave overall completion pending visual acceptance.
If the branch is absent or checkout contents conflict with this plan, report
the mismatch before choosing a different branch or overwriting existing work.

This is an implementation plan, not permission to launch a release, change
provider credentials, sign in or out, or alter the deployment target.

## Goal

Make AgentRoom feel like a calm, native Mac utility with clearer hierarchy,
fewer competing cards, and consistent styling across the dashboard, Settings,
and menu bar panel.

This plan follows a source review. Review the running app before settling final
colors, spacing, and proportions.

## Current foundation and problems

The app already uses `NavigationSplitView`, shared spacing constants in
`DashboardTheme`, and reusable card components. Keep those foundations.

The main layout problems are:

- Overview stacks five cards with similar visual weight.
- Threads nests scrolling panels inside a page-wide scroll view.
- Settings places six tabs in a fixed 580 by 560 window.
- The shared card treatment applies a rounded background, border, and shadow to
  every card, limiting visual hierarchy.

## Constraints

- Preserve the Mac app's operator role. Threads remains a monitoring and
  active-turn cancellation interface.
- Keep backend supervision, ownership checks, Keychain storage, managed
  settings, and shared API contracts in their existing owners.
- Distinguish an app-owned backend from an externally running backend, including
  the lifecycle controls available for each.
- Keep appearance preferences local to the app. They are not backend managed
  settings and must contain no secrets.
- Support the existing macOS 14 deployment target.
- Follow `docs/engineering/SWIFTUI_STANDARDS.md` and source-file size budgets.
- Apply DRY throughout the redesign. Reuse existing components first, and
  extract repeated presentation or interaction behavior into shared components
  with one owning implementation.

## Reuse and DRY

Make reusable code a goal of every delivery step, alongside visual quality.

- Inventory existing shared views and modifiers before adding new ones,
  including card backgrounds, headers, status treatments, copy controls, and
  settings rows. Extend or consolidate these instead of creating parallel
  implementations.
- Share theme tokens, section containers, label/value rows, status indicators,
  empty states, and configuration-state treatments wherever their meaning and
  behavior match across the dashboard, Settings, and menu bar.
- Keep lifecycle actions, settings-state interpretation, and async operations
  in their existing state or service owners. Views consume derived state and
  actions rather than duplicating decision logic.
- Extract reusable views into the appropriate shared or feature directory,
  keeping one primary type per file and respecting file-size budgets.
- Keep shared components focused, with explicit inputs and actions. Avoid a
  universal component with many flags for unrelated layouts; reuse the common
  parts while allowing each screen to compose its own layout.
- Reuse shared Apple contracts for backend data. Share presentation code
  between Apple apps only where platform behavior and meaning match, after
  inspecting affected callers.
- Review each phase for duplicated code, consolidate matching implementations,
  and remove superseded components and styling constants.

## Settled design direction

The following choices are implementation defaults, not questions to reopen in
each session. Measurements are starting values to verify against real content.

| Element | Decision |
| --- | --- |
| Window chrome | Native title bar, toolbar, and sidebar; system-provided materials where available |
| Navigation | Overview, Threads, Diagnostics; backend status in a quiet sidebar footer, not a selectable navigation row |
| Accent | System accent color; status colors remain separate semantic values |
| Appearance | System by default, with Light and Dark overrides; no custom palette picker |
| Content surfaces | Flat window background and grouped control backgrounds; subtle separators, no default card shadow |
| Typography | System title, headline, body, and callout styles; secondary text for supporting detail; avoid uppercase micro-labels |
| Spacing | Shared 4, 8, 12, 16, 24, 32 point scale; migrate existing constants instead of keeping a competing scale |
| Corners | 10 points for grouped content, 6 for small inset surfaces; retain native control shapes |
| Main window | Retain 1080 by 720 default and 920 by 620 minimum initially |
| Sidebar | Retain approximately 220 to 260 points, with native resizing and collapse |
| Overview | Centered content up to 1040 points; 24 point page inset; compact status header, then attention, pairing, and configuration |
| Overview adaptation | Two columns only when the detail pane can fit two 320 point groups plus spacing and insets; otherwise stack |
| Threads | Full-height list and detail; list starts near 300 points; transcript gets remaining width; independent scrolling |
| Settings | Native Settings scene with sidebar; target default 820 by 640 and minimum 720 by 560, verify resizing on macOS 14 |
| Menu bar | Keep approximately 296 point width; reuse status semantics, typography, and spacing |
| Motion | Short opacity or state transitions; suppress optional transitions with Reduce Motion; no continuously animated status decoration |

Overview composition:

```text
Sidebar           Detail
Overview          Backend status + ownership + primary action
Threads           Attention banner, only when actionable
Diagnostics       Pairing                    Configuration summary
                  Quiet readiness/update rows
Backend status
```

Threads composition:

```text
App sidebar       Session list               Selected thread
                  Search + status filter      Metadata + cancel active turn
                  Session rows                Transcript | Events
                                              Independently scrolling content
```

A healthy Overview should fit its primary status and pairing information at the
minimum window size. Preserve technical details through disclosures instead of
removing them. Use wrapping and selectable text for long values rather than
shrinking fonts to fit. Do not simulate newer glass effects with custom blur or
raise the minimum OS to obtain them.

## Design evidence and inference

References checked on 2026-10-01. The choices above are AgentRoom design
inferences, not claims that the referenced apps use these exact measurements.

- [Apple sidebar guidance](https://developer.apple.com/design/human-interface-guidelines/sidebars)
  supports persistent navigation and a content list between navigation and
  detail when hierarchy needs it. Apply that structure to Threads.
- [Nova's main window](https://help.panic.com/nova/window/) separates navigation,
  primary content, and optional supporting panes. Infer that raw thread events
  should be secondary to the transcript.
- [Raycast Settings](https://manual.raycast.com/settings) documents appearance
  and interface-size preferences as well as menu bar access. Infer a restrained
  local Appearance pane and a compact utility panel, without adopting Raycast's
  command launcher interaction model.

## Architecture and reuse contract

Keep this work inside the macOS presentation layer unless an observed contract
problem requires separately documented scope. No backend route or DTO change is
planned.

| Owner | Responsibility | Must not own |
| --- | --- | --- |
| App composition | Inject shared app dependencies and apply appearance to scene content | Per-screen copies of preference state |
| Appearance state module | Persist and resolve the non-secret System/Light/Dark preference | Backend settings, credentials, lifecycle operations |
| Shared presentation modules | Theme values, grouped surfaces, status presentation, label/value and setting-state rows | Network calls or global mutable screen state |
| Feature root views | Compose layout and own selection, filters, and disclosure state | Duplicated supervision or settings policy |
| Existing state/services | Backend operations, polling, settings interpretation and persistence | View layout or theme choices |
| Shared Apple contracts | Existing backend DTOs and endpoint behavior | Mac-only appearance or layout types |

Prefer deep modules with small interfaces. For example, the appearance module
should expose the selected preference and resolved color scheme while hiding
storage details. A status presentation module should resolve label, symbol, and
semantic tone once for all its callers. Do not add pass-through wrappers,
protocols with only one hypothetical implementation, or a general rendering
engine for ordinary SwiftUI composition.

Reuse inventory must begin with `DashboardTheme`, `CardBackground`, `CardHeader`,
`StatusStyle`, status pills, copy controls, settings captions and footnotes, and
existing backend lifecycle confirmations. Search all callers before replacing a
shared module. Keep feature-specific types near their feature. Use
`Views/Shared` only for presentation that has actual shared callers. Keep
appearance state outside view files in a focused app-local directory following
the repository's current structure.

Do not merge unlike concepts merely because they look similar: backend health,
connection state, runner readiness, and thread activity retain separate domain
meanings. They can share visual primitives without sharing invented status
policy. Do not add app-local shadows of shared DTOs or `import AgentRoomClient`.

## Starting source map

Paths below are relative to `apps/macos/AgentRoomMac`. Verify callers at the
start of the implementing session because names may change.

| Area | Existing owner and important callers |
| --- | --- |
| Scene composition | `AgentRoomMacApp.swift`, main `WindowGroup`, `Settings`, and window-style `MenuBarExtra` |
| Dashboard navigation | `Views/Dashboard/SupervisionDashboardView.swift`, `DashboardSection.swift`, `DashboardSidebarView.swift`, `DashboardDetailContainer.swift`, `DashboardToolbar.swift` |
| Shared styling | `Views/Shared/DashboardTheme.swift`, card modifiers and headers, `StatusStyle.swift`, `StatusPill.swift` |
| Lifecycle policy | `Supervision/BackendSupervisor.swift`, existing lifecycle actions and confirmation modifiers; trace their extensions before editing |
| Settings | `Views/Settings/SettingsView.swift` and existing panes, `Features/Settings/ManagedSettingStatus.swift`, managed file store, supervisor settings extensions |
| Thread data | `State/BackendThreadMirrorStore.swift`, `State/AgentSession+ThreadMirror.swift` |
| Thread presentation | `Views/Dashboard/Threads/ThreadMirrorSection.swift`, list, metadata, message, and event views |
| Tests and build | `apps/macos/AgentRoomMacTests`, `apps/macos/project.yml`, public CI in `mirror/overlay/.github/workflows/ci.yml` |

The current dashboard routes Overview through `DashboardSection.backend`.
Renaming the visible label does not require renaming the internal case. The
current thread store owns selection and automatically picks the first session
when the selected id disappears. Batch 3 deliberately changes that fallback;
keep selection in the same owner and test the change. Search, filters, and
reading state belong to the Threads feature, not shared API DTOs.

## Thread interaction contract

- Search locally across displayed title, workspace name, and runner id, with
  case-insensitive substring matching and trimmed query whitespace. An empty
  query matches all sessions. Retain the store's existing newest-updated order.
- Running uses the existing `threadIsRunning` predicate. Idle and Failed match
  their canonical status strings case-insensitively only when not running.
  All includes every status, including unknown values. Align summary counts
  with these predicates; search and filters affect the list, not global counts.
- On initial load, select the first available session if none has been selected.
  After explicit selection, preserve its id through refresh, sorting, and
  filtering. A hidden selection shows a detail placeholder with a Clear filters
  action; it does not silently select another row or expose a cancel action.
  A removed selection shows an unavailable placeholder until the operator
  selects another session. Failed refresh keeps the last successful data and
  selection visible with an error. Distinguish these states from no sessions.
- Start a newly selected thread on Transcript at the latest content. Maintain
  independent reading state for Transcript and Events while switching tabs in
  that thread. Changing thread resets both. A refresh with unchanged content
  must leave scroll position untouched. While following, appended messages and
  growth of the last message keep the bottom visible. Scrolling away suspends
  following; returning to the bottom or Jump to latest resumes it.
- Use stable message and event identities. Specify and manually verify the
  bottom-detection tolerance during implementation. Do not depend on scroll
  observation APIs introduced after macOS 14. Preserve an anchor while reading
  older content; if bounded event history drops that anchor, show the retained
  content without automatically resuming follow mode. Events remains the
  existing bounded recent-event view, not a complete historical event log.

## Implementation batches

### Batch 0: Baseline and reuse inventory

Scope: inspect the running app and prepare implementation without redesigning
behavior.

- Read the named client and SwiftUI references and inspect affected state owners.
- Record current screens and representative states. Use previews or safe fixture
  data for failure states that cannot be reproduced without mutating user setup.
- Inventory shared modules and their callers; record what will be reused,
  extended, replaced, or kept feature-local.
- Locate existing macOS tests and determine the available build destination.
- Confirm public mirror handling before introducing files or renaming paths.

Done when: the progress record identifies concrete owners, reuse candidates,
validation commands, and any unavailable visual states. Baseline evidence must
not include credentials or sensitive project content.

### Batch 1: Theme, appearance, and Overview

Depends on Batch 0. Owners: `Views/Shared`, `AgentRoomMacApp.swift`,
`DashboardSidebarView`, `DashboardDetailContainer`, `OverviewSection`,
`StatusHeroCard`, setup/pairing/configuration/update views.

- Replace universal raised cards with shared flat group treatment and migrate
  existing callers rather than creating a second card system.
- Introduce one app-owned appearance preference and apply it to main, Settings,
  and menu bar content. Cover System appearance changes while the app is open.
  System resolves to no override; unknown stored values fall back to System.
  Inject the same preference owner into every scene. Use observable state and
  explicit local persistence rather than `@AppStorage` inside an `@Observable`
  class. Scope the override to app content and verify native scene chrome.
  Keep the menu bar icon legible against the actual system menu bar appearance.
- Build the settled Overview hierarchy and adaptive columns.
- Keep one primary lifecycle action in the header. Retain secondary lifecycle
  actions in the toolbar menu and existing confirmations.
- Collapse healthy setup and quiet update state. Keep warnings and ownership
  explanations visible when relevant.

Done when: Overview passes minimum/large-window, light/dark, long-value, and
backend-ownership checks; appearance persists; state policy remains in existing
owners; duplicate card styling is removed. Add meaningful preference/state
checks, not tests of padding constants.

### Batch 2: Settings navigation and reusable rows

Depends on Batch 1. Owners: `SettingsView`, existing Settings panes, shared
setting rows, appearance state.

- Replace fixed tabs with sidebar navigation for Setup, Credentials, Runners,
  Models, Languages, Appearance, and Advanced. Start on Setup, preserve selection
  while the scene remains open, and keep sidebar labels visible at minimum size.
  Remove the fixed content frame and use minimum sizing plus scene default size.
  Use navigation available on macOS 14 rather than newer sidebar tab APIs.
- Reuse existing pane behavior and form controls. Introduce shared row treatment
  for locked, pending, and repair states only where semantics match.
- Keep initial setup distinct through labels and grouping, not a duplicate
  configuration editor.
- Verify Settings links from Overview still open the Settings scene correctly.

Done when: window sizing and navigation work on macOS 14; offline editing,
locked values, pending restart, schema errors, and secret masking retain their
behavior; keyboard access and long descriptions work. No wholesale state-store
migration is required for styling.

### Batch 3: Threads layout and reading behavior

Depends on Batch 1. Owners: `DashboardDetailContainer`, `ThreadMirrorSection`,
thread list/row, metadata, transcript, events, and the existing thread store.

- Give Threads its own non-page-scrolling detail layout. Keep ordinary page
  scrolling for Overview and Diagnostics.
- Implement search, filters, selection reconciliation, and placeholders using
  the Thread interaction contract above. Keep the existing thread data owner;
  adjust its selection fallback rather than creating a competing view selection.
- Add Transcript/Events selection and compact metadata.
- Implement the reading-state transitions in the Thread interaction contract
  using APIs available on macOS 14.
- Preserve scene-aware polling and cancellation behavior.

Done when: list and transcript scroll independently, refresh does not reset
reading position, filters and selection behave coherently, and cancellation
remains correct. Test filtering and follow-latest state transitions through
focused interfaces; manually verify actual scrolling and keyboard navigation.

### Batch 4: Diagnostics, menu bar, and cleanup

Depends on Batches 1 through 3. Owners: diagnostics views, menu bar views, shared
presentation modules and all migrated callers.

- Prioritize logs and export; disclose technical endpoints and local details.
- Apply shared status and appearance styling to the menu bar without copying
  dashboard lifecycle policy.
- Audit empty/loading/error states, labels, focus, contrast, and Reduce Motion.
- Remove unused views, duplicate constants, obsolete modifiers, and imports.
- Check file budgets and one-primary-type-per-file organization.

Done when: all app surfaces use the same design vocabulary; old implementations
have been removed; no feature has acquired a parallel state owner or copied
policy; accessibility checks have recorded evidence.

### Batch 5: Final verification and documentation

Depends on all preceding batches.

- Run `xcodegen generate` in `apps/macos` and build the app with `xcodebuild`
  using the generated project's actual scheme and an available macOS destination.
- Run affected macOS tests and documentation-contract tests. Record exact
  commands and results. Run backend checks only if backend code was changed.
- Update the authoritative macOS guide and any necessary mirror overlay or
  manifest entries. Check Markdown links and retired paths.
- Run the public mirror dry run against a temporary commit or isolated candidate
  snapshot if mirrored content changed; a default-HEAD run does not verify
  uncommitted changes.
- Complete the acceptance matrix below and summarize unresolved limitations.

Done when: required checks pass and visual acceptance has evidence, or remaining
limitations are explicitly recorded without claiming full completion.

## Verification procedure

Discover schemes with `xcodebuild -list` after XcodeGen. Use the current public
CI build-for-testing then test-without-building sequence as the starting point,
with `CODE_SIGNING_ALLOWED=NO`, an available macOS destination, and derived data
outside committed source. Do not assume a successful build on a newer SDK proves
macOS 14 runtime compatibility. If a macOS 14 runtime is unavailable, record
that gap separately from compile results.

Run affected Swift tests, including existing managed-setting and supervision
regressions when their callers change. New behavior checks cover appearance
fallback and persistence, thread predicates and selection reconciliation, and
follow-mode transitions. Actual scroll geometry still needs visual review.
Run these repository contract checks from the root:

```bash
pnpm --filter @agentroom/backend test -- test/swiftModelStructure.test.ts test/sourceFileBudget.test.ts test/mirrorManifest.test.ts
```

Check local Markdown targets and retired references in changed documents. This
plan is included in the public mirror through the `docs` allowlist. The current
app source directory is also included, so ordinary additions within it need no
new manifest rule. For this plan or other mirrored changes, validate a candidate
snapshot with `pnpm mirror:public --dry-run --source-ref <candidate-commit>`.
Use an isolated Git index or checkout to create the temporary candidate, preserve
the user's real index and branch, and record the candidate hash and result.

## Acceptance matrix and progress record

For visual review, cover System/Light/Dark, minimum/default/large windows,
normal/increased contrast, and Reduce Motion. Exercise running, stopped,
unhealthy-owned, external-backend, setup-needed, empty-thread, populated-thread,
settings-locked, and pending-restart states. Use representative fixtures where
necessary and identify them as fixtures.

For every batch record: implementation status, visual acceptance status, files
changed, reused/replaced modules, checks and
results, visual evidence location when available, and next remaining action.
Keep generated screenshots and build output outside committed source unless
repository policy explicitly permits them.

| Batch | Status | Evidence and remaining work |
| --- | --- | --- |
| 0 Baseline | Implementation complete; baseline reviewed | Running installed app reviewed with CUA on 2026-10-01: stopped/setup-needed Overview, empty Threads with connection error. Five equal cards and sidebar status inside List confirmed. Owners: DashboardTheme/CardBackground, StatusStyle and existing styling extensions, InfoRow/CopyableValueRow, SettingsCaption/ManagedSettingFootnote, lifecycle confirmations, BackendThreadMirrorStore. Extend these; keep appearance app-local and filtering/reading thread-local. XcodeGen and Xcode 27.0 available; platform=macOS destination, macOS 14 runtime unavailable. Source and docs are already allowlisted. Build-for-testing then test-without-building with CODE_SIGNING_ALLOWED=NO and /tmp/agentroom-design-derived. Contract tests and candidate-ref mirror dry run required. Owned-unhealthy, external, populated thread, locked/pending states need safe fixtures or later visual review. Baseline screenshots remain in tool output, no sensitive content committed. |
| 1 Theme and Overview | Implementation complete; visual acceptance pending | Added Features/Appearance AppAppearance and AppAppearanceStore with fallback/persistence test; injected one owner into all scenes. Migrated DashboardTheme and CardBackground, Sidebar footer, StatusHeroCard, OverviewSection, PairingURLsCard, ConfigurationCard. Reused lifecycle actions, status extensions, copy and info rows. XcodeGen and Xcode 27 build-for-testing passed; AppAppearanceTests passed 1/1. Initial CUA compiled-app launch timed out; retry after batch 2 tests succeeded. Stopped Overview reviewed in System dark. Long content caused ViewThatFits to stack at default width; fix tracked for batch 4. Minimum/large sizing, System changes/chrome, long values and ownership matrix still need runtime visual acceptance. |
| 2 Settings | Implementation complete; partial visual acceptance | Replaced SettingsView tabs with SettingsSection sidebar and SettingsPaneContent; added AppearanceSettingsPane; scene default 820x640, minimum 720x560; Setup labels and long workspace text improved. Existing grouped Forms, ManagedSettingFootnote and SettingsCaption already own matching locked/pending/repair treatments and remain reused, with no new settings state owner. XcodeGen/build-for-testing passed. ManagedSettingStatus, BackendSupervisorManagedSettings and PreservedManagedSettingRow tests passed. CUA verified Overview SettingsLink opens Setup with seven destinations, Appearance radio controls and Light/Dark/System native chrome. Restored System. Offline editing and masking preserve existing panes; locked/pending/schema fixtures and macOS 14 resizing still pending. |
| 3 Threads | Implementation complete; partial visual acceptance | DashboardDetailContainer gives Threads full height. Reused existing store, rows, metadata/context and cancellation. Added ThreadStatusFilter/ThreadSelectionState, search and placeholders, compact disclosed ThreadSessionDetails, ThreadSelectedDetail tabs, ThreadReadingState/ScrollView/ScrollObserver. Failed transcript fetches remain retryable. XcodeGen/build-for-testing passed; 11 focused ThreadInteraction, ThreadMirrorStore and ThreadContextCompaction tests passed. CUA checked empty/error layout. Synthetic app in /tmp/agentroom-design-review uses repo views, no credentials/backend: initial bottom, append, same-message growth, scroll-away pause, paused anchor, separate tabs, dropped event anchor and Jump reviewed; fixed observed Jump/stale-anchor issues, rechecked second pause. Bottom tolerance 24 points. Screenshots in CUA outputs. Real cancellation, polling on activation, list keyboard selection and macOS 14 scrolling remain acceptance gaps. |
| 4 Smaller surfaces and cleanup | Implementation complete; partial visual acceptance | DiagnosticsSection prioritizes controls/logs and discloses endpoints/local events. OverviewGroupsLayout fixes default-width columns at two 320-point groups plus spacing; shared rows wrap/select long values, duplicate pairing copy controls removed. BackendStateSymbol shared by hero/sidebar/menu; StatusOrb and obsolete ThreadMirrorEmptyDetailCard removed. Shared spacing migrated, menu header/footer spacing aligned, optional dashboard/copy animations suppress under Reduce Motion, grouped border strengthens under increased contrast. Thread status presentation uses running predicate; hidden detail/tab controls disabled. CUA confirmed default Overview columns and long-hostname wrapping; AX inspection identified hidden row copy actions, fixed with contained accessibility and verified labeled Copy controls. XcodeGen/build-for-testing passed. Three contract suites passed 17 checks, including budgets and shared Swift ownership. Coordinate resizing did not change window; exact minimum/large and full accessibility matrix remain pending. |
| 5 Verification and docs | Automated verification complete; overall acceptance pending | XcodeGen and Xcode 27.0 build-for-testing passed; full AgentRoomMacTests passed 174/174. Three documentation/source/mirror contract suites passed 17/17. Updated MACOS.md and private/public docs indexes. CUA reviewed compiled Diagnostics; synthetic fixtures reviewed healthy minimum stacked/default columns, owned/external/unhealthy lifecycle presentation and menu content in Light/Dark. Large fixture exceeded the visible desktop, so full large-window review remains pending. Candidate mirror result and exact commands below. No backend source changed; backend runtime/build checks are outside this presentation-only change. |

## Scope limits and escalation

Defer custom palettes, custom fonts, a command launcher, a new onboarding flow,
new backend capabilities, new dependencies, session creation, and broad state
architecture rewrites. These are not necessary to deliver this plan.

Resolve ordinary spacing and implementation choices within the settled design.
Record departures with evidence. Seek user input only when a choice changes
product scope, established behavior, dependencies, or supported platforms.

## Repository references

- [macOS client ownership](../clients/MACOS.md)
- [SwiftUI standards](../engineering/SWIFTUI_STANDARDS.md)
- [Architecture and file-size budgets](../architecture/ARCHITECTURE.md)
- [Public mirror contract](../operations/OPEN_SOURCE_MIRROR.md)

## Plan review record

Reviewed against the checkout on 2026-10-01. Clarified selection changes relative
to the current store, search and filter predicates, reading-state transitions,
appearance persistence, macOS 14 navigation constraints, and verification when
visual tools are unavailable. This review established the handoff. Implementation and verification results are
recorded above; the initial pending status has been superseded.

## Final validation record

Implementation batches 0 through 5 were committed and pushed sequentially on
`codex/macos-app-design`. The deployment target remains macOS 14.0. No backend
routes, shared DTOs, provider credentials, or release settings changed.

Commands run from `apps/macos` with Xcode 27.0 on macOS 27.0:

```bash
xcodegen generate
xcodebuild -list -project AgentRoomMac.xcodeproj
xcodebuild -project AgentRoomMac.xcodeproj -scheme AgentRoomMac -configuration Debug \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/agentroom-design-derived \
  CODE_SIGNING_ALLOWED=NO build-for-testing
xcodebuild -project AgentRoomMac.xcodeproj -scheme AgentRoomMac -configuration Debug \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath /tmp/agentroom-design-derived \
  CODE_SIGNING_ALLOWED=NO test-without-building -only-testing:AgentRoomMacTests
```

Result: build and 174 tests passed. The generated project remains ignored. Logs
are outside source at `/tmp/agentroom-design-build-final.log` and
`/tmp/agentroom-design-tests-final.log`; test results are under
`/tmp/agentroom-design-derived/Logs/Test`. Existing URLProtocol Sendable and
AppIntents metadata warnings remain; no new production compile warning was
reported.

Repository checks:

```bash
pnpm --filter @agentroom/backend test -- test/swiftModelStructure.test.ts test/sourceFileBudget.test.ts test/mirrorManifest.test.ts
```

Result: 3 suites and 17 tests passed. Markdown target and retired-reference
checks cover the changed guides and indexes. The isolated-index candidate `f3f91db4469504d9414da0da727b567a19f0e747` passed
`pnpm mirror:public --dry-run --source-ref f3f91db4469504d9414da0da727b567a19f0e747`.
The temporary index preserved the real index and branch. The final committed
record will receive the same dry run before push. Output is in
`/tmp/agentroom-design-mirror-candidate.log`.

### Visual acceptance evidence and remaining checks

CUA screenshots remain in this chat's tool output. The synthetic review app
lives in `/tmp/agentroom-design-review`, with build output under
`/tmp/agentroom-design-review-derived`. It compiles the repository's views,
uses synthetic messages/events and an isolated temporary supervisor fixture,
and performs no runner or backend launch. Its private state seam exists only in
the temporary source copy. It uses a synthetic secret store and temporary
app-support paths, with no user credentials. It has been closed after review.

| Check | Evidence | Remaining acceptance |
| --- | --- | --- |
| System, Light, Dark | Compiled Settings controls and native chrome reviewed; preference fallback/persistence tested; Overview/menu fixture reviewed in Light and Dark | Change the OS appearance while System remains selected; verify actual menu bar glyph/popover against both system appearances |
| Minimum and default Overview | Healthy synthetic minimum detail width shows status and pairing together; default compiled and synthetic columns wrap hostnames | Resize the production window directly and review all failure states at the exact minimum |
| Large Overview | Synthetic large layout reached bounded content width | Full screenshot clipped at the desktop edge; repeat on a larger display |
| Ownership | Synthetic running-owned, external and unhealthy-owned status/action presentation reviewed; external menu lifecycle controls disabled | Attended real owned-unhealthy and external runtime checks |
| Empty/error Threads | Compiled app reviewed with backend stopped | Initial loading and keyboard navigation through a populated list |
| Populated thread reading | Synthetic initial bottom, append/growth, pause, retained anchor, tab switching, event eviction and Jump reviewed; two viewport bugs corrected before commit | Repeat on macOS 14; verify actual scene polling and cancellation without affecting a live user turn |
| Settings | Sidebar and Setup link reviewed; all existing setting regressions pass, masked credentials remain in secure fields | Minimum resizing, locked/pending/schema fixtures and keyboard traversal in each pane |
| Diagnostics/menu | Compiled Diagnostics order and disclosures reviewed; synthetic menu content reviewed at 296 points in both appearances | Export interaction and actual menu bar panel placement |
| Contrast, VoiceOver, Reduce Motion | AX tree verifies labeled copy actions; symbol/text status cues and Reduce Motion gates inspected | Attended increased-contrast, VoiceOver and Reduce Motion review across all surfaces; these OS environment values are read-only in SwiftUI fixtures |
| macOS 14 | Target retained and macOS 14-compatible APIs compiled | No macOS 14 runtime is installed on this host |

These are acceptance gaps, not a claim of full visual or macOS 14 runtime
completion. The implementation is ready for those attended checks.
