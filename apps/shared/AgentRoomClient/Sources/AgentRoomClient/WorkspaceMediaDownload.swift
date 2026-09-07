import Foundation

public struct WorkspaceMediaDownload: Sendable {
    public let fileURL: URL
    public let mimeType: String
    public let byteCount: Int64
    public let modificationDate: Date?

    public init(fileURL: URL, mimeType: String, byteCount: Int64, modificationDate: Date?) {
        self.fileURL = fileURL
        self.mimeType = mimeType
        self.byteCount = byteCount
        self.modificationDate = modificationDate
    }
}

public enum WorkspaceMediaDownloadError: LocalizedError, Equatable, Sendable {
    case redirected
    case unauthorized
    case busy(retryAfter: TimeInterval)
    case server(statusCode: Int, code: String?, message: String)
    case invalidResponse(String)
    case unsupportedMIME(String?)
    case declaredSizeMismatch(expected: Int64, actual: Int64)
    case tooLarge(limit: Int64)

    public var errorDescription: String? {
        switch self {
        case .redirected:
            return "The backend redirected the media request."
        case .unauthorized:
            return "The AgentRoom bearer token was rejected."
        case .busy:
            return "The preview service is busy. Try again shortly."
        case .server(_, _, let message):
            return message
        case .invalidResponse(let message):
            return message
        case .unsupportedMIME(let mime):
            if let mime {
                return "The backend returned an unsupported media type: \(mime)."
            }
            return "The backend did not return a media type."
        case .declaredSizeMismatch:
            return "The media response length did not match the downloaded file."
        case .tooLarge:
            return "The media file exceeds the preview size limit."
        }
    }
}
