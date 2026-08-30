import Foundation

public struct APIErrorResponse: Codable, Hashable {
    public var error: String?
    public var message: String?

    public init(error: String? = nil, message: String? = nil) {
        self.error = error
        self.message = message
    }
}
