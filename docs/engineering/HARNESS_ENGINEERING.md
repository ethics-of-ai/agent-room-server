# Harness Engineering

AgentRoom exposes a harness profile at `GET /api/harness`. The goal is to make
repository knowledge, runtime feedback, guardrails, and verification commands
easy for agents and humans to inspect.

The profile does not run commands, mutate workspaces, or expose secrets. Bounded
POST harness actions can run only fixed, repository-specific workflows inside a
registered workspace.

## Encoded Feedback Loops

- `/api/status`: active sessions, recent events, and turn metrics.
- `/api/logs`: recent in-memory runtime events.
- `/api/events`: WebSocket stream of typed events.
- `/api/audit`: sanitized durable lifecycle and runner audit entries.
- `/api/harness/visionos/xcodegen`: fixed `xcodegen generate` in
  `apps/visionos` for a registered workspace, with bounded
  `coding_tool_activity_*` feedback.
- `/api/harness/visionos/xcodebuild`: fixed visionOS `xcodebuild build` or
  targeted `xcodebuild test`, with bounded output and diagnostics surfaced as
  `coding_tool_activity_*` feedback.

Both harness actions attribute their feedback to the runner the supplied
`sessionId` actually runs. `VisionOSHarness` takes that resolver as a required
option rather than defaulting: the fixed `runnerKind: "codex"` it replaced
reported every Claude Code session's harness activity as Codex, and a silent
default is how that happened.
- `AGENTS.md` and `CLAUDE.md`: verification commands and repository guardrails.
- `.codex/skills/prime-context` and `.claude/skills/prime-context`: local
  agent context-loading workflows.
- `docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md`: required Apple spatial
  design grounding checklist for visionOS questions, reviews, and
  implementation.
- `docs/reference/apple-wwdc2023-spatial-video-manifest.json`: collection of
  timestamped Apple spatial design video indexes for finding visual examples
  from transcript cues.

## visionOS Design Grounding

The harness profile includes a `visionOSDesignGrounding` section. Agents must
use it before answering visionOS design questions or editing `apps/visionos`
UI. The section points to the AgentRoom checklist, Apple WWDC spatial video
indexes, and SwiftUI standards, and it requires agents to identify the relevant
Apple reference cue or timestamp plus the AgentRoom client boundary before
proposing design changes.

## Maintenance Rules

When changing harness behavior:

- Update this document and `docs/api/API.md`.
- Keep `/api/harness` free of secrets.
- Keep POST harness actions registered-workspace-only, path-bounded, and based
  on fixed command templates rather than arbitrary command strings.
- Add or update tests for new fields.
- Do not weaken `docs/safety/TRUST_AND_SAFETY.md` without documenting why.
- Keep agent-facing guidance files in sync with the current codebase so harness
  consumers do not prime on removed modules or policies.
