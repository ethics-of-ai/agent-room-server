import Foundation

extension String {
    /// Renders a backend ISO 8601 timestamp (e.g. `2026-06-17T16:50:03.123Z`)
    /// as a concise, locale-aware absolute date and time. Falls back to the raw
    /// string when it cannot be parsed, so a value is never silently dropped.
    var threadTimestampDisplay: String {
        if let date = try? Date(self, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        if let date = try? Date(self, strategy: .iso8601) {
            return date.formatted(date: .abbreviated, time: .shortened)
        }
        return self
    }
}
