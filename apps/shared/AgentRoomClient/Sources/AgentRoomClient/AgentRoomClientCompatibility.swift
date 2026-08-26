import Foundation

public struct AgentRoomClientCompatibility: Hashable, Sendable {
    public var platform: AgentRoomClientPlatform
    public var clientVersion: String
    public var clientBuild: String
    public var clientAPIVersion: String
    public var minimumSupportedBackendAPIVersion: String

    public init(
        platform: AgentRoomClientPlatform,
        clientVersion: String,
        clientBuild: String,
        clientAPIVersion: String,
        minimumSupportedBackendAPIVersion: String
    ) {
        self.platform = platform
        self.clientVersion = clientVersion
        self.clientBuild = clientBuild
        self.clientAPIVersion = clientAPIVersion
        self.minimumSupportedBackendAPIVersion = minimumSupportedBackendAPIVersion
    }
}
