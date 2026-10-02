import Foundation

struct ThreadReadingState {
    static let bottomTolerance: Double = 24
    private(set) var isFollowing = true
    private(set) var isUserScrolling = false
    var anchorID: String?

    var shouldFollowUpdates: Bool { isFollowing && !isUserScrolling }

    mutating func userScrolled(distanceToBottom: Double) {
        isFollowing = distanceToBottom <= Self.bottomTolerance
        if isFollowing { anchorID = nil }
    }

    mutating func scrollPhaseChanged(isUserScrolling: Bool, distanceToBottom: Double) {
        let wasUserScrolling = self.isUserScrolling
        self.isUserScrolling = isUserScrolling
        if isUserScrolling || wasUserScrolling {
            userScrolled(distanceToBottom: distanceToBottom)
        }
    }

    mutating func contentChanged(retainedIDs: [String]) -> Bool {
        if let anchorID, !retainedIDs.contains(anchorID) {
            self.anchorID = nil
        }
        return shouldFollowUpdates
    }

    mutating func jumpToLatest() {
        isFollowing = true
        isUserScrolling = false
        anchorID = nil
    }
}
