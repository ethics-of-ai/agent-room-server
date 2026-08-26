import Foundation

public enum BackendCompatibilityEvaluator {
    public static func evaluate(
        release: BackendReleaseCompatibility?,
        client: AgentRoomClientCompatibility
    ) -> BackendCompatibilityStatus {
        guard let release else {
            return .unverifiedLegacyBackend
        }

        guard let clientVersion = SemanticVersion(rawValue: client.clientVersion),
              let minimumClientVersion = SemanticVersion(
                  rawValue: minimumClientVersion(in: release, for: client.platform)
              ),
              SemanticVersion(rawValue: release.backendVersion) != nil,
              let clientAPI = APIRevision(rawValue: client.clientAPIVersion),
              let minimumClientAPI = APIRevision(rawValue: release.minimumSupportedClientApiVersion),
              let backendAPI = APIRevision(rawValue: release.apiVersion),
              let minimumBackendAPI = APIRevision(rawValue: client.minimumSupportedBackendAPIVersion) else {
            return .invalidMetadata
        }

        if clientVersion < minimumClientVersion || clientAPI < minimumClientAPI {
            return .clientUpdateRequired
        }
        if backendAPI < minimumBackendAPI {
            return .backendUpdateRequired
        }
        return .compatible
    }

    private static func minimumClientVersion(
        in release: BackendReleaseCompatibility,
        for platform: AgentRoomClientPlatform
    ) -> String {
        switch platform {
        case .macos:
            release.compatibleClients.macos.minimumVersion
        case .visionos:
            release.compatibleClients.visionos.minimumVersion
        }
    }
}
