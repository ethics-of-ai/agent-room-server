import Foundation

public enum LanguageServiceReadiness: String, Codable, Hashable, Sendable {
    case ready
    case unavailable
    case ambiguousProject = "ambiguous_project"
    case projectNotFound = "project_not_found"
    case restarting
    case failed
}
