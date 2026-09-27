import { describe, expect, it } from "vitest";
import { completionFromClaudeCodeMessage } from "../src/runner/claudeCode/messageMapper";

/// The CLI reports a turn that failed before reaching the model (not logged in,
/// an API error) as `subtype: "success"` with `is_error: true`, and puts the
/// reason in `result`. The error subtypes carry theirs in `errors` instead.

describe("Claude Code turn completion", () => {
  it("succeeds with the final text", () => {
    expect(completionFromClaudeCodeMessage({ type: "result", subtype: "success", is_error: false, result: "Done." }))
      .toEqual({ type: "run_succeeded", message: "Done." });
  });

  it("fails with the result text when a success-subtype result is an error", () => {
    expect(completionFromClaudeCodeMessage({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login"
    })).toEqual({ type: "run_failed", error: "Not logged in · Please run /login" });
  });

  it("fails with the joined errors of an error subtype", () => {
    expect(completionFromClaudeCodeMessage({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["first", "second"]
    })).toEqual({ type: "run_failed", error: "first; second" });
  });

  it("falls back to the subtype when the CLI gives no reason", () => {
    expect(completionFromClaudeCodeMessage({ type: "result", subtype: "error_max_turns", is_error: true }))
      .toEqual({ type: "run_failed", error: "Claude Code turn ended with error_max_turns" });
    expect(completionFromClaudeCodeMessage({ type: "result", subtype: "success", is_error: true, result: "" }))
      .toEqual({ type: "run_failed", error: "Claude Code turn failed without a reason" });
  });
});
