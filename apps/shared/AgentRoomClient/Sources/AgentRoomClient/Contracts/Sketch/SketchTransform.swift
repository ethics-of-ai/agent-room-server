import Foundation

/// One sketch object's placement: translation in meters, rotation as a
/// normalized `[x, y, z, w]` quaternion, and positive per-axis scale. Geometry
/// is stored in object-local space and placed by this transform composed with
/// the parent chain — the same contract the backend evaluator enforces.
public struct SketchTransform: Codable, Hashable {
    public var translation: [Double]
    public var rotation: [Double]
    public var scale: [Double]

    public init(
        translation: [Double] = [0, 0, 0],
        rotation: [Double] = [0, 0, 0, 1],
        scale: [Double] = [1, 1, 1]
    ) {
        self.translation = translation
        self.rotation = rotation
        self.scale = scale
    }

    /// A translation-only transform, the shape every client-authored box,
    /// text, and group placement uses.
    public static func translating(_ x: Double, _ y: Double, _ z: Double) -> SketchTransform {
        SketchTransform(translation: [x, y, z])
    }
}
