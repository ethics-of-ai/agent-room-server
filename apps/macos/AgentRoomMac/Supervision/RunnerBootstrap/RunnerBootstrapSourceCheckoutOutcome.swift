import Foundation

/// The result of walking a source checkout, as the pane shows it.
///
/// It carries its own message rather than deriving one from
/// `RunnerBootstrapProbeMessages`, because those are a fixed vocabulary per
/// probe and this answer is composed from what the walk actually found — how
/// many fields were filled, which composition was taken, and what the operator
/// still has to supply.
struct RunnerBootstrapSourceCheckoutOutcome: Equatable {
    var status: RunnerBootstrapCheckStatus
    var message: String
}
