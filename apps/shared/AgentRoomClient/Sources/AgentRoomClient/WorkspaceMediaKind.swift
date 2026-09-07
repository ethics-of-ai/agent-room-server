import Foundation

public enum WorkspaceMediaKind: String, Codable, CaseIterable, Sendable {
    case image
    case pdf
    case usdz

    public var maximumDownloadBytes: Int64 {
        switch self {
        case .image:
            20 * 1_024 * 1_024
        case .pdf, .usdz:
            50 * 1_024 * 1_024
        }
    }

    public var contentTypes: Set<String> {
        switch self {
        case .image:
            ["image/png", "image/jpeg", "image/webp"]
        case .pdf:
            ["application/pdf"]
        case .usdz:
            ["model/vnd.usdz+zip"]
        }
    }

    public static func inferred(from path: String) -> WorkspaceMediaKind? {
        switch URL(fileURLWithPath: path).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "webp":
            .image
        case "pdf":
            .pdf
        case "usdz":
            .usdz
        default:
            nil
        }
    }
}
