import Foundation
@testable import AgentRoomClient
import XCTest

final class APIClientTests: XCTestCase {
    override func setUp() {
        super.setUp()
        RequestCapturingURLProtocol.lastRequest = nil
        RequestCapturingURLProtocol.lastRequestBody = nil
        RequestCapturingURLProtocol.response = nil
        RequestCapturingURLProtocol.responseBody = nil
    }

    func testURLBuilderPreservesBasePathAndEscapesPathSegments() throws {
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://example.test/agent-room")),
            authToken: ""
        )

        let url = try client.url(
            pathSegments: ["api", "workspaces", "workspace 1", "tree"],
            queryItems: [
                URLQueryItem(name: "path", value: "Sources/App.swift"),
                URLQueryItem(name: "depth", value: "3")
            ]
        )

        XCTAssertEqual(
            url.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/tree?path=Sources/App.swift&depth=3"
        )
    }

    func testDeleteAgentSessionSendsDeleteToSessionEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RequestCapturingURLProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://example.test/agent-room")),
            authToken: "secret",
            urlSession: urlSession
        )
        RequestCapturingURLProtocol.response = HTTPURLResponse(
            url: try XCTUnwrap(URL(string: "http://example.test/agent-room/api/agent-sessions/session%201")),
            statusCode: 204,
            httpVersion: nil,
            headerFields: nil
        )

        try await client.deleteAgentSession(sessionId: "session 1")

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.absoluteString, "http://example.test/agent-room/api/agent-sessions/session%201")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testFetchWorkspaceGitStatusUsesStatusEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RequestCapturingURLProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://example.test/agent-room")),
            authToken: "secret",
            urlSession: urlSession
        )
        RequestCapturingURLProtocol.response = HTTPURLResponse(
            url: try XCTUnwrap(URL(string: "http://example.test/agent-room/api/workspaces/workspace%201/git/status")),
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","isRepository":true,"branch":"main","clean":false,"counts":{"total":1,"staged":0,"unstaged":1,"untracked":0,"conflicts":0},"files":[{"path":"README.md","status":"modified","staged":false,"unstaged":true,"additions":2,"deletions":1}],"truncated":false,"refreshedAt":"2026-06-08T00:00:00.000Z"}
        """.utf8)

        let status = try await client.fetchWorkspaceGitStatus(workspaceId: "workspace 1")

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.absoluteString, "http://example.test/agent-room/api/workspaces/workspace%201/git/status")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(status.workspaceId, "workspace 1")
        XCTAssertEqual(status.files.first?.path, "README.md")
    }

    func testDeleteWorkspaceFileSendsOptimisticLockPayload() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","path":"Sources/App.swift","sizeBytes":42,"deleted":true}
        """.utf8)

        let response = try await client.deleteWorkspaceFile(
            workspaceId: "workspace 1",
            path: "Sources/App.swift",
            baseModifiedAt: "2026-08-27T01:02:03.000Z"
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/file"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(payload["path"], "Sources/App.swift")
        XCTAssertEqual(payload["baseModifiedAt"], "2026-08-27T01:02:03.000Z")
        XCTAssertTrue(response.deleted)
        XCTAssertEqual(response.path, "Sources/App.swift")
    }

    func testCreateWorkspaceDirectoryPostsPathWithoutAnOptimisticLockToken() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","path":"Sources/Generated","modifiedAt":"2026-08-29T01:02:03.000Z","created":true}
        """.utf8)

        let response = try await client.createWorkspaceDirectory(
            workspaceId: "workspace 1",
            path: "Sources/Generated"
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(request.httpMethod, "POST")
        // Create and recursive delete share the `/directory` path and differ by
        // method, the way the file PUT and DELETE do.
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/directory"
        )
        XCTAssertEqual(payload["path"], "Sources/Generated")
        // Nothing is being replaced, so there is no version to prove we had seen.
        XCTAssertNil(payload["baseModifiedAt"])
        XCTAssertTrue(response.created)
        XCTAssertEqual(response.path, "Sources/Generated")
        // The returned token makes the new folder an immediate mutation target.
        XCTAssertEqual(response.modifiedAt, "2026-08-29T01:02:03.000Z")
    }

    func testDeleteWorkspaceDirectorySendsRecursiveEndpointPayload() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","path":"Sources/Generated","fileCount":3,"directoryCount":2,"sizeBytes":84,"deleted":true}
        """.utf8)

        let response = try await client.deleteWorkspaceDirectory(
            workspaceId: "workspace 1",
            path: "Sources/Generated",
            baseModifiedAt: "2026-08-27T01:02:03.000Z"
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/directory"
        )
        XCTAssertEqual(payload["path"], "Sources/Generated")
        XCTAssertEqual(payload["baseModifiedAt"], "2026-08-27T01:02:03.000Z")
        XCTAssertTrue(response.deleted)
        XCTAssertEqual(response.fileCount, 3)
        XCTAssertEqual(response.directoryCount, 2)
    }

    func testRenameWorkspaceEntrySendsLeafNameAndOptimisticLockPayload() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","oldPath":"Sources/App.swift","path":"Sources/Main.swift","entryType":"file","sizeBytes":42,"renamed":true}
        """.utf8)

        let response = try await client.renameWorkspaceEntry(
            workspaceId: "workspace 1",
            path: "Sources/App.swift",
            newName: "Main.swift",
            baseModifiedAt: "2026-08-27T01:02:03.000Z"
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/entry/rename"
        )
        XCTAssertEqual(payload["path"], "Sources/App.swift")
        XCTAssertEqual(payload["newName"], "Main.swift")
        XCTAssertEqual(payload["baseModifiedAt"], "2026-08-27T01:02:03.000Z")
        XCTAssertEqual(response.oldPath, "Sources/App.swift")
        XCTAssertEqual(response.path, "Sources/Main.swift")
        XCTAssertEqual(response.entryType, "file")
        XCTAssertTrue(response.renamed)
    }

    func testMoveWorkspaceEntrySendsDestinationParentAndNoCollisionStrategy() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","oldPath":"Sources/App.swift","path":"docs/App.swift","entryType":"file","sizeBytes":42,"moved":true}
        """.utf8)

        let response = try await client.moveWorkspaceEntry(
            workspaceId: "workspace 1",
            path: "Sources/App.swift",
            destinationParent: "docs",
            baseModifiedAt: "2026-08-27T01:02:03.000Z"
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/entry/move"
        )
        XCTAssertEqual(payload["path"], "Sources/App.swift")
        XCTAssertEqual(payload["destinationParent"], "docs")
        XCTAssertEqual(payload["baseModifiedAt"], "2026-08-27T01:02:03.000Z")
        // An omitted `newName` keeps the entry's own name, and a move never asks
        // the backend to rename around a collision.
        XCTAssertNil(payload["newName"])
        XCTAssertNil(payload["onCollision"])
        XCTAssertEqual(response.oldPath, "Sources/App.swift")
        XCTAssertEqual(response.path, "docs/App.swift")
        XCTAssertTrue(response.moved)
    }

    func testCopyWorkspaceEntrySendsCollisionStrategyAndReportsCounts() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","sourcePath":"Sources","path":"Sources-2","entryType":"directory","fileCount":3,"directoryCount":2,"sizeBytes":84,"copied":true}
        """.utf8)

        let response = try await client.copyWorkspaceEntry(
            workspaceId: "workspace 1",
            path: "Sources",
            destinationParent: "",
            baseModifiedAt: "2026-08-27T01:02:03.000Z",
            onCollision: .keepBoth
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/entry/copy"
        )
        XCTAssertEqual(payload["path"], "Sources")
        // "" is the workspace root, a real paste target rather than an omission.
        XCTAssertEqual(payload["destinationParent"], "")
        XCTAssertEqual(payload["onCollision"], "keep_both")
        // The backend reports the name it actually took, so the client never guesses.
        XCTAssertEqual(response.sourcePath, "Sources")
        XCTAssertEqual(response.path, "Sources-2")
        XCTAssertEqual(response.fileCount, 3)
        XCTAssertEqual(response.directoryCount, 2)
        XCTAssertTrue(response.copied)
    }

    func testFetchWorkspaceGitFileBaselineUsesFileBaseEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RequestCapturingURLProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://example.test/agent-room")),
            authToken: "secret",
            urlSession: urlSession
        )
        RequestCapturingURLProtocol.response = HTTPURLResponse(
            url: try XCTUnwrap(URL(string: "http://example.test/agent-room/api/workspaces/workspace%201/git/file-base")),
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","path":"src/app.ts","ref":"HEAD","isRepository":true,"existsInHead":true,"sizeBytes":18,"encoding":"utf8","content":"const before = 1;\\n","truncated":false}
        """.utf8)

        let baseline = try await client.fetchWorkspaceGitFileBaseline(
            workspaceId: "workspace 1",
            path: "src/app.ts",
            maxBytes: 262_144
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/git/file-base?path=src/app.ts&maxBytes=262144"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(baseline.path, "src/app.ts")
        XCTAssertEqual(baseline.content, "const before = 1;\n")
        XCTAssertTrue(baseline.hasUsableContent)
    }

    func testDecodesWorkspaceGitFileBaselineWithoutContent() throws {
        let missing = Data("""
        {"workspaceId":"workspace-1","path":"new.txt","ref":"HEAD","isRepository":true,"existsInHead":false}
        """.utf8)
        let truncated = Data("""
        {"workspaceId":"workspace-1","path":"large.txt","ref":"HEAD","isRepository":true,"existsInHead":true,"sizeBytes":400000,"truncated":true}
        """.utf8)

        let missingBaseline = try JSONDecoder().decode(WorkspaceGitFileBaseline.self, from: missing)
        let truncatedBaseline = try JSONDecoder().decode(WorkspaceGitFileBaseline.self, from: truncated)

        XCTAssertFalse(missingBaseline.existsInHead)
        XCTAssertNil(missingBaseline.content)
        XCTAssertFalse(missingBaseline.hasUsableContent)
        XCTAssertEqual(truncatedBaseline.truncated, true)
        XCTAssertFalse(truncatedBaseline.hasUsableContent)
    }

    func testFetchWorkspaceFileIndexOmitsEmptyQueryAndClampsLimit() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","query":"","files":[{"path":"src/app.ts","name":"app.ts","previewable":true}],"truncated":false}
        """.utf8)

        let snapshot = try await client.fetchWorkspaceFileIndex(workspaceId: "workspace 1", limit: 5_000)

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/files?limit=200"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(snapshot.files.first?.path, "src/app.ts")
        XCTAssertEqual(snapshot.files.first?.id, "src/app.ts")
        XCTAssertTrue(snapshot.query.isEmpty)
    }

    func testFetchWorkspaceFileIndexSendsQueryAndLowerClampsLimit() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace-1","query":"app","files":[],"truncated":true}
        """.utf8)

        _ = try await client.fetchWorkspaceFileIndex(workspaceId: "workspace-1", query: "app", limit: 0)

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace-1/files?query=app&limit=1"
        )
    }

    func testSearchWorkspaceFilesUsesSearchEndpointWithFlagsAndClampedLimit() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace 1","query":"needle","files":[{"path":"src/app.ts","matches":[{"line":2,"column":7,"length":6,"preview":"const needle = needleValue;","previewColumn":7}],"truncated":false}],"totalMatches":1,"filesScanned":724,"truncated":false}
        """.utf8)

        let results = try await client.searchWorkspaceFiles(
            workspaceId: "workspace 1",
            query: "needle",
            matchCase: true,
            include: "src/**",
            limit: 900
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace%201/search"
                + "?query=needle&matchCase=true&wholeWord=false&include=src/**&limit=500"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(results.totalMatches, 1)
        XCTAssertEqual(results.filesScanned, 724)
        XCTAssertEqual(results.files.first?.matches.first?.previewColumn, 7)
        XCTAssertEqual(results.files.first?.matches.first?.id, "2:7")
    }

    func testSearchWorkspaceFilesOmitsEmptyIncludeAndLimit() async throws {
        let client = try makeClient()
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace-1","query":"needle","files":[],"totalMatches":0,"filesScanned":0,"truncated":false}
        """.utf8)

        _ = try await client.searchWorkspaceFiles(workspaceId: "workspace-1", query: "needle", include: "")

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        XCTAssertEqual(
            request.url?.absoluteString,
            "http://example.test/agent-room/api/workspaces/workspace-1/search?query=needle&matchCase=false&wholeWord=false"
        )
    }

    /// Search queries carry characters a file path rarely does. Assert the round
    /// trip against how the backend's query parser actually decodes (`+` means
    /// space, then percent-decode), not just against our own encoder.
    func testSearchWorkspaceFilesQueryRoundTripsDelimiterAndNonASCIICharacters() async throws {
        let client = try makeClient()
        let query = "a b/c&d#e+f=g?h ü 漢 100%"
        RequestCapturingURLProtocol.responseBody = Data("""
        {"workspaceId":"workspace-1","query":"needle","files":[],"totalMatches":0,"filesScanned":0,"truncated":false}
        """.utf8)

        _ = try await client.searchWorkspaceFiles(
            workspaceId: "workspace-1",
            query: query,
            include: "a+b/**"
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let decoded = serverDecodedQuery(request.url)
        XCTAssertEqual(decoded["query"], query)
        XCTAssertEqual(decoded["include"], "a+b/**")
        XCTAssertEqual(decoded["matchCase"], "false")
        XCTAssertEqual(decoded["wholeWord"], "false")
        // The delimiters that would otherwise split or truncate the query string.
        let encodedQuery = try XCTUnwrap(
            URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.percentEncodedQuery
        )
        XCTAssertTrue(encodedQuery.contains("%26"), "& must be escaped")
        XCTAssertTrue(encodedQuery.contains("%23"), "# must be escaped")
        XCTAssertTrue(encodedQuery.contains("%2B"), "+ must be escaped")
        XCTAssertTrue(encodedQuery.contains("%20"), "spaces must be escaped")
        XCTAssertFalse(encodedQuery.contains("+"), "a bare + would decode as a space server-side")
    }

    func testDecodesWorkspaceSearchSnapshot() throws {
        let data = Data("""
        {
          "workspaceId": "workspace-1",
          "query": "needle",
          "files": [
            {
              "path": "src/app.ts",
              "matches": [
                { "line": 2, "column": 7, "length": 6, "preview": "const needle = needleValue;", "previewColumn": 7 },
                { "line": 2, "column": 16, "length": 6, "preview": "const needle = needleValue;", "previewColumn": 16 }
              ],
              "truncated": true
            }
          ],
          "totalMatches": 2,
          "filesScanned": 724,
          "truncated": false
        }
        """.utf8)

        let results = try JSONDecoder().decode(WorkspaceSearchSnapshot.self, from: data)

        XCTAssertEqual(results.files.first?.id, "src/app.ts")
        XCTAssertEqual(results.files.first?.truncated, true)
        XCTAssertFalse(results.truncated)
        XCTAssertEqual(results.files.first?.matches.map(\.id), ["2:7", "2:16"])
        XCTAssertEqual(results.files.first?.matches.last?.column, 16)
    }

    func testSendAgentTurnIncludesAttachmentIdsInContext() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RequestCapturingURLProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://example.test/agent-room")),
            authToken: "secret",
            urlSession: urlSession
        )
        RequestCapturingURLProtocol.response = HTTPURLResponse(
            url: try XCTUnwrap(URL(string: "http://example.test/agent-room/api/agent-sessions/session%201/turns")),
            statusCode: 202,
            httpVersion: nil,
            headerFields: nil
        )
        RequestCapturingURLProtocol.responseBody = Data("""
        {"turn":{"id":"turn-1","sessionId":"session 1","status":"running","startedAt":"2026-05-23T00:00:00.000Z","inputTokens":0,"outputTokens":0,"totalTokens":0}}
        """.utf8)

        _ = try await client.sendAgentTurn(
            sessionId: "session 1",
            message: "Describe this",
            contextPaths: ["README.md"],
            attachmentIds: ["attachment-00000000-0000-0000-0000-000000000001"]
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let payload = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        let context = try XCTUnwrap(payload?["context"] as? [String: Any])
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://example.test/agent-room/api/agent-sessions/session%201/turns")
        XCTAssertEqual(context["paths"] as? [String], ["README.md"])
        XCTAssertEqual(context["attachments"] as? [String], ["attachment-00000000-0000-0000-0000-000000000001"])
    }

    func testUploadAgentSessionAttachmentUsesMultipartEndpoint() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RequestCapturingURLProtocol.self]
        let urlSession = URLSession(configuration: configuration)
        let client = APIClient(
            serverBaseURL: try XCTUnwrap(URL(string: "http://example.test/agent-room")),
            authToken: "secret",
            urlSession: urlSession
        )
        RequestCapturingURLProtocol.response = HTTPURLResponse(
            url: try XCTUnwrap(URL(string: "http://example.test/agent-room/api/agent-sessions/session%201/attachments")),
            statusCode: 201,
            httpVersion: nil,
            headerFields: nil
        )
        RequestCapturingURLProtocol.responseBody = Data("""
        {"attachment":{"id":"attachment-00000000-0000-0000-0000-000000000001","workspaceId":"workspace-1","sessionId":"session 1","kind":"image","sourceName":"clipboard.png","contentType":"image/png","sizeBytes":12,"sha256":"0000000000000000000000000000000000000000000000000000000000000000","createdAt":"2026-05-23T00:00:00.000Z"}}
        """.utf8)

        let attachment = try await client.uploadAgentSessionAttachment(
            sessionId: "session 1",
            sourceName: "clipboard.png",
            contentType: "image/png",
            data: Data([0x89, 0x50, 0x4e, 0x47])
        )

        let request = try XCTUnwrap(RequestCapturingURLProtocol.lastRequest)
        let body = try XCTUnwrap(RequestCapturingURLProtocol.lastRequestBody)
        let bodyText = String(decoding: body, as: UTF8.self)
        XCTAssertEqual(attachment.id, "attachment-00000000-0000-0000-0000-000000000001")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.absoluteString, "http://example.test/agent-room/api/agent-sessions/session%201/attachments")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertTrue(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=") == true)
        XCTAssertTrue(bodyText.contains("name=\"file\"; filename=\"clipboard.png\""))
        XCTAssertTrue(bodyText.contains("Content-Type: image/png"))
    }

    func testDecodesMessageContextMetadata() throws {
        let data = Data("""
        {
          "id": "agent-message-1",
          "sessionId": "agent-session-1",
          "turnId": "agent-turn-1",
          "role": "user",
          "content": "Use this context.",
          "status": "sent",
          "at": "2026-05-23T00:00:00.000Z",
          "context": {
            "paths": ["README.md"],
            "attachments": [
              {
                "id": "attachment-00000000-0000-0000-0000-000000000001",
                "kind": "image",
                "sourceName": "clipboard.png",
                "contentType": "image/png",
                "sizeBytes": 12
              }
            ]
          }
        }
        """.utf8)

        let message = try JSONDecoder().decode(AgentSessionMessage.self, from: data)

        XCTAssertEqual(message.context?.paths, ["README.md"])
        XCTAssertEqual(message.context?.attachments?.first?.id, "attachment-00000000-0000-0000-0000-000000000001")
        XCTAssertEqual(message.context?.attachments?.first?.sourceName, "clipboard.png")
        XCTAssertEqual(message.context?.attachments?.first?.contentType, "image/png")
        XCTAssertEqual(message.context?.attachments?.first?.sizeBytes, 12)
    }

    func testDecodesWorkspaceGitStatus() throws {
        let data = Data("""
        {
          "workspaceId": "workspace-1",
          "isRepository": true,
          "branch": "feature/example",
          "clean": false,
          "counts": {
            "total": 2,
            "staged": 1,
            "unstaged": 1,
            "untracked": 0,
            "conflicts": 0
          },
          "files": [
            {
              "path": "Sources/App.swift",
              "status": "modified",
              "staged": false,
              "unstaged": true,
              "additions": 4,
              "deletions": 1
            },
            {
              "path": "Sources/NewName.swift",
              "oldPath": "Sources/OldName.swift",
              "status": "renamed",
              "staged": true,
              "unstaged": false
            }
          ],
          "truncated": false,
          "refreshedAt": "2026-06-08T00:00:00.000Z"
        }
        """.utf8)

        let status = try JSONDecoder().decode(LocalWorkspaceGitStatus.self, from: data)

        XCTAssertEqual(status.workspaceId, "workspace-1")
        XCTAssertEqual(status.branch, "feature/example")
        XCTAssertEqual(status.counts.total, 2)
        XCTAssertEqual(status.files[0].additions, 4)
        XCTAssertEqual(status.files[1].oldPath, "Sources/OldName.swift")
    }

    /// A bearer-authenticated client whose traffic is captured by
    /// `RequestCapturingURLProtocol` and answered with a 200; each test installs
    /// its own `responseBody`.
    private func makeClient(file: StaticString = #filePath, line: UInt = #line) throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RequestCapturingURLProtocol.self]
        let baseURL = try XCTUnwrap(URL(string: "http://example.test/agent-room"), file: file, line: line)
        RequestCapturingURLProtocol.response = HTTPURLResponse(
            url: baseURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )
        return APIClient(
            serverBaseURL: baseURL,
            authToken: "secret",
            urlSession: URLSession(configuration: configuration)
        )
    }

    /// Decodes a request URL's query the way the backend's Fastify query parser
    /// does — a literal `+` means a space, then percent-decode — so encoding
    /// assertions describe what the server receives, not what we emitted.
    private func serverDecodedQuery(_ url: URL?) -> [String: String] {
        guard let url,
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery else {
            return [:]
        }
        var values: [String: String] = [:]
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let rawName = parts.first.map(String.init) else { continue }
            let rawValue = parts.count > 1 ? String(parts[1]) : ""
            let name = rawName.replacing("+", with: " ")
            let value = rawValue.replacing("+", with: " ")
            values[name.removingPercentEncoding ?? name] = value.removingPercentEncoding ?? value
        }
        return values
    }
}

private final class RequestCapturingURLProtocol: URLProtocol {
    nonisolated(unsafe) static var lastRequest: URLRequest?
    nonisolated(unsafe) static var lastRequestBody: Data?
    nonisolated(unsafe) static var response: HTTPURLResponse?
    nonisolated(unsafe) static var responseBody: Data?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.lastRequest = request
        Self.lastRequestBody = request.httpBody ?? request.httpBodyStream?.readAllData()
        let response = Self.response ?? HTTPURLResponse(
            url: request.url ?? URL(string: "http://example.test")!,
            statusCode: 204,
            httpVersion: nil,
            headerFields: nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private extension InputStream {
    func readAllData() -> Data {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        open()
        defer { close() }
        while hasBytesAvailable {
            let count = read(&buffer, maxLength: buffer.count)
            if count > 0 {
                data.append(buffer, count: count)
            } else {
                break
            }
        }
        return data
    }
}
