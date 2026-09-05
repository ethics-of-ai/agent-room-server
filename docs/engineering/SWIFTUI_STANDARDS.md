# SwiftUI Standards

AgentRoom's Apple clients are REST and WebSocket clients for the Mac-hosted
backend. SwiftUI code should make that boundary obvious: views present state and
collect user intent, state/services perform async work, and the backend remains
the source of truth.

## Structure

- Organize SwiftUI code by feature area, not by dumping all view types into one
  file.
- Keep app-local value types, presentation metadata, and algorithms with their
  owning feature, state, or infrastructure area. Do not recreate a top-level
  `Models/` directory as a general destination.
- Keep one primary Swift type per file. Small private helper types are allowed
  only when they are inseparable from the parent type and unlikely to be reused.
  This holds in `apps/shared/AgentRoomClient` exactly as it does in the two apps:
  the rule stopping one directory short is what let the retired
  `AgentRoomContracts.swift` reach 2,542 lines and 102 public types. The
  repository-wide source and test limits, exception ledger, and removal rule
  are defined in [File-size budgets](../architecture/ARCHITECTURE.md#file-size-budgets).
- Extract large `body` implementations and `some View` helper properties into
  named `View` structs.
- Keep button actions and async work in methods or state objects. View bodies
  should read as layout, state, and navigation.
- Keep generated Xcode projects out of hand edits. Change `project.yml` and run
  XcodeGen.

## State And Dependencies

- Prefer one owner for mutable screen state. Pass derived values and actions to
  subviews instead of letting every leaf view mutate global state directly.
- Shared Apple API DTOs, endpoint construction, bearer auth attachment, and
  response decoding should live in `apps/shared/AgentRoomClient`. Both app
  project definitions compile those sources **directly into the app module**, so
  the contracts are in scope with no `import AgentRoomClient` and no
  `#if canImport(AgentRoomClient)` guard — there is no package-dependency build
  mode for either app, and the migration typealias shims that once needed one are
  gone. Do not reintroduce duplicate DTO structs in `apps/macos` or
  `apps/visionos`: because the sources are in-module, an app-local redeclaration
  shadows the contract silently instead of failing to link.
  `apps/backend/test/swiftModelStructure.test.ts` enforces this.
- New shared state should use `@Observable` and be `@MainActor` when deployment
  targets allow it. Existing `ObservableObject` stores can remain until migrated
  behind a clear settings/state split.
- Do not put provider, model, tool, or macOS launch secrets in `@AppStorage`.
  macOS launch secrets remain Keychain backed; visionOS may store only the
  AgentRoom bearer token.
- Do not move agent execution, shell access, or provider credentials into client
  code.

## SwiftUI Quality Bar

- Use `NavigationSplitView` or `NavigationStack`; do not introduce
  `NavigationView`.
- Use `ContentUnavailableView` for empty states.
- Prefer `Label` for icon-and-text affordances and text-labeled buttons for
  accessibility.
- Respect Dynamic Type and system styles. Avoid hard-coded font sizes unless a
  platform-specific control requires them.
- Use `LazyVStack` or `LazyHStack` for scrollable repeated content.
- Prefer `Task.sleep(for:)` over nanosecond-based sleep calls.
- Prefer modern Foundation APIs such as `Date.now` and format styles for user
  display.

## Verification

- For macOS client changes, run `cd apps/macos && xcodegen generate` when
  XcodeGen is available.
- For visionOS client changes, run `cd apps/visionos && xcodegen generate` when
  XcodeGen is available.
- Prefer `xcodebuild` for compile checks when the relevant SDK and simulator are
  installed. State explicitly when local tooling prevents this.
