import Foundation

public enum LanguageServiceClientFrame: Codable, Hashable, Sendable {
    case open(path: String, languageId: String, clientVersion: Int, text: String)
    case change(clientVersion: Int, text: String)
    case request(
        requestId: String,
        clientVersion: Int,
        kind: LanguageServiceFeatureKind,
        position: LanguageServicePosition?,
        range: LanguageServiceRange?
    )
    case cancel(requestId: String)
    case close

    private enum FrameType: String, Codable { case open, change, request, cancel, close }
    private enum CodingKeys: String, CodingKey {
        case type, path, languageId, clientVersion, text, requestId, kind, position, range
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(FrameType.self, forKey: .type) {
        case .open:
            self = .open(
                path: try container.decode(String.self, forKey: .path),
                languageId: try container.decode(String.self, forKey: .languageId),
                clientVersion: try container.decode(Int.self, forKey: .clientVersion),
                text: try container.decode(String.self, forKey: .text)
            )
        case .change:
            self = .change(
                clientVersion: try container.decode(Int.self, forKey: .clientVersion),
                text: try container.decode(String.self, forKey: .text)
            )
        case .request:
            self = .request(
                requestId: try container.decode(String.self, forKey: .requestId),
                clientVersion: try container.decode(Int.self, forKey: .clientVersion),
                kind: try container.decode(LanguageServiceFeatureKind.self, forKey: .kind),
                position: try container.decodeIfPresent(LanguageServicePosition.self, forKey: .position),
                range: try container.decodeIfPresent(LanguageServiceRange.self, forKey: .range)
            )
        case .cancel:
            self = .cancel(requestId: try container.decode(String.self, forKey: .requestId))
        case .close:
            self = .close
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .open(let path, let languageId, let clientVersion, let text):
            try container.encode(FrameType.open, forKey: .type)
            try container.encode(path, forKey: .path)
            try container.encode(languageId, forKey: .languageId)
            try container.encode(clientVersion, forKey: .clientVersion)
            try container.encode(text, forKey: .text)
        case .change(let clientVersion, let text):
            try container.encode(FrameType.change, forKey: .type)
            try container.encode(clientVersion, forKey: .clientVersion)
            try container.encode(text, forKey: .text)
        case .request(let requestId, let clientVersion, let kind, let position, let range):
            try container.encode(FrameType.request, forKey: .type)
            try container.encode(requestId, forKey: .requestId)
            try container.encode(clientVersion, forKey: .clientVersion)
            try container.encode(kind, forKey: .kind)
            try container.encodeIfPresent(position, forKey: .position)
            try container.encodeIfPresent(range, forKey: .range)
        case .cancel(let requestId):
            try container.encode(FrameType.cancel, forKey: .type)
            try container.encode(requestId, forKey: .requestId)
        case .close:
            try container.encode(FrameType.close, forKey: .type)
        }
    }
}
