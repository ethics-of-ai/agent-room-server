import XCTest
@testable import AgentRoomMac

/// The Claude sign-in runs a fixed command in Terminal. These pin that the
/// command is the one the descriptor declares and that no path can break out
/// of its quoting.
final class RunnerSignInCommandTests: XCTestCase {
    func testClaudeDescriptorSignsInWithTheResolvedCLI() throws {
        let descriptor = RunnerBootstrapTestSupport.descriptor("claude_code")
        let signIn = try XCTUnwrap(descriptor.signIn)

        XCTAssertEqual(signIn.arguments, ["auth", "login"])
        XCTAssertEqual(signIn.signOutArguments, ["auth", "logout"])
        XCTAssertEqual(signIn.readinessCheckID, "claude_login")
        // Both probes must exist, or the row can never decide to show itself.
        XCTAssertNotNil(descriptor.probe(signIn.executableProbeID)?.resolvedSlotID)
        XCTAssertNotNil(descriptor.probe(signIn.credentialProbeID))
    }

    func testOtherRunnersOfferNoSignIn() {
        XCTAssertNil(RunnerBootstrapTestSupport.descriptor("codex").signIn)
    }

    func testScriptQuotesTheExecutableAndDeletesItself() throws {
        let signIn = try XCTUnwrap(RunnerBootstrapTestSupport.descriptor("claude_code").signIn)

        let script = signIn.script(executablePath: "/Users/me/My Tools/it's/claude", arguments: signIn.arguments)

        XCTAssertTrue(script.hasPrefix("#!/bin/zsh\nrm -f -- \"$0\"\n"))
        XCTAssertTrue(script.contains("'/Users/me/My Tools/it'\\''s/claude' 'auth' 'login'\n"))
    }

    func testSignOutScriptRunsLogoutWithTheSameQuoting() throws {
        let signIn = try XCTUnwrap(RunnerBootstrapTestSupport.descriptor("claude_code").signIn)

        let script = signIn.script(executablePath: "/Users/me/it's/claude", arguments: signIn.signOutArguments)

        XCTAssertTrue(script.hasPrefix("#!/bin/zsh\nrm -f -- \"$0\"\n"))
        XCTAssertTrue(script.contains("'/Users/me/it'\\''s/claude' 'auth' 'logout'\n"))
    }

    func testQuotingNeutralizesShellSyntax() {
        XCTAssertEqual(RunnerSignInCommand.shellQuoted("$(rm -rf ~); `x`"), "'$(rm -rf ~); `x`'")
        XCTAssertEqual(RunnerSignInCommand.shellQuoted("a'b"), "'a'\\''b'")
    }
}
