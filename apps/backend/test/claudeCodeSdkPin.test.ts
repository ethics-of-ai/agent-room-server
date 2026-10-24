import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// MCP tool view calls send the CLI's `mcp_call` through the SDK's private
// `Query.request()` (see `ClaudeCodeToolApps.callTool`). These are the SDK
// versions whose `request()` and bundled CLI `mcp_call` handler were read and
// found to match. Before adding a version, check that `request(controlRequest)`
// still resolves to an object whose `response` is the CLI's answer, and that
// the CLI still answers a plain `mcp_call` with `{ content, structuredContent,
// _meta }`. Drop this guard once a public SDK method replaces `request()`.
const VERIFIED_SDK_VERSIONS = ["0.3.296"];

describe("Claude Agent SDK pin", () => {
  it("is a version whose private request() was checked for tool view calls", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(VERIFIED_SDK_VERSIONS).toContain(manifest.dependencies["@anthropic-ai/claude-agent-sdk"]);
  });
});
