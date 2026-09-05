import Foundation

/// The operator-facing meaning of the backend's safe service projection.
/// `ready == nil` is deliberately a neutral state: the registry read never
/// starts a server, so there may simply be no editor observation yet.
enum LanguageServiceOperatorState: Equatable {
    case disabled
    case notConfigured
    case ready
    case failed
    case notChecked

    init(service: LanguageServiceDescriptor) {
        if !service.enabled {
            self = .disabled
        } else if !service.configured {
            self = .notConfigured
        } else {
            self = switch service.ready {
            case true: .ready
            case false: .failed
            case nil: .notChecked
            }
        }
    }

    var message: String {
        switch self {
        case .disabled:
            "Disabled by the backend setting. Enable language services, then restart the backend."
        case .notConfigured:
            "Enabled, but no approved local executable is configured for this service."
        case .ready:
            "Ready. The backend initialized this service successfully."
        case .failed:
            "The last initialization attempt failed. Check backend diagnostics."
        case .notChecked:
            "Not checked yet. Open a supported file to initialize this service."
        }
    }
}
