import Foundation

/// One tier-3 launch value this app holds on a runner's behalf.
///
/// Phase 6 of `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md` makes the
/// bootstrap surface a **bundled, trusted contract** rather than typed fields
/// per runner. A slot names the environment variable its value is injected as,
/// and that name is the allowlist: `BackendLaunchConfiguration` iterates the
/// bundled descriptors, so a value stored for a runner this build does not
/// describe reaches no child process.
///
/// Nothing here may ever arrive from the backend. `GET /api/runners` and
/// `config/runners.json` carry a runner's identity and availability and
/// deliberately carry no environment name, executable path, or Keychain
/// account — a served descriptor that could name one would be remote code
/// execution by configuration.
struct RunnerBootstrapSlot: Equatable, Identifiable {
    /// The closed set of tier-3 primitives this app knows how to hold. A runner
    /// that needs a genuinely new one needs a scoped Swift change and its own
    /// safety review; a runner that reuses these needs only a descriptor.
    enum Kind: Equatable {
        /// An absolute path to a binary the backend spawns.
        case executablePath
        /// A comma-separated argument list for that binary.
        case arguments
        /// An absolute path to a **data** file the backend hands a runner, never
        /// one it executes. DeepSeek Harness needs it: its SDK runtime takes the
        /// Cordis composition to boot as a path and exits without one, so a
        /// build that could not hold this value could not set that runner up at
        /// all.
        ///
        /// It is a distinct kind rather than a reused `executablePath` because
        /// the two carry different authority — this one is not spawned — and
        /// rather than a reused `arguments` because it is one path, not a
        /// comma-separated list. The safety properties are the same as every
        /// other slot's: tier 3, bundled-descriptor-declared, Keychain-held,
        /// and never arriving from the backend.
        case filePath
        /// A provider credential the backend's child reads from its environment.
        ///
        /// The kind exists because *display* differs, not because storage does:
        /// every slot is already Keychain-held and already redacted out of
        /// exported diagnostics by `DiagnosticsTextRedactor`, which walks stored
        /// values precisely so an unknown one cannot leak. What a path may do
        /// and a secret may not is appear on screen, so this renders masked.
        ///
        /// AgentRoom held no provider credential before this: Codex brings its
        /// own config and Claude Code its `claude login`, so neither needed one.
        /// A runner whose key has nowhere to live *but* the environment did, and
        /// the alternative was an operator hand-editing a plaintext dotfile —
        /// strictly worse than the Keychain for the same secret.
        case secret
    }

    /// Stable within a runner: the key its value is stored under in the
    /// Keychain blob, so renaming one would orphan the operator's value.
    var id: String
    var kind: Kind
    var environmentName: String
    /// Field label in the Runner pane. Deliberately short: a grouped `Form`
    /// sizes **one** label column for every row in the pane, so one long label
    /// squeezes every other runner's field, not just its own.
    var title: String
    /// Placeholder shown while the field is empty. An **example value**, not a
    /// sentence: it occupies the field, so anything longer reads as content the
    /// operator has to clear, and it is gone the moment there is a value.
    /// Explanation belongs in `note`, guidance in the probe's messages.
    var prompt: String? = nil
    /// A standing caption under this field, for a consequence of *this* value
    /// that outlives filling it in. Section-level notes on the descriptor cover
    /// what belongs to no single slot.
    var note: RunnerBootstrapNote? = nil
}
