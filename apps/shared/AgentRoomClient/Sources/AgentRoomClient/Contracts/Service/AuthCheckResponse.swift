import Foundation

public struct AuthCheckResponse: Codable, Hashable {
    public var authRequired: Bool
    public var authenticated: Bool

    public init(authRequired: Bool, authenticated: Bool) {
        self.authRequired = authRequired
        self.authenticated = authenticated
    }
}
