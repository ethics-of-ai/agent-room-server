import Darwin
import XCTest
@testable import AgentRoomMac

/// A backend sidecar outlives an app that was force quit, crashed, or was
/// stopped from Xcode, because `applicationWillTerminate` never runs. These
/// pin the recovery: the next app session recognises its own orphan and
/// supervises it, and refuses to claim a backend it did not start.
@MainActor
final class BackendSupervisorAdoptionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        HealthyBackendURLProtocol.isHealthy = true
    }

    func testAdoptsTheSidecarRecordedByAPreviousAppSession() async {
        let defaults = makeDefaults()
        let inspector = FakeProcessInspector()
        let sidecar = inspector.stage(pid: 4242, port: AppSettings.defaultServerPort)
        BackendSidecarRecordStore(defaults: defaults).save(sidecar)

        let supervisor = makeSupervisor(defaults: defaults, inspector: inspector)
        await supervisor.refreshConnectionStatus()

        XCTAssertEqual(supervisor.serverState, .running)
        XCTAssertTrue(supervisor.hasSupervisedProcess)
        XCTAssertTrue(supervisor.canStopBackend)
        XCTAssertTrue(supervisor.canRestartBackend)
        XCTAssertFalse(supervisor.canStartBackend)
    }

    func testDoesNotClaimABackendThisAppDidNotStart() async {
        // No launch record: whatever is answering belongs to whoever started it,
        // and stopping someone's `pnpm dev` is not this app's call.
        let supervisor = makeSupervisor(defaults: makeDefaults(), inspector: FakeProcessInspector())
        await supervisor.refreshConnectionStatus()

        XCTAssertEqual(supervisor.serverState, .externalRunning)
        XCTAssertFalse(supervisor.hasSupervisedProcess)
        XCTAssertFalse(supervisor.canStopBackend)
    }

    func testDropsALaunchRecordWhoseProcessIsGone() async {
        let defaults = makeDefaults()
        let inspector = FakeProcessInspector()
        // Recorded, but no longer running: the healthy backend on the port is
        // somebody else's, and the stale record must not survive to be signalled.
        let store = BackendSidecarRecordStore(defaults: defaults)
        store.save(inspector.identity(pid: 4242, port: AppSettings.defaultServerPort))

        let supervisor = makeSupervisor(defaults: defaults, inspector: inspector)
        await supervisor.refreshConnectionStatus()

        XCTAssertEqual(supervisor.serverState, .externalRunning)
        XCTAssertNil(store.load())
    }

    func testDoesNotAdoptARecordedProcessThatDoesNotOwnTheHealthyPort() async {
        let defaults = makeDefaults()
        let inspector = FakeProcessInspector()
        let sidecar = inspector.stage(
            pid: 4242,
            port: AppSettings.defaultServerPort,
            ownsPort: false
        )
        let store = BackendSidecarRecordStore(defaults: defaults)
        store.save(sidecar)

        let supervisor = makeSupervisor(defaults: defaults, inspector: inspector)
        await supervisor.refreshConnectionStatus()

        XCTAssertEqual(supervisor.serverState, .externalRunning)
        XCTAssertFalse(supervisor.hasSupervisedProcess)
        XCTAssertFalse(supervisor.canStopBackend)
        // The process identity is real but does not explain the healthy port.
        // Keep the record for a later truthful observation; never signal it as
        // the service currently answering.
        XCTAssertEqual(store.load(), sidecar)
    }

    func testDoesNotAdoptARecordWrittenForADifferentPort() async {
        let defaults = makeDefaults()
        let inspector = FakeProcessInspector()
        let sidecar = inspector.stage(pid: 4242, port: AppSettings.defaultServerPort + 1)
        BackendSidecarRecordStore(defaults: defaults).save(sidecar)

        let supervisor = makeSupervisor(defaults: defaults, inspector: inspector)
        await supervisor.refreshConnectionStatus()

        // The recorded sidecar is alive, but it is not what answers on the port
        // this app is configured for now.
        XCTAssertEqual(supervisor.serverState, .externalRunning)
    }

    func testStoppingAnAdoptedSidecarSignalsItAndSettles() async {
        let defaults = makeDefaults()
        let inspector = FakeProcessInspector()
        let sidecar = inspector.stage(pid: 4242, port: AppSettings.defaultServerPort)
        let store = BackendSidecarRecordStore(defaults: defaults)
        store.save(sidecar)
        // The sidecar honours SIGINT, as the backend does: it installs no
        // handler, so the default disposition ends it.
        inspector.onSignal = { [weak inspector] signal, pid in
            if signal == SIGINT {
                inspector?.retire(pid: pid)
            }
        }

        let supervisor = makeSupervisor(defaults: defaults, inspector: inspector)
        await supervisor.refreshConnectionStatus()
        XCTAssertEqual(supervisor.serverState, .running)

        supervisor.stopServer()
        await waitFor(supervisor, toReach: .stopped)

        XCTAssertEqual(inspector.signals.map(\.signal), [SIGINT])
        XCTAssertEqual(supervisor.serverState, .stopped)
        // Nothing is left to adopt on the next launch.
        XCTAssertNil(store.load())
    }

    func testStopSettlesAnAdoptedSidecarThatExitedBeforeTheWatchPoll() async {
        let defaults = makeDefaults()
        let inspector = FakeProcessInspector()
        let sidecar = inspector.stage(pid: 4242, port: AppSettings.defaultServerPort)
        BackendSidecarRecordStore(defaults: defaults).save(sidecar)

        let supervisor = makeSupervisor(defaults: defaults, inspector: inspector)
        await supervisor.refreshConnectionStatus()
        XCTAssertEqual(supervisor.serverState, .running)

        // The process ends after adoption but before the two-second watch task
        // sees it. Stop must settle that fact as the requested outcome instead
        // of classifying it as a crash and scheduling an automatic restart.
        inspector.retire(pid: sidecar.pid)
        supervisor.stopServer()
        await waitFor(supervisor, toReach: .stopped)

        XCTAssertEqual(supervisor.serverState, .stopped)
        XCTAssertFalse(supervisor.hasSupervisedProcess)
        XCTAssertTrue(inspector.signals.isEmpty)
        XCTAssertFalse(supervisor.diagnostics.contains { $0.message.contains("Auto-restarting") })
    }

    /// A matching record and a healthy response still do not prove causation:
    /// the recorded pid must own the listening socket. This uses the real
    /// inspector to keep that boundary pinned outside the fake.
    func testRealInspectorDoesNotAdoptAProcessWithoutTheBackendSocket() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["300"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }

        let defaults = makeDefaults()
        let inspector = DarwinProcessInspector()
        let identity = try XCTUnwrap(
            inspector.describe(pid: process.processIdentifier, port: AppSettings.defaultServerPort)
        )
        let store = BackendSidecarRecordStore(defaults: defaults)
        store.save(identity)

        let supervisor = BackendSupervisor(
            defaults: defaults,
            secretStore: StubSecretStore(),
            bootstrapProber: RunnerBootstrapTestSupport.prober(),
            apiURLSession: HealthyBackendURLProtocol.session(),
            launchAtLoginController: StubLaunchAtLogin(),
            processInspector: inspector
        )
        await supervisor.refreshConnectionStatus()

        XCTAssertEqual(supervisor.serverState, .externalRunning)
        XCTAssertTrue(process.isRunning)
        XCTAssertEqual(store.load(), identity)
    }

    /// A backend that is still running but has stopped answering health lands
    /// in `failed`, which reports nothing about whether a process is there.
    /// Stop has to stay available, or the operator is back in the same corner
    /// the orphan put them in.
    func testKeepsStopAvailableWhenAnAdoptedBackendStopsAnsweringHealth() async {
        let defaults = makeDefaults()
        let inspector = FakeProcessInspector()
        inspector.stage(pid: 4242, port: AppSettings.defaultServerPort)
        BackendSidecarRecordStore(defaults: defaults).save(
            inspector.identity(pid: 4242, port: AppSettings.defaultServerPort)
        )

        let supervisor = makeSupervisor(defaults: defaults, inspector: inspector)
        await supervisor.refreshConnectionStatus()
        XCTAssertEqual(supervisor.serverState, .running)

        HealthyBackendURLProtocol.isHealthy = false
        await supervisor.refreshConnectionStatus()

        XCTAssertEqual(supervisor.serverState, .failed)
        XCTAssertTrue(supervisor.hasSupervisedProcess)
        XCTAssertTrue(supervisor.canStopBackend)
        // Nothing is offered that would do nothing: a running process is not
        // started again.
        XCTAssertFalse(supervisor.canStartBackend)
    }

    // MARK: - Process inspection

    func testDarwinInspectorDescribesALiveProcessAndForgetsADeadOne() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        addTeardownBlock { if process.isRunning { process.terminate() } }

        let inspector = DarwinProcessInspector()
        let identity = try XCTUnwrap(inspector.describe(pid: process.processIdentifier, port: 8787))
        XCTAssertEqual(identity.executablePath, "/bin/sleep")
        XCTAssertTrue(inspector.isAlive(identity))

        process.terminate()
        process.waitUntilExit()
        XCTAssertFalse(inspector.isAlive(identity))
    }

    func testDarwinInspectorRefusesToSignalAPidItNoLongerDescribes() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()

        let inspector = DarwinProcessInspector()
        var identity = try XCTUnwrap(inspector.describe(pid: process.processIdentifier, port: 8787))
        process.terminate()
        process.waitUntilExit()

        // Pids are recycled, so a record that no longer matches the process at
        // that number must never be signalled — the check lives in the
        // inspector so no caller can skip it.
        XCTAssertFalse(inspector.signal(SIGINT, to: identity))
        identity.startTimeSeconds += 1
        XCTAssertFalse(inspector.signal(SIGINT, to: identity))
    }

    func testDarwinInspectorFindsOnlyPortsListenedToByTheRecordedProcess() throws {
        let listener = try makeListeningSocket()
        addTeardownBlock { Darwin.close(listener.descriptor) }

        let inspector = DarwinProcessInspector()
        let identity = try XCTUnwrap(inspector.describe(pid: getpid(), port: listener.port))

        XCTAssertTrue(inspector.ownsListeningTCPPort(listener.port, for: identity))
        XCTAssertFalse(inspector.ownsListeningTCPPort(listener.port + 1, for: identity))
    }

    func testSidecarRecordSurvivesAWriteAndRead() {
        let defaults = makeDefaults()
        let store = BackendSidecarRecordStore(defaults: defaults)
        XCTAssertNil(store.load())

        let identity = BackendProcessIdentity(
            pid: 4242,
            startTimeSeconds: 1_787_576_264,
            startTimeMicroseconds: 404_147,
            executablePath: "/Applications/AgentRoom.app/Contents/Resources/node/bin/node",
            port: 8787
        )
        store.save(identity)
        XCTAssertEqual(store.load(), identity)

        store.clear()
        XCTAssertNil(store.load())
    }

    // MARK: - Support

    /// The stop path deliberately gives the backend a few seconds to honour
    /// SIGINT before escalating, so the settled state is awaited rather than
    /// asserted immediately.
    private func waitFor(
        _ supervisor: BackendSupervisor,
        toReach expected: BackendServerState,
        timeout: Duration = .seconds(10)
    ) async {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            if supervisor.serverState == expected {
                return
            }
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    private func makeDefaults() -> UserDefaults {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set(root.path, forKey: "agentRoomHomePath")
        defaults.set(root.appendingPathComponent("workspaces", isDirectory: true).path, forKey: "workspacePath")
        defaults.set(root.appendingPathComponent("state", isDirectory: true).path, forKey: "statePath")
        return defaults
    }

    private func makeListeningSocket() throws -> (descriptor: Int32, port: Int) {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw POSIXError(.EIO)
        }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.stride)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.stride))
            }
        }
        guard bindResult == 0, Darwin.listen(descriptor, 1) == 0 else {
            Darwin.close(descriptor)
            throw POSIXError(.EADDRINUSE)
        }

        var addressLength = socklen_t(MemoryLayout<sockaddr_in>.stride)
        let nameResult = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(descriptor, $0, &addressLength)
            }
        }
        guard nameResult == 0 else {
            Darwin.close(descriptor)
            throw POSIXError(.EIO)
        }
        return (descriptor, Int(UInt16(bigEndian: address.sin_port)))
    }

    private func makeSupervisor(
        defaults: UserDefaults,
        inspector: FakeProcessInspector
    ) -> BackendSupervisor {
        BackendSupervisor(
            defaults: defaults,
            secretStore: StubSecretStore(),
            bootstrapProber: RunnerBootstrapTestSupport.prober(),
            apiURLSession: HealthyBackendURLProtocol.session(),
            launchAtLoginController: StubLaunchAtLogin(),
            processInspector: inspector
        )
    }
}

/// Records what the supervisor asked of a process, and lets a test decide which
/// pids are live without spawning anything.
private final class FakeProcessInspector: BackendProcessInspecting {
    private var live: [pid_t: BackendProcessIdentity] = [:]
    private var listeningPorts: [pid_t: Set<Int>] = [:]
    private(set) var signals: [(signal: Int32, pid: pid_t)] = []
    var onSignal: ((Int32, pid_t) -> Void)?

    func identity(pid: pid_t, port: Int) -> BackendProcessIdentity {
        BackendProcessIdentity(
            pid: pid,
            startTimeSeconds: 1_787_576_264,
            startTimeMicroseconds: 404_147,
            executablePath: "/Applications/AgentRoom.app/Contents/Resources/node/bin/node",
            port: port
        )
    }

    /// Marks a pid live and returns the identity a launch would have recorded.
    @discardableResult
    func stage(pid: pid_t, port: Int, ownsPort: Bool = true) -> BackendProcessIdentity {
        let identity = identity(pid: pid, port: port)
        live[pid] = identity
        listeningPorts[pid] = ownsPort ? [port] : []
        return identity
    }

    func retire(pid: pid_t) {
        live.removeValue(forKey: pid)
        listeningPorts.removeValue(forKey: pid)
    }

    // Mirrors the Darwin reader: the port is what the caller asked about, not
    // something the kernel knows, so a record written for another port fails the
    // identity comparison rather than the lookup.
    func describe(pid: pid_t, port: Int) -> BackendProcessIdentity? {
        guard var identity = live[pid] else {
            return nil
        }
        identity.port = port
        return identity
    }

    func ownsListeningTCPPort(_ port: Int, for identity: BackendProcessIdentity) -> Bool {
        isAlive(identity) && listeningPorts[identity.pid]?.contains(port) == true
    }

    @discardableResult
    func signal(_ signal: Int32, to identity: BackendProcessIdentity) -> Bool {
        guard describe(pid: identity.pid, port: identity.port) == identity else {
            return false
        }
        signals.append((signal, identity.pid))
        onSignal?(signal, identity.pid)
        return true
    }
}

/// Answers `/health` the way a running backend does and refuses everything
/// else, so a test reaches the supervision decision without a live sidecar.
private final class HealthyBackendURLProtocol: URLProtocol {
    private static let healthState = LockedHealthState(true)

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HealthyBackendURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    /// Flipped by the test that needs a backend to stop answering. URL loading
    /// calls this class from a session worker while tests run on the main actor,
    /// so the shared value is synchronized rather than actor-escaped.
    static var isHealthy: Bool {
        get { healthState.value }
        set { healthState.value = newValue }
    }

    override func startLoading() {
        guard let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        let payload: (status: Int, body: String) = url.path == "/health" && Self.isHealthy
            ? (200, #"{"ok":true,"uptimeSeconds":12,"runnerKind":"codex","mode":"agent-bridge"}"#)
            : (404, #"{"error":"not found"}"#)
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: payload.status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class LockedHealthState: @unchecked Sendable {
    private let lock = NSLock()
    private var storedValue: Bool

    init(_ value: Bool) {
        storedValue = value
    }

    var value: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return storedValue
        }
        set {
            lock.lock()
            storedValue = newValue
            lock.unlock()
        }
    }
}

private final class StubSecretStore: BackendSecretStore {
    private var values: BackendSecretValues = .empty

    func loadSecrets() throws -> BackendSecretValues { values }

    func saveSecrets(_ values: BackendSecretValues) throws { self.values = values }
}

private struct StubLaunchAtLogin: LaunchAtLoginManaging {
    var isEnabled = false

    func setEnabled(_ isEnabled: Bool) throws {}
}
