import Foundation

/// Lock-guarded staging buffer between the sidecar pipes' readability handlers
/// (which fire on FileHandle's internal queues) and the main-actor supervisor.
/// Chunks are split into lines with a per-stream partial-line carry (a pipe
/// chunk can end mid-line), kept in arrival order across stdout/stderr, and
/// drained to the UI in one batched flush — instead of one main-actor hop per
/// pipe chunk and one O(n) array insert per line.
final class BackendProcessLogBuffer: @unchecked Sendable {
    struct Entry {
        let timestamp: Date
        let stream: BackendProcessStream
        let message: String
    }

    private let lock = NSLock()
    private var entries: [Entry] = []
    private var partialLineByStream: [BackendProcessStream: String] = [:]

    /// Append a raw pipe chunk. Returns true when this append transitioned the
    /// buffer from empty to non-empty, i.e. the caller should schedule a flush;
    /// chunks arriving before that flush ride along in the same batch.
    func append(chunk: String, stream: BackendProcessStream, at timestamp: Date = Date()) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let wasEmpty = entries.isEmpty
        var text = (partialLineByStream[stream] ?? "") + chunk
        while let newlineIndex = text.firstIndex(where: { $0.isNewline }) {
            let line = String(text[..<newlineIndex])
            text = String(text[text.index(after: newlineIndex)...])
            if !line.isEmpty {
                entries.append(Entry(timestamp: timestamp, stream: stream, message: line))
            }
        }
        partialLineByStream[stream] = text
        return wasEmpty && !entries.isEmpty
    }

    /// Emit any held partial lines as final entries (call at process exit so a
    /// trailing unterminated line is not lost).
    func flushPartialLines(at timestamp: Date = Date()) {
        lock.lock()
        defer { lock.unlock() }
        for (stream, partial) in partialLineByStream where !partial.isEmpty {
            entries.append(Entry(timestamp: timestamp, stream: stream, message: partial))
        }
        partialLineByStream = [:]
    }

    func drain() -> [Entry] {
        lock.lock()
        defer { lock.unlock() }
        let drained = entries
        entries = []
        return drained
    }
}
