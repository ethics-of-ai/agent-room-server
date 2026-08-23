import XCTest
@testable import AgentRoomMac

/// What the Mac shows for a setting it cannot address.
///
/// Phase 1 of `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md`. These rows
/// are the only place on this machine where a trust posture belonging to a
/// runner this build does not know becomes visible, so what they say is worth
/// asserting rather than eyeballing.
final class PreservedManagedSettingRowTests: XCTestCase {
    private let runners = RunnerCatalog(descriptors: [
        RunnerDescriptor(runnerKind: "acp_gemini", displayName: "Gemini CLI")
    ])

    func testARegisteredRunnersSettingIsNamedByItsDisplayName() throws {
        var preserved = PreservedManagedSettings()
        preserved.runners["acp_gemini"] = ["permissionPolicy": .string("auto_allow")]

        let rows = PreservedManagedSettingRow.rows(from: preserved, runners: runners)

        XCTAssertEqual(rows.count, 1)
        let row = try XCTUnwrap(rows.first)
        XCTAssertEqual(row.address, "runners.acp_gemini.permissionPolicy")
        XCTAssertEqual(row.title, "Gemini CLI permission policy")
        XCTAssertEqual(row.value, "auto_allow")
    }

    /// A runner id no catalog describes renders as itself. Resolving it to a
    /// known runner would put a wrong name on a trust setting, which is worse
    /// than an ugly one.
    func testAnUnknownRunnerIsNamedAsItself() throws {
        var preserved = PreservedManagedSettings()
        preserved.runners["acp_demo"] = ["permissionPolicy": .string("reject")]

        let rows = PreservedManagedSettingRow.rows(from: preserved, runners: runners)

        XCTAssertEqual(try XCTUnwrap(rows.first).title, "Acp Demo permission policy")
    }

    func testValuesRenderInTheirOwnShape() {
        var preserved = PreservedManagedSettings()
        preserved.global = [
            "futureFlag": .bool(true),
            "futureCap": .number(12),
            "futureRatio": .number(1.75),
            "futureHugeNumber": .number(1e100),
            "futureName": .string("something"),
            "futureShape": .object(["nested": .bool(false)])
        ]

        let values = Dictionary(
            uniqueKeysWithValues: PreservedManagedSettingRow.rows(from: preserved, runners: runners)
                .map { ($0.title, $0.value) }
        )

        XCTAssertEqual(values["Future flag"], "On")
        XCTAssertEqual(values["Future cap"], "12")
        XCTAssertEqual(values["Future ratio"], "1.75")
        XCTAssertEqual(values["Future huge number"], "1e+100")
        XCTAssertEqual(values["Future name"], "something")
        // Managed settings are JSON scalars, so this is a shape only a future
        // release would write — reported as unshowable rather than guessed at.
        XCTAssertEqual(values["Future shape"], "A structured value")
    }

    /// Dictionary order is not stable, and a list that reshuffles between reads
    /// is unreadable.
    func testRowsAreSortedByTitle() {
        var preserved = PreservedManagedSettings()
        preserved.global = ["zulu": .string("z"), "alpha": .string("a")]
        preserved.runners["acp_gemini"] = ["permissionPolicy": .string("reject")]

        for _ in 0..<8 {
            XCTAssertEqual(
                PreservedManagedSettingRow.rows(from: preserved, runners: runners).map(\.title),
                ["Alpha", "Gemini CLI permission policy", "Zulu"]
            )
        }
    }

    func testNothingPreservedMeansNoRows() {
        XCTAssertTrue(
            PreservedManagedSettingRow.rows(from: PreservedManagedSettings(), runners: runners).isEmpty
        )
    }
}
