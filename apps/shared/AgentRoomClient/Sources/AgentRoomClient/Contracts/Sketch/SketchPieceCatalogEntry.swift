import Foundation

/// What a piece's catalog id means for placement, mirroring the backend's
/// `apps/backend/src/sketch/core/pieceCatalog.ts`. A backend test parses
/// ``catalog`` and fails when the two differ, so keep each entry on one line
/// in this form. Meshes are a client concern and live with the renderer.
public struct SketchPieceCatalogEntry: Hashable, Identifiable, Sendable {
    /// The most levels one column holds, the backend's `SKETCH_PIECE_MAX_LEVELS`.
    public static let maximumColumnLevels = 8
    /// The longest text a piece carries, the backend's `SKETCH_MAX_PIECE_TEXT_CHARACTERS`.
    public static let maximumTextCharacters = 64

    public static let catalog: [SketchPieceCatalogEntry] = [
        SketchPieceCatalogEntry(id: "block.cube", title: "Cube", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: true, carriesText: false, ends: [], setsFlow: false),
        SketchPieceCatalogEntry(id: "block.ramp", title: "Ramp", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: false, carriesText: false, ends: [], setsFlow: false),
        SketchPieceCatalogEntry(id: "block.cylinder", title: "Cylinder", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: true, carriesText: false, ends: [], setsFlow: false),
        SketchPieceCatalogEntry(id: "block.road", title: "Road", footprint: [1, 1], levels: 1, height: 0.1, stacksOnTop: false, carriesText: false, ends: [], setsFlow: false),
        SketchPieceCatalogEntry(id: "block.wall", title: "Wall", footprint: [1, 1], levels: 2, height: 2, stacksOnTop: false, carriesText: false, ends: [], setsFlow: false),
        SketchPieceCatalogEntry(id: "block.label", title: "Label", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: false, carriesText: true, ends: [], setsFlow: false),
        SketchPieceCatalogEntry(id: "block.pipe", title: "Pipe", footprint: [1, 1], levels: 1, height: 0.5, stacksOnTop: false, carriesText: false, ends: [.front, .back], setsFlow: true),
        SketchPieceCatalogEntry(id: "block.pipe-angle", title: "Angle Pipe", footprint: [1, 1], levels: 1, height: 0.5, stacksOnTop: false, carriesText: false, ends: [.front, .right], setsFlow: false)
    ]

    /// Stands in for a stored id this build does not know: one level that
    /// nothing stacks on, drawn as a placeholder.
    public static let unknown = SketchPieceCatalogEntry(
        id: "", title: "Unknown Piece", footprint: [1, 1], levels: 1, height: 1, stacksOnTop: false, carriesText: false,
        ends: [], setsFlow: false
    )

    public let id: String
    public let title: String
    /// Cells covered, columns by rows.
    public let footprint: [Int]
    /// Levels the piece fills; the next piece in its column starts this many levels up.
    public let levels: Int
    /// Visible height in cells, which can be less than ``levels`` (a road).
    public let height: Double
    /// Whether another piece may stand on this one.
    public let stacksOnTop: Bool
    /// Whether the piece may store text. The tabletop draws that text only on
    /// `block.label` for now.
    public let carriesText: Bool
    /// The edges a pipe opens on at rotation 0; none for a block. A pipe that
    /// sets flow takes it in at the first and out at the second.
    public let ends: [SketchPieceEdge]
    /// Whether the piece decides its run's direction. A pipe that does not
    /// takes its run's.
    public let setsFlow: Bool

    public init(
        id: String, title: String, footprint: [Int], levels: Int, height: Double, stacksOnTop: Bool, carriesText: Bool,
        ends: [SketchPieceEdge], setsFlow: Bool
    ) {
        self.id = id
        self.title = title
        self.footprint = footprint
        self.levels = levels
        self.height = height
        self.stacksOnTop = stacksOnTop
        self.carriesText = carriesText
        self.ends = ends
        self.setsFlow = setsFlow
    }

    /// The entry for a stored id, or ``unknown`` when this build lacks it.
    public static func entry(for catalogId: String) -> SketchPieceCatalogEntry {
        catalog.first { $0.id == catalogId } ?? unknown
    }

    public static func isKnown(_ catalogId: String) -> Bool {
        catalog.contains { $0.id == catalogId }
    }
}
