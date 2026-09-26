import Foundation

/// The line pattern applied to one saved stroke object.
public enum SketchLineStyle: String, Codable, Hashable {
    case solid
    case dashed
    case dotted
}
