import Foundation

/// A sketch-route failure with the backend's typed detail preserved: the
/// sketch error `code` (`stale_revision`, `file_changed`, …) and, where the
/// route sends it, the `currentRevision` a caller can refresh against without
/// another read. The generic request plumbing folds error bodies into a plain
/// message; sketch conflict handling needs the structure, so the sketch
/// endpoints in `APIClient+Sketch.swift` decode it themselves.
public struct SketchEndpointError: Error, Equatable {
    public let statusCode: Int
    public let code: String?
    public let message: String
    public let currentRevision: Int?

    public init(statusCode: Int, code: String?, message: String, currentRevision: Int?) {
        self.statusCode = statusCode
        self.code = code
        self.message = message
        self.currentRevision = currentRevision
    }

    public var isStaleRevision: Bool { ["stale_revision", "file_changed", "file_missing"].contains(code ?? "") }
}
