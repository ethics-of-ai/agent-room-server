import XCTest
@testable import AgentRoomClient

final class BackendCompatibilityTests: XCTestCase {
    private let client = AgentRoomClientCompatibility(
        platform: .visionos,
        clientVersion: "0.2.0",
        clientBuild: "2",
        clientAPIVersion: "2026-05-12",
        minimumSupportedBackendAPIVersion: "2026-05-12"
    )

    func testSemanticVersionUsesNumericAndPrereleaseOrdering() throws {
        let zeroNine = try version("0.9.0")
        let zeroTen = try version("0.10.0")
        let prerelease = try version("1.0.0-rc.2")
        let laterPrerelease = try version("1.0.0-rc.10")
        let release = try version("1.0.0")

        XCTAssertLessThan(zeroNine, zeroTen)
        XCTAssertLessThan(prerelease, laterPrerelease)
        XCTAssertLessThan(laterPrerelease, release)
        XCTAssertEqual(try version("1.0.0+build.1"), try version("1.0.0+build.2"))
    }

    func testSemanticVersionRejectsInvalidValues() {
        for value in ["1", "1.0", "01.0.0", "1.0.0-01", "1.0.0-", "1.0.0+", " 1.0.0"] {
            XCTAssertNil(SemanticVersion(rawValue: value), value)
        }
    }

    func testAPIRevisionValidatesCalendarDatesAndSortsChronologically() throws {
        let earlier = try revision("2026-05-12")
        let later = try revision("2026-12-01")

        XCTAssertLessThan(earlier, later)
        XCTAssertNotNil(APIRevision(rawValue: "2024-02-29"))
        XCTAssertNil(APIRevision(rawValue: "2025-02-29"))
        XCTAssertNil(APIRevision(rawValue: "2026-13-01"))
        XCTAssertNil(APIRevision(rawValue: "2026-5-12"))
    }

    func testMissingReleaseMetadataIsUnverifiedButNotKnownIncompatible() {
        let status = BackendCompatibilityEvaluator.evaluate(release: nil, client: client)

        XCTAssertEqual(status, .unverifiedLegacyBackend)
        XCTAssertFalse(status.isKnownIncompatible)
    }

    func testEqualCompatibilityFloorsAreCompatible() {
        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(release: release(), client: client),
            .compatible
        )
    }

    func testBackendCanRequireANewerClientProductVersion() {
        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(
                release: release(minimumVisionOSVersion: "0.3.0"),
                client: client
            ),
            .clientUpdateRequired
        )
    }

    func testBackendCanRequireANewerClientAPI() {
        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(
                release: release(minimumClientAPI: "2026-06-01"),
                client: client
            ),
            .clientUpdateRequired
        )
    }

    func testClientCanRequireANewerBackendAPI() {
        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(
                release: release(backendAPI: "2026-04-30"),
                client: client
            ),
            .backendUpdateRequired
        )
    }

    func testInvalidReleaseOrClientMetadataCannotBeReportedAsCompatible() {
        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(
                release: release(backendVersion: "next"),
                client: client
            ),
            .invalidMetadata
        )

        var invalidClient = client
        invalidClient.clientAPIVersion = "May 12"
        XCTAssertEqual(
            BackendCompatibilityEvaluator.evaluate(release: release(), client: invalidClient),
            .invalidMetadata
        )
    }

    private func release(
        backendVersion: String = "0.3.1",
        backendAPI: String = "2026-05-12",
        minimumClientAPI: String = "2026-05-12",
        minimumVisionOSVersion: String = "0.1.0"
    ) -> BackendReleaseCompatibility {
        BackendReleaseCompatibility(
            backendVersion: backendVersion,
            apiVersion: backendAPI,
            minimumSupportedClientApiVersion: minimumClientAPI,
            compatibleClients: .init(
                macos: .init(minimumVersion: "0.1.0"),
                visionos: .init(minimumVersion: minimumVisionOSVersion)
            )
        )
    }

    private func version(_ value: String) throws -> SemanticVersion {
        try XCTUnwrap(SemanticVersion(rawValue: value))
    }

    private func revision(_ value: String) throws -> APIRevision {
        try XCTUnwrap(APIRevision(rawValue: value))
    }
}
