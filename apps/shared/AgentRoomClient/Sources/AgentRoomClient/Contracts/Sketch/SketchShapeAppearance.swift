import Foundation

/// Which planar shape parts are visible. Fill and outline colors remain
/// independent even while one part is hidden. `none` hides the whole panel
/// and is valid only for version-3 text boxes, which then show only their
/// text; planar shapes always show a part.
public enum SketchShapeAppearance: String, Codable, Hashable, CaseIterable {
    case outline
    case fill
    case fillAndOutline
    case none

    /// The choices a planar shape, or a text box that shows its panel, offers.
    public static var visiblePartCases: [SketchShapeAppearance] { [.outline, .fill, .fillAndOutline] }

    public var includesFill: Bool {
        self == .fill || self == .fillAndOutline
    }

    public var includesOutline: Bool {
        self == .outline || self == .fillAndOutline
    }
}
