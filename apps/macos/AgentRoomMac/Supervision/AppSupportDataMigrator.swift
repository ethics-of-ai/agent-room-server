import Foundation

struct AppSupportMigrationResult: Equatable {
    var schemaVersion: Int
    var migratedFromSchemaVersion: Int?
}

enum AppSupportDataMigrationError: LocalizedError, Equatable {
    case invalidSchemaMarker
    case futureSchemaVersion(Int)

    var errorDescription: String? {
        switch self {
        case .invalidSchemaMarker:
            return "App support schema marker is invalid."
        case .futureSchemaVersion(let version):
            return "App support schema version \(version) is newer than this app supports."
        }
    }
}

struct AppSupportDataMigrator {
    static let currentSchemaVersion = 1

    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    func migrateIfNeeded(settings: AppSettings) throws -> AppSupportMigrationResult {
        try createDirectory(atPath: settings.agentRoomHomePath)
        try createDirectory(atPath: "\(settings.agentRoomHomePath)/config")
        try createDirectory(atPath: settings.workspacePath)
        try createDirectory(atPath: settings.statePath)

        let markerURL = schemaMarkerURL(for: settings)
        let existing = try loadMarker(at: markerURL)
        if let existing {
            guard existing.schemaVersion <= Self.currentSchemaVersion else {
                throw AppSupportDataMigrationError.futureSchemaVersion(existing.schemaVersion)
            }
            if existing.schemaVersion == Self.currentSchemaVersion {
                return AppSupportMigrationResult(schemaVersion: existing.schemaVersion, migratedFromSchemaVersion: nil)
            }
        }

        try writeMarker(to: markerURL, schemaVersion: Self.currentSchemaVersion)
        return AppSupportMigrationResult(
            schemaVersion: Self.currentSchemaVersion,
            migratedFromSchemaVersion: existing?.schemaVersion
        )
    }

    private func createDirectory(atPath path: String) throws {
        try fileManager.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    private func schemaMarkerURL(for settings: AppSettings) -> URL {
        URL(fileURLWithPath: settings.agentRoomHomePath, isDirectory: true)
            .appendingPathComponent("config", isDirectory: true)
            .appendingPathComponent("app-support-schema.json")
    }

    private func loadMarker(at url: URL) throws -> AppSupportSchemaMarker? {
        guard fileManager.fileExists(atPath: url.path) else {
            return nil
        }
        let data = try Data(contentsOf: url)
        do {
            return try JSONDecoder().decode(AppSupportSchemaMarker.self, from: data)
        } catch {
            throw AppSupportDataMigrationError.invalidSchemaMarker
        }
    }

    private func writeMarker(to url: URL, schemaVersion: Int) throws {
        let marker = AppSupportSchemaMarker(schemaVersion: schemaVersion, updatedAt: ISO8601DateFormatter().string(from: Date()))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(marker)
        try data.write(to: url, options: .atomic)
    }
}

private struct AppSupportSchemaMarker: Codable, Equatable {
    var schemaVersion: Int
    var updatedAt: String
}
