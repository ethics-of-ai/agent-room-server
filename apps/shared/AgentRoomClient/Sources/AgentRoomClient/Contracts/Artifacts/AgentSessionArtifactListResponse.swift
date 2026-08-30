import Foundation

public struct AgentSessionArtifactListResponse: Codable, Hashable {
    public var artifacts: [ArtifactSnapshot]

    public init(artifacts: [ArtifactSnapshot]) {
        self.artifacts = artifacts
    }
}
