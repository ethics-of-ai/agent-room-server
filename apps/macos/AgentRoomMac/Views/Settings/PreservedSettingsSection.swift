import SwiftUI

/// The settings in the backend's file that this build cannot address: a runner
/// it does not know, or a field a newer AgentRoom added to one it does.
///
/// See `docs/engineering/RUNNERS.md`. Adding a
/// coding agent is a backend registration, so a registered runner brings its own
/// managed settings — including trust-posture ones. Those have always survived a
/// write here untouched, but they were *invisible*, which is the worse half of
/// the problem: an `auto_allow` permission posture set from a paired client would
/// be running on this Mac with nothing on this Mac saying so.
///
/// Deliberately **read-only**, and this is not a shortcut. The headset edits
/// through `PATCH /api/config`, where the backend validates every value and
/// refuses what its schema does not accept. This app writes the file directly, so
/// there is nothing to refuse it: a value outside a vocabulary it cannot know
/// would make the backend drop the **whole** file onto defaults and take the
/// operator's entire trust posture with it. Visible and read-only is strictly
/// better than invisible, and it is the honest answer to "this app does not know
/// what this accepts".
struct PreservedSettingsSection: View {
    @Environment(BackendSupervisor.self) private var supervisor

    var body: some View {
        if !rows.isEmpty {
            Section("Settings From Other Runners") {
                ForEach(rows) { row in
                    LabeledContent(row.title) {
                        Text(row.value)
                            .foregroundStyle(.secondary)
                    }
                }
                SettingsCaption(
                    text: "These are in the backend's settings file, but this version of AgentRoom does not know what values they accept — so it shows them and leaves them alone rather than risking a write the backend would reject. Change one from the client that set it, or update AgentRoom.",
                    systemImage: "eye"
                )
            }
        }
    }

    private var rows: [PreservedManagedSettingRow] {
        // An unusable file is not being applied by anyone, so reporting its
        // contents as the live posture would be a lie. The pane's reset offer is
        // the right thing on screen in that state.
        guard supervisor.managedSettingsIssue == nil else { return [] }
        return PreservedManagedSettingRow.rows(
            from: supervisor.preservedManagedSettings,
            runners: supervisor.runnerCatalog
        )
    }
}
