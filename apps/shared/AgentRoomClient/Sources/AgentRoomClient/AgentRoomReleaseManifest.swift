import Foundation

/// Compatibility metadata shipped beside an AgentRoom for Mac release.
///
/// The release page and download URL are deliberately absent: GitHub owns
/// those values, while this manifest owns only AgentRoom's compatibility
/// policy and the exact artifact name that policy applies to.
public struct AgentRoomReleaseManifest: Codable, Hashable, Sendable {
    public var schemaVersion: Int
    public var backendVersion: String
    public var apiVersion: String
    public var minimumSupportedClientApiVersion: String
    public var compatibleClients: BackendReleaseCompatibility.CompatibleClients
    public var macArtifact: MacArtifact

    public init(
        schemaVersion: Int,
        backendVersion: String,
        apiVersion: String,
        minimumSupportedClientApiVersion: String,
        compatibleClients: BackendReleaseCompatibility.CompatibleClients,
        macArtifact: MacArtifact
    ) {
        self.schemaVersion = schemaVersion
        self.backendVersion = backendVersion
        self.apiVersion = apiVersion
        self.minimumSupportedClientApiVersion = minimumSupportedClientApiVersion
        self.compatibleClients = compatibleClients
        self.macArtifact = macArtifact
    }

    public var compatibility: BackendReleaseCompatibility {
        BackendReleaseCompatibility(
            backendVersion: backendVersion,
            apiVersion: apiVersion,
            minimumSupportedClientApiVersion: minimumSupportedClientApiVersion,
            compatibleClients: compatibleClients
        )
    }

    public struct MacArtifact: Codable, Hashable, Sendable {
        public var name: String
        public var architecture: String

        public init(name: String, architecture: String) {
            self.name = name
            self.architecture = architecture
        }
    }
}
