import Foundation
import Observation

@MainActor
@Observable
final class BackendSupervisor {
    private(set) var settings: AppSettings
    /// The backend-owned managed settings, read from
    /// `$AGENTROOM_HOME/config/settings.json`. These panes edit the file rather
    /// than `PATCH /api/config` so they keep working while the backend is stopped.
    private(set) var managedSettings = ManagedBackendSettings()
    /// The settings-file sections this build cannot address — a runner it does
    /// not know, or a field a newer AgentRoom added to one it does.
    ///
    /// They have always been carried back out untouched on every write; Phase 1
    /// of `docs/engineering/REGISTERED_RUNNER_COMPLETENESS.md` is what makes them
    /// *visible*, because a registered runner brings its own settings and a trust
    /// posture set from a paired client was previously invisible on the machine
    /// that posture is about.
    private(set) var preservedManagedSettings = PreservedManagedSettings()
    /// Set when the settings file exists but cannot be parsed. The backend drops
    /// such a file whole and runs on defaults; this app refuses to merge into it,
    /// so the panes offer a reset instead of silently rewriting the operator's work.
    private(set) var managedSettingsIssue: String?
    /// The schema version the settings file on disk declares, when it is one this
    /// app can apply. `nil` for a missing or unusable file. The Advanced pane
    /// reads it to say whether the file is already in the older format a
    /// pre-Phase-5 backend can read.
    private(set) var managedSettingsSchemaVersion: Int?
    /// Per-key provenance from the running backend's `/api/config`. `nil` while
    /// the backend is unreachable — the panes then say so instead of guessing
    /// which keys an environment variable has locked.
    private(set) var backendSettingsMetadata: [String: PublicManagedSetting]?
    /// The runners the backend registers (`GET /api/runners`), or the offline
    /// catalog while the backend is stopped — which is exactly when an operator
    /// is fixing why it would not start, so the panes cannot depend on asking it.
    /// See `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`.
    private(set) var runnerCatalog: RunnerCatalog = .builtIn
    private(set) var secrets: BackendSecretValues
    private(set) var serverState: BackendServerState = .stopped
    private(set) var connectionState: BackendConnectionState = .unknown
    private(set) var health: HealthResponse?
    private(set) var workspaceSnapshot: LocalWorkspaceRegistrySnapshot?
    private(set) var diagnostics: [DiagnosticMessage] = []
    private(set) var processLogs: [BackendProcessLogLine] = []
    private(set) var healthDiagnostics: String?
    private(set) var configDiagnostics: String?
    private(set) var recentLogsDiagnostics: String?
    private(set) var auditTrailDiagnostics: String?
    private(set) var diagnosticsExportMessage: String?
    /// Mac bootstrap readiness, keyed by `runnerKind/probeID` — the local half of
    /// Phase 6's split readiness. It answers "is the prerequisite on *this*
    /// machine satisfied", which must work with the backend stopped, and is a
    /// different authority from the `ready` a running backend reports on
    /// `GET /api/runners`. See `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`.
    private(set) var bootstrapStatuses: [String: RunnerBootstrapCheckStatus] = [:]
    /// Keyed by runner kind: one source-checkout walk per runner, unlike probe
    /// statuses, which are per probe.
    private(set) var sourceCheckoutOutcomes: [String: RunnerBootstrapSourceCheckoutOutcome] = [:]
    private(set) var editorCatalogStatus: EditorCatalogStatus?
    private(set) var editorCatalogActionStatus: EditorCatalogActionStatus?
    /// Whether a backend this app supervises exists right now — spawned this
    /// session or adopted from an earlier one.
    ///
    /// Observed rather than checked on demand, because the live answer is a
    /// syscall on a pid and a view that read it in a body would neither be
    /// cheap nor re-render when it changed. It is what keeps Stop honest in the
    /// states `serverState` alone cannot describe: a process that is running
    /// while its health check fails reads as `failed`, and refusing to stop it
    /// there is the same dead end as refusing to stop an orphan.
    private(set) var hasSupervisedProcess = false

    private let defaults: UserDefaults
    private let secretStore: BackendSecretStore
    private let runtimeLocator: BackendRuntimeLocator
    private let bootstrapDescriptors: [RunnerBootstrapDescriptor]
    private let bootstrapProber: RunnerBootstrapProber
    private let portProbe: BackendPortProbe
    private let fileManager: FileManager
    private let apiURLSession: URLSession
    private let launchAtLoginController: any LaunchAtLoginManaging
    private let appSupportMigrator: AppSupportDataMigrator
    private let managedSettingsStore: ManagedSettingsFileStore
    private let runnerCatalogStore: RunnerCatalogFileStore
    private let processInspector: any BackendProcessInspecting
    private let sidecarRecordStore: BackendSidecarRecordStore
    @ObservationIgnored private var secretLoadError: Error?
    @ObservationIgnored private var backendProcess: Process?
    /// A sidecar this app launched in an earlier session and has recognised
    /// again. It is supervised exactly like `backendProcess` — the operator
    /// sees "running" and can stop or restart it — because it *is* this app's
    /// backend; only the handle differs, since `Process` cannot attach to a pid
    /// it did not spawn. See `BackendProcessIdentity`.
    @ObservationIgnored private var adoptedProcess: AdoptedBackendProcess?
    /// An adopted process has no `terminationHandler`, so its exit is noticed by
    /// polling. Runs only while one is adopted.
    @ObservationIgnored private var adoptedProcessWatchTask: Task<Void, Never>?
    @ObservationIgnored private var stdoutPipe: Pipe?
    @ObservationIgnored private var stderrPipe: Pipe?
    // Immutable + internally locked, so the nonisolated readability handlers can
    // stage output into it without a main-actor hop per pipe chunk.
    @ObservationIgnored private let processLogBuffer = BackendProcessLogBuffer()
    @ObservationIgnored private var isGracefullyStopping = false
    @ObservationIgnored private var pendingCrashRestartTask: Task<Void, Never>?
    @ObservationIgnored private var restartLimiter = BackendCrashRestartLimiter(maxAttempts: 3, windowSeconds: 300)
    @ObservationIgnored private let backendSettingsEventMonitor = BackendSettingsEventMonitor()

    private let crashRestartDelay: Duration = .seconds(2)
    private let backendReadinessAttempts = 40
    private let backendReadinessDelay: Duration = .milliseconds(250)

    init(
        defaults: UserDefaults = .standard,
        secretStore: BackendSecretStore = KeychainBackendSecretStore(),
        runtimeLocator: BackendRuntimeLocator = BackendRuntimeLocator(),
        bootstrapDescriptors: [RunnerBootstrapDescriptor] = RunnerBootstrapCatalog.builtIn,
        bootstrapProber: RunnerBootstrapProber = RunnerBootstrapProber(),
        portProbe: BackendPortProbe = BackendPortProbe(),
        fileManager: FileManager = .default,
        apiURLSession: URLSession = .shared,
        launchAtLoginController: any LaunchAtLoginManaging = LaunchAtLoginController(),
        appSupportMigrator: AppSupportDataMigrator? = nil,
        managedSettingsStore: ManagedSettingsFileStore = ManagedSettingsFileStore(),
        runnerCatalogStore: RunnerCatalogFileStore = RunnerCatalogFileStore(),
        processInspector: any BackendProcessInspecting = DarwinProcessInspector(),
        sidecarRecordStore: BackendSidecarRecordStore? = nil
    ) {
        self.defaults = defaults
        self.secretStore = secretStore
        self.runtimeLocator = runtimeLocator
        self.bootstrapDescriptors = bootstrapDescriptors
        self.bootstrapProber = bootstrapProber
        self.portProbe = portProbe
        self.fileManager = fileManager
        self.apiURLSession = apiURLSession
        self.launchAtLoginController = launchAtLoginController
        self.appSupportMigrator = appSupportMigrator ?? AppSupportDataMigrator(fileManager: fileManager)
        self.managedSettingsStore = managedSettingsStore
        self.runnerCatalogStore = runnerCatalogStore
        self.processInspector = processInspector
        self.sidecarRecordStore = sidecarRecordStore ?? BackendSidecarRecordStore(defaults: defaults)
        var loadedSettings = Self.loadSettings(from: defaults)
        loadedSettings.launchAtLoginEnabled = launchAtLoginController.isEnabled
        self.settings = loadedSettings
        do {
            self.secrets = try secretStore.loadSecrets()
        } catch {
            self.secrets = .empty
            self.secretLoadError = error
        }
        appendDiagnostic("info", "Loaded macOS app settings.")
        // The settings file lives under AGENTROOM_HOME, so the directory has to
        // exist before the first-run seed can write it.
        prepareAgentRoomHomeForLaunch()
        loadManagedSettings(seedingFrom: defaults)
        migrateLegacyCodexReasoningEffortIfNeeded()
        checkRunnerBootstrap()
    }

    var localServerURLString: String {
        settings.localServerURL.absoluteString
    }

    var lanServerURLString: String {
        settings.primaryLANServerURLString
    }

    var macHostnameServerURLString: String? {
        settings.macHostnameServerURLString
    }

    var lanIPAddressServerURLStrings: [String] {
        settings.lanIPAddressServerURLStrings
    }

    var lanServerURLStrings: [String] {
        settings.lanServerURLStrings
    }

    func currentAPIClient() -> APIClient {
        apiClient
    }

    var setupReadiness: SetupReadiness {
        SetupReadiness(
            settings: settings,
            runnerKind: displayedRunnerKind,
            secrets: secrets,
            bootstrapDescriptor: bootstrapDescriptors.first { $0.runnerKind == displayedRunnerKind },
            bootstrapStatuses: bootstrapStatuses,
            connectionState: connectionState,
            hasLANURL: !lanServerURLStrings.isEmpty
        )
    }

    private var apiClient: APIClient {
        APIClient(
            serverBaseURL: settings.localServerURL,
            authToken: secrets.authToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            urlSession: apiURLSession
        )
    }

    /// The file is the pending value the panes edit, except when the running
    /// backend reports an environment lock. In that case the file is inert and
    /// the disabled control must show the value actually in force.
    /// A backend runner id, not a case of a closed enum, and deliberately not
    /// coerced to Codex when this app does not recognize it: an unknown id shown
    /// as "Codex" would tell the operator their Mac is set up for a runner it is
    /// not. An absent value *is* the backend's own default, which is Codex.
    var displayedRunnerKind: String {
        settingStatus(for: .runnerKind)?.displayedString(fileValue: managedSettings.runnerKind)
            ?? managedSettings.runnerKind
            ?? ManagedBackendSettings.defaultRunnerKind
    }

    var displayedCodexReasoningEffort: String? {
        settingStatus(for: .codexReasoningEffort)?.displayedString(
            fileValue: managedSettings.codexReasoningEffort
        ) ?? managedSettings.codexReasoningEffort
    }

    var displayedCodexWorkspaceNetworkAccess: Bool {
        settingStatus(for: .codexWorkspaceNetworkAccess)?.displayedBool(
            fileValue: managedSettings.codexGitNetworkAccessEnabled
        ) ?? managedSettings.codexGitNetworkAccessEnabled
    }

    var displayedTerminalEnabled: Bool {
        settingStatus(for: .terminalEnabled)?.displayedBool(
            fileValue: managedSettings.resolvedTerminalEnabled
        ) ?? managedSettings.resolvedTerminalEnabled
    }

    var displayedSceneEngineEnabled: Bool {
        settingStatus(for: .sceneEngineEnabled)?.displayedBool(
            fileValue: managedSettings.resolvedSceneEngineEnabled
        ) ?? managedSettings.resolvedSceneEngineEnabled
    }

    func updateServerPort(_ value: Int) {
        guard (1...65535).contains(value) else {
            appendDiagnostic("warning", "Ignored invalid server port \(value).")
            return
        }
        settings.serverPort = value
        backendSettingsEventMonitor.disconnect()
        persistSettings()
        appendDiagnostic("info", "Updated server port to \(value).")
    }

    func updateWorkspacePath(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            appendDiagnostic("warning", "Workspace path cannot be empty.")
            return
        }
        settings.workspacePath = NSString(string: trimmed).expandingTildeInPath
        persistSettings()
        appendDiagnostic("info", "Updated workspace path.")
    }

    func updateStorageRootPath(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            appendDiagnostic("warning", "Storage root path cannot be empty.")
            return
        }
        let expanded = NSString(string: trimmed).expandingTildeInPath
        settings.agentRoomHomePath = expanded
        settings.workspacePath = AppSettings.defaultWorkspacePath(for: expanded)
        settings.statePath = AppSettings.defaultStatePath(for: expanded)
        persistSettings()
        appendDiagnostic("info", "Updated storage root and derived workspace/state paths.")
        prepareAgentRoomHomeForLaunch()
        // The managed settings file moved with the storage root. A file already
        // at the new location wins; otherwise carry the current values over
        // rather than reverting to backend defaults.
        let previousManagedSettings = managedSettings
        loadManagedSettings(seedingFrom: defaults, fallback: previousManagedSettings)
        migrateLegacyCodexReasoningEffortIfNeeded()
    }

    func updateStatePath(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            appendDiagnostic("warning", "State path cannot be empty.")
            return
        }
        settings.statePath = NSString(string: trimmed).expandingTildeInPath
        persistSettings()
        appendDiagnostic("info", "Updated state path.")
    }

    func updateLaunchAtLogin(_ isEnabled: Bool) {
        do {
            if launchAtLoginController.isEnabled != isEnabled {
                try launchAtLoginController.setEnabled(isEnabled)
            }
            settings.launchAtLoginEnabled = launchAtLoginController.isEnabled
            persistSettings()
            appendDiagnostic("info", isEnabled ? "Enabled launch at login." : "Disabled launch at login.")
        } catch {
            settings.launchAtLoginEnabled = launchAtLoginController.isEnabled
            persistSettings()
            appendDiagnostic("error", "Failed to update launch at login: \(error.localizedDescription)")
        }
    }

    func updateAutoRestartBackendAfterCrash(_ isEnabled: Bool) {
        settings.autoRestartBackendAfterCrash = isEnabled
        if !isEnabled {
            cancelPendingCrashRestart()
            restartLimiter.reset()
        }
        persistSettings()
        appendDiagnostic("info", isEnabled ? "Enabled crash auto-restart for the backend sidecar." : "Disabled crash auto-restart for the backend sidecar.")
    }

    func updateCodexWorkspaceNetworkAccess(_ isEnabled: Bool) {
        updateManagedSettings(
            describedAs: isEnabled
                ? "Enabled Codex workspace network access for future backend launches."
                : "Disabled Codex workspace network access for future backend launches."
        ) { settings in
            settings.setCodexGitNetworkAccess(isEnabled)
        }
    }

    func updateCodexReasoningEffort(_ value: String?) {
        updateManagedSettings(describedAs: "Updated the default Codex reasoning effort for future backend launches.") {
            $0.codexReasoningEffort = value
        }
    }

    func updateTerminalEnabled(_ isEnabled: Bool) {
        updateManagedSettings(
            describedAs: isEnabled
                ? "Enabled the interactive terminal for future backend launches."
                : "Disabled the interactive terminal for future backend launches."
        ) { settings in
            settings.terminalEnabled = isEnabled
        }
    }

    func updateSceneEngineEnabled(_ isEnabled: Bool) {
        updateManagedSettings(
            describedAs: isEnabled
                ? "Enabled the spatial scene engine for future backend launches."
                : "Disabled the spatial scene engine for future backend launches."
        ) { settings in
            settings.sceneEngineEnabled = isEnabled
        }
    }

    func updateRunnerKind(_ runnerKind: String) {
        updateManagedSettings(
            describedAs: "Set default runner to \(runnerCatalog.displayName(for: runnerKind)) for future backend launches."
        ) { settings in
            settings.runnerKind = runnerKind
        }
    }

    /// The master switch for remote tier-2 edits. It is app state injected as
    /// `REMOTE_SETTINGS_ADMIN` at launch, deliberately never a managed key: a
    /// bearer-token holder must not be able to grant themselves the permission.
    func updateRemoteSettingsAdmin(_ isEnabled: Bool) {
        guard settings.remoteSettingsAdminEnabled != isEnabled else { return }
        settings.remoteSettingsAdminEnabled = isEnabled
        persistSettings()
        appendDiagnostic(
            isEnabled ? "warning" : "info",
            isEnabled
                ? "Allowed paired clients to change backend trust settings from the next backend launch."
                : "Restricted backend trust settings to this Mac from the next backend launch."
        )
    }

    /// The deliberate way out of an unparseable settings file: replace it with an
    /// empty document, which is every managed key back on its backend default.
    /// Nothing else in this app overwrites a file it could not read.
    ///
    /// It clears only the keys *this* schema owns. A file written for a newer
    /// schema is refused outright — it is not broken, and a reset would silently
    /// discard a posture the operator authored on a newer AgentRoom — and any
    /// reserved section a readable file carries is written back untouched, so a
    /// reset never blanks a `runners` block this app cannot render.
    func resetManagedSettingsFile() {
        let url = settings.managedSettingsFileURL
        let current = managedSettingsStore.read(at: url)
        if let version = current.unsupportedSchemaVersion {
            appendDiagnostic(
                "error",
                "Backend settings file uses settings schema version \(version), which this version of "
                    + "AgentRoom cannot read. Update AgentRoom rather than resetting; a reset would discard "
                    + "settings it cannot show you."
            )
            return
        }
        do {
            try managedSettingsStore.write(ManagedBackendSettings(), preserved: current.preserved, to: url)
            managedSettings = ManagedBackendSettings()
            managedSettingsIssue = nil
            appendDiagnostic("warning", "Reset backend settings to defaults; restart the backend to apply.")
            migrateLegacyCodexReasoningEffortIfNeeded()
            refreshBackendSettingsMetadataSoon()
        } catch {
            appendDiagnostic("error", "Failed to reset backend settings: \(error.localizedDescription)")
        }
    }

    /// Whether the settings file is already the flat document an older AgentRoom
    /// reads. A missing file counts as legacy: there is nothing to convert, and
    /// an older backend simply starts on its own defaults.
    var isManagedSettingsFileLegacy: Bool {
        (managedSettingsSchemaVersion ?? ManagedSettingsDocument.legacySchemaVersion)
            == ManagedSettingsDocument.legacySchemaVersion
    }

    /// The configured default runner that a rollback cannot carry, or `nil`.
    ///
    /// An older AgentRoom knows only the two runners that predate the rollout
    /// gate, and `runnerKind` is a *known* key there — so a value it does not
    /// know is not preserved-and-ignored the way an unknown runner's settings
    /// namespace is, it makes the whole file unusable. The pane reads this to
    /// say so before the button is pressed; the store refuses independently,
    /// because it is what actually writes.
    var runnerKindBlockingLegacyManagedSettingsFile: String? {
        ManagedSettingsDocument.runnerKindBlockingLegacyConversion(managedSettings.runnerKind)
    }

    /// The conversion is offered only for a file this app can read, and only for
    /// a posture the older build could actually hold. Converting an unusable one
    /// would mean writing over settings it cannot see, which is the same refusal
    /// `update` makes.
    var canWriteLegacyManagedSettingsFile: Bool {
        managedSettingsIssue == nil
            && !isManagedSettingsFileLegacy
            && runnerKindBlockingLegacyManagedSettingsFile == nil
    }

    /// Converts the settings file back to the flat document a pre-Phase-5
    /// AgentRoom reads, so running an older build is a supported step rather than
    /// a one-way upgrade.
    ///
    /// This app writes the nested version-2 document by default. An older backend
    /// cannot be taught to read it — it would call the file malformed and drop
    /// the operator's whole trust posture onto defaults — so the way back is to
    /// convert, not to hope. Every setting this release knows survives the round
    /// trip in both directions; a section only a newer release understands rides
    /// along unaddressed, exactly as Phase 4 taught the older reader to preserve
    /// it. See `docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md`.
    func writeLegacyManagedSettingsFile() {
        do {
            try managedSettingsStore.writeLegacyDocument(at: settings.managedSettingsFileURL)
            refreshManagedSettingsFromDisk()
            appendDiagnostic(
                "warning",
                "Converted backend settings to the older file format. A current AgentRoom will convert it "
                    + "back the next time these settings change."
            )
        } catch {
            appendDiagnostic("error", "Failed to convert backend settings: \(error.localizedDescription)")
        }
    }

    /// The status the panes render for one managed key, or `nil` while the
    /// backend is unreachable and cannot report provenance.
    func settingStatus(for key: ManagedBackendSettingKey) -> ManagedSettingStatus? {
        backendSettingsMetadata?[key.rawValue].map(ManagedSettingStatus.init(metadata:))
    }

    /// Whether an environment variable has taken this key, which makes the
    /// settings file inert for it — so the pane's control is shown read-only
    /// rather than letting the operator change something with no effect.
    func isSettingEnvironmentLocked(_ key: ManagedBackendSettingKey) -> Bool {
        settingStatus(for: key)?.isEnvironmentLocked ?? false
    }

    /// True when the file on disk no longer matches what the backend is running,
    /// so the panes can offer a restart rather than leaving the edit looking inert.
    var hasPendingBackendSettings: Bool {
        backendSettingsMetadata?.values.contains { $0.pendingValue != nil && $0.source != "env" } ?? false
    }

    func updateBackendSecrets(_ values: BackendSecretValues) {
        do {
            try secretStore.saveSecrets(values)
            secrets = try secretStore.loadSecrets()
            secretLoadError = nil
            appendDiagnostic("info", "Updated backend secrets in Keychain.")
            if connectionState == .reachable {
                startBackendSettingsEventMonitor()
            }
        } catch {
            secretLoadError = error
            appendDiagnostic("error", "Failed to update backend secrets in Keychain: \(error.localizedDescription)")
        }
    }

    /// Every runner the settings pane needs to present. The live/public catalog
    /// leads, while bundled bootstrap-only runners are appended so their local
    /// prerequisites remain editable when the two lists legitimately differ.
    /// A public runner with no bundled descriptor still appears here for the
    /// backend runtime-readiness row and receives no local controls.
    var runnerSettingsDescriptors: [RunnerDescriptor] {
        var descriptors = runnerCatalog.descriptors
        var runnerKinds = Set(descriptors.map(\.runnerKind))
        for bootstrapDescriptor in bootstrapDescriptors
            where runnerKinds.insert(bootstrapDescriptor.runnerKind).inserted {
            descriptors.append(runnerCatalog.descriptor(for: bootstrapDescriptor.runnerKind))
        }
        return descriptors
    }

    /// The trusted/local half of one runner's settings section. Absence is an
    /// honest "no local check" and never falls back to another runner.
    func runnerBootstrapDescriptor(for runnerKind: String) -> RunnerBootstrapDescriptor? {
        bootstrapDescriptors.first { $0.runnerKind == runnerKind }
    }

    func bootstrapStatus(runnerKind: String, probeID: String) -> RunnerBootstrapCheckStatus? {
        bootstrapStatuses[Self.bootstrapKey(runnerKind: runnerKind, probeID: probeID)]
    }

    /// Re-run every bundled bootstrap probe. Runs at launch and behind the
    /// dashboard's "Run safe checks", because these read the operator's own
    /// machine and never the backend — which is the point: they have to answer
    /// while it is stopped.
    func checkRunnerBootstrap() {
        for descriptor in bootstrapDescriptors {
            for probe in descriptor.probes {
                checkRunnerBootstrap(probe, of: descriptor)
            }
        }
    }

    /// Run one probe, persisting whatever path it resolved so the next backend
    /// launch uses it.
    @discardableResult
    func checkRunnerBootstrap(
        _ probe: RunnerBootstrapProbe,
        of descriptor: RunnerBootstrapDescriptor
    ) -> RunnerBootstrapCheckStatus {
        let outcome = bootstrapProber.run(probe, of: descriptor) { slotID in
            secrets.slotValue(runnerKind: descriptor.runnerKind, slotID: slotID)
        }
        var status = outcome.status
        if let resolved = outcome.resolvedSlot {
            do {
                var updated = secrets
                updated.setSlotValue(resolved.path, runnerKind: descriptor.runnerKind, slotID: resolved.slotID)
                try secretStore.saveSecrets(updated)
                secrets = try secretStore.loadSecrets()
                secretLoadError = nil
            } catch {
                // A resolved path that could not be stored is not a success: the
                // next launch would not use it, so the probe reports its own
                // failure message rather than a path the backend never sees.
                secretLoadError = error
                status = .failed(
                    message: probe.messages.filled(probe.messages.failure, with: error.localizedDescription)
                )
            }
        }
        bootstrapStatuses[Self.bootstrapKey(runnerKind: descriptor.runnerKind, probeID: probe.id)] = status
        appendDiagnostic(Self.diagnosticLevel(for: status, requirement: probe.requirement), probe.message(for: status))
        return status
    }

    /// Fill a runner's slots from a source checkout the operator chose.
    ///
    /// The walk is pure and happens first: nothing is written unless something
    /// was derived, and a partial result is still saved, because an operator who
    /// gets two of three fields filled is better off than one who gets none and
    /// no reason why. What could not be derived is reported rather than left as
    /// a silently empty field.
    @discardableResult
    func adoptSourceCheckout(_ root: URL, of descriptor: RunnerBootstrapDescriptor) -> RunnerBootstrapCheckStatus {
        guard let contract = descriptor.sourceCheckout else {
            return .failed(message: "\(descriptor.runnerKind) has no source-checkout layout in this build.")
        }
        let resolution = contract.resolve(root: root)
        var status: RunnerBootstrapCheckStatus
        var message: String

        if resolution.slots.isEmpty {
            status = .failed(message: "")
            message = "Nothing could be derived from \(root.path). " + resolution.problems.joined(separator: " ")
        } else {
            do {
                var updated = secrets
                for slot in resolution.slots {
                    updated.setSlotValue(slot.value, runnerKind: descriptor.runnerKind, slotID: slot.slotID)
                }
                try secretStore.saveSecrets(updated)
                secrets = try secretStore.loadSecrets()
                secretLoadError = nil
                status = .detected(detail: root.path)
                // Naming the composition is not a flourish: it decides what
                // bounds the agent, so "filled 3 fields" would hide the one
                // choice the operator most needs to see was made for them.
                let filled = "Filled \(resolution.slots.count) field(s) from \(root.lastPathComponent)."
                let composition = resolution.compositionPath.map { " Composition: \($0). Read it before running a turn." } ?? ""
                let problems = resolution.problems.isEmpty ? "" : " " + resolution.problems.joined(separator: " ")
                message = filled + composition + problems + " Restart the backend to apply."
            } catch {
                secretLoadError = error
                status = .failed(message: "")
                message = "Could not save the derived paths: \(error.localizedDescription)"
            }
        }

        sourceCheckoutOutcomes[descriptor.runnerKind] = RunnerBootstrapSourceCheckoutOutcome(
            status: status,
            message: message
        )
        appendDiagnostic(status.isSatisfied ? "info" : "warning", message)
        return status
    }

    /// Ask the backend to establish its own runtime readiness for one runner.
    ///
    /// Reading a runner's capabilities *is* the probe — it spawns the child,
    /// handshakes, and reads the model list — so this makes no separate call and
    /// adds no route. `GET /api/runners` then reports what it proved, which is
    /// why the catalog is re-read afterwards.
    func checkRunnerRuntimeReadiness(runnerKind: String) async {
        do {
            _ = try await apiClient.fetchCodingAgentCapabilities(runnerKind: runnerKind)
        } catch {
            // The readiness observer records a server-side discovery failure
            // before the capabilities route rethrows it, so the catalog still
            // needs to be re-read. A transport failure is also followed by the
            // same best-effort read, which either recovers or uses the floor.
            appendDiagnostic("warning", "Runner readiness check failed: \(error.localizedDescription)")
        }
        await refreshRunnerCatalog()
    }

    /// Store one tier-3 slot value. A blank value clears the slot, so an emptied
    /// field stops being injected rather than launching the backend with `""`.
    func updateRunnerBootstrapSlot(_ value: String, runnerKind: String, slotID: String) {
        var updated = secrets
        updated.setSlotValue(value, runnerKind: runnerKind, slotID: slotID)
        guard updated != secrets else { return }
        updateBackendSecrets(updated)
        guard secrets == updated,
              let descriptor = bootstrapDescriptors.first(where: { $0.runnerKind == runnerKind }) else {
            return
        }
        // A probe answer describes the old stored value. Once that value
        // changes, readiness must return to unchecked until the operator reruns
        // the probe; otherwise a formerly valid path can make a new invalid one
        // look ready.
        for probe in descriptor.probes where probe.resolvedSlotID == slotID {
            bootstrapStatuses.removeValue(forKey: Self.bootstrapKey(runnerKind: runnerKind, probeID: probe.id))
        }
    }

    private static func bootstrapKey(runnerKind: String, probeID: String) -> String {
        "\(runnerKind)/\(probeID)"
    }

    /// An unmet *informational* prerequisite is not a warning — Claude Code's
    /// bundled CLI is a working default — so the requirement decides the level.
    private static func diagnosticLevel(
        for status: RunnerBootstrapCheckStatus,
        requirement: RunnerBootstrapProbe.Requirement
    ) -> String {
        switch status {
        case .satisfied, .detected:
            "info"
        case .absent:
            requirement == .required ? "warning" : "info"
        case .failed:
            "error"
        }
    }

    /// What the lifecycle controls render from. Each folds the reported state
    /// together with whether a process is actually there, so a button is
    /// offered exactly when pressing it would do something.
    var canStartBackend: Bool {
        serverState.canStart && !hasSupervisedProcess
    }

    var canStopBackend: Bool {
        serverState.canStop || hasSupervisedProcess
    }

    var canRestartBackend: Bool {
        serverState.canRestart || hasSupervisedProcess
    }

    func startServer() {
        Task { await startServerIfNeeded() }
    }

    func stopServer() {
        Task { await stopServerGracefully() }
    }

    func restartServer() {
        Task { await restartServerIfPossible() }
    }

    func resetLocalDiagnostics() {
        diagnostics.removeAll()
        processLogs.removeAll()
        healthDiagnostics = nil
        configDiagnostics = nil
        recentLogsDiagnostics = nil
        auditTrailDiagnostics = nil
        diagnosticsExportMessage = nil
        health = nil
        workspaceSnapshot = nil
        connectionState = .unknown
        appendDiagnostic("info", "Reset local diagnostics and cached backend snapshots.")
    }

    func stopForApplicationTermination() async -> Bool {
        cancelPendingCrashRestart()
        guard let process = supervisedProcessController else { return true }

        isGracefullyStopping = true
        serverState = .stopping
        appendDiagnostic("info", "Stopping backend sidecar before application termination.")
        let stopped = await BackendProcessTerminator().stopAndWait(process)
        if !stopped {
            serverState = .failed
            appendDiagnostic("error", "Application termination was cancelled because the backend sidecar did not stop.")
        }
        return stopped
    }

    // MARK: - Sidecar adoption

    /// Whether a backend this app supervises is running — spawned in this
    /// session, or adopted from an earlier one.
    private var supervisedProcessIsRunning: Bool {
        backendProcess?.isRunning == true || adoptedProcess?.isRunning == true
    }

    private var supervisedProcessController: (any BackendProcessControlling)? {
        if let process = backendProcess, process.isRunning {
            return process
        }
        if let adopted = adoptedProcess, adopted.isRunning {
            return adopted
        }
        return nil
    }

    /// Republishes `supervisedProcessIsRunning` for the views. Called at each
    /// point a supervised process starts or stops existing, which is the whole
    /// set of moments the answer can change.
    private func refreshSupervisedProcessFlag() {
        hasSupervisedProcess = supervisedProcessIsRunning
    }

    /// Recognise a sidecar left behind by a previous app session.
    ///
    /// Quitting normally stops the sidecar, but a force quit, a crash, or
    /// Xcode's stop button never reaches `applicationWillTerminate`: the child
    /// is reparented to launchd and keeps the port. Without this the next
    /// launch could only report a healthy backend it did not own and refuse to
    /// stop it, which left the operator no way out of the app at all.
    ///
    /// Only this app's own launch record is adopted. A backend the operator
    /// started themselves stays foreign, because stopping someone's `pnpm dev`
    /// from a button labelled Stop Backend is not this app's call.
    @discardableResult
    private func adoptRecordedSidecarIfPossible() -> Bool {
        if let adopted = adoptedProcess, adopted.isRunning {
            return true
        }
        guard backendProcess == nil, let recorded = sidecarRecordStore.load() else {
            return false
        }
        // A record written for a different port does not describe whatever is
        // answering on the one this app is configured for now.
        guard recorded.port == settings.serverPort else {
            return false
        }
        guard processInspector.isAlive(recorded) else {
            sidecarRecordStore.clear()
            return false
        }
        guard processInspector.ownsListeningTCPPort(recorded.port, for: recorded) else {
            appendDiagnostic(
                "warning",
                "The recorded sidecar (pid \(recorded.pid)) does not own the listening socket on port \(recorded.port); leaving the healthy backend external."
            )
            return false
        }

        adoptedProcess = AdoptedBackendProcess(identity: recorded, inspector: processInspector)
        isGracefullyStopping = false
        refreshSupervisedProcessFlag()
        startAdoptedProcessWatch()
        appendDiagnostic(
            "info",
            "Adopted the backend sidecar started by an earlier app session (pid \(recorded.pid)). "
                + "Its output went to that session, so process logs start here; use /api/logs for the backend's own log."
        )
        return true
    }

    private func recordLaunchedSidecar(_ process: Process) {
        guard let identity = processInspector.describe(
            pid: process.processIdentifier,
            port: settings.serverPort
        ) else {
            appendDiagnostic(
                "warning",
                "Could not record the backend sidecar's process identity; if this app is force quit, a new session will not be able to stop the sidecar."
            )
            sidecarRecordStore.clear()
            return
        }
        sidecarRecordStore.save(identity)
    }

    private func forgetSupervisedSidecar() {
        adoptedProcessWatchTask?.cancel()
        adoptedProcessWatchTask = nil
        adoptedProcess = nil
        sidecarRecordStore.clear()
        refreshSupervisedProcessFlag()
    }

    /// An adopted process was never this app's child, so there is no
    /// `terminationHandler` to fire and no exit status to read. Polling is the
    /// only way to notice it went away.
    private func startAdoptedProcessWatch() {
        adoptedProcessWatchTask?.cancel()
        adoptedProcessWatchTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                } catch {
                    return
                }
                guard let self else {
                    return
                }
                guard settleAdoptedProcessIfExited() else {
                    continue
                }
                return
            }
        }
    }

    /// Reports an adopted process's exit exactly once, whether the watch task
    /// or the stop path notices it first. Returns whether it had exited.
    @discardableResult
    private func settleAdoptedProcessIfExited() -> Bool {
        guard let adopted = adoptedProcess else {
            return true
        }
        guard !adopted.isRunning else {
            return false
        }
        adoptedProcessDidExit()
        return true
    }

    private func adoptedProcessDidExit() {
        let wasStopping = isGracefullyStopping
        forgetSupervisedSidecar()
        isGracefullyStopping = false
        if wasStopping {
            serverState = .stopped
            resetCachedBackendSnapshot(connectionState: .unknown)
            appendDiagnostic("info", "Backend sidecar stopped.")
            return
        }
        // No exit status exists for a process this app did not spawn, so an exit
        // nobody asked for is read the way an owned crash is — including the
        // auto-restart the operator configured. That is also what settles the
        // narrow race where a relaunched app adopts a sidecar whose own
        // exit-with-parent watchdog is about to stop it: the backend goes, and
        // this app starts a fresh one it fully owns.
        serverState = .failed
        resetCachedBackendSnapshot(connectionState: .unreachable)
        appendDiagnostic("error", "Adopted backend sidecar exited.")
        scheduleCrashRestartIfAllowed()
    }

    private func startServerIfNeeded() async {
        if supervisedProcessIsRunning {
            serverState = .running
            appendDiagnostic("info", "App-owned backend process is already running.")
            await refreshConnectionStatus()
            return
        }

        serverState = .starting
        resetCachedBackendSnapshot(connectionState: .checking)
        if let secretLoadError {
            serverState = .failed
            connectionState = .unknown
            appendDiagnostic("error", "Cannot start backend because Keychain secrets could not be loaded: \(secretLoadError.localizedDescription)")
            return
        }
        if portProbe.isLocalPortOpen(settings.serverPort) {
            let response: HealthResponse? = try? await apiClient.fetchHealth()
            if let response, response.ok {
                health = response
                connectionState = .reachable
                if adoptRecordedSidecarIfPossible() {
                    serverState = .running
                } else {
                    serverState = .externalRunning
                    appendDiagnostic("info", "Backend is already reachable on port \(settings.serverPort), but it was not started by this app.")
                }
            } else {
                serverState = .failed
                connectionState = .unreachable
                appendDiagnostic("error", "Port \(settings.serverPort) is already in use by another process.")
            }
            return
        }

        do {
            let runtime = try runtimeLocator.locateRuntime()
            let configuration = BackendLaunchConfiguration(
                runtime: runtime,
                settings: settings,
                secrets: secrets
            )
            try prepareAgentRoomHome()
            try launchBackend(with: configuration)
            appendDiagnostic("info", "Started backend sidecar with \(runtime.backendEntrypointURL.path).")
            await waitForStartedBackendReadiness()
        } catch {
            serverState = .failed
            connectionState = .unreachable
            appendDiagnostic("error", "Failed to start backend: \(error.localizedDescription)")
        }
    }

    private func stopServerGracefully() async {
        cancelPendingCrashRestart()
        if let process = backendProcess, process.isRunning {
            await requestGracefulStop(of: process, message: "Stopping backend sidecar.")
            return
        }

        if let adopted = adoptedProcess {
            // Stop is a user-requested outcome even if the process died between
            // the two-second watch ticks. Mark that intent before inspecting it
            // so settlement cannot classify the already-finished process as a
            // crash and schedule an unwanted restart.
            isGracefullyStopping = true
            if settleAdoptedProcessIfExited() {
                return
            }
            await requestGracefulStop(of: adopted, message: "Stopping the adopted backend sidecar.")
            try? await Task.sleep(for: .milliseconds(500))
            // Settling here rather than waiting for the next poll is what keeps
            // a restart from sitting on the watch interval; whichever notices
            // first reports the exit, and only once.
            settleAdoptedProcessIfExited()
            return
        }

        if serverState == .externalRunning {
            appendDiagnostic("info", "Backend is running outside this app; stop it from the process that started it.")
        } else {
            appendDiagnostic("info", "No app-owned backend process is running.")
        }
        if serverState != .failed && serverState != .externalRunning {
            serverState = .stopped
            resetCachedBackendSnapshot(connectionState: .unknown)
        }
    }

    private func requestGracefulStop(
        of process: any BackendProcessControlling,
        message: String
    ) async {
        serverState = .stopping
        isGracefullyStopping = true
        appendDiagnostic("info", message)
        process.interrupt()

        try? await Task.sleep(for: .seconds(3))
        if process.isRunning {
            appendDiagnostic("warning", "Backend did not stop after SIGINT; terminating process.")
            process.terminate()
        }
    }

    private func restartServerIfPossible() async {
        guard canRestartBackend else {
            if serverState == .externalRunning {
                appendDiagnostic("warning", "Cannot restart a backend that was started outside this app.")
            } else {
                appendDiagnostic("warning", "Restart requested while backend is not app-owned and running.")
            }
            return
        }

        appendDiagnostic("info", "Restarting app-owned backend sidecar.")
        await stopServerGracefully()
        for _ in 0..<20 {
            if backendProcess == nil && adoptedProcess == nil {
                break
            }
            try? await Task.sleep(for: .milliseconds(250))
        }
        if backendProcess != nil || adoptedProcess != nil {
            serverState = .failed
            appendDiagnostic("error", "Backend restart timed out while waiting for the current process to stop.")
            return
        }
        await startServerIfNeeded()
    }

    func refreshConnectionStatus() async {
        connectionState = .checking
        appendDiagnostic("info", "Checking \(localServerURLString)/health.")
        do {
            let response = try await apiClient.fetchHealth()
            health = response
            connectionState = response.ok ? .reachable : .unreachable
            if response.ok {
                if serverState != .stopping {
                    // A healthy backend this app can recognise as its own is
                    // running, not foreign — which is the whole point of the
                    // launch record. See `adoptRecordedSidecarIfPossible`.
                    serverState = supervisedProcessIsRunning || adoptRecordedSidecarIfPossible()
                        ? .running
                        : .externalRunning
                }
                appendDiagnostic("info", "Backend reachable. Runner: \(response.runnerKind), mode: \(response.mode).")
                startBackendSettingsEventMonitor()
                await refreshWorkspaces()
                await refreshBackendSettingsMetadata()
            } else {
                backendSettingsEventMonitor.disconnect()
                runnerCatalog = offlineRunnerCatalog
                appendDiagnostic("warning", "Backend responded but did not report healthy state.")
            }
        } catch {
            backendSettingsEventMonitor.disconnect()
            health = nil
            workspaceSnapshot = nil
            runnerCatalog = offlineRunnerCatalog
            connectionState = .unreachable
            if serverState == .running || serverState == .externalRunning {
                serverState = .failed
            }
            appendDiagnostic("error", "Backend health check failed: \(error.localizedDescription)")
        }
    }

    private func waitForStartedBackendReadiness() async {
        appendDiagnostic("info", "Waiting for backend health check.")
        var lastErrorDescription: String?

        for attempt in 1...backendReadinessAttempts {
            guard backendProcess?.isRunning == true else {
                return
            }

            do {
                let response = try await apiClient.fetchHealth()
                health = response
                if response.ok {
                    connectionState = .reachable
                    serverState = .running
                    appendDiagnostic("info", "Backend reachable. Runner: \(response.runnerKind), mode: \(response.mode).")
                    startBackendSettingsEventMonitor()
                    await refreshWorkspaces()
                    await refreshBackendSettingsMetadata()
                    return
                }
                connectionState = .checking
                lastErrorDescription = "Backend responded but did not report healthy state."
            } catch {
                lastErrorDescription = error.localizedDescription
            }

            if attempt < backendReadinessAttempts {
                try? await Task.sleep(for: backendReadinessDelay)
            }
        }

        health = nil
        workspaceSnapshot = nil
        connectionState = .unreachable
        if backendProcess?.isRunning == true {
            serverState = .failed
        }
        appendDiagnostic(
            "error",
            "Backend did not become reachable after launch: \(lastErrorDescription ?? "health check timed out")."
        )
    }

    func refreshWorkspaces() async {
        do {
            let snapshot = try await apiClient.fetchWorkspaces()
            workspaceSnapshot = snapshot
            appendDiagnostic("info", "Loaded local workspace registry.")
        } catch {
            workspaceSnapshot = nil
            appendDiagnostic("warning", "Could not load /api/workspaces: \(error.localizedDescription)")
        }
    }

    func registerWorkspace(path: String) async {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            appendDiagnostic("warning", "Workspace folder path cannot be empty.")
            return
        }

        do {
            let workspace = try await apiClient.registerWorkspace(path: trimmed)
            await refreshWorkspaces()
            appendDiagnostic("info", "Registered workspace \(workspace.name).")
        } catch {
            appendDiagnostic("error", "Failed to register workspace folder: \(error.localizedDescription)")
        }
    }

    func unregisterWorkspace(_ workspace: LocalWorkspace) async {
        do {
            try await apiClient.unregisterWorkspace(workspaceId: workspace.id)
            await refreshWorkspaces()
            appendDiagnostic("info", "Removed workspace \(workspace.name) from the registry.")
        } catch {
            appendDiagnostic("error", "Failed to remove workspace \(workspace.name): \(error.localizedDescription)")
        }
    }

    func switchWorkspaceBranch(_ workspace: LocalWorkspace, branch: String) async {
        guard workspace.git.branch != branch else {
            return
        }
        do {
            let response = try await apiClient.switchWorkspaceBranch(workspaceId: workspace.id, branch: branch)
            await refreshWorkspaces()
            let action = response.changed ? "Switched" : "Confirmed"
            appendDiagnostic("info", "\(action) workspace \(response.workspace.name) on branch \(response.branch).")
        } catch {
            appendDiagnostic("error", "Failed to switch \(workspace.name) branch: \(error.localizedDescription)")
        }
    }

    // MARK: - Editor language catalog (Phase C.5)

    /// Refresh the operator-facing catalog status (source/version/language count)
    /// for the Languages settings pane.
    func refreshEditorCatalogStatus() async {
        do {
            editorCatalogStatus = try await apiClient.fetchEditorCatalogStatus()
        } catch {
            editorCatalogStatus = nil
            appendDiagnostic("warning", "Could not load editor catalog status: \(error.localizedDescription)")
        }
    }

    /// Import a catalog folder into the app-managed override dir (data-only copy),
    /// then ask the running backend to reload so connected Vision Pro editors update.
    func importEditorCatalog(from sourceURL: URL) async {
        editorCatalogActionStatus = .working("Importing catalog…")
        do {
            // The copy includes multi-MB .wasm files; running it synchronously on
            // the main actor hung the UI for the duration of the import.
            let destinationPath = settings.editorCatalogPath
            let summary = try await Task.detached(priority: .userInitiated) {
                try EditorCatalogImporter().importCatalog(from: sourceURL, into: destinationPath)
            }.value
            let result = try await apiClient.reloadEditorCatalog()
            await refreshEditorCatalogStatus()
            editorCatalogActionStatus = .success("Imported \(summary.fileCount) files. Backend serving the \(result.source.rawValue) catalog.")
            appendDiagnostic("info", "Imported editor catalog (\(summary.fileCount) files); backend now serving \(result.source.rawValue).")
        } catch {
            editorCatalogActionStatus = .failure("Import failed: \(error.localizedDescription)")
            appendDiagnostic("error", "Failed to import editor catalog: \(error.localizedDescription)")
        }
    }

    /// Ask the running backend to re-read the catalog directory and swap in any
    /// changes (e.g. after editing files in the override dir directly).
    func reloadEditorCatalog() async {
        editorCatalogActionStatus = .working("Reloading catalog…")
        do {
            let result = try await apiClient.reloadEditorCatalog()
            await refreshEditorCatalogStatus()
            editorCatalogActionStatus = .success(result.changed ? "Reloaded; catalog updated." : "Reloaded; no changes.")
            appendDiagnostic("info", "Reloaded editor catalog (changed: \(result.changed), source: \(result.source.rawValue)).")
        } catch {
            editorCatalogActionStatus = .failure("Reload failed: \(error.localizedDescription)")
            appendDiagnostic("error", "Failed to reload editor catalog: \(error.localizedDescription)")
        }
    }

    /// Empty the override dir and reload so the backend falls back to its bundled
    /// catalog.
    func resetEditorCatalog() async {
        editorCatalogActionStatus = .working("Resetting to bundled…")
        do {
            try EditorCatalogImporter().reset(settings.editorCatalogPath)
            let result = try await apiClient.reloadEditorCatalog()
            await refreshEditorCatalogStatus()
            editorCatalogActionStatus = .success("Reset to the \(result.source.rawValue) catalog.")
            appendDiagnostic("info", "Reset editor catalog override; backend now serving \(result.source.rawValue).")
        } catch {
            editorCatalogActionStatus = .failure("Reset failed: \(error.localizedDescription)")
            appendDiagnostic("error", "Failed to reset editor catalog: \(error.localizedDescription)")
        }
    }

    func refreshDiagnosticsData() async {
        await refreshConnectionStatus()
        async let healthResult = diagnosticsRequestRaw("health")
        async let configResult = diagnosticsRequestRaw("api/config")
        async let logsResult = diagnosticsRequestRaw("api/logs")
        async let auditResult = diagnosticsRequestRaw("api/audit")

        healthDiagnostics = await diagnosticsValue(for: "/health", result: healthResult)
        configDiagnostics = await diagnosticsValue(for: "/api/config", result: configResult)
        recentLogsDiagnostics = await diagnosticsValue(for: "/api/logs", result: logsResult)
        auditTrailDiagnostics = await diagnosticsValue(for: "/api/audit", result: auditResult)
        appendDiagnostic("info", "Refreshed health, safe config, recent logs, and audit trail diagnostics.")
    }

    func writeDiagnosticsBundle(to url: URL) async {
        if healthDiagnostics == nil || configDiagnostics == nil || recentLogsDiagnostics == nil || auditTrailDiagnostics == nil {
            await refreshDiagnosticsData()
        }

        let bundle = DiagnosticsBundle(
            generatedAt: Date(),
            app: DiagnosticsBundle.AppSection(
                serverState: serverState.rawValue,
                connectionState: connectionState.rawValue,
                localServerURL: localServerURLString,
                lanServerURLs: lanServerURLStrings,
                settings: SanitizedSettings(settings: settings, managedSettings: managedSettings),
                configuredSecrets: SanitizedSecretStatus(secrets: secrets)
            ),
            backend: DiagnosticsBundle.BackendSection(
                health: healthDiagnostics,
                config: configDiagnostics,
                recentLogs: recentLogsDiagnostics,
                auditTrail: auditTrailDiagnostics
            ),
            localDiagnostics: diagnostics,
            processLogs: processLogs
        )

        do {
            // Redaction is a multi-pass string sweep over every field and the
            // encode can be large; run both plus the file write off-main so the
            // export click doesn't hitch the UI.
            let secretsSnapshot = secrets
            try await Task.detached(priority: .utility) {
                let data = try JSONEncoder.diagnosticsEncoder.encode(bundle.redactingSecrets(secretsSnapshot))
                try data.write(to: url, options: .atomic)
            }.value
            diagnosticsExportMessage = "Exported diagnostics to \(url.path)."
            appendDiagnostic("info", "Exported diagnostics bundle without stored secret values.")
        } catch {
            diagnosticsExportMessage = "Failed to export diagnostics: \(error.localizedDescription)"
            appendDiagnostic("error", "Failed to export diagnostics bundle: \(error.localizedDescription)")
        }
    }

    private func diagnosticsRequestRaw(_ path: String) async -> Result<String, Error> {
        do {
            let raw = try await apiClient.fetchRaw(path)
            // /api/logs and /api/audit bodies can be hundreds of KB; re-parsing
            // and pretty-printing them belongs off the main actor.
            let pretty = await Task.detached(priority: .utility) { prettyJSON(raw) }.value
            return .success(pretty)
        } catch {
            return .failure(error)
        }
    }

    private func diagnosticsValue(for label: String, result: Result<String, Error>) -> String {
        switch result {
        case .success(let value):
            return value
        case .failure(let error):
            let message = "Failed to load \(label): \(error.localizedDescription)"
            appendDiagnostic("warning", message)
            return message
        }
    }

    private func prepareAgentRoomHome() throws {
        let result = try appSupportMigrator.migrateIfNeeded(settings: settings)
        if let migratedFrom = result.migratedFromSchemaVersion {
            appendDiagnostic("info", "Migrated app support data from schema \(migratedFrom) to \(result.schemaVersion).")
        } else {
            appendDiagnostic("info", "Verified app support data schema \(result.schemaVersion).")
        }
    }

    private func prepareAgentRoomHomeForLaunch() {
        do {
            try prepareAgentRoomHome()
        } catch {
            appendDiagnostic("error", "Failed to initialize app support storage: \(error.localizedDescription)")
        }
    }

    private func launchBackend(with configuration: BackendLaunchConfiguration) throws {
        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()

        process.executableURL = configuration.executableURL
        process.arguments = configuration.arguments
        process.environment = configuration.environment
        process.currentDirectoryURL = configuration.currentDirectoryURL
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.captureAvailableOutput(from: handle, stream: .stdout)
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.captureAvailableOutput(from: handle, stream: .stderr)
        }
        process.terminationHandler = { [weak self] process in
            Task { @MainActor in
                self?.backendProcessDidTerminate(process)
            }
        }

        backendProcess = process
        self.stdoutPipe = stdoutPipe
        self.stderrPipe = stderrPipe
        isGracefullyStopping = false
        try process.run()
        // Written after the spawn succeeds, so the record always describes a
        // process that existed. It is what lets the next app session recognise
        // this sidecar if this one never gets to stop it.
        recordLaunchedSidecar(process)
        refreshSupervisedProcessFlag()
    }

    private nonisolated func captureAvailableOutput(from handle: FileHandle, stream: BackendProcessStream) {
        let data = handle.availableData
        guard !data.isEmpty else {
            return
        }
        let output = String(data: data, encoding: .utf8) ?? "<non-UTF8 output>"
        // Line splitting happens off-main in the lock-guarded buffer; only the
        // first chunk of a burst schedules a flush, so a chatty backend costs
        // one main-actor hop and one log-array update per ~250 ms instead of
        // one hop per pipe chunk and one O(n) insert per line.
        guard processLogBuffer.append(chunk: output, stream: stream) else { return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(250))
            self?.flushProcessLogBuffer()
        }
    }

    private func flushProcessLogBuffer() {
        let entries = processLogBuffer.drain()
        guard !entries.isEmpty else { return }
        // Display order is newest-first; prepend the batch in one pass.
        let newLines = entries.reversed().map {
            BackendProcessLogLine(timestamp: $0.timestamp, stream: $0.stream, message: $0.message)
        }
        processLogs = newLines + processLogs
        if processLogs.count > 300 {
            processLogs.removeLast(processLogs.count - 300)
        }
    }

    private func backendProcessDidTerminate(_ process: Process) {
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        processLogBuffer.flushPartialLines()
        flushProcessLogBuffer()

        if backendProcess === process {
            backendProcess = nil
        }
        // The sidecar this app was supervising is gone, so the record that
        // describes it is stale; leaving it would have a later session try to
        // adopt a dead pid.
        forgetSupervisedSidecar()
        stdoutPipe = nil
        stderrPipe = nil

        let status = process.terminationStatus
        if isGracefullyStopping || status == 0 {
            serverState = .stopped
            resetCachedBackendSnapshot(connectionState: .unknown)
            appendDiagnostic("info", "Backend sidecar stopped.")
        } else {
            serverState = .failed
            resetCachedBackendSnapshot(connectionState: .unreachable)
            appendDiagnostic("error", "Backend sidecar exited with status \(status).")
            scheduleCrashRestartIfAllowed()
        }
        isGracefullyStopping = false
    }

    private func scheduleCrashRestartIfAllowed() {
        guard settings.autoRestartBackendAfterCrash else {
            appendDiagnostic("warning", "Crash auto-restart is disabled.")
            return
        }
        guard restartLimiter.recordCrashAndShouldRestart() else {
            appendDiagnostic("error", "Crash auto-restart limit reached; manual restart required.")
            return
        }
        appendDiagnostic("warning", "Auto-restarting backend sidecar after unexpected exit.")
        serverState = .starting
        pendingCrashRestartTask?.cancel()
        pendingCrashRestartTask = Task { [weak self] in
            do {
                try await Task.sleep(for: self?.crashRestartDelay ?? .seconds(2))
            } catch {
                return
            }
            guard let self else {
                return
            }
            guard settings.autoRestartBackendAfterCrash, serverState == .starting, backendProcess == nil else {
                pendingCrashRestartTask = nil
                return
            }
            pendingCrashRestartTask = nil
            await startServerIfNeeded()
        }
    }

    private func cancelPendingCrashRestart() {
        pendingCrashRestartTask?.cancel()
        pendingCrashRestartTask = nil
    }

    private func resetCachedBackendSnapshot(connectionState: BackendConnectionState) {
        backendSettingsEventMonitor.disconnect()
        health = nil
        workspaceSnapshot = nil
        // Provenance describes a running process; a stopped backend has none, and
        // stale metadata would let a pane claim a key is env-locked after the
        // environment that locked it is gone.
        backendSettingsMetadata = nil
        // Runner registration belongs to the process that supplied it. Once
        // that process is stopping, stopped, or being replaced, only the app's
        // identity-only offline floor remains authoritative.
        runnerCatalog = offlineRunnerCatalog
        self.connectionState = connectionState
    }

    /// Read the settings file, seeding it on first run from the values this app
    /// used to inject as environment variables so an upgrade preserves the
    /// behavior the operator was already getting. Once the file exists it is
    /// authoritative and the legacy defaults are never consulted again.
    private func loadManagedSettings(seedingFrom defaults: UserDefaults, fallback: ManagedBackendSettings? = nil) {
        let url = settings.managedSettingsFileURL
        let read = managedSettingsStore.read(at: url)
        preservedManagedSettings = read.preserved
        if let issue = read.issue {
            managedSettings = ManagedBackendSettings()
            managedSettingsIssue = issue
            managedSettingsSchemaVersion = nil
            appendDiagnostic("error", "Backend settings file \(issue); the backend is running on defaults until it is fixed or reset.")
            return
        }
        managedSettingsIssue = nil
        managedSettingsSchemaVersion = read.schemaVersion

        if fileManager.fileExists(atPath: url.path) {
            managedSettings = read.settings
            return
        }

        let seed = fallback ?? Self.legacyManagedSettingsSeed(from: defaults)
        do {
            try managedSettingsStore.write(seed, to: url)
            managedSettings = seed
            managedSettingsSchemaVersion = ManagedSettingsDocument.currentSchemaVersion
            appendDiagnostic("info", "Created backend settings file from the current app settings.")
        } catch {
            managedSettings = seed
            appendDiagnostic("error", "Failed to create backend settings file: \(error.localizedDescription)")
        }
    }

    /// Refresh without seeding or writing. Once initial migration has run, a
    /// missing file means backend defaults — for example after an operator
    /// deliberately removes it — and an external PATCH must replace the local
    /// snapshot rather than being overwritten by it later.
    func refreshManagedSettingsFromDisk() {
        let read = managedSettingsStore.read(at: settings.managedSettingsFileURL)
        let previousIssue = managedSettingsIssue
        // Kept even for an unusable file, since the reset path writes them back.
        preservedManagedSettings = read.preserved
        if let issue = read.issue {
            managedSettings = ManagedBackendSettings()
            managedSettingsIssue = issue
            managedSettingsSchemaVersion = nil
            if issue != previousIssue {
                appendDiagnostic("error", "Backend settings file \(issue); the backend is running on defaults until it is fixed or reset.")
            }
            return
        }

        managedSettings = read.settings
        managedSettingsIssue = nil
        managedSettingsSchemaVersion = read.schemaVersion
        if previousIssue != nil {
            appendDiagnostic("info", "Backend settings file is usable again.")
        }
    }

    /// One-time compatibility bridge for installs that stored
    /// CODEX_REASONING_EFFORT in Keychain. settings.json wins when it already
    /// has a value; otherwise a valid legacy value is merged into the file, then
    /// removed from the launch-secret blob so it cannot become an env lock.
    private func migrateLegacyCodexReasoningEffortIfNeeded() {
        guard managedSettingsIssue == nil,
              let rawValue = secrets.legacyCodexReasoningEffort?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rawValue.isEmpty else {
            return
        }

        do {
            if managedSettings.codexReasoningEffort == nil {
                if ManagedBackendSettings.reasoningEffortValues.contains(rawValue) {
                    managedSettings = try managedSettingsStore.update(at: settings.managedSettingsFileURL) {
                        if $0.codexReasoningEffort == nil {
                            $0.codexReasoningEffort = rawValue
                        }
                    }
                    // `update` also converts a legacy version-1 file to version 2
                    // when it writes. Re-read the whole snapshot so the offline
                    // rollback control reports the file's actual shape; assigning
                    // version 2 blindly would be wrong if another writer supplied
                    // the value before this read-merge-write ran.
                    refreshManagedSettingsFromDisk()
                    appendDiagnostic("info", "Migrated the default Codex reasoning effort from Keychain to backend settings.")
                } else {
                    appendDiagnostic("warning", "Discarded an invalid legacy Codex reasoning effort while moving the preference out of Keychain.")
                }
            }

            var migratedSecrets = secrets
            migratedSecrets.legacyCodexReasoningEffort = nil
            try secretStore.saveSecrets(migratedSecrets)
            secrets = try secretStore.loadSecrets()
            secretLoadError = nil
        } catch {
            secretLoadError = error
            appendDiagnostic("error", "Could not finish migrating the Codex reasoning effort: \(error.localizedDescription)")
        }
    }

    /// Read-merge-write one managed key, then re-read the backend's provenance so
    /// the pane's pending badge reflects the write that just landed.
    private func updateManagedSettings(
        describedAs description: String,
        _ mutate: (inout ManagedBackendSettings) -> Void
    ) {
        do {
            let previous = managedSettings
            managedSettings = try managedSettingsStore.update(at: settings.managedSettingsFileURL, mutate)
            managedSettingsIssue = nil
            // A control re-set to the value it already had writes nothing, so it
            // should not claim in the log that it changed something.
            guard managedSettings != previous else { return }
            // A write is also a migration when the file was still the flat
            // version-1 document, so the pane's "convert for an older AgentRoom"
            // offer has to come back with it.
            managedSettingsSchemaVersion = ManagedSettingsDocument.currentSchemaVersion
            appendDiagnostic("info", description)
            refreshBackendSettingsMetadataSoon()
        } catch {
            if case ManagedSettingsFileStoreError.unusableFile(let issue) = error {
                managedSettingsIssue = issue
            }
            appendDiagnostic("error", "Failed to update backend settings: \(error.localizedDescription)")
        }
    }

    private func refreshBackendSettingsMetadataSoon() {
        Task { await refreshBackendSettingsMetadata() }
    }

    private func startBackendSettingsEventMonitor() {
        backendSettingsEventMonitor.connect(
            baseURL: settings.localServerURL,
            authToken: secrets.authToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        ) { [weak self] in
            guard let self else { return }
            await refreshBackendSettingsMetadata()
        }
    }

    /// `/api/config` re-reads the settings file per request, so its metadata is
    /// the authority on both halves of what the panes show: which keys an
    /// environment variable locked, and what a restart would change.
    private func refreshBackendSettingsMetadata() async {
        refreshManagedSettingsFromDisk()
        guard connectionState == .reachable else {
            backendSettingsMetadata = nil
            // The floor, not the last-known catalog: with the backend stopped,
            // the honest statement is "the runners this app ships knowing", not
            // a list from a backend that is no longer answering.
            runnerCatalog = offlineRunnerCatalog
            return
        }
        do {
            backendSettingsMetadata = try await apiClient.fetchPublicConfig().settings
        } catch {
            backendSettingsMetadata = nil
            appendDiagnostic("warning", "Could not read backend settings metadata: \(error.localizedDescription)")
        }
        await refreshRunnerCatalog()
    }

    /// Hydrate the runner picker from the running backend. Best-effort in both
    /// directions: a backend that predates `/api/runners` answers `404`, and an
    /// empty list would leave the picker with nothing to choose — the built-in
    /// floor is the right answer for both.
    private func refreshRunnerCatalog() async {
        applyRunnerCatalog(try? await apiClient.fetchRunners())
    }

    /// One state transition for both a successful live read and its fallback.
    /// Internal so lifecycle tests can seed the same state the route supplies.
    func applyRunnerCatalog(_ response: RunnerCatalogResponse?) {
        guard let response, !response.runners.isEmpty else {
            runnerCatalog = offlineRunnerCatalog
            return
        }
        runnerCatalog = RunnerCatalog(descriptors: response.runners)
    }

    /// What the picker offers with no backend answering: the catalog a backend
    /// that started successfully left in `$AGENTROOM_HOME/config/runners.json`,
    /// else the runners this app was built knowing.
    ///
    /// The override exists because the floor cannot grow — a runner registered
    /// after this app shipped would otherwise be unselectable on exactly the
    /// screen an operator uses when the backend will not start. It is a cache and
    /// is treated like one: a live `GET /api/runners` always wins, and an absent,
    /// unreadable, or newer-versioned file falls back to the bundle rather than
    /// to nothing.
    private var offlineRunnerCatalog: RunnerCatalog {
        runnerCatalogStore.read(
            at: RunnerCatalogFileStore.fileURL(forAgentRoomHomePath: settings.agentRoomHomePath)
        ) ?? .builtIn
    }

    private func persistSettings() {
        defaults.set(settings.serverPort, forKey: SettingKey.serverPort)
        defaults.set(settings.workspacePath, forKey: SettingKey.workspacePath)
        defaults.set(settings.statePath, forKey: SettingKey.statePath)
        defaults.set(settings.agentRoomHomePath, forKey: SettingKey.agentRoomHomePath)
        defaults.set(settings.launchAtLoginEnabled, forKey: SettingKey.launchAtLoginEnabled)
        defaults.set(settings.autoRestartBackendAfterCrash, forKey: SettingKey.autoRestartBackendAfterCrash)
        defaults.set(settings.remoteSettingsAdminEnabled, forKey: SettingKey.remoteSettingsAdminEnabled)
    }

    private func appendDiagnostic(_ level: String, _ message: String) {
        diagnostics.insert(DiagnosticMessage(timestamp: Date(), level: level, message: message), at: 0)
        if diagnostics.count > 80 {
            diagnostics.removeLast(diagnostics.count - 80)
        }
    }

    private static func loadSettings(from defaults: UserDefaults) -> AppSettings {
        var settings = AppSettings.defaults
        let savedPort = defaults.integer(forKey: SettingKey.serverPort)
        if savedPort > 0 {
            settings.serverPort = savedPort
        }
        if let agentRoomHomePath = defaults.string(forKey: SettingKey.agentRoomHomePath), !agentRoomHomePath.isEmpty {
            settings.agentRoomHomePath = agentRoomHomePath
            settings.workspacePath = AppSettings.defaultWorkspacePath(for: agentRoomHomePath)
            settings.statePath = AppSettings.defaultStatePath(for: agentRoomHomePath)
        }
        if let workspacePath = defaults.string(forKey: SettingKey.workspacePath), !workspacePath.isEmpty {
            settings.workspacePath = workspacePath
        }
        if let statePath = defaults.string(forKey: SettingKey.statePath), !statePath.isEmpty {
            settings.statePath = statePath
        }
        settings.launchAtLoginEnabled = defaults.bool(forKey: SettingKey.launchAtLoginEnabled)
        if defaults.object(forKey: SettingKey.autoRestartBackendAfterCrash) != nil {
            settings.autoRestartBackendAfterCrash = defaults.bool(forKey: SettingKey.autoRestartBackendAfterCrash)
        }
        settings.remoteSettingsAdminEnabled = defaults.bool(forKey: SettingKey.remoteSettingsAdminEnabled)
        return settings
    }

    /// The first-run seed for `settings.json`, built from the app preferences
    /// that used to be injected as environment variables at launch. Every one of
    /// them is written explicitly, including the ones that match a backend
    /// default, because the app *always* injected a value before — so writing
    /// only the differences would quietly change what an upgraded install runs.
    private static func legacyManagedSettingsSeed(from defaults: UserDefaults) -> ManagedBackendSettings {
        var seed = ManagedBackendSettings()
        if let runnerKind = defaults.string(forKey: LegacySettingKey.runnerKind),
           AgentRunnerKind(rawValue: runnerKind) != nil {
            seed.runnerKind = runnerKind
        } else {
            seed.runnerKind = AppSettings.defaultRunnerKind
        }
        seed.setCodexGitNetworkAccess(defaults.bool(forKey: LegacySettingKey.codexWorkspaceNetworkAccessEnabled))
        seed.terminalEnabled = defaults.bool(forKey: LegacySettingKey.terminalEnabled)
        // Absent key keeps the backend default (ON); an explicit stored value wins.
        seed.sceneEngineEnabled = defaults.object(forKey: LegacySettingKey.sceneEngineEnabled) != nil
            ? defaults.bool(forKey: LegacySettingKey.sceneEngineEnabled)
            : ManagedBackendSettings.defaultSceneEngineEnabled
        return seed
    }
}

private enum SettingKey {
    static let serverPort = "serverPort"
    static let workspacePath = "workspacePath"
    static let statePath = "statePath"
    static let agentRoomHomePath = "agentRoomHomePath"
    static let launchAtLoginEnabled = "launchAtLoginEnabled"
    static let autoRestartBackendAfterCrash = "autoRestartBackendAfterCrash"
    static let remoteSettingsAdminEnabled = "remoteSettingsAdminEnabled"
}

/// Preferences that moved into the backend's `settings.json`. They are read once,
/// to seed that file on first run, and never written again.
private enum LegacySettingKey {
    static let codexWorkspaceNetworkAccessEnabled = "codexWorkspaceNetworkAccessEnabled"
    static let terminalEnabled = "terminalEnabled"
    static let sceneEngineEnabled = "sceneEngineEnabled"
    static let runnerKind = "runnerKind"
}
