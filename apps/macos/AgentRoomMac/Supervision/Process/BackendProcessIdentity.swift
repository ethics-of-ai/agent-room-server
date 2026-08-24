import Foundation

/// Enough to recognise one specific backend sidecar across app launches.
///
/// A pid alone is not enough: pids are recycled, and signalling a recycled one
/// would reach an unrelated process. The kernel's process start time makes the
/// pair unique for the life of the machine, and the executable path is what
/// says the process is a backend this app knows how to launch rather than
/// something else that inherited the number.
///
/// `port` travels with it because the record's whole purpose is answering "is
/// the backend answering on the port I am configured for mine?", and an
/// operator who changed the port has a record that no longer describes their
/// setup.
struct BackendProcessIdentity: Codable, Equatable, Sendable {
    var pid: pid_t
    var startTimeSeconds: Int64
    var startTimeMicroseconds: Int32
    var executablePath: String
    var port: Int
}
