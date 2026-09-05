# Documentation

Use the smallest reference that owns the work.

## Backend and contracts

- [Architecture](architecture/ARCHITECTURE.md) maps responsibilities and source
  entry points.
- [API](api/API.md) defines REST and WebSocket behavior.
- [Trust and safety](safety/TRUST_AND_SAFETY.md) owns gates, bounds, trust
  decisions, and known limitations.
- [Local Mac server](operations/LOCAL_MAC_SERVER.md) covers setup, recovery, and
  smoke checks.

For a focused change, start with the matching sections:

| Task | API contract | Trust contract |
| --- | --- | --- |
| Managed settings | [Config](api/API.md#config) | [Settings and migration](safety/TRUST_AND_SAFETY.md#managed-settings) |
| Runner discovery | [Capabilities](api/API.md#coding-agent-capabilities) | [Catalog and readiness](safety/TRUST_AND_SAFETY.md#runner-catalog-and-readiness) |
| Sessions and turns | [Agent sessions](api/API.md#agent-sessions) | [Persistence](safety/TRUST_AND_SAFETY.md#session-persistence) |
| Files and search | [Workspaces](api/API.md#workspaces) | [Workspace files](safety/TRUST_AND_SAFETY.md#workspace-files) |
| Git mutations | [Git operations](api/API.md#mutating-git-operations) | [Git safety](safety/TRUST_AND_SAFETY.md#git-operations) |
| Permission input | [Permission answers](api/API.md#permission-answers) | [Approval](safety/TRUST_AND_SAFETY.md#permission-approval) |
| Question input | [Question answers](api/API.md#clarifying-question-answers) | [Questions and storage](safety/TRUST_AND_SAFETY.md#clarifying-questions) |
| Language services | [Semantic protocol](api/API.md#editor-language-services) | [Execution](safety/TRUST_AND_SAFETY.md#language-services) |

## Runners

- [Runner architecture](engineering/RUNNERS.md) defines registry ownership,
  canonical events, lifecycle, settings, permissions, and questions.
- [DeepSeek Harness](engineering/DEEPSEEK_HARNESS_RUNNER.md) covers its runtime
  and composition.
- [Cursor SDK](engineering/CURSOR_SDK_RUNNER.md) covers SDK integration,
  credentials, packaging, and open checks.
- [ACP conformance](engineering/ACP_CONFORMANCE.md) is the attended verification
  procedure for a real external agent.

## Apple client and operations

- [macOS client](clients/MACOS.md) covers backend supervision, settings,
  bootstrap, diagnostics, and updates.
- [SwiftUI standards](engineering/SWIFTUI_STANDARDS.md) defines shared Apple
  source structure and quality rules.
- [Open-source mirror](operations/OPEN_SOURCE_MIRROR.md) defines publication,
  release, and private/public boundaries.

The visionOS client and its Apple evidence stay in the private repository.
Some shared references may describe those contracts without publishing the
private app source.
