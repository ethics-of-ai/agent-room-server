import Foundation

/// Character formatting over a UTF-16 range of a text box's text. The wire
/// form writes only flags that are on, so a span with a flag off and a span
/// without it encode the same way.
public struct SketchTextSpan: Codable, Hashable, Sendable {
    public var start: Int
    public var length: Int
    public var bold: Bool
    public var italic: Bool
    public var underline: Bool
    public var strikethrough: Bool

    public init(
        start: Int,
        length: Int,
        bold: Bool = false,
        italic: Bool = false,
        underline: Bool = false,
        strikethrough: Bool = false
    ) {
        self.start = start
        self.length = length
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.strikethrough = strikethrough
    }

    private enum CodingKeys: String, CodingKey {
        case start, length, bold, italic, underline, strikethrough
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        start = try container.decode(Int.self, forKey: .start)
        length = try container.decode(Int.self, forKey: .length)
        bold = try container.decodeIfPresent(Bool.self, forKey: .bold) ?? false
        italic = try container.decodeIfPresent(Bool.self, forKey: .italic) ?? false
        underline = try container.decodeIfPresent(Bool.self, forKey: .underline) ?? false
        strikethrough = try container.decodeIfPresent(Bool.self, forKey: .strikethrough) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(start, forKey: .start)
        try container.encode(length, forKey: .length)
        if bold { try container.encode(true, forKey: .bold) }
        if italic { try container.encode(true, forKey: .italic) }
        if underline { try container.encode(true, forKey: .underline) }
        if strikethrough { try container.encode(true, forKey: .strikethrough) }
    }
}
