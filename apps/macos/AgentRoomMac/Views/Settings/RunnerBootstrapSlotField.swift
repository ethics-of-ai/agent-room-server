import SwiftUI

/// A text field for one tier-3 launch value, committed when editing ends.
///
/// It keeps its own draft so a path is not written to the Keychain keystroke
/// by keystroke, and follows the stored value when something else changes it —
/// running a probe saves the path it resolved, and the field should show what
/// the backend will actually launch with rather than the operator's stale draft.
struct RunnerBootstrapSlotField: View {
    let slot: RunnerBootstrapSlot
    let storedValue: String
    let commit: (String) -> Void

    @State private var text = ""
    @State private var isSecretRevealed = false
    @FocusState private var isFocused: Bool

    var body: some View {
        field
            // A grouped Form sizes one label column across the whole pane, so
            // without a floor the longest label in *any* runner's section
            // collapses every field to a sliver. The label wraps instead.
            .frame(minWidth: 220)
            .onSubmit { commit(text) }
            .onAppear { text = displayValue(storedValue) }
            // Reveal is view state only, so the key is masked again the next
            // time the pane appears even if Settings keeps this view alive.
            .onDisappear { isSecretRevealed = false }
            .onChange(of: isFocused) { _, focused in
                guard !focused else { return }
                commit(text)
            }
            .onChange(of: storedValue) { _, newValue in
                guard !isFocused else { return }
                text = displayValue(newValue)
            }
            .onChange(of: text) { _, value in
                if !slot.choices.isEmpty, value != displayValue(storedValue) { commit(value) }
            }
    }

    /// Same draft, commit, and follow-the-store behavior either way — a secret
    /// differs only in being masked, so it deliberately does not fork the logic
    /// that decides when a value is written.
    ///
    /// `.focused` sits on each control rather than on `field`, because the
    /// secret branch is a whole row and focus belongs to its text control.
    @ViewBuilder
    private var field: some View {
        if !slot.choices.isEmpty {
            Picker(slot.title, selection: $text) {
                ForEach(slot.choices) { choice in
                    Text(choice.title).tag(choice.id)
                }
            }
            .focused($isFocused)
        } else if slot.kind == .secret {
            RunnerBootstrapSecretRow(
                slot: slot,
                text: $text,
                isRevealed: $isSecretRevealed,
                isFocused: $isFocused,
                canRemove: !storedValue.isEmpty,
                remove: removeSecret
            )
        } else {
            TextField(slot.title, text: $text, prompt: slot.prompt.map(Text.init))
                // A grouped Form trailing-aligns its fields, which puts the
                // caret at the far right of an empty one.
                .multilineTextAlignment(.leading)
                .focused($isFocused)
        }
    }

    /// Clears the stored key and leaves the empty field focused, so replacing
    /// a key is remove, then paste.
    private func removeSecret() {
        text = ""
        commit("")
        isFocused = true
    }

    private func displayValue(_ value: String) -> String {
        value.isEmpty ? slot.choices.first?.id ?? "" : value
    }
}
