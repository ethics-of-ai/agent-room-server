import XCTest
@testable import AgentRoomMac

final class EditorCatalogImporterTests: XCTestCase {
    private let fileManager = FileManager.default

    private func makeTempDir() -> URL {
        let url = fileManager.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func write(_ contents: String, to url: URL) throws {
        try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: url)
    }

    func testImportCopiesDataFilesAndExcludesExecutableCode() throws {
        let source = makeTempDir()
        try write("{\"grammars\":[]}", to: source.appendingPathComponent("EditorGrammars.json"))
        try write("{}", to: source.appendingPathComponent("grammars/swift.tmLanguage.json"))
        try write("wasm-bytes", to: source.appendingPathComponent("vs-textmate/onig.wasm"))
        // The TextMate engine JS must never be imported.
        try write("evil()", to: source.appendingPathComponent("vs-textmate/vscode-textmate.js"))

        let destination = makeTempDir().appendingPathComponent("catalog-assets").path
        let summary = try EditorCatalogImporter().importCatalog(from: source, into: destination)

        XCTAssertEqual(summary.fileCount, 3)
        let dest = URL(fileURLWithPath: destination)
        XCTAssertTrue(fileManager.fileExists(atPath: dest.appendingPathComponent("EditorGrammars.json").path))
        XCTAssertTrue(fileManager.fileExists(atPath: dest.appendingPathComponent("grammars/swift.tmLanguage.json").path))
        XCTAssertTrue(fileManager.fileExists(atPath: dest.appendingPathComponent("vs-textmate/onig.wasm").path))
        XCTAssertFalse(fileManager.fileExists(atPath: dest.appendingPathComponent("vs-textmate/vscode-textmate.js").path))
    }

    func testImportRejectsFolderWithoutIndex() throws {
        let source = makeTempDir()
        try write("{}", to: source.appendingPathComponent("grammars/swift.tmLanguage.json"))
        let destination = makeTempDir().appendingPathComponent("catalog-assets").path

        XCTAssertThrowsError(try EditorCatalogImporter().importCatalog(from: source, into: destination)) { error in
            XCTAssertEqual(error as? EditorCatalogImporter.ImportError, .missingIndex)
        }
    }

    func testImportCleanReplacesStaleFiles() throws {
        let source = makeTempDir()
        try write("{\"grammars\":[]}", to: source.appendingPathComponent("EditorGrammars.json"))

        let destination = makeTempDir().appendingPathComponent("catalog-assets").path
        // Pre-seed a stale grammar the source no longer has; the clean replace must drop it.
        try write("stale", to: URL(fileURLWithPath: destination).appendingPathComponent("grammars/old.tmLanguage.json"))

        _ = try EditorCatalogImporter().importCatalog(from: source, into: destination)

        let dest = URL(fileURLWithPath: destination)
        XCTAssertTrue(fileManager.fileExists(atPath: dest.appendingPathComponent("EditorGrammars.json").path))
        XCTAssertFalse(fileManager.fileExists(atPath: dest.appendingPathComponent("grammars/old.tmLanguage.json").path))
    }

    func testResetEmptiesTheOverrideDirectory() throws {
        let destination = makeTempDir().appendingPathComponent("catalog-assets").path
        try write("{}", to: URL(fileURLWithPath: destination).appendingPathComponent("EditorGrammars.json"))

        try EditorCatalogImporter().reset(destination)

        let dest = URL(fileURLWithPath: destination)
        XCTAssertTrue(fileManager.fileExists(atPath: dest.path))
        XCTAssertFalse(fileManager.fileExists(atPath: dest.appendingPathComponent("EditorGrammars.json").path))
    }
}
