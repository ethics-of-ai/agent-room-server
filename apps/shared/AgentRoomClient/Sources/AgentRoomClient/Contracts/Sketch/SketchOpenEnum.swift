import Foundation

/// A string enum that a newer backend may extend. Decoding never fails on an
/// unfamiliar value: it lands in the conforming type's `unsupported` case,
/// encodes back unchanged, and lets the client show the object read-only
/// instead of rejecting the whole document.
public protocol SketchOpenEnum: Codable, Hashable, Sendable, RawRepresentable where RawValue == String {
    init(rawValue: String)
    var isSupported: Bool { get }
}

extension SketchOpenEnum {
    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
