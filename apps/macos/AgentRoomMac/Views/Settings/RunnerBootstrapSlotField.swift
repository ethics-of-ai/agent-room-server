import SwiftUI

/// A text field for one tier-3 launch value, committed when editing ends.
///
/// It keeps its own draft so a half-typed path is never written to the Keychain,
/// and follows the stored value when something else changes it — running a probe
/// saves the path it resolved, and the field should show what the backend will
/// actually launch with rather than the operator's stale draft.
struct RunnerBootstrapSlotField: View {
    let slot: RunnerBootstrapSlot
    let storedValue: String
    let commit: (String) -> Void

    @State private var text = ""
    @FocusState private var isFocused: Bool

    var body: some View {
        field
            // A grouped Form sizes one label column across the whole pane, so
            // without a floor the longest label in *any* runner's section
            // collapses every field to a sliver. The label wraps instead.
            .frame(minWidth: 220)
            .focused($isFocused)
            .onSubmit { commit(text) }
            .onAppear { text = storedValue }
            .onChange(of: isFocused) { _, focused in
                guard !focused else { return }
                commit(text)
            }
            .onChange(of: storedValue) { _, newValue in
                guard !isFocused else { return }
                text = newValue
            }
    }

    /// Same draft, commit, and follow-the-store behavior either way — a secret
    /// differs only in being masked, so it deliberately does not fork the logic
    /// that decides when a value is written.
    @ViewBuilder
    private var field: some View {
        if slot.kind == .secret {
            SecureField(slot.title, text: $text, prompt: slot.prompt.map(Text.init))
        } else {
            TextField(slot.title, text: $text, prompt: slot.prompt.map(Text.init))
        }
    }
}
