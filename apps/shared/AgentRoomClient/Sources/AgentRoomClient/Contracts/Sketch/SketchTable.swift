import Foundation

/// A sketch's table (schema version 4): a square board of ``cells`` by
/// ``cells`` cells on the y = 0 plane, and the whole board, since every piece
/// stands on it. Cell (c, r), with c and r from 0 to cells − 1, has its centre
/// at x = (c + 0.5) × cellSize and z = (r + 0.5) × cellSize; level l starts at
/// y = l × cellSize. A document without a table uses ``standard``.
public struct SketchTable: Codable, Hashable, Sendable {
    public static let defaultCellSize = 0.05
    public static let minimumCellSize = 0.02
    public static let maximumCellSize = 0.2
    /// Metres across the board that a cell size is fitted to.
    public static let width = 0.8
    public static let standard = SketchTable(cellSize: defaultCellSize)

    /// Metres.
    public var cellSize: Double
    /// The board's width in cells. The file stores it, so a saved board keeps
    /// its size if ``width`` changes.
    public var cells: Int

    public init(cellSize: Double, cells: Int) {
        self.cellSize = cellSize
        self.cells = cells
    }

    /// The table the backend writes for a cell size: as many cells as fit
    /// ``width``, 40 at 2 cm and 4 at 20 cm.
    public init(cellSize: Double) {
        self.init(cellSize: cellSize, cells: Self.cells(for: cellSize))
    }

    /// Rounds half up, as the backend's `Math.round` does for positive widths.
    public static func cells(for cellSize: Double) -> Int {
        Int((width / cellSize).rounded())
    }
}
