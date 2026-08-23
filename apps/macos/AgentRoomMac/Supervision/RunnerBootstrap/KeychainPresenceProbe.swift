import Foundation
import Security

/// Asks the login Keychain whether a generic-password item exists, and nothing
/// else.
///
/// The probe is **presence-only**: it requests no item data and never decrypts,
/// returns, or logs the secret, so it neither prompts for Keychain access nor
/// exposes the credential. That posture is documented in
/// `docs/safety/TRUST_AND_SAFETY.md` and must not be widened into a read — the
/// question is "is the operator signed in", never "with what".
struct KeychainPresenceProbe {
    private let lookup: (_ service: String) -> OSStatus

    init(lookup: @escaping (_ service: String) -> OSStatus = KeychainPresenceProbe.keychainLookup) {
        self.lookup = lookup
    }

    enum Presence: Equatable {
        case present
        case absent
        /// The lookup itself failed; the message names the status, not the item.
        case failed(reason: String)
    }

    func presence(ofService service: String) -> Presence {
        switch lookup(service) {
        case errSecSuccess:
            .present
        case errSecItemNotFound:
            .absent
        case let code:
            .failed(reason: "Keychain status \(code)")
        }
    }

    private static func keychainLookup(service: String) -> OSStatus {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        return SecItemCopyMatching(query as CFDictionary, nil)
    }
}
