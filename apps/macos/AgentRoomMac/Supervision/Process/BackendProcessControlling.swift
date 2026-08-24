import Foundation

/// The small lifecycle surface shared by a child `Process` and an adopted
/// sidecar. Keeping it here lets the supervisor use one escalation policy for
/// both without pretending their output or termination metadata are alike.
protocol BackendProcessControlling {
    var isRunning: Bool { get }
    func interrupt()
    func terminate()
}

extension Process: BackendProcessControlling {}
