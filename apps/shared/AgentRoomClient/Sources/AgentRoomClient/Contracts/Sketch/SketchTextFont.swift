import Foundation

/// The whole-box font of a text box. `size` is the Body size in meters; the
/// other paragraph styles scale from it on the client.
public struct SketchTextFont: Codable, Hashable, Sendable {
    public enum Family: SketchOpenEnum {
        case system
        case rounded
        case serif
        case monospaced
        case unsupported(String)

        public init(rawValue: String) {
            switch rawValue {
            case "system": self = .system
            case "rounded": self = .rounded
            case "serif": self = .serif
            case "monospaced": self = .monospaced
            default: self = .unsupported(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .system: "system"
            case .rounded: "rounded"
            case .serif: "serif"
            case .monospaced: "monospaced"
            case .unsupported(let value): value
            }
        }

        public var isSupported: Bool {
            if case .unsupported = self { false } else { true }
        }
    }

    /// The Body size a version-2 text box had: 17 pt at 1,360 pt per meter.
    public static let defaultSize = 0.0125
    public static let plain = SketchTextFont(family: .system, size: defaultSize)

    public var family: Family
    public var size: Double

    public init(family: Family, size: Double) {
        self.family = family
        self.size = size
    }
}
