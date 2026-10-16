import Foundation

/// One stored answer to a choice slot: "slot `slotID` holds choice `choiceID`".
///
/// Compared against the stored value only, never the slot's display default.
/// The backend reads an unset choice as its own default, which need not be the
/// first choice the picker shows, so matching the default here could disagree
/// with what the backend actually launches.
struct RunnerBootstrapChoiceSelection: Equatable {
    var slotID: String
    var choiceID: String

    func isSelected(storedValue: (String) -> String?) -> Bool {
        storedValue(slotID)?.trimmingCharacters(in: .whitespacesAndNewlines) == choiceID
    }
}
