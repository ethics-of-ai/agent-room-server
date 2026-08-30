import Foundation

/// Canonical correlation and display metadata carried by every `coding_*`
/// event. A client correlates and renders from these fields alone; `native`
/// holds bounded per-runner extras with no canonical home, and is absent
/// (with `nativeTruncated`) when it exceeded the backend's limits.
///
/// `posture` is the runner's own label/value pair — a Codex approval policy or
/// a Claude Code permission mode — deliberately not one reconciled enum.
public struct CodingRunnerMetadata: Codable, Hashable, Sendable {
    public struct Posture: Codable, Hashable, Sendable {
        public var label: String
        public var value: String

        public init(label: String, value: String) {
            self.label = label
            self.value = value
        }
    }

    public var nativeSessionId: String?
    public var nativeTurnId: String?
    public var nativeItemId: String?
    public var model: String?
    public var cwd: String?
    public var posture: Posture?
    public var sandbox: JSONValue?
    public var native: [String: JSONValue]?
    public var nativeTruncated: Bool?

    public init(
        nativeSessionId: String? = nil,
        nativeTurnId: String? = nil,
        nativeItemId: String? = nil,
        model: String? = nil,
        cwd: String? = nil,
        posture: Posture? = nil,
        sandbox: JSONValue? = nil,
        native: [String: JSONValue]? = nil,
        nativeTruncated: Bool? = nil
    ) {
        self.nativeSessionId = nativeSessionId
        self.nativeTurnId = nativeTurnId
        self.nativeItemId = nativeItemId
        self.model = model
        self.cwd = cwd
        self.posture = posture
        self.sandbox = sandbox
        self.native = native
        self.nativeTruncated = nativeTruncated
    }
}
