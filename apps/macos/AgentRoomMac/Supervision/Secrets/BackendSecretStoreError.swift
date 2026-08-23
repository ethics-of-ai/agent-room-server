import Foundation
import Security

enum BackendSecretStoreError: LocalizedError {
    case unexpectedKeychainData
    case keychainFailure(OSStatus)

    var errorDescription: String? {
        switch self {
        case .unexpectedKeychainData:
            return "The Keychain returned an unreadable AgentRoom secret."
        case .keychainFailure(let status):
            return "The Keychain operation failed with status \(status)."
        }
    }
}
