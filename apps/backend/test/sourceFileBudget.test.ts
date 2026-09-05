import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

/**
 * Line ceilings. A file over one of these is not automatically wrong, but it is
 * a decision someone has to make on purpose rather than reach by adding fifty
 * lines a branch: either split it, or record it below in the change that grows
 * it. The two numbers differ because a test file's repetition is not the same
 * cost as a source file's. A suite reads top to bottom, a 900-line module does
 * not.
 */
const sourceCeiling = 600;
const testCeiling = 900;

interface BudgetRoot {
  /** Repo-relative with POSIX separators, the spelling the allowlist uses. */
  readonly path: string;
  readonly extensions: readonly string[];
  readonly ceiling: number;
}

/**
 * No root contains another, so a file belongs to exactly one and inherits its
 * ceiling. `apps/visionos` is in the public mirror's `deny` list
 * (`mirror/manifest.json`), so those roots are absent in the mirrored
 * repository and every rule below skips them there rather than failing. That is
 * the same accommodation `swiftModelStructure.test.ts` makes.
 */
const budgetRoots: readonly BudgetRoot[] = [
  { path: "apps/backend/src", extensions: [".ts"], ceiling: sourceCeiling },
  { path: "apps/shared/AgentRoomClient/Sources", extensions: [".swift"], ceiling: sourceCeiling },
  { path: "apps/visionos/AgentRoom", extensions: [".swift"], ceiling: sourceCeiling },
  { path: "apps/macos/AgentRoomMac", extensions: [".swift"], ceiling: sourceCeiling },
  { path: "apps/backend/test", extensions: [".ts"], ceiling: testCeiling },
  { path: "apps/shared/AgentRoomClient/Tests", extensions: [".swift"], ceiling: testCeiling },
  { path: "apps/visionos/AgentRoomTests", extensions: [".swift"], ceiling: testCeiling },
  { path: "apps/visionos/AgentRoomUITests", extensions: [".swift"], ceiling: testCeiling },
  { path: "apps/macos/AgentRoomMacTests", extensions: [".swift"], ceiling: testCeiling }
];

/**
 * The files already over their ceiling when this guard landed, each held at the
 * length it had. The list can only get shorter: a recorded file may shrink and
 * may never grow, and an entry whose file is gone or back under the ceiling
 * fails, so a completed split deletes its own line.
 *
 * Adding an entry is the deliberate act this guard exists to make visible. Do
 * it in the change that needs it, not as cleanup afterwards.
 */
const allowlist: Readonly<Record<string, number>> = {
  "apps/macos/AgentRoomMac/Supervision/BackendSupervisor.swift": 1749,
  "apps/visionos/AgentRoom/State/Spatial/SpatialSceneStore.swift": 1277,
  "apps/visionos/AgentRoom/Views/SpatialScene/Rendering/SpatialSceneRealityView.swift": 1189,
  "apps/backend/src/runner/deepseek/DeepSeekHarnessRunner.ts": 1046,
  "apps/backend/src/config/settingsStore.ts": 1030,
  "apps/backend/src/runner/acp/AcpRunner.ts": 1028,
  "apps/backend/src/scene/diagram/mermaidImport.ts": 1006,
  // Reviewed for a split and deliberately left whole. The two collaborators
  // proposed for it, one for hydration and one for turn settlement, are
  // mutually recursive: hydration settles an interrupted turn through
  // `failTurn`, and every settlement path persists through `snapshot`. They
  // also share the counters, the session and turn maps, and the message
  // store, so neither would own anything the other does not touch, unlike
  // `AgentTurnEventApplier` and the two trackers beside it. The split would
  // have landed near 675 lines, still over the ceiling, in exchange for a
  // wide callback seam across the hydration path
  // `docs/safety/TRUST_AND_SAFETY.md` pins under *Session persistence*.
  // Recorded here rather than attempted.
  "apps/backend/src/agent/AgentSessionService.ts": 894,
  "apps/backend/src/scene/diagram/compose.ts": 866,
  "apps/backend/src/runner/codex/CodexAppServerRunner.ts": 849,
  "apps/shared/AgentRoomClient/Sources/AgentRoomClient/APIClient.swift": 824,
  "apps/backend/src/runner/cursor/CursorSdkRunner.ts": 810,
  "apps/backend/src/runner/registry.ts": 800,
  "apps/visionos/AgentRoom/Views/Workspace/WorkspaceWindowView.swift": 787,
  "apps/backend/src/domain/models.ts": 683,
  "apps/backend/src/scene/diagram/humanEdits.ts": 639,
  "apps/visionos/AgentRoom/State/AppStore/AppStore.swift": 623,
  "apps/visionos/AgentRoom/Views/WorkspaceScene/WorkspaceRunnerBuddyView.swift": 621,
  "apps/backend/src/runner/claudeCode/ClaudeCodeRunner.ts": 613,
  "apps/backend/src/protocol/coding/events.ts": 603,
  "apps/backend/src/agent/AgentTurnEventApplier.ts": 602,

  "apps/backend/test/codexJsonRpcRunner.test.ts": 1486,
  "apps/backend/test/workspaceContext.test.ts": 1233,
  "apps/visionos/AgentRoomTests/Editor/MonacoEditorRenderTests.swift": 1192,
  "apps/backend/test/acpRunner.test.ts": 1175,
  "apps/backend/test/diagramCompose.test.ts": 945
};

/** Directories holding no hand-written source: build output, assets, vendored bundles. */
function skipDirectory(name: string): boolean {
  return (
    name === ".build" ||
    name === "Resources" ||
    name === "node_modules" ||
    name === "dist" ||
    name.endsWith(".xcassets")
  );
}

async function filesUnder(root: BudgetRoot): Promise<string[]> {
  const found: string[] = [];
  const absoluteRoot = resolve(repoRoot, root.path);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (skipDirectory(entry.name)) continue;
        await walk(path);
      } else if (root.extensions.some((extension) => entry.name.endsWith(extension))) {
        found.push(relative(repoRoot, path).split("\\").join("/"));
      }
    }
  };
  await walk(absoluteRoot);
  return found;
}

/**
 * Counts lines the way `wc -l` does for the ordinary case and one better for
 * the rest: a final line with no trailing newline still counts, so a file
 * cannot lose a line by omitting one.
 */
function lineCount(source: string): number {
  if (source.length === 0) return 0;
  const parts = source.split("\n").length;
  return source.endsWith("\n") ? parts - 1 : parts;
}

async function countLines(path: string): Promise<number> {
  return lineCount(await readFile(resolve(repoRoot, path), "utf8"));
}

const presentRoots = budgetRoots.filter((root) => existsSync(resolve(repoRoot, root.path)));

function rootFor(path: string): BudgetRoot | undefined {
  return budgetRoots.find((root) => path.startsWith(`${root.path}/`));
}

describe("source file budget", () => {
  test("keeps every unlisted file under its ceiling", async () => {
    const overBudget: string[] = [];
    for (const root of presentRoots) {
      for (const path of await filesUnder(root)) {
        if (path in allowlist) continue;
        const lines = await countLines(path);
        if (lines > root.ceiling) overBudget.push(`${path} is ${lines} lines (ceiling ${root.ceiling})`);
      }
    }
    expect(overBudget.sort()).toEqual([]);
  });

  test("holds every allowlisted file at or below its recorded length", async () => {
    const grown: string[] = [];
    for (const [path, recorded] of Object.entries(allowlist)) {
      const root = rootFor(path);
      if (!root || !presentRoots.includes(root)) continue;
      if (!existsSync(resolve(repoRoot, path))) continue;
      const lines = await countLines(path);
      if (lines > recorded) grown.push(`${path} grew to ${lines} lines from a recorded ${recorded}`);
    }
    expect(grown.sort()).toEqual([]);
  });

  test("drops an allowlist entry once its file is gone or back under the ceiling", async () => {
    const stale: string[] = [];
    for (const [path, recorded] of Object.entries(allowlist)) {
      const root = rootFor(path);
      if (!root) {
        stale.push(`${path} is under no budgeted root. Remove the entry or fix the path`);
        continue;
      }
      if (!presentRoots.includes(root)) continue;
      if (!existsSync(resolve(repoRoot, path))) {
        stale.push(`${path} no longer exists. Remove its allowlist entry`);
        continue;
      }
      const lines = await countLines(path);
      if (lines <= root.ceiling) {
        stale.push(`${path} is ${lines} lines, under the ${root.ceiling} ceiling. Remove its allowlist entry`);
      }
      if (recorded <= root.ceiling) {
        stale.push(`${path} is recorded at ${recorded}, at or under the ${root.ceiling} ceiling. Remove its allowlist entry`);
      }
    }
    expect(stale.sort()).toEqual([]);
  });
});
