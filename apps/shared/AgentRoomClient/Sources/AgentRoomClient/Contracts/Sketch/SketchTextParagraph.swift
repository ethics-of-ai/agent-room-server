import Foundation

/// The format of one `\n`-separated paragraph of a text box. A text box
/// carries exactly one per paragraph of its text.
public struct SketchTextParagraph: Codable, Hashable, Sendable {
    public enum Style: SketchOpenEnum {
        case title
        case heading1
        case heading2
        case heading3
        case body
        case caption
        case unsupported(String)

        public init(rawValue: String) {
            switch rawValue {
            case "title": self = .title
            case "heading1": self = .heading1
            case "heading2": self = .heading2
            case "heading3": self = .heading3
            case "body": self = .body
            case "caption": self = .caption
            default: self = .unsupported(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .title: "title"
            case .heading1: "heading1"
            case .heading2: "heading2"
            case .heading3: "heading3"
            case .body: "body"
            case .caption: "caption"
            case .unsupported(let value): value
            }
        }

        public var isSupported: Bool {
            if case .unsupported = self { false } else { true }
        }
    }

    public enum Alignment: SketchOpenEnum {
        case leading
        case center
        case trailing
        case unsupported(String)

        public init(rawValue: String) {
            switch rawValue {
            case "leading": self = .leading
            case "center": self = .center
            case "trailing": self = .trailing
            default: self = .unsupported(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .leading: "leading"
            case .center: "center"
            case .trailing: "trailing"
            case .unsupported(let value): value
            }
        }

        public var isSupported: Bool {
            if case .unsupported = self { false } else { true }
        }
    }

    public enum List: SketchOpenEnum {
        case none
        case bullet
        case numbered
        case unsupported(String)

        public init(rawValue: String) {
            switch rawValue {
            case "none": self = .none
            case "bullet": self = .bullet
            case "numbered": self = .numbered
            default: self = .unsupported(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .none: "none"
            case .bullet: "bullet"
            case .numbered: "numbered"
            case .unsupported(let value): value
            }
        }

        public var isSupported: Bool {
            if case .unsupported = self { false } else { true }
        }
    }

    public static let plain = SketchTextParagraph(style: .body, alignment: .leading, list: .none)

    public var style: Style
    public var alignment: Alignment
    public var list: List

    public init(style: Style, alignment: Alignment, list: List) {
        self.style = style
        self.alignment = alignment
        self.list = list
    }

    public var isSupported: Bool {
        style.isSupported && alignment.isSupported && list.isSupported
    }

    /// One plain Body paragraph per `\n`-separated paragraph of `text`. It
    /// counts `\n` code units, as the backend does; splitting characters
    /// would miss the `\n` inside a `\r\n` grapheme.
    public static func plainParagraphs(for text: String) -> [SketchTextParagraph] {
        Array(repeating: .plain, count: text.utf16.reduce(1) { $1 == 0x0A ? $0 + 1 : $0 })
    }
}
