import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public extension APIClient {
    func downloadWorkspaceMedia(
        workspaceId: String,
        path: String,
        kind: WorkspaceMediaKind
    ) async throws -> WorkspaceMediaDownload {
        let endpoint = try url(
            pathSegments: ["api", "workspaces", workspaceId, "file-media"],
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
        var request = URLRequest(url: endpoint)
        request.httpMethod = "GET"
        if !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }

        let delegate = WorkspaceMediaRedirectDelegate()
        let (bytes, response) = try await urlSession.bytes(for: request, delegate: delegate)
        defer { bytes.task.cancel() }
        guard let http = response as? HTTPURLResponse else {
            throw WorkspaceMediaDownloadError.invalidResponse("The backend returned a non-HTTP media response.")
        }
        if delegate.wasRedirected || (300..<400).contains(http.statusCode) {
            throw WorkspaceMediaDownloadError.redirected
        }
        guard http.statusCode == 200 else {
            if http.statusCode == 401 || http.statusCode == 503 {
                throw mediaServiceError(http: http, body: Data())
            }
            var body = Data()
            for try await byte in bytes {
                try Task.checkCancellation()
                body.append(byte)
                if body.count == 8 * 1_024 { break }
            }
            throw mediaServiceError(http: http, body: body)
        }

        let mimeType = normalizedMIME(http.value(forHTTPHeaderField: "Content-Type") ?? http.mimeType)
        guard let mimeType, kind.contentTypes.contains(mimeType) else {
            throw WorkspaceMediaDownloadError.unsupportedMIME(mimeType)
        }
        let declaredBytes = declaredContentLength(http)
        if let declaredBytes, declaredBytes > kind.maximumDownloadBytes {
            throw WorkspaceMediaDownloadError.tooLarge(limit: kind.maximumDownloadBytes)
        }
        if let declaredBytes, declaredBytes < 0 {
            throw WorkspaceMediaDownloadError.invalidResponse("The media response has an invalid content length.")
        }
        let directory = try workspaceMediaTemporaryDirectory()
        let suffix = URL(fileURLWithPath: path).pathExtension.lowercased()
        let fileName = suffix.isEmpty ? UUID().uuidString : "\(UUID().uuidString).\(suffix)"
        let ownedURL = directory.appending(path: fileName)
        guard FileManager.default.createFile(atPath: ownedURL.path, contents: nil) else {
            throw WorkspaceMediaDownloadError.invalidResponse("The preview temporary file could not be created.")
        }
        var succeeded = false
        defer {
            if !succeeded { try? FileManager.default.removeItem(at: ownedURL) }
        }
        let handle = try FileHandle(forWritingTo: ownedURL)
        defer { try? handle.close() }
        var actualBytes: Int64 = 0
        var buffer = Data()
        buffer.reserveCapacity(64 * 1_024)
        for try await byte in bytes {
            try Task.checkCancellation()
            actualBytes += 1
            guard actualBytes <= kind.maximumDownloadBytes else {
                throw WorkspaceMediaDownloadError.tooLarge(limit: kind.maximumDownloadBytes)
            }
            buffer.append(byte)
            if buffer.count == 64 * 1_024 {
                try handle.write(contentsOf: buffer)
                buffer.removeAll(keepingCapacity: true)
            }
        }
        try Task.checkCancellation()
        if let declaredBytes, declaredBytes != actualBytes {
            throw WorkspaceMediaDownloadError.declaredSizeMismatch(expected: declaredBytes, actual: actualBytes)
        }
        try handle.write(contentsOf: buffer)
        succeeded = true
        let modifiedAt = http.value(forHTTPHeaderField: "Last-Modified").flatMap(parseHTTPDate)
        return WorkspaceMediaDownload(
            fileURL: ownedURL,
            mimeType: mimeType,
            byteCount: actualBytes,
            modificationDate: modifiedAt
        )
    }
}

private final class WorkspaceMediaRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var redirectEncountered = false

    var wasRedirected: Bool { lock.withLock { redirectEncountered } }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        lock.withLock { redirectEncountered = true }
        completionHandler(nil)
    }
}

private struct WorkspaceMediaErrorBody: Decodable {
    let error: String?
    let message: String?
    let code: String?
}

private func mediaServiceError(http: HTTPURLResponse, body: Data) -> WorkspaceMediaDownloadError {
    if http.statusCode == 401 { return .unauthorized }
    if http.statusCode == 503 {
        let value = http.value(forHTTPHeaderField: "Retry-After") ?? "1"
        let delay = TimeInterval(value) ?? parseHTTPDate(value)?.timeIntervalSinceNow ?? 1
        return .busy(retryAfter: delay.isFinite ? max(0, delay) : 1)
    }
    if let decoded = try? JSONDecoder().decode(WorkspaceMediaErrorBody.self, from: body) {
        return .server(
            statusCode: http.statusCode,
            code: decoded.code,
            message: decoded.message ?? decoded.error ?? "Backend returned HTTP \(http.statusCode)."
        )
    }
    return .server(statusCode: http.statusCode, code: nil, message: "Backend returned HTTP \(http.statusCode).")
}

private func normalizedMIME(_ value: String?) -> String? {
    value?
        .split(separator: ";", maxSplits: 1)
        .first
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
}

private func declaredContentLength(_ response: HTTPURLResponse) -> Int64? {
    guard let value = response.value(forHTTPHeaderField: "Content-Length") else { return nil }
    return Int64(value)
}

private func workspaceMediaTemporaryDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appending(path: "AgentRoomWorkspaceMedia", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

private func parseHTTPDate(_ value: String) -> Date? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
    return formatter.date(from: value)
}
