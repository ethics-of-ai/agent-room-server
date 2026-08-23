import Foundation

/// The outcome of one Mac bootstrap probe.
///
/// One shape for every probe kind, because the *authority* is what varies, not
/// the answer: an executable that is present and a `claude login` credential
/// that exists are both "the local prerequisite is satisfied". What a given
/// outcome *means* for setup — blocking or informational — is the probe's
/// `requirement`, not this enum's business.
enum RunnerBootstrapCheckStatus: Equatable {
    /// Already in place: a stored path that still resolves, a credential found.
    case satisfied(detail: String?)
    /// Found just now and saved, so it applies on the backend's next launch.
    case detected(detail: String)
    /// Nothing found. Blocking or merely informational depending on the probe.
    case absent
    /// The probe itself could not answer — a Keychain error, a failed save.
    case failed(message: String)

    /// Whether the local prerequisite is satisfied. Deliberately not "ready":
    /// whether the backend can actually spawn the runner is the other authority
    /// (`ready` on `GET /api/runners`), and only a running backend can say.
    var isSatisfied: Bool {
        switch self {
        case .satisfied, .detected:
            true
        case .absent, .failed:
            false
        }
    }

    /// The path a probe resolved, when it resolved one.
    var resolvedPath: String? {
        switch self {
        case .satisfied(let detail):
            detail
        case .detected(let detail):
            detail
        case .absent, .failed:
            nil
        }
    }
}
