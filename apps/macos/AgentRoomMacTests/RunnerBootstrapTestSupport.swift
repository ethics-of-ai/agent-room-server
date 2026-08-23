import Foundation
import Security
@testable import AgentRoomMac

/// Probers pointed at the test's own filesystem instead of the operator's.
///
/// The bundled descriptors search real directories (`/opt/homebrew/bin`,
/// `~/.local/bin`), so a test that used them would pass or fail depending on
/// what the developer happens to have installed. Overriding the search keeps the
/// descriptor under test and the machine out of it.
enum RunnerBootstrapTestSupport {
    static func prober(
        codexCandidates: [URL] = [],
        claudeCandidates: [URL] = [],
        deepseekCandidates: [URL] = [],
        keychainStatus: OSStatus = errSecItemNotFound
    ) -> RunnerBootstrapProber {
        RunnerBootstrapProber(
            environment: [:],
            keychain: KeychainPresenceProbe(lookup: { _ in keychainStatus }),
            searchOverrides: [
                RunnerBootstrapProber.overrideKey(runnerKind: "codex", probeID: "executable"):
                    search(binaryName: "codex", candidates: codexCandidates),
                RunnerBootstrapProber.overrideKey(runnerKind: "claude_code", probeID: "executable"):
                    search(binaryName: "claude", candidates: claudeCandidates),
                RunnerBootstrapProber.overrideKey(runnerKind: "deepseek", probeID: "executable"):
                    search(binaryName: "dsh-jsonrpc-agent", candidates: deepseekCandidates)
            ]
        )
    }

    /// The bundled DeepSeek source-checkout contract with its interpreter search
    /// pointed at the test's own fake `node`, so the walk under test does not
    /// depend on what the developer has installed.
    static func sourceCheckout(interpreterCandidates: [URL]) -> RunnerBootstrapSourceCheckout {
        guard var contract = descriptor("deepseek").sourceCheckout else {
            preconditionFailure("the bundled DeepSeek descriptor is expected to declare a source checkout")
        }
        contract.interpreterSearch = search(binaryName: "node", candidates: interpreterCandidates)
        return contract
    }

    static func search(binaryName: String, candidates: [URL]) -> ExecutableSearch {
        ExecutableSearch(
            binaryName: binaryName,
            searchPathFallbacks: [],
            absoluteCandidates: candidates.map(\.path)
        )
    }

    static func descriptor(_ runnerKind: String) -> RunnerBootstrapDescriptor {
        guard let descriptor = RunnerBootstrapCatalog.descriptor(for: runnerKind) else {
            preconditionFailure("the bundled catalog is expected to describe \(runnerKind)")
        }
        return descriptor
    }

    static func makeExecutableFile(at url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try "#!/bin/sh\nexit 0\n".write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }
}
