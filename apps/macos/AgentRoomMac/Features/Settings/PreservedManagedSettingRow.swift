import Foundation

/// One settings-file entry this build cannot address, ready to render.
///
/// The derivation lives here rather than in the view so it can be tested: what
/// an operator is shown about a trust posture their Mac is running is not
/// something to verify by looking at it. See `PreservedSettingsSection` for why
/// these rows are read-only.
struct PreservedManagedSettingRow: Identifiable, Equatable {
    /// The canonical address in the settings document — `global.<field>` or
    /// `runners.<runnerKind>.<field>`. Unique, so it is also the identity.
    let address: String
    let title: String
    let value: String

    var id: String { address }

    /// Rows for a read of the settings file, sorted for a stable list.
    ///
    /// Titles come from the shared `ManagedSettingLabel`, which is what the
    /// headset names the same settings with, so one operator's two surfaces do
    /// not disagree about what a setting is called. A runner is named through the
    /// catalog, which renders an id this build does not know as itself rather
    /// than as another runner — a wrong name on a trust setting is the one
    /// outcome worse than an ugly one.
    static func rows(
        from preserved: PreservedManagedSettings,
        runners: RunnerCatalog
    ) -> [PreservedManagedSettingRow] {
        let globals = preserved.global.map { field, value in
            PreservedManagedSettingRow(
                address: "\(ManagedBackendSettingKey.globalSection).\(field)",
                title: ManagedSettingLabel.title(field: field, runnerDisplayName: nil),
                value: displayValue(value)
            )
        }
        let runnerRows = preserved.runners.flatMap { runnerKind, fields in
            fields.map { field, value in
                PreservedManagedSettingRow(
                    address: "\(ManagedBackendSettingKey.runnersSection).\(runnerKind).\(field)",
                    title: ManagedSettingLabel.title(
                        field: field,
                        runnerDisplayName: runners.displayName(for: runnerKind)
                    ),
                    value: displayValue(value)
                )
            }
        }
        // Dictionary order is not stable, and a list that reshuffles between
        // reads is unreadable.
        return (globals + runnerRows).sorted {
            $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }

    /// Managed settings are JSON scalars, so the last case is a shape only a
    /// future release would write — reported as unshowable rather than guessed at.
    private static func displayValue(_ value: JSONValue) -> String {
        switch value {
        case .bool(let isOn):
            isOn ? "On" : "Off"
        case .number:
            value.numberText ?? "A number"
        case .string(let text):
            text
        case .null:
            "None"
        case .object, .array:
            "A structured value"
        }
    }
}
