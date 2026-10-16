import AppKit

/// Opens a script in Terminal.app as a `.command` file.
///
/// A file handed to Terminal needs no Automation (Apple Events) consent, which
/// `tell application "Terminal" to do script` would. The file lives in this
/// app's temporary directory, is readable only by the user, and removes itself
/// when it runs.
enum TerminalCommandLauncher {
    static let terminalURL = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")

    static func open(script: String, named name: String) async throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(name)-\(UUID().uuidString).command")
        try Data(script.utf8).write(to: url, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        _ = try await NSWorkspace.shared.open([url], withApplicationAt: terminalURL, configuration: configuration)
    }

    /// `open`, reporting a failure in the operator's terms instead of throwing.
    /// Returns `nil` once Terminal has the script.
    static func openReportingFailure(script: String, named name: String) async -> String? {
        do {
            try await open(script: script, named: name)
            return nil
        } catch {
            return "Could not open Terminal: \(error.localizedDescription)"
        }
    }
}
