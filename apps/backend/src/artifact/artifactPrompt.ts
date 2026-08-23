// Concise, backend-owned instruction that teaches both runners the in-band
// artifact convention. Injected into the assembled turn prompt when artifacts
// are enabled, so it reaches Codex and Claude Code uniformly without
// runner-specific plumbing, independent of whatever a workspace's own
// CLAUDE.md may or may not say.

export const ARTIFACT_PROMPT_INSTRUCTION = [
  "Live artifacts: when you want to show a diagram or visual sketch, render it",
  "live by emitting an artifact instead of a fenced code block. Write a line",
  'beginning with `<artifact kind="svg" title="...">`, then the complete SVG',
  "markup, then a closing `</artifact>` line. Use `kind=\"mermaid\"` with Mermaid",
  "diagram syntax for flowcharts and graphs. Only emit an artifact when you",
  "actually intend to render one — do not wrap example markup you are merely",
  "explaining. Everything outside artifact tags is shown as normal chat text."
].join(" ");
