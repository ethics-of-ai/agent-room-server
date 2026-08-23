import Foundation
import Security

struct KeychainBackendSecretStore: BackendSecretStore {
    private let service: String
    private let consolidatedAccount = "agentroom-secrets-v1"

    // Consolidating all credentials into a single Keychain item means macOS
    // prompts the user (or asks for Always Allow) at most once per save and
    // once per launch, instead of nine times. For ad-hoc-signed local builds
    // each install has a fresh code signature, so the prior multi-item layout
    // produced one prompt per credential on every reinstall.

    init(service: String = "dev.agentroom.AgentRoomMac.backend") {
        self.service = service
    }

    func loadSecrets() throws -> BackendSecretValues {
        if let data = try readConsolidatedBlob() {
            do {
                return try JSONDecoder().decode(BackendSecretValues.self, from: data)
            } catch {
                throw BackendSecretStoreError.unexpectedKeychainData
            }
        }
        let legacyValues = try loadLegacySecrets()
        if legacyValues != .empty {
            try writeConsolidatedBlob(JSONEncoder().encode(legacyValues))
        }
        return legacyValues
    }

    func saveSecrets(_ values: BackendSecretValues) throws {
        let data = try JSONEncoder().encode(values)
        try writeConsolidatedBlob(data)
    }

    private func readConsolidatedBlob() throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: consolidatedAccount,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw BackendSecretStoreError.keychainFailure(status)
        }
        guard let data = result as? Data else {
            throw BackendSecretStoreError.unexpectedKeychainData
        }
        return data
    }

    private func writeConsolidatedBlob(_ data: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: consolidatedAccount
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var item = query
            item.merge(attributes) { _, new in new }
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw BackendSecretStoreError.keychainFailure(addStatus)
            }
            return
        }
        guard updateStatus == errSecSuccess else {
            throw BackendSecretStoreError.keychainFailure(updateStatus)
        }
    }

    /// The pre-consolidation layout: one Keychain item per environment variable.
    ///
    /// A frozen historical mapping, which is why it names slots directly rather
    /// than walking the bundled descriptors — it describes what an *older* build
    /// wrote, so it must not change when a descriptor does.
    private static let legacyAccountSlots: [(account: String, runnerKind: String, slotID: String)] = [
        ("CODEX_EXECUTABLE", "codex", "executable"),
        ("CODEX_ARGS", "codex", "arguments")
    ]

    private func loadLegacySecrets() throws -> BackendSecretValues {
        var values = BackendSecretValues.empty
        values.authToken = try readLegacy(account: "AUTH_TOKEN")
        for slot in Self.legacyAccountSlots {
            values.setSlotValue(try readLegacy(account: slot.account), runnerKind: slot.runnerKind, slotID: slot.slotID)
        }
        values.legacyCodexReasoningEffort = try readLegacy(account: "CODEX_REASONING_EFFORT")
        return values
    }

    private func readLegacy(account: String) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecReturnData as String: true
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            // Legacy entries owned by a different ad-hoc signature may refuse
            // access. Surface as missing rather than failing the whole load.
            return nil
        }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }
}
