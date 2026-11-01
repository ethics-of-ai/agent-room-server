import Foundation

/// The fields a route's refusal body may carry beside its HTTP status: the
/// backend's `error` text and `code`, a sketch conflict's `currentRevision`,
/// and the `message` and `statusCode` of Fastify's own replies, such as a
/// route miss.
struct CodedRefusalBody: Decodable {
    var error: String?
    var code: String?
    var currentRevision: Int?
    var message: String?
    var statusCode: Int?
}
