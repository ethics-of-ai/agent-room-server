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
