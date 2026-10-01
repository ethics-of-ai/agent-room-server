import Foundation

struct ThreadReadingState {
    static let bottomTolerance: Double = 24
    private(set) var isFollowing = true
    var anchorID: String?

    mutating func userScrolled(distanceToBottom: Double) {
        isFollowing = distanceToBottom <= Self.bottomTolerance
        if isFollowing { anchorID = nil }
    }

    mutating func contentChanged(retainedIDs: [String]) -> Bool {
        if let anchorID, !retainedIDs.contains(anchorID) {
            self.anchorID = nil
        }
        return isFollowing
    }

    mutating func jumpToLatest() {
        isFollowing = true
        anchorID = nil
    }
}
