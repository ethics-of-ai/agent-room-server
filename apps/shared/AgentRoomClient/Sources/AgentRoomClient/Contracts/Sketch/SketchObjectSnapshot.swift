import Foundation

/// One stored sketch object as the backend serves it. `kind` stays an open
/// string: the supported kinds are `stroke`, `box`, `text`, `planarShape`, `textBox`, and `group`, and any
/// other kind is an object a newer document introduced — preserved verbatim
/// server-side, readable here, but not editable by this client (see
/// `isKnownKind`). Payload fields are optional because which ones carry data
/// depends on the kind.
public struct SketchObjectSnapshot: Codable, Hashable, Identifiable {
    public var id: String
    public var kind: String
    public var parentId: String?
    /// Ordered stroke points in object-local space; present for strokes.
    public var points: [[Double]]?
    /// Stroke radius in meters; present for strokes.
    public var width: Double?
    /// V2 brush preset; missing on legacy server responses.
    public var brush: SketchStrokeBrush?
    /// V2 line pattern; missing on legacy server responses.
    public var lineStyle: SketchLineStyle?
    public var shapeType: SketchPlanarShapeType?
    public var appearance: SketchShapeAppearance?
    public var fillColor: String?
    public var outlineColor: String?
    public var outlineWidth: Double?
    /// Box edge lengths; present for boxes.
    public var size: [Double]?
    /// Label text; present for text objects.
    public var text: String?
    public var color: String?
    /// Text box formatting; missing from version-2 server responses.
    public var font: SketchTextFont?
    public var paragraphs: [SketchTextParagraph]?
    public var spans: [SketchTextSpan]?
    public var rendering: SketchTextRendering?
    public var extrusionDepth: Double?
    public var transform: SketchTransform?

    public init(
        id: String,
        kind: String,
        parentId: String? = nil,
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
        self.id = id
        self.kind = kind
        self.parentId = parentId
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

    /// The six kinds this client understands. Everything else is a
    /// forward-compatibility entry: shown as unsupported, never targeted by
    /// operations from this client.
    public static let knownKinds: Set<String> = ["stroke", "box", "text", "planarShape", "textBox", "group"]

    public var isKnownKind: Bool {
        SketchObjectSnapshot.knownKinds.contains(kind)
    }

    /// False when a newer backend sent a text format value this client does
    /// not know. The client then shows the text box read-only, so an edit
    /// cannot rewrite formatting it does not understand.
    public var hasSupportedTextFormat: Bool {
        (font?.family.isSupported ?? true) &&
            (paragraphs?.allSatisfy(\.isSupported) ?? true) &&
            (rendering?.isSupported ?? true)
    }
}
