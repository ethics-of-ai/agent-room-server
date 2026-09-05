import Foundation

public enum LanguageServiceErrorCode: String, Codable, Hashable, Sendable {
    case unauthorized, invalidPath = "invalid_path", unsupportedLanguage = "unsupported_language"
    case unavailable = "service_unavailable", processLimit = "process_limit"
    case documentLimit = "document_limit", documentTooLarge = "document_too_large"
    case globalDocumentLimit = "global_document_limit", documentBusy = "document_busy"
    case resyncRequired = "resync_required", requestLimit = "request_limit"
    case staleDocument = "stale_document", invalidPosition = "invalid_position"
    case timeout, cancelled, serverFailed = "server_failed"
    case unsupportedResponse = "unsupported_response", outboundLimit = "outbound_limit"
    case invalidFrame = "invalid_frame", frameTooLarge = "frame_too_large"
    case workspaceNotFound = "workspace_not_found", projectNotFound = "project_not_found"
    case ambiguousProject = "ambiguous_project"
}
