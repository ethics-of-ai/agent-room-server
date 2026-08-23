import Foundation

struct DiagnosticsTextRedactor {
    private let values: [String]

    /// Redacts every launch secret this app holds: the bearer token and **every
    /// stored slot value**, not a hand-listed set of fields.
    ///
    /// It walks the stored values rather than the descriptor allowlist on
    /// purpose. Injection is an allowlist because an unknown value must not
    /// reach a child; redaction is the opposite question — an unknown value must
    /// still not reach an exported diagnostic — so here breadth is the safe
    /// direction.
    init(secrets: BackendSecretValues) {
        self.values = ([secrets.authToken] + secrets.runnerSlots.values.flatMap(\.values))
            .flatMap(Self.redactionCandidates)
            .sorted { $0.count > $1.count }
    }

    func redact(_ input: String) -> String {
        values.reduce(input) { redacted, value in
            redacted.replacingOccurrences(of: value, with: "<redacted>")
        }
    }

    private static func redactionCandidates(_ value: String?) -> [String] {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), trimmed.count >= 4 else {
            return []
        }
        var candidates = [trimmed]
        candidates.append(contentsOf: trimmed.split(whereSeparator: \.isWhitespace).map(String.init).filter { $0.count >= 4 })
        return Array(NSOrderedSet(array: candidates)) as? [String] ?? candidates
    }
}
