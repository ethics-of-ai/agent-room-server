import Foundation

/// A private URL loading seam for the runtime-readiness regression: capability
/// discovery fails after the backend records `ready: false`, then the public
/// catalog read returns that recorded answer.
final class RunnerReadinessFailureURLProtocol: URLProtocol {
    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RunnerReadinessFailureURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let payload: (status: Int, body: String)
        switch url.path {
        case "/api/coding-agent/capabilities":
            payload = (500, #"{"error":"runner spawn failed"}"#)
        case "/api/runners":
            payload = (
                200,
                #"{"runners":[{"runnerKind":"codex","displayName":"Codex","registered":true,"configured":true,"enabled":true,"ready":false}]}"#
            )
        default:
            payload = (404, #"{"error":"not found"}"#)
        }
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: payload.status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
