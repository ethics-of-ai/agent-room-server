import Foundation

/// What a probe says about itself, per outcome.
///
/// Presentation, and legitimately per-runner: "Install Codex, then rerun this
/// check" and "Run claude login in Terminal" are different remedies for the same
/// shape of failure. Keeping them as descriptor data is what lets the status row
/// and the setup checklist render a runner they know nothing else about.
///
/// A template may carry a single `%@`, filled with the resolved path or the
/// underlying reason. One without a placeholder is used as written.
struct RunnerBootstrapProbeMessages: Equatable {
    /// The prerequisite was already in place.
    var satisfied: String
    /// Found and saved during this check.
    var detected: String
    /// Nothing found.
    var absent: String
    /// The probe could not answer.
    var failure: String
    /// Setup checklist line when nothing was found.
    var blockingAbsent: String
    /// Setup checklist line when the probe errored.
    var blockingFailed: String
    /// Setup checklist line before any check has run.
    var blockingUnchecked: String

    func filled(_ template: String, with value: String?) -> String {
        guard let value, template.contains("%@") else { return template }
        return String(format: template, value)
    }
}
