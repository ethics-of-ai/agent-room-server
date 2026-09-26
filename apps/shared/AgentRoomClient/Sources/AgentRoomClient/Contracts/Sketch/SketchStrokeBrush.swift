import Foundation

/// The persisted brush choice for a stroke. Width remains an independent
/// measurement so a person can fine-tune a preset without losing its name.
public enum SketchStrokeBrush: String, Codable, Hashable {
    case finePen
    case broadMarker
    /// A broad stroke drawn in a translucent version of the chosen color.
    case highlighter
}
