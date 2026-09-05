import Foundation

/// Holds the first reload so tests can attempt competing operator actions.
final class EditorCatalogTransactionURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var held: EditorCatalogTransactionURLProtocol?
    nonisolated(unsafe) private static var reloads = 0

    static var reloadCount: Int { lock.withLock { reloads } }

    static func session() -> URLSession {
        lock.withLock { held = nil; reloads = 0 }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Self.self]
        return URLSession(configuration: configuration)
    }

    static func rejectFirstReload() {
        let request = lock.withLock { let value = held; held = nil; return value }
        request?.respond(accepted: false)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard request.url?.path == "/api/editor/catalog/reload" else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable))
            return
        }
        let shouldHold = Self.lock.withLock {
            Self.reloads += 1
            if Self.reloads == 1 { Self.held = self; return true }
            return false
        }
        if !shouldHold { respond(accepted: true) }
    }

    private func respond(accepted: Bool) {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else { return }
        let body = """
        {"reloaded":true,"accepted":\(accepted),"source":"override","version":"fixture","changed":true}
        """
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
