import Foundation

/// Everything this app must know locally to *start* a runner and to say whether
/// the operator's machine is ready for it.
///
/// The counterpart to the backend's `RunnerDescriptor`, and deliberately a
/// separate contract: that one is safe/public and crosses the wire, this one
/// names environment variables and Keychain accounts and never leaves the Mac.
/// The two meet only at `runnerKind`.
struct RunnerBootstrapDescriptor: Equatable, Identifiable {
    /// The backend's runner id. Data — the key this app files a value under —
    /// never a branch: nothing here switches on which runner it is.
    var runnerKind: String
    var slots: [RunnerBootstrapSlot]
    var probes: [RunnerBootstrapProbe]
    /// How to fill this runner's slots from a source checkout, when it has a
    /// layout worth walking. Absent for a runner installed as a CLI, where
    /// there is nothing to walk and the probe's search is the whole answer.
    var sourceCheckout: RunnerBootstrapSourceCheckout? = nil
    /// Standing captions for this runner's bootstrap controls, rendered in
    /// order beneath them.
    ///
    /// Deliberately not `RunnerBootstrapSlot.prompt`, which is a placeholder and
    /// therefore disappears exactly when a value exists — the wrong behavior for
    /// a consequence that outlives the field being filled. Deliberately not
    /// per-slot either: what a runner needs said is not always about a value it
    /// holds, and the sharpest case is a value it deliberately does *not* hold.
    ///
    /// Presentation only, and bundled like the rest of this contract: a note is
    /// a sentence this build shipped, never something the backend can supply.
    var notes: [RunnerBootstrapNote] = []

    var id: String { runnerKind }

    func slot(_ slotID: String) -> RunnerBootstrapSlot? {
        slots.first { $0.id == slotID }
    }

    func probe(_ probeID: String) -> RunnerBootstrapProbe? {
        probes.first { $0.id == probeID }
    }
}

/// One standing caption under a runner's bootstrap controls.
///
/// Scoped to what this app can stand behind: its own contract (what a value is
/// used for, what it decides, what is deliberately absent) rather than how to
/// obtain the operator's runtime. Install recipes for a third-party developer
/// preview age badly and cannot be corrected without shipping the app again,
/// which is why they stay in `.env.example` and `docs/clients/MACOS.md`.
struct RunnerBootstrapNote: Equatable, Identifiable {
    var id: String
    var text: String
    var systemImage: String
}
