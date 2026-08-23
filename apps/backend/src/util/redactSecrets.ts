/**
 * Credential redaction for text AgentRoom did not author.
 *
 * A runner child's stderr, a spawned process's error message, or a config-parse
 * failure can echo credentials the child read from its own environment or from a
 * workspace's committed config (a `.codex/config.toml` `mcp_servers.*.env` entry,
 * for example). That text reaches API responses, event payloads, and durable
 * audit, so it passes through here first. This is defense in depth, not a
 * boundary: the primary controls are not putting secrets in the child's
 * environment (see `codexChildEnv` / `claudeCodeChildEnv`) and never logging
 * them.
 *
 * Patterns are deliberately conservative — a labelled assignment or a bearer
 * header — because an unlabelled high-entropy string is indistinguishable from
 * the file paths, hashes, and thread ids that make these diagnostics useful.
 */
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// The value part tolerates a `Bearer ` prefix and a closing quote so a labelled
// header collapses to one marker instead of stacking on the bearer pass above,
// and a quoted TOML/JSON value does not leave its delimiter dangling.
const LABELLED_SECRET_PATTERN =
  /(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*(?:Bearer\s+)?['"]?[^'",\s}]+['"]?/gi;

export function redactSecrets(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(LABELLED_SECRET_PATTERN, "$1=[REDACTED]");
}
