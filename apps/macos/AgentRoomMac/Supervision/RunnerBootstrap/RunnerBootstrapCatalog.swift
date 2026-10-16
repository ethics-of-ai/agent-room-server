import Foundation

/// The bundled tier-3 bootstrap descriptors.
///
/// This table is the trusted half of `docs/engineering/RUNNERS.md`, and it is **bundled on
/// purpose**. The backend's `/api/runners` says which runners exist; it may not
/// say what starting one requires, because an environment name or an executable
/// slot arriving over the network would make configuration into code execution.
/// So the two lists can legitimately disagree: a runner the backend registers
/// but this build has no bootstrap for simply contributes no local check, which
/// is the honest answer rather than another runner's.
enum RunnerBootstrapCatalog {
    static let builtIn: [RunnerBootstrapDescriptor] = [codex, claudeCode, deepseek, cursor]

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
                            // ChatGPT.app. Newer ChatGPT releases move it into a
                            // `codex-cli` package; its `bin/codex` is a shell
                            // wrapper that needs PATH tools, so the native
                            // binary it execs is listed instead. The older
                            // flat path and the standalone bundle stay as
                            // fallbacks for older installations.
                            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
                            "~/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
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
            ),
            RunnerBootstrapProbe(
                id: "signIn",
                // The file `codex login` writes under the default CODEX_HOME.
                // Presence only, as the Cursor lookup: the path is stat'ed and
                // never opened, because the file is the credential. The
                // backend's `codex_login` check is the proof once it runs.
                kind: .filePresence(path: "~/.codex/auth.json"),
                // Informational, unlike Claude Code's: a Codex configured to
                // keep its sign-in in the Keychain, or under another
                // CODEX_HOME, writes no file here and must not be blocked.
                requirement: .informational,
                actionTitle: "Check Codex sign-in",
                actionSymbol: "person.badge.key",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "Found a Codex sign-in on this Mac. Turns bill the account codex login used.",
                    detected: "Found a Codex sign-in on this Mac. Turns bill the account codex login used.",
                    absent: "No Codex sign-in found in ~/.codex. Sign in to Codex, then rerun this check.",
                    failure: "Could not verify Codex sign-in (%@).",
                    blockingAbsent: "",
                    blockingFailed: "",
                    blockingUnchecked: ""
                )
            )
        ],
        // Every codex CLI sharing ~/.codex reads the same auth file, so signing
        // in with the resolved executable signs in the one the backend launches.
        signIn: RunnerSignInCommand(
            title: "Sign in to Codex",
            executableProbeID: "executable",
            arguments: ["login"],
            signOutTitle: "Sign out of Codex",
            signOutArguments: ["logout"],
            credentialProbeID: "signIn",
            readinessCheckID: "codex_login",
            missingExecutableMessage: "No local codex CLI was found to sign in with. Install Codex, or run codex login in a terminal.",
            signOutWarning: "This signs out every codex CLI on this Mac that uses ~/.codex, including one you use in a terminal. AgentRoom Codex turns stop until you sign in again."
        )
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
                    // Presence cannot tell a live sign-in from an expired
                    // one; the backend's sign-in check below is the proof.
                    satisfied: "Found a Claude Code sign-in on this Mac. Turns bill your claude login subscription.",
                    detected: "Found a Claude Code sign-in on this Mac. Turns bill your claude login subscription.",
                    absent: "No Claude Code sign-in found. Sign in to Claude, then rerun this check.",
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
        ],
        // Every claude CLI reads and writes the same Keychain item, so signing
        // in with the resolved CLI signs in the one the backend launches.
        signIn: RunnerSignInCommand(
            title: "Sign in to Claude",
            executableProbeID: "executable",
            arguments: ["auth", "login"],
            signOutTitle: "Sign out of Claude",
            signOutArguments: ["auth", "logout"],
            credentialProbeID: "signIn",
            readinessCheckID: "claude_login",
            missingExecutableMessage: "No local claude CLI was found to sign in with. Install Claude Code, or run claude auth login in a terminal.",
            signOutWarning: "This signs out every claude CLI on this Mac, including one you use in a terminal. AgentRoom turns stop until you sign in again."
        )
    )

    /// The launcher package and the Harness pin the backend runs. Move both
    /// with the pin in `docs/engineering/DEEPSEEK_HARNESS_RUNNER.md`.
    private static let dshPackage = RunnerBootstrapEntrypointPackage(
        name: "@deepseek-ai/dsh",
        displayName: "dsh",
        testedVersion: "0.2.1-alpha.4",
        testedRevision: "86a402200d95fecef4529d969836f1fe13c6cb0d"
    )

    private static let deepseek = RunnerBootstrapDescriptor(
        runnerKind: "deepseek",
        slots: [
            RunnerBootstrapSlot(
                id: "executable",
                kind: .executablePath,
                environmentName: "DEEPSEEK_EXECUTABLE",
                title: "Executable",
                // Either the `dsh` launcher itself or, on the recommended
                // source path, the Node interpreter that runs its entrypoint
                // in Arguments. The example shows Node because a launcher bin
                // relies on a `#!/usr/bin/env node` shebang.
                prompt: "e.g. /opt/homebrew/bin/node"
            ),
            // Second, because it completes the field above: an interpreter with
            // no entrypoint is half a launch command.
            RunnerBootstrapSlot(
                id: "arguments",
                kind: .arguments,
                environmentName: "DEEPSEEK_ARGS",
                title: "Arguments",
                prompt: "e.g. ~/src/deepseek-harness/apps/cli/lib/bin.js",
                note: RunnerBootstrapNote(
                    id: "entrypoint",
                    text: "Use a source checkout fills this in. AgentRoom adds its own --profile and --patch arguments.",
                    systemImage: "terminal"
                )
            ),
            RunnerBootstrapSlot(
                id: "compositionMode",
                kind: .arguments,
                environmentName: "DEEPSEEK_COMPOSITION_MODE",
                title: "Setup",
                note: RunnerBootstrapNote(
                    id: "compositionMode",
                    text: "AgentRoom managed needs no composition file. It runs a workspace-write sandbox with file and shell tools, background shell jobs, and subagents. Custom runs a composition file of your own.",
                    systemImage: "gearshape"
                ),
                choices: [
                    RunnerBootstrapChoice(id: "custom", title: "Custom composition"),
                    RunnerBootstrapChoice(id: "managed", title: "AgentRoom managed")
                ]
            ),
            RunnerBootstrapSlot(
                id: "cordisConfig",
                kind: .filePath,
                environmentName: "DEEPSEEK_CORDIS_CONFIG",
                title: "Composition",
                prompt: "e.g. ~/agentroom/deepseek.cordis.patch.yml",
                note: RunnerBootstrapNote(
                    id: "composition",
                    text: "A Cordis patch whose insert rows form the whole graph. Review its tools and execution policy before launching. AgentRoom does not check provider access or sandbox enforcement.",
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
                    text: "Kept in this Mac's Keychain and passed to DeepSeek when the backend starts. A DEEPSEEK_API_KEY exported in your shell does not reach it.",
                    systemImage: "key"
                )
            )
        ],
        probes: [
            RunnerBootstrapProbe(
                id: "executable",
                kind: .executablePath(
                    slotID: "executable",
                    // Every Harness app boots through the `dsh` launcher, and the
                    // backend appends `--profile agentroom --patch` to it. A
                    // packaged single-file runtime carries a platform suffix
                    // this search cannot express, so an operator who installed
                    // one fills the slot by hand.
                    search: ExecutableSearch(
                        binaryName: "dsh",
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
                            "/opt/homebrew/bin/dsh",
                            "/usr/local/bin/dsh",
                            "~/.local/bin/dsh",
                            "~/.npm-global/bin/dsh",
                            "~/.bun/bin/dsh",
                            "~/bin/dsh"
                        ],
                        // Harness 86a40220 removed this bin, and earlier builds
                        // of this app saved it here. A leftover install stays
                        // executable but cannot take the launcher's arguments,
                        // so reject it and let the next check find `dsh`.
                        rejectedBinaryNames: ["dsh-jsonrpc-agent"]
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
                id: "entrypoint",
                kind: .nodeEntrypoint(executableSlotID: "executable", argumentsSlotID: "arguments", package: dshPackage),
                requirement: .required,
                // It shares the Arguments row with the field, so it is
                // titled like the other per-field checks.
                actionTitle: "Check",
                actionSymbol: "magnifyingglass",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "SDK entrypoint is ready: %@.",
                    detected: "SDK entrypoint is ready: %@.",
                    absent: "Choose a built source checkout or set an absolute, readable SDK entrypoint in Arguments.",
                    failure: "Could not check the SDK entrypoint: %@",
                    blockingAbsent: "Build the Harness checkout and check its SDK entrypoint.",
                    blockingFailed: "Resolve the SDK entrypoint check error.",
                    blockingUnchecked: "Check the DeepSeek SDK entrypoint."
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
                    blockingAbsent: "Choose an existing DeepSeek Harness Cordis patch, or select AgentRoom managed setup.",
                    blockingFailed: "Resolve the DeepSeek Harness composition check error.",
                    blockingUnchecked: "Set or check the DeepSeek Harness composition, or select AgentRoom managed setup."
                ),
                // Managed setup generates its own graph and never reads the
                // file. Only an explicit `managed` waives it: the backend
                // treats an unset mode as custom.
                waivedBy: RunnerBootstrapChoiceSelection(slotID: "compositionMode", choiceID: "managed")
            )
        ],
        // The recommended install is a source checkout, and the interpreter and
        // entrypoint are both derivable from it, so the operator names the one
        // thing they actually know and this walks the rest. The checkout ships
        // no composition AgentRoom should run unchanged, so none is derived.
        // Choosing it selects managed setup instead, unless the operator
        // already keeps a readable composition of their own.
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
            entrypointPackagePath: "apps/cli",
            entrypointBinName: "dsh",
            package: dshPackage,
            setupChoice: RunnerBootstrapChoiceSelection(slotID: "compositionMode", choiceID: "managed"),
            customSetupFileSlotID: "cordisConfig",
            note: RunnerBootstrapNote(
                id: "sourceCheckout",
                text: "Choose your deepseek-harness folder. AgentRoom fills in Node and the dsh entrypoint, checks for a built dsh \(dshPackage.testedVersion), and offers to update or build the checkout if it needs it.",
                systemImage: "folder"
            )
        ),
        // The credentials note that used to sit here explained an *absence*.
        // The field above replaced it, and the explanation went with it — a
        // caption about a value now belongs to that value's own slot.
        notes: []
    )

    private static let cursor = RunnerBootstrapDescriptor(
        runnerKind: "cursor",
        // No slots. The SDK is bundled with the backend, so there is no
        // executable to find on PATH and no argument list, and its credential
        // is a file the SDK owns rather than a value this app holds. So this
        // descriptor adds no name to the launch-environment allowlist.
        // `CURSOR_API_KEY` deliberately has no Keychain slot in this pass: a
        // required sign-in probe that a filled secret slot could satisfy is a
        // composition the probe model does not have, and an operator who
        // prefers a key sets it in $AGENTROOM_HOME/config/.env, which the
        // backend reads itself.
        slots: [],
        probes: [
            RunnerBootstrapProbe(
                id: "signIn",
                // The file `Cursor.auth.login()` writes (0600): the minted user
                // API key. Presence only, exactly as the Claude Code Keychain
                // lookup: the path is stat'ed and never opened, because the
                // file *is* the credential. Presence cannot tell an expired
                // key from a live one; that is the backend's `ready`, and the
                // two stay separate authorities.
                kind: .filePresence(path: "~/.cursor/sdk/auth.json"),
                requirement: .required,
                actionTitle: "Check Cursor sign-in",
                actionSymbol: "person.badge.key",
                messages: RunnerBootstrapProbeMessages(
                    satisfied: "Cursor is signed in. Turns bill your Cursor account.",
                    detected: "Cursor is signed in. Turns bill your Cursor account.",
                    // The command itself lives in the docs, where it can be
                    // corrected without shipping the app again.
                    absent: "No Cursor sign-in found. Run the Cursor sign-in command in Terminal, then rerun this check. See docs/clients/MACOS.md.",
                    failure: "Could not verify Cursor sign-in (%@).",
                    blockingAbsent: "Sign in to Cursor with the sign-in command so Cursor turns can authenticate.",
                    blockingFailed: "Resolve the Cursor sign-in check error.",
                    blockingUnchecked: "Sign in to Cursor with the sign-in command so Cursor turns can authenticate."
                )
            )
        ]
    )
}
