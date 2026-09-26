import Foundation

/// Whether a text box draws flat on its panel or as extruded 3D text.
public enum SketchTextRendering: SketchOpenEnum {
    case flat
    case extruded
    case unsupported(String)

    public init(rawValue: String) {
        switch rawValue {
        case "flat": self = .flat
        case "extruded": self = .extruded
        default: self = .unsupported(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .flat: "flat"
        case .extruded: "extruded"
        case .unsupported(let value): value
        }
    }

    public var isSupported: Bool {
        if case .unsupported = self { false } else { true }
    }
}
