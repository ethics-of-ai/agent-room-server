import type { HarnessProfile, ServiceConfig } from "../domain/models";
import { harnessProfileSchema } from "../domain/schemas";

export function buildHarnessProfile(config: ServiceConfig): HarnessProfile {
  return harnessProfileSchema.parse({
    name: "AgentRoom Harness",
    source: {
      title: "Harness engineering: leveraging Codex in an agent-first world",
      url: "https://openai.com/index/harness-engineering/",
      publishedAt: "2026-02-11"
    },
    summary:
      "AgentRoom exposes registered local workspaces, safe file context, and turn-based Codex sessions through a Mac-hosted API so visionOS and macOS clients can drive agentic tools without running them directly.",
    principles: [
      "The Mac backend is the only local agent host.",
      "Clients send typed session and turn requests; they do not execute tools directly.",
      "Registered local workspaces are preserved and used in place.",
      "Runtime behavior should be legible through APIs, logs, audit entries, and WebSocket events.",
      "Safety boundaries are enforced in code before richer client surfaces are added."
    ],
    knowledgeMap: [
      {
        path: "AGENTS.md",
        purpose: "Short agent entry point and repository guardrails."
      },
      {
        path: "CLAUDE.md",
        purpose: "Claude Code guidance kept in sync with repository guardrails."
      },
      {
        path: "docs/architecture/ARCHITECTURE.md",
        purpose: "System boundary map for the local-agent bridge, backend runner adapter, and clients."
      },
      {
        path: "docs/api/API.md",
        purpose: "REST and WebSocket contract for workspaces, agent sessions, status, logs, and audit."
      },
      {
        path: "docs/safety/TRUST_AND_SAFETY.md",
        purpose: "Safety posture for local runner execution and credential handling."
      },
      {
        path: "docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md",
        purpose: "Required Apple spatial design grounding for visionOS questions and UI implementation."
      },
      {
        path: "docs/reference/apple-wwdc2023-spatial-video-manifest.json",
        purpose: "collection of timestamped Apple spatial design video indexes for finding visual examples from transcript cues."
      },
      {
        path: "docs/reference/APPLE_WWDC2023_10076_SPATIAL_UI.md",
        purpose: "how to use the Apple WWDC 2023 spatial video reference collection."
      },
      {
        path: ".codex/skills/prime-context/SKILL.md",
        purpose: "Codex context-loading workflow for current AgentRoom architecture."
      },
      {
        path: ".claude/skills/prime-context/SKILL.md",
        purpose: "Claude context-loading workflow for current AgentRoom architecture."
      }
    ],
    visionOSDesignGrounding: {
      requiredReferences: [
        {
          path: "docs/engineering/VISIONOS_DESIGN_PRINCIPLES.md",
          purpose: "AgentRoom-specific checklist for grounding every visionOS design question and implementation."
        },
        {
          path: "docs/reference/apple-wwdc2023-spatial-video-manifest.json",
          purpose: "Timestamped Apple spatial design video collection used to choose the relevant WWDC reference."
        },
        {
          path: "docs/reference/APPLE_WWDC2023_10076_SPATIAL_UI.md",
          purpose: "Instructions for using the Apple spatial UI video indexes without storing full transcripts."
        },
        {
          path: "docs/engineering/SWIFTUI_STANDARDS.md",
          purpose: "SwiftUI structure, state, accessibility, and verification standards for Apple clients."
        }
      ],
      preflightChecklist: [
        "Identify the relevant WWDC spatial reference before answering a visionOS design question or editing UI.",
        "Cite the selected Apple reference index entry or timestamp cue when making a spatial design claim.",
        "State the AgentRoom client boundary: visionOS is a REST/WebSocket client and must not run agents, shell commands, or provider tools.",
        "Map the change to the SwiftUI standards for structure, state ownership, accessibility, and verification.",
        "Prefer native visionOS windows, system materials, ornaments, comfortable input targets, and familiar navigation before adding custom spatial novelty."
      ]
    },
    feedbackLoops: [
      {
        name: "status snapshot",
        endpoint: "/api/status",
        purpose: "Expose active agent sessions, recent events, and turn metrics."
      },
      {
        name: "runtime event stream",
        endpoint: "/api/events",
        purpose: "Stream typed agent-session and runner events for live client monitoring."
      },
      {
        name: "audit trail",
        endpoint: "/api/audit",
        purpose: "Persist sanitized runner and agent-session lifecycle events."
      },
      {
        name: "visionOS XcodeGen harness",
        endpoint: "/api/harness/visionos/xcodegen",
        purpose: "Run the fixed apps/visionos XcodeGen generation step inside a registered workspace and stream bounded coding-agent activity."
      },
      {
        name: "visionOS xcodebuild harness",
        endpoint: "/api/harness/visionos/xcodebuild",
        purpose: "Run fixed visionOS build or targeted test checks inside a registered workspace and stream bounded coding-agent activity."
      },
      {
        name: "verification commands",
        artifact: "AGENTS.md / CLAUDE.md",
        purpose: "Give agents a stable completion checklist before claiming backend work is done."
      }
    ],
    guardrails: [
      "Use registered local workspaces and Codex runner as the normal runtime path.",
      "Keep runner implementations behind AgentRunner.",
      "Require bearer auth for mutating routes when AUTH_TOKEN is configured.",
      "Require bearer auth for workspace tree and file-preview reads when AUTH_TOKEN is configured.",
      "Do not add arbitrary shell execution API endpoints.",
      "Preserve user-selected workspaces unless deletion is explicitly requested.",
      "Keep provider credentials out of clients and diagnostics.",
      "Keep workspace context registered-workspace-relative, bounded, and symlink-safe.",
      "Ground visionOS design questions and implementation in the Apple spatial design references before proposing or editing UI."
    ],
    verificationCommands: [
      "pnpm typecheck",
      "pnpm --filter @agentroom/backend build",
      "pnpm test",
      "PORT=8799 pnpm --filter @agentroom/backend start",
      "curl -sS http://127.0.0.1:8799/health",
      "curl -sS http://127.0.0.1:8799/api/status"
    ],
    safetyPosture: {
      runnerKind: config.runnerKind,
      arbitraryShellApi: false,
      authRequiredForMutations: config.requireAuth ?? false
    }
  });
}
