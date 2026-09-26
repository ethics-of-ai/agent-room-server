import Foundation

/// `POST /api/workspaces/:workspaceId/sketch`, which creates a named sketch
/// file at revision 0.
public struct SessionSketchCreateResponse: Codable, Hashable {
    public var sketch: SketchSessionSnapshot

    public init(sketch: SketchSessionSnapshot) {
        self.sketch = sketch
    }
}
