import Foundation

protocol BackendSecretStore {
    func loadSecrets() throws -> BackendSecretValues
    func saveSecrets(_ values: BackendSecretValues) throws
}
