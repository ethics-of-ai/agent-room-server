import Foundation

public struct BackendReleaseCompatibility: Codable, Hashable, Sendable {
    public var backendVersion: String
    public var apiVersion: String
    public var minimumSupportedClientApiVersion: String
    public var compatibleClients: CompatibleClients

    public init(
        backendVersion: String,
        apiVersion: String,
        minimumSupportedClientApiVersion: String,
        compatibleClients: CompatibleClients
    ) {
        self.backendVersion = backendVersion
        self.apiVersion = apiVersion
        self.minimumSupportedClientApiVersion = minimumSupportedClientApiVersion
        self.compatibleClients = compatibleClients
    }

    public struct CompatibleClients: Codable, Hashable, Sendable {
        public var macos: Client
        public var visionos: Client

        public init(macos: Client, visionos: Client) {
            self.macos = macos
            self.visionos = visionos
        }
    }

    public struct Client: Codable, Hashable, Sendable {
        public var minimumVersion: String

        public init(minimumVersion: String) {
            self.minimumVersion = minimumVersion
        }
    }
}
