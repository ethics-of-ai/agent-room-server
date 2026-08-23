import Foundation

/// Result of an operator catalog action (Import / Reload / Reset) shown in the
/// macOS Languages settings pane. Mirrors the model/styling split used by
/// `RunnerBootstrapCheckStatus` — message here, `StatusStyle` in the Views layer.
enum EditorCatalogActionStatus: Equatable {
    case working(String)
    case success(String)
    case failure(String)

    var message: String {
        switch self {
        case .working(let message), .success(let message), .failure(let message):
            return message
        }
    }
}
