import Foundation

/// The bundled tier-3 bootstrap descriptors.
///
/// This table is the trusted half of Phase 6 of
/// `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`, and it is **bundled on
/// purpose**. The backend's `/api/runners` says which runners exist; it may not
/// say what starting one requires, because an environment name or an executable
/// slot arriving over the network would make configuration into code execution.
/// So the two lists can legitimately disagree: a runner the backend registers
/// but this build has no bootstrap for simply contributes no local check, which
/// is the honest answer rather than another runner's.
enum RunnerBootstrapCatalog {
    static let builtIn: [RunnerBootstrapDescriptor] = [codex, claudeCode, deepseek]

    static func descriptor(for runnerKind: String) -> RunnerBootstrapDescriptor? {
        builtIn.first { $0.runnerKind == runnerKind }
    }

    /// Every environment variable the bundled descriptors declare. This is the
    /// allowlist the launch configuration injects and strips: a stored value for
    /// an unlisted runner or slot reaches no child process.
    static var environmentNames: [String] {
        builtIn.flatMap { descriptor in descriptor.slots.map(\.environmentName) }
    }

    private static let codex = RunnerBootstrapDescriptor(
        runnerKind: "codex",
        slots: [
            RunnerBootstrapSlot(
                id: "executable",
                kind: .executablePath,
                environmentName: "CODEX_EXECUTABLE",
                title: "Executable"
            ),
            RunnerBootstrapSlot(
                id: "arguments",
                kind: .arguments,
                environmentName: "CODEX_ARGS",
                title: "Arguments",
                prompt: "comma-separated; empty starts app-server"
            )
        ],
        probes: [
            RunnerBootstrapProbe(
                id: "executable",
                kind: .executablePath(
                    slotID: "executable",
                    search: ExecutableSearch(
                        binaryName: "codex",
                        searchPathFallbacks: [
                            "/opt/homebrew/bin",
                            "/usr/local/bin",
                            "~/.local/bin",
                            "~/.npm-global/bin",
                            "~/.bun/bin",
                            "~/bin",
                            "/usr/bin",
                            "/bin"
                        ],
                        absoluteCandidates: [
                            // Since the Codex desktop integration moved into
                            // ChatGPT, the bundled executable ships from
                            // ChatGPT.app. The standalone bundle path stays as a
                            // compatibility fallback for older installations.
                            "/Applications/ChatGPT.app/Contents/Resources/codex",
                            "~/Applications/ChatGPT.app/Contents/Resources/codex",
                            "/Applications/Codex.app/Contents/Resources/codex",
                            "~/Applications/Codex.app/Contents/Resources/codex",
                            "/opt/homebrew/bin/codex",
                            "/usr/local/bin/codex"
                        ]
                    )
                ),
                requirement: .required,
                actionTitle: "Check",
                actionSymbol: "magnifyingglass",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "Codex is configured at %@.",
                    detected: "Saved Codex at %@. Start or restart the backend to apply it.",
                    absent: "Codex CLI was not found. Install Codex, then rerun this check.",
                    failure: "Could not save Codex executable path: %@",
                    blockingAbsent: "Install Codex CLI, then rerun the check.",
                    blockingFailed: "Resolve the Codex executable check error.",
                    blockingUnchecked: "Set or check the Codex executable path."
                )
            )
        ]
    )

    private static let claudeCode = RunnerBootstrapDescriptor(
        runnerKind: "claude_code",
        slots: [
            RunnerBootstrapSlot(
                id: "executable",
                kind: .executablePath,
                environmentName: "CLAUDE_CODE_EXECUTABLE",
                title: "CLI path"
            )
        ],
        probes: [
            RunnerBootstrapProbe(
                id: "signIn",
                // Generic-password service name written by `claude login` on
                // macOS. Presence only: no item data is requested, so the probe
                // neither prompts for Keychain access nor exposes the credential.
                kind: .keychainPresence(service: "Claude Code-credentials"),
                requirement: .required,
                actionTitle: "Check Claude Code sign-in",
                actionSymbol: "person.badge.key",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "Claude Code is signed in. Turns bill your claude login subscription.",
                    detected: "Claude Code is signed in. Turns bill your claude login subscription.",
                    absent: "No Claude Code sign-in found. Run claude login in Terminal, then rerun this check.",
                    failure: "Could not verify Claude Code sign-in (%@).",
                    blockingAbsent: "Sign in with claude login so Claude Code turns can authenticate.",
                    blockingFailed: "Resolve the Claude Code sign-in check error.",
                    blockingUnchecked: "Sign in with claude login so Claude Code turns can authenticate."
                )
            ),
            RunnerBootstrapProbe(
                id: "executable",
                kind: .executablePath(
                    slotID: "executable",
                    search: ExecutableSearch(
                        binaryName: "claude",
                        searchPathFallbacks: [
                            // The native installer writes ~/.local/bin, so it
                            // leads: a Homebrew or npm shim left over from an
                            // older install should not win over the binary
                            // `claude update` actually maintains.
                            "~/.local/bin",
                            "~/.claude/local",
                            "/opt/homebrew/bin",
                            "/usr/local/bin",
                            "~/.npm-global/bin",
                            "~/.bun/bin",
                            "~/bin",
                            "/usr/bin",
                            "/bin"
                        ],
                        absoluteCandidates: [
                            "~/.local/bin/claude",
                            // Legacy per-user install layout kept by older
                            // `claude` releases.
                            "~/.claude/local/claude",
                            "/opt/homebrew/bin/claude",
                            "/usr/local/bin/claude"
                        ]
                    )
                ),
                // Never blocking: with no local binary the Agent SDK runs turns
                // with the CLI it bundles. The only cost is that the bundled
                // CLI's pinned model catalog is what client pickers see.
                requirement: .informational,
                actionTitle: "Check",
                actionSymbol: "magnifyingglass",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "Claude Code CLI is configured at %@.",
                    detected: "Saved Claude Code CLI at %@. Start or restart the backend to apply it.",
                    absent: """
                    No local claude CLI found. Turns will use the CLI bundled with the Agent SDK, \
                    which can advertise an older model list than an installed claude.
                    """,
                    failure: "Could not save Claude Code CLI path: %@",
                    blockingAbsent: "",
                    blockingFailed: "",
                    blockingUnchecked: ""
                )
            )
        ]
    )

    private static let deepseek = RunnerBootstrapDescriptor(
        runnerKind: "deepseek",
        slots: [
            RunnerBootstrapSlot(
                id: "executable",
                kind: .executablePath,
                environmentName: "DEEPSEEK_EXECUTABLE",
                title: "Executable",
                // Deliberately not `dsh`. That launcher boots profiles and has
                // no entry mode serving this protocol; on the recommended
                // source path this is the Node interpreter that runs the
                // entrypoint in Arguments, which is why the example shows one.
                prompt: "e.g. /opt/homebrew/bin/node"
            ),
            // Second, because it completes the field above: an interpreter with
            // no entrypoint is half a launch command.
            RunnerBootstrapSlot(
                id: "arguments",
                kind: .arguments,
                environmentName: "DEEPSEEK_ARGS",
                title: "Arguments",
                prompt: "e.g. ~/src/deepseek-harness/packages/examples/jsonrpc-demo/lib/bin.js",
                // No probe checks this, so the failure it causes is worth
                // naming where it is typed rather than leaving it to be met as
                // a runtime error with no obvious cause.
                note: RunnerBootstrapNote(
                    id: "entrypoint",
                    text: "For a source build, the built entrypoint goes here and the interpreter above. Nothing checks this path — a wrong one fails when the backend starts the runner, not on Check.",
                    systemImage: "terminal"
                )
            ),
            RunnerBootstrapSlot(
                id: "cordisConfig",
                kind: .filePath,
                environmentName: "DEEPSEEK_CORDIS_CONFIG",
                title: "Composition",
                // Required, not optional: the runtime demands an explicit
                // composition and exits without one. AgentRoom ships none on
                // purpose — the plugin graph decides which tools the agent has,
                // which is the operator's deployment decision, not ours.
                prompt: "e.g. ~/src/deepseek-harness/examples/jsonrpc-agent/cordis.yml",
                note: RunnerBootstrapNote(
                    id: "composition",
                    text: "This file decides which tools the agent gets and whether it can write outside the workspace. AgentRoom ships none and cannot inspect yours — read it first. See docs/safety/TRUST_AND_SAFETY.md.",
                    systemImage: "lock.shield"
                )
            ),
            RunnerBootstrapSlot(
                id: "apiKey",
                kind: .secret,
                environmentName: "DEEPSEEK_API_KEY",
                title: "API key",
                prompt: "sk-…",
                note: RunnerBootstrapNote(
                    id: "apiKey",
                    text: "Kept in this Mac's Keychain and injected when the backend launches — which is also why an exported DEEPSEEK_API_KEY no longer reaches it. It has to be here rather than in the composition's own credential store, which publishes too late for the first turn.",
                    systemImage: "key"
                )
            )
        ],
        probes: [
            RunnerBootstrapProbe(
                id: "executable",
                kind: .executablePath(
                    slotID: "executable",
                    // `dsh-jsonrpc-agent` is the bin that serves this protocol;
                    // searching for `dsh` would resolve the launcher, save it,
                    // and report a ready runner that can never complete a
                    // handshake. The packaged single-file runtime carries a
                    // platform suffix this search cannot express, so an
                    // operator who installed that one fills the slot by hand.
                    search: ExecutableSearch(
                        binaryName: "dsh-jsonrpc-agent",
                        searchPathFallbacks: [
                            "/opt/homebrew/bin",
                            "/usr/local/bin",
                            "~/.local/bin",
                            "~/.npm-global/bin",
                            "~/.bun/bin",
                            "~/bin",
                            "/usr/bin",
                            "/bin"
                        ],
                        absoluteCandidates: [
                            "/opt/homebrew/bin/dsh-jsonrpc-agent",
                            "/usr/local/bin/dsh-jsonrpc-agent",
                            "~/.local/bin/dsh-jsonrpc-agent",
                            "~/.npm-global/bin/dsh-jsonrpc-agent",
                            "~/.bun/bin/dsh-jsonrpc-agent",
                            "~/bin/dsh-jsonrpc-agent"
                        ],
                        // Builds before the SDK launch-contract correction
                        // auto-saved this still-executable launcher in the same
                        // slot. Reject it so the next probe migrates to the
                        // serving runtime instead of preserving stale state.
                        rejectedBinaryNames: ["dsh"]
                    )
                ),
                requirement: .required,
                actionTitle: "Check",
                actionSymbol: "magnifyingglass",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "DeepSeek Harness SDK runtime is configured at %@.",
                    detected: "Saved the DeepSeek Harness SDK runtime at %@. Start or restart the backend to apply it.",
                    // The search covers one of three ways to hold this runtime
                    // and not the recommended one, so "not found" is a normal
                    // opening state here. It says the one thing that gets an
                    // operator moving and leaves the walkthrough to the docs —
                    // a paragraph of setup in a warning colour trains people to
                    // stop reading the warnings.
                    absent: "Not found on the usual paths. For a source build, set your Node interpreter here. See docs/clients/MACOS.md.",
                    failure: "Could not save the DeepSeek Harness runtime path: %@",
                    blockingAbsent: "Set the DeepSeek Harness runtime path, then rerun the check.",
                    blockingFailed: "Resolve the DeepSeek Harness runtime check error.",
                    blockingUnchecked: "Set or check the DeepSeek Harness SDK runtime path."
                )
            ),
            RunnerBootstrapProbe(
                id: "cordisConfig",
                kind: .filePath(slotID: "cordisConfig"),
                requirement: .required,
                actionTitle: "Check",
                actionSymbol: "magnifyingglass",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "DeepSeek Harness composition is configured at %@.",
                    detected: "Saved the DeepSeek Harness composition at %@. Start or restart the backend to apply it.",
                    absent: "The DeepSeek Harness composition was not found. Choose a readable absolute path, then rerun this check.",
                    failure: "Could not save the DeepSeek Harness composition path: %@",
                    blockingAbsent: "Choose an existing DeepSeek Harness Cordis composition, then rerun the check.",
                    blockingFailed: "Resolve the DeepSeek Harness composition check error.",
                    blockingUnchecked: "Set or check the DeepSeek Harness Cordis composition path."
                )
            )
        ],
        // The recommended install is a source checkout, and the three values
        // above are all derivable from it — so the operator names the one thing
        // they actually know and this walks the rest.
        sourceCheckout: RunnerBootstrapSourceCheckout(
            interpreterSlotID: "executable",
            interpreterSearch: ExecutableSearch(
                binaryName: "node",
                searchPathFallbacks: [
                    "/opt/homebrew/bin",
                    "/usr/local/bin",
                    "~/.local/bin",
                    "~/.nvm/versions/node/current/bin",
                    "/usr/bin",
                    "/bin"
                ],
                absoluteCandidates: [
                    "/opt/homebrew/bin/node",
                    "/usr/local/bin/node"
                ]
            ),
            entrypointSlotID: "arguments",
            entrypointPackagePath: "packages/examples/jsonrpc-demo",
            entrypointBinName: "dsh-jsonrpc-agent",
            compositionSlotID: "cordisConfig",
            // Only the unattended example, never `minimal.cordis.yml`. The
            // minimal one mounts `danger-full-access` and a terminal UI, and
            // this one's own header reserves stdout for JSON-RPC — which is the
            // property AgentRoom's transport depends on. Offering the operator
            // the safer of two files without saying so would be the wrong kind
            // of convenience, so the resolution names what it took.
            compositionCandidates: ["examples/jsonrpc-agent/cordis.yml"]
        ),
        // The credentials note that used to sit here explained an *absence*.
        // The field above replaced it, and the explanation went with it — a
        // caption about a value now belongs to that value's own slot.
        notes: []
    )
}
