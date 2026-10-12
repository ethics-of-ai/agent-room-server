import Foundation

/// The reply to a commit, undo, or redo: the receipt for
/// the applied transaction plus the resulting revision and undo/redo depths.
/// The document itself is not echoed — callers re-read it through the sketch
/// read route when they did not author the operations themselves.
public struct SketchTransactionOutcome: Codable, Hashable {
    public var receipt: SketchReceiptSnapshot
    public var fileVersion: String?
    public var revision: Int
    public var undoDepth: Int
    public var redoDepth: Int
    /// Absent from a backend before `sketchIndex`; `nil` inside means an empty stack.
    public var undoHead: SketchHistoryHead?
    public var redoHead: SketchHistoryHead?

    public init(
        receipt: SketchReceiptSnapshot,
        revision: Int,
        undoDepth: Int,
        redoDepth: Int,
        fileVersion: String? = nil,
        undoHead: SketchHistoryHead? = nil,
        redoHead: SketchHistoryHead? = nil
    ) {
        self.fileVersion = fileVersion
        self.receipt = receipt
        self.revision = revision
        self.undoDepth = undoDepth
        self.redoDepth = redoDepth
        self.undoHead = undoHead
        self.redoHead = redoHead
    }
}
