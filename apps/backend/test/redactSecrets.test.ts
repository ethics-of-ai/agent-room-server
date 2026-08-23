import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/util/redactSecrets";

describe("redactSecrets", () => {
  it("redacts labelled credentials while keeping the surrounding diagnostic", () => {
    const redacted = redactSecrets(
      'failed to parse config at .codex/config.toml: api_key = "sk-live-not-a-real-key"'
    );

    expect(redacted).not.toContain("sk-live-not-a-real-key");
    expect(redacted).toContain("failed to parse config at .codex/config.toml");
    expect(redacted).toContain("api_key=[REDACTED]");
  });

  it("redacts bearer headers, token, secret, and password assignments", () => {
    expect(redactSecrets("Bearer abc.def-123=")).toBe("Bearer [REDACTED]");
    // A labelled header collapses to a single marker rather than stacking the
    // bearer and assignment passes on top of each other.
    expect(redactSecrets("Authorization: Bearer abc.def-123=")).toBe("Authorization=[REDACTED]");
    expect(redactSecrets("token=hunter2")).toBe("token=[REDACTED]");
    expect(redactSecrets("secret: 'hunter2'")).toBe("secret=[REDACTED]");
    expect(redactSecrets("password = hunter2")).toBe("password=[REDACTED]");
    expect(redactSecrets("API-KEY: hunter2")).toBe("API-KEY=[REDACTED]");
  });

  it("leaves the identifiers that make a runner diagnostic useful", () => {
    // Unlabelled high-entropy strings are what thread ids, hashes, and paths look
    // like. Redacting them would gut the stderr tail's whole reason to exist.
    const diagnostic =
      "thread 0199f0c2-4a1b-7c3d-9e8f-1a2b3c4d5e6f exited: /Users/me/repos/app/.codex/config.toml";

    expect(redactSecrets(diagnostic)).toBe(diagnostic);
  });

  it("returns text unchanged when there is nothing to redact", () => {
    expect(redactSecrets("Codex app-server exited with code 3")).toBe(
      "Codex app-server exited with code 3"
    );
  });
});
