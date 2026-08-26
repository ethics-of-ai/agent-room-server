import Foundation

public enum AgentRoomReleaseError: LocalizedError, Equatable, Sendable {
    case invalidGitHubResponse
    case githubRequestFailed(statusCode: Int)
    case draftOrPrerelease
    case invalidReleaseTag
    case manifestMissing(String)
    case invalidManifest
    case unsupportedManifestSchema(Int)
    case manifestVersionMismatch
    case macArtifactMissing(String)
    case macArtifactInvalid

    public var errorDescription: String? {
        switch self {
        case .invalidGitHubResponse:
            "GitHub returned an invalid release response."
        case .githubRequestFailed(let statusCode):
            "GitHub release lookup failed (HTTP \(statusCode))."
        case .draftOrPrerelease:
            "The latest GitHub result is not a published stable release."
        case .invalidReleaseTag:
            "The latest release tag is not a valid AgentRoom version."
        case .manifestMissing:
            "The latest release does not include compatibility information."
        case .invalidManifest:
            "The latest release compatibility information is invalid."
        case .unsupportedManifestSchema:
            "This app cannot read the latest release compatibility format."
        case .manifestVersionMismatch:
            "The latest release tag and compatibility version do not agree."
        case .macArtifactMissing:
            "The latest release does not include its declared Mac download."
        case .macArtifactInvalid:
            "The latest release declares an invalid Mac download."
        }
    }
}
