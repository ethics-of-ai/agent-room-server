import Foundation

/// A piece's edge at rotation 0, clockwise seen from above, the backend's
/// `SketchPieceEdge`. ``back`` is -z, the way the piece faces. Each quarter
/// turn moves an edge one place along.
public enum SketchPieceEdge: String, CaseIterable, Hashable, Sendable {
    case back, right, front, left

    /// Quarter turns clockwise from ``back`` to this edge.
    public var quarterTurnsFromBack: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    /// The edge this one becomes after `quarterTurns` clockwise.
    public func turned(quarterTurns: Int) -> SketchPieceEdge {
        let index = (quarterTurnsFromBack + quarterTurns) % 4
        return Self.allCases[(index + 4) % 4]
    }
}
