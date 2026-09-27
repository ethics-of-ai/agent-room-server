import Foundation

/// The backend's model catalog rules, checked before the app writes a local
/// copy. The backend's zod schema in `runner/modelCatalog.ts` stays the
/// authority: it ignores a copy that fails, so a rule missing here costs the
/// operator their edit rather than a broken turn. Keep the two in step.
enum ModelCatalogValidator {
    /// `codingAgentModelIdSchema`.
    private static let modelIDPattern = /^[A-Za-z0-9._:\[\]-]{1,120}$/
    /// `codingAgentReasoningEffortIdSchema`.
    private static let effortIDPattern = /^[A-Za-z0-9._:-]{1,80}$/
    /// The levels the Claude Code runner accepts.
    static let claudeCodeEffortIDs = ["low", "medium", "high", "xhigh"]

    static func issues(in runners: ModelCatalogDocument.Runners) -> [String] {
        var issues: [String] = []
        if let codex = runners.codex {
            issues += self.issues(in: codex)
        }
        if let claudeCode = runners.claudeCode {
            issues += self.issues(in: claudeCode)
        }
        if let cursor = runners.cursor {
            issues += self.issues(in: cursor)
        }
        if let deepseek = runners.deepseek {
            issues += rowIssues(deepseek.models, runner: .deepseek, max: 32)
        }
        // Two rows can fail the same way; list each message once.
        var seen = Set<String>()
        return issues.filter { seen.insert($0).inserted }
    }

    private static func issues(in catalog: ClaudeCodeModelCatalog) -> [String] {
        var issues = rowIssues(catalog.fallbackModels, runner: .claudeCode, max: 32)
        let vocabulary = catalog.reasoningEfforts.map(\.id)
        if vocabulary.contains(where: { !claudeCodeEffortIDs.contains($0) }) {
            issues.append("Claude Code: effort levels must be \(claudeCodeEffortIDs.joined(separator: ", ")).")
        }
        for model in catalog.fallbackModels where model.reasoningEfforts?.contains(where: { !vocabulary.contains($0) }) == true {
            issues.append("Claude Code: \(name(model)) uses an effort level the section does not define.")
        }
        return issues
    }

    private static func issues(in catalog: CodexModelCatalog) -> [String] {
        var issues = rowIssues(catalog.fallbackModels, runner: .codex, max: 64)
        if catalog.fallbackModels.filter(\.isDefault).count > 1 {
            issues.append("Codex: only one model can be the default.")
        }
        for model in catalog.fallbackModels {
            if model.reasoningEfforts.count > 12 {
                issues.append("Codex: \(name(model)) lists more than 12 effort levels.")
            }
            if model.reasoningEfforts.contains(where: { $0.wholeMatch(of: effortIDPattern) == nil }) {
                issues.append("Codex: \(name(model)) has an effort level with spaces or symbols.")
            }
            if let defaultEffort = model.defaultReasoningEffort, !model.reasoningEfforts.contains(defaultEffort) {
                issues.append("Codex: \(name(model))'s default effort is not one of its levels.")
            }
        }
        return issues
    }

    private static func issues(in catalog: CursorModelCatalog) -> [String] {
        var issues = rowIssues(catalog.fallbackModels, runner: .cursor, max: 64)
        if catalog.fallbackModels.filter(\.isDefault).count > 1 {
            issues.append("Cursor: only one model can be the default.")
        }
        for model in catalog.fallbackModels {
            if let tokens = model.contextWindowTokens, tokens <= 0 {
                issues.append("Cursor: \(name(model)) needs a positive context window.")
            }
            guard let depth = model.depth else { continue }
            if depth.values.isEmpty || depth.values.count > 12 {
                issues.append("Cursor: \(name(model)) needs 1 to 12 \(depth.parameter) values.")
            }
            if depth.values.contains(where: { $0.wholeMatch(of: effortIDPattern) == nil }) {
                issues.append("Cursor: \(name(model)) has a \(depth.parameter) value with spaces or symbols.")
            }
            if let defaultValue = depth.defaultValue, !depth.values.contains(defaultValue) {
                issues.append("Cursor: \(name(model))'s default \(depth.parameter) is not one of its values.")
            }
        }
        return issues
    }

    private static func rowIssues<Row: ModelCatalogRow>(_ rows: [Row], runner: ModelCatalogRunner, max: Int) -> [String] {
        var issues: [String] = []
        if rows.isEmpty {
            issues.append("\(runner.displayName): add at least one model.")
        }
        if rows.count > max {
            issues.append("\(runner.displayName): list at most \(max) models.")
        }
        var seen = Set<String>()
        for row in rows {
            let id = trimmed(row.id)
            if id.wholeMatch(of: modelIDPattern) == nil {
                issues.append("\(runner.displayName): \(name(row)) needs an ID of letters, digits, and . _ : [ ] - only.")
            } else if !seen.insert(id).inserted {
                issues.append("\(runner.displayName): the ID \(id) is listed twice.")
            }
            let label = trimmed(row.label)
            if label.isEmpty || label.count > 80 {
                issues.append("\(runner.displayName): \(name(row)) needs a name of 1 to 80 characters.")
            }
            if trimmed(row.description).count > 200 {
                issues.append("\(runner.displayName): \(name(row))'s description is longer than 200 characters.")
            }
        }
        return issues
    }

    private static func name(_ row: some ModelCatalogRow) -> String {
        let id = trimmed(row.id)
        return id.isEmpty ? "a model with no ID" : id
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
