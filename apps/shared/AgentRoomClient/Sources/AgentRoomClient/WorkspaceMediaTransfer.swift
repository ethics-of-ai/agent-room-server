import Foundation

/// Receives network chunks and writes them on a serial utility queue. Iterating
/// AsyncBytes one byte at a time made large previews spend seconds in Swift.
/// The lock protects all mutable state, including cancellation before startup.
final class WorkspaceMediaTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let kind: WorkspaceMediaKind
    private let path: String
    private var continuation: CheckedContinuation<WorkspaceMediaDownload, any Error>?
    private var session: URLSession?
    private var cancelled = false
    private var response: HTTPURLResponse?
    private var mimeType: String?
    private var declaredBytes: Int64?
    private var actualBytes: Int64 = 0
    private var errorBody = Data()
    private var fileURL: URL?
    private var handle: FileHandle?

    init(kind: WorkspaceMediaKind, path: String) {
        self.kind = kind
        self.path = path
    }

    func download(request: URLRequest, configuration: URLSessionConfiguration) async throws -> WorkspaceMediaDownload {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.withLock {
                    self.continuation = continuation
                    guard !cancelled else {
                        finishLocked(.failure(CancellationError()))
                        return
                    }
                    // Preserve the caller's transport configuration, but never
                    // inherit a main delegate queue for network/file processing.
                    let queue = OperationQueue()
                    queue.maxConcurrentOperationCount = 1
                    queue.qualityOfService = .utility
                    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
                    self.session = session
                    session.dataTask(with: request).resume()
                }
            }
        } onCancel: {
            self.lock.withLock {
                self.cancelled = true
                self.finishLocked(.failure(CancellationError()))
            }
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        lock.withLock { finishLocked(.failure(WorkspaceMediaDownloadError.redirected)) }
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        let disposition: URLSession.ResponseDisposition = lock.withLock {
            guard continuation != nil else { return .cancel }
            do {
                guard let http = response as? HTTPURLResponse else {
                    throw WorkspaceMediaDownloadError.invalidResponse("The backend returned a non-HTTP media response.")
                }
                if (300..<400).contains(http.statusCode) { throw WorkspaceMediaDownloadError.redirected }
                self.response = http
                if http.statusCode == 401 || http.statusCode == 503 {
                    throw mediaServiceError(http: http, body: Data())
                }
                guard http.statusCode == 200 else { return .allow }
                let mimeType = normalizedMIME(http.value(forHTTPHeaderField: "Content-Type") ?? http.mimeType)
                guard let mimeType, kind.contentTypes.contains(mimeType) else {
                    throw WorkspaceMediaDownloadError.unsupportedMIME(mimeType)
                }
                self.mimeType = mimeType
                declaredBytes = declaredContentLength(http)
                if let declaredBytes, declaredBytes < 0 {
                    throw WorkspaceMediaDownloadError.invalidResponse("The media response has an invalid content length.")
                }
                let directory = try workspaceMediaTemporaryDirectory()
                let suffix = URL(fileURLWithPath: path).pathExtension.lowercased()
                let name = suffix.isEmpty ? UUID().uuidString : "\(UUID().uuidString).\(suffix)"
                let url = directory.appending(path: name)
                guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
                    throw WorkspaceMediaDownloadError.invalidResponse("The preview temporary file could not be created.")
                }
                fileURL = url
                handle = try FileHandle(forWritingTo: url)
                return .allow
            } catch {
                finishLocked(.failure(error))
                return .cancel
            }
        }
        completionHandler(disposition)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.withLock {
            guard continuation != nil, let response else { return }
            if response.statusCode != 200 {
                errorBody.append(data.prefix(8 * 1_024 - errorBody.count))
                if errorBody.count == 8 * 1_024 {
                    finishLocked(.failure(mediaServiceError(http: response, body: errorBody)))
                }
                return
            }
            do {
                // Write the network chunk directly. There is no per-byte task
                // suspension or app-owned queue of pending chunks.
                try handle?.write(contentsOf: data)
                actualBytes += Int64(data.count)
            } catch {
                finishLocked(.failure(error))
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        lock.withLock {
            guard continuation != nil else { return }
            do {
                if let error { throw error }
                guard let response else {
                    throw WorkspaceMediaDownloadError.invalidResponse("The backend returned no media response.")
                }
                guard response.statusCode == 200 else {
                    throw mediaServiceError(http: response, body: errorBody)
                }
                if let declaredBytes, declaredBytes != actualBytes {
                    throw WorkspaceMediaDownloadError.declaredSizeMismatch(expected: declaredBytes, actual: actualBytes)
                }
                guard let fileURL, let mimeType else {
                    throw WorkspaceMediaDownloadError.invalidResponse("The preview temporary file is missing.")
                }
                try handle?.close()
                handle = nil
                finishLocked(.success(WorkspaceMediaDownload(
                    fileURL: fileURL,
                    mimeType: mimeType,
                    byteCount: actualBytes,
                    modificationDate: response.value(forHTTPHeaderField: "Last-Modified").flatMap(parseHTTPDate)
                )))
            } catch {
                finishLocked(.failure(error))
            }
        }
    }

    /// Called only while holding lock; resolves once and releases owned resources.
    private func finishLocked(_ result: Result<WorkspaceMediaDownload, any Error>) {
        guard let continuation else { return }
        self.continuation = nil
        try? handle?.close()
        handle = nil
        if case .failure = result, let fileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        fileURL = nil
        session?.invalidateAndCancel()
        session = nil
        continuation.resume(with: result)
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
