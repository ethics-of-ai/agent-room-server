# Documentation

## Start here

- [Architecture](architecture/ARCHITECTURE.md) explains the backend and client
  boundaries.
- [Moving parts](architecture/MOVING_PARTS.md) maps responsibilities to source
  directories and files.
- [API](api/API.md) defines the REST and WebSocket contracts.
- [Local Mac server](operations/LOCAL_MAC_SERVER.md) covers setup, packaging,
  configuration, and smoke checks.
- [Open source mirror](operations/OPEN_SOURCE_MIRROR.md) records how this
  repository is produced from the private monorepo and how releases are built.
- [Trust and safety](safety/TRUST_AND_SAFETY.md) records defaults, gates,
  bounds, and known risks.

## Client guides

- [macOS client](clients/MACOS.md) covers backend setup and supervision.
- [SwiftUI standards](engineering/SWIFTUI_STANDARDS.md) defines the structure
  and quality bar for the Apple clients.

The visionOS client guide, the visionOS design principles, and the Apple
reference indexes stay in the private repository with the visionOS app. Some
documents here link to them; those links do not resolve in this tree.

## Runner and agent engineering

- [Harness engineering](engineering/HARNESS_ENGINEERING.md) defines the
  agent-facing runtime profile.
- [Runner capability matrix](engineering/RUNNER_CAPABILITY_MATRIX.md) maps
  runner-specific decisions to registry fields.
- [DeepSeek Harness runner](engineering/DEEPSEEK_HARNESS_RUNNER.md) documents
  the built-in DeepSeek adapter and its remaining real-runtime checks.
- [ACP real-agent conformance](engineering/ACP_CONFORMANCE.md) describes the
  attended checks that CI cannot perform without a provider credential.

## Implementation records

These documents explain how the current runner design was introduced. They are
useful when changing the contracts, but they are not setup guides.

- [Universal runner boundary](engineering/UNIVERSAL_RUNNER_BOUNDARY.md)
- [Registered runner completeness](engineering/REGISTERED_RUNNER_COMPLETENESS.md)

Repository instructions for coding agents live in [`AGENTS.md`](../AGENTS.md)
and [`CLAUDE.md`](../CLAUDE.md).
