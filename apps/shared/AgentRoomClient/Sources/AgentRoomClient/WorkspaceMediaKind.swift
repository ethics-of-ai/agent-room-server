import Foundation

public enum WorkspaceMediaKind: String, Codable, CaseIterable, Sendable {
    case image
    case pdf
    case usdz

    /// Retained for source compatibility. Media downloads no longer impose an
    /// application-level file-size cap.
    @available(*, deprecated, message: "Workspace media downloads no longer impose an application-level file-size cap.")
    public var maximumDownloadBytes: Int64 { .max }

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
