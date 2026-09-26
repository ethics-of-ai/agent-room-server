import Foundation

/// The supported planar geometry stored in a sketch document.
public enum SketchPlanarShapeType: String, Codable, Hashable, CaseIterable {
    case rectangle
    case ellipse
    case triangle
}
