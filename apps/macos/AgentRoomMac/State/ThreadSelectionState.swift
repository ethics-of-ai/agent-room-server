import Foundation

/// Once a thread has been chosen, only another explicit choice replaces it.
/// List may clear its binding when filtering removes a row; ignore that write.
struct ThreadSelectionState {
    private(set) var id: String?

    mutating func select(_ id: String?) {
        guard let id else { return }
        self.id = id
    }

    mutating func reconcile(availableIDs: [String]) {
        if id == nil { id = availableIDs.first }
    }
}
