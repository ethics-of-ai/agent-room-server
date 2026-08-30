import Foundation

public struct HealthResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var uptimeSeconds: Int
    public var runnerKind: String
    public var mode: String
    public var release: BackendReleaseCompatibility?

    public init(
        ok: Bool,
        uptimeSeconds: Int,
        runnerKind: String,
        mode: String,
        release: BackendReleaseCompatibility? = nil
    ) {
        self.ok = ok
        self.uptimeSeconds = uptimeSeconds
        self.runnerKind = runnerKind
        self.mode = mode
        self.release = release
    }
}
