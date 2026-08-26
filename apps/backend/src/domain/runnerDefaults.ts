import type { ClaudeCodePermissionMode } from "./models";

/**
 * Runner defaults that are trust decisions, kept in a module with **no runtime
 * imports**.
 *
 * They used to live in `domain/schemas.ts`, which is now derived from the runner
 * registry (`runner/registry.ts`) — and the registry reaches into the Claude Code
 * adapter for its workspace-settings gate, which in turn needs these two values.
 * Leaving them in `schemas.ts` would close that loop into a require cycle
 * (`schemas` → `registry` → `claudeCode/settings` → `schemas`) whose initialization
 * order decides whether a documented default is `undefined` at module load. A leaf
 * cannot participate in a cycle, so the single-source-of-truth property survives the
 * registry landing.
 *
 * `domain/schemas.ts` re-exports both, so every existing import site is unchanged.
 */

// Single source of truth for the documented bypassPermissions posture
// (docs/safety/TRUST_AND_SAFETY.md); config parsing and the runner both
// resolve through this constant so they cannot drift apart. Typed against the
// domain union rather than derived from the zod schema, because the schema now
// lives downstream of this module.
export const defaultClaudeCodePermissionMode: ClaudeCodePermissionMode = "bypassPermissions";

// Single source of truth for the workspace-settings-loading default. The env
// parser, the schema default, and the runner fallback all resolve through it
// so the documented default (on) cannot drift across those layers.
export const defaultClaudeCodeLoadWorkspaceSkills = true;

// Single source of truth for whether a Cursor session loads the registered
// workspace's `project` settings source (`AGENTS.md`, `.cursor/rules`, hooks,
// MCP servers, and skills from all four skill directories). On by default, the
// same posture as Claude Code's `project` source, and the same class of trust
// decision — see docs/engineering/CURSOR_SDK_RUNNER.md and
// docs/safety/TRUST_AND_SAFETY.md. The registry's skills gate reads it through
// `runner/cursor/settings.ts`, which is why it lives in this import-free leaf.
export const defaultCursorLoadWorkspaceSettings = true;

// Single source of truth for the Cursor sandbox default. Sandboxed by default
// (fact 7 of docs/engineering/CURSOR_SDK_RUNNER.md bounds it to writes and
// network, not reads); this is the nearest thing Cursor has to Codex's
// `workspace-write`, so the two bundled runners with a sandbox default to on.
export const defaultCursorSandbox = true;

// Single source of truth for the Cursor auto-review default. Off by default: a
// server-side classifier that denies a blocked call is a trust decision, not a
// preference. See docs/safety/TRUST_AND_SAFETY.md.
export const defaultCursorAutoReview = false;
