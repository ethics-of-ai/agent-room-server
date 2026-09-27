import XCTest
@testable import AgentRoomMac

final class ModelCatalogValidatorTests: XCTestCase {
    func testRejectsDuplicateAndMalformedIDs() {
        let runners = ModelCatalogDocument.Runners(deepseek: DeepSeekModelCatalog(models: [
            DeepSeekCatalogModel(id: "deepseek-flash", label: "A"),
            DeepSeekCatalogModel(id: "deepseek-flash", label: "B"),
            DeepSeekCatalogModel(id: "bad id", label: "C")
        ]))

        let issues = ModelCatalogValidator.issues(in: runners)

        XCTAssertTrue(issues.contains("DeepSeek: the ID deepseek-flash is listed twice."))
        XCTAssertTrue(issues.contains { $0.hasPrefix("DeepSeek: bad id needs an ID") })
    }

    func testRejectsAnEmptyList() {
        let issues = ModelCatalogValidator.issues(in: ModelCatalogDocument.Runners(deepseek: DeepSeekModelCatalog(models: [])))

        XCTAssertEqual(issues, ["DeepSeek: add at least one model."])
    }

    func testRejectsAClaudeCodeEffortTheRunnerRefuses() {
        let runners = ModelCatalogDocument.Runners(claudeCode: ClaudeCodeModelCatalog(
            reasoningEfforts: [ModelCatalogEffortLevel(id: "max", label: "Max")],
            fallbackModels: [ClaudeCodeCatalogModel(id: "opus", label: "Opus")]
        ))

        XCTAssertEqual(ModelCatalogValidator.issues(in: runners), ["Claude Code: effort levels must be low, medium, high, xhigh."])
    }

    func testRejectsTwoCursorDefaultsAndAStrayDepthDefault() {
        var first = CursorCatalogModel(id: "a", label: "A")
        first.isDefault = true
        first.depth = CursorCatalogModel.Depth(parameter: "effort", values: ["low"], defaultValue: "high")
        var second = CursorCatalogModel(id: "b", label: "B")
        second.isDefault = true

        let issues = ModelCatalogValidator.issues(in: ModelCatalogDocument.Runners(cursor: CursorModelCatalog(fallbackModels: [first, second])))

        XCTAssertTrue(issues.contains("Cursor: only one model can be the default."))
        XCTAssertTrue(issues.contains("Cursor: a's default effort is not one of its values."))
    }

    func testRejectsACodexDefaultEffortOutsideItsLevels() {
        var model = CodexCatalogModel(id: "gpt-6-sol", label: "GPT-6-Sol")
        model.reasoningEfforts = ["low", "high"]
        model.defaultReasoningEffort = "max"

        let issues = ModelCatalogValidator.issues(in: ModelCatalogDocument.Runners(codex: CodexModelCatalog(fallbackModels: [model])))

        XCTAssertEqual(issues, ["Codex: gpt-6-sol's default effort is not one of its levels."])
    }
}
