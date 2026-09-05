import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import AgentRoomClient
import XCTest

final class EditorLanguageServiceContractTests: XCTestCase {
    func testCompletionPreservesInsertionTextAcrossTheNativeBridge() throws {
        let raw = Data(#"{"label":"greet(name: string): void","kind":"function","insertText":"greet"}"#.utf8)
        let completion = try JSONDecoder().decode(LanguageServiceCompletion.self, from: raw)
        XCTAssertEqual(completion.label, "greet(name: string): void")
        XCTAssertEqual(completion.insertText, "greet")
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(completion)) as? [String: Any])
        XCTAssertEqual(encoded["insertText"] as? String, "greet")
    }

    override func setUp() {
        super.setUp()
        LanguageServiceURLProtocol.lastRequest = nil
        LanguageServiceURLProtocol.responseBody = Data()
    }

    func testDecodesCatalogWithUnobservedReadiness() throws {
        let catalog = try JSONDecoder().decode(LanguageServiceCatalog.self, from: Data("""
        {
          "protocolVersion": 1,
          "services": [{
            "id": "sourcekit_lsp",
            "displayName": "SourceKit-LSP",
            "configured": true,
            "enabled": true,
            "languageIds": ["swift"],
            "featureKinds": ["completion", "document_symbols", "semantic_tokens"]
          }]
        }
        """.utf8))

        XCTAssertEqual(catalog.protocolVersion, 1)
        XCTAssertNil(catalog.services.first?.ready)
        XCTAssertEqual(
            catalog.services.first?.featureKinds,
            [.completion, .documentSymbols, .semanticTokens]
        )
    }

    func testClientOpenFrameMatchesClosedWireShape() throws {
        let frame = LanguageServiceClientFrame.open(
            path: "Sources/App.swift",
            languageId: "swift",
            clientVersion: 7,
            text: "let value = 1\n"
        )
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(frame)) as? [String: Any]
        )

        XCTAssertEqual(object["type"] as? String, "open")
        XCTAssertEqual(object["path"] as? String, "Sources/App.swift")
        XCTAssertEqual(object["languageId"] as? String, "swift")
        XCTAssertEqual(object["clientVersion"] as? Int, 7)
        XCTAssertEqual(object["text"] as? String, "let value = 1\n")
        XCTAssertEqual(Set(object.keys), ["type", "path", "languageId", "clientVersion", "text"])
    }

    func testDecodesUTF16DiagnosticAndNullHover() throws {
        let diagnostics = try JSONDecoder().decode(LanguageServiceServerFrame.self, from: Data("""
        {
          "type": "diagnostics",
          "clientVersion": 4,
          "diagnostics": [{
            "range": {
              "start": {"line": 0, "character": 4},
              "end": {"line": 0, "character": 11}
            },
            "message": "Unknown identifier after emoji",
            "severity": "error",
            "source": "sourcekit-lsp"
          }],
          "truncated": false
        }
        """.utf8))
        guard case .diagnostics(let version, let items, let truncated) = diagnostics else {
            return XCTFail("Expected diagnostics frame")
        }
        XCTAssertEqual(version, 4)
        XCTAssertEqual(items.first?.range.start.character, 4)
        XCTAssertEqual(items.first?.range.end.character, 11)
        XCTAssertFalse(truncated)

        let response = try JSONDecoder().decode(LanguageServiceServerFrame.self, from: Data("""
        {"type":"response","requestId":"hover-1","clientVersion":4,
         "result":{"kind":"hover","hover":null,"truncated":false}}
        """.utf8))
        guard case .response(_, _, .hover(let hover, let hoverTruncated)) = response else {
            return XCTFail("Expected hover response")
        }
        XCTAssertNil(hover)
        XCTAssertFalse(hoverTruncated)
    }

    func testUnknownFrameAndFeatureKindsAreRejected() {
        XCTAssertThrowsError(try JSONDecoder().decode(
            LanguageServiceServerFrame.self,
            from: Data("{\"type\":\"native_lsp_packet\"}".utf8)
        ))
        XCTAssertThrowsError(try JSONDecoder().decode(
            LanguageServiceServerFrame.self,
            from: Data("""
            {"type":"response","requestId":"raw","clientVersion":1,
             "result":{"kind":"workspace/executeCommand","truncated":false}}
            """.utf8)
        ))
    }

    func testEndpointPreservesBasePathAndAuthenticatesCatalogAndSocket() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LanguageServiceURLProtocol.self]
        LanguageServiceURLProtocol.responseBody = Data("{\"protocolVersion\":1,\"services\":[]}".utf8)
        let endpoint = EditorLanguageServiceEndpoint(
            serverBaseURL: try XCTUnwrap(URL(string: "https://example.test/agent-room")),
            authToken: "secret",
            urlSession: URLSession(configuration: configuration)
        )

        _ = try await endpoint.fetchCatalog()
        XCTAssertEqual(
            LanguageServiceURLProtocol.lastRequest?.url?.absoluteString,
            "https://example.test/agent-room/api/editor/language-services"
        )
        XCTAssertEqual(
            LanguageServiceURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
            "Bearer secret"
        )

        let socket = try endpoint.socketRequest(workspaceId: "workspace 1")
        XCTAssertEqual(
            socket.url?.absoluteString,
            "wss://example.test/agent-room/api/workspaces/workspace%201/editor/language-service"
        )
        XCTAssertEqual(socket.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testEndpointBuiltFromClientPreservesItsInjectedSession() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LanguageServiceURLProtocol.self]
        LanguageServiceURLProtocol.responseBody = Data("{\"protocolVersion\":1,\"services\":[]}".utf8)
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "https://example.test/agent-room")),
            authToken: "secret",
            urlSession: URLSession(configuration: configuration)
        )

        _ = try await EditorLanguageServiceEndpoint(client: client).fetchCatalog()

        XCTAssertEqual(
            LanguageServiceURLProtocol.lastRequest?.url?.absoluteString,
            "https://example.test/agent-room/api/editor/language-services"
        )
    }
}

private final class LanguageServiceURLProtocol: URLProtocol {
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var responseBody = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://example.test")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
