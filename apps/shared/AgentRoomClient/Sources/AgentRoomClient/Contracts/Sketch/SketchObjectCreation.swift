import Foundation

/// The payload of a `create` operation. Exactly the fields the object will
/// store; the wire form rejects unknown keys, so this encodes only what the
/// backend's strict schema accepts.
public struct SketchObjectCreation: Codable, Hashable {
    public var objectId: String
    /// `stroke`, `box`, `text`, `planarShape`, or `textBox` — groups are created
    /// by the `group` operation, not by `create`.
    public var kind: String
    public var points: [[Double]]?
    public var width: Double?
    public var brush: SketchStrokeBrush?
    public var lineStyle: SketchLineStyle?
    public var shapeType: SketchPlanarShapeType?
    public var appearance: SketchShapeAppearance?
    public var fillColor: String?
    public var outlineColor: String?
    public var outlineWidth: Double?
    public var size: [Double]?
    public var text: String?
    public var color: String?
    /// Text box formatting. A create fills any field it leaves out with plain defaults.
    public var font: SketchTextFont?
    public var paragraphs: [SketchTextParagraph]?
    public var spans: [SketchTextSpan]?
    public var rendering: SketchTextRendering?
    public var extrusionDepth: Double?
    public var transform: SketchTransform?

    public init(
        objectId: String,
        kind: String,
        points: [[Double]]? = nil,
        width: Double? = nil,
        brush: SketchStrokeBrush? = nil,
        lineStyle: SketchLineStyle? = nil,
        shapeType: SketchPlanarShapeType? = nil,
        appearance: SketchShapeAppearance? = nil,
        fillColor: String? = nil,
        outlineColor: String? = nil,
        outlineWidth: Double? = nil,
        size: [Double]? = nil,
        text: String? = nil,
        color: String? = nil,
        font: SketchTextFont? = nil,
        paragraphs: [SketchTextParagraph]? = nil,
        spans: [SketchTextSpan]? = nil,
        rendering: SketchTextRendering? = nil,
        extrusionDepth: Double? = nil,
        transform: SketchTransform? = nil
    ) {
        self.objectId = objectId
        self.kind = kind
        self.points = points
        self.width = width
        self.brush = brush
        self.lineStyle = lineStyle
        self.shapeType = shapeType
        self.appearance = appearance
        self.fillColor = fillColor
        self.outlineColor = outlineColor
        self.outlineWidth = outlineWidth
        self.size = size
        self.text = text
        self.color = color
        self.font = font
        self.paragraphs = paragraphs
        self.spans = spans
        self.rendering = rendering
        self.extrusionDepth = extrusionDepth
        self.transform = transform
    }
}
