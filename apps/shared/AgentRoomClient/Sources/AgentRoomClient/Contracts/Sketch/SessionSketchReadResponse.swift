import Foundation

/// `GET /api/workspaces/:workspaceId/sketch?path=…` and history reset. A
/// missing file is a `409 file_missing` refusal; the model also treats a
/// `null` sketch as missing.
public struct SessionSketchReadResponse: Codable, Hashable {
    public var sketch: SketchSessionSnapshot?

    public init(sketch: SketchSessionSnapshot?) {
        self.sketch = sketch
    }
}
