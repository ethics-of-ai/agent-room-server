import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PLAN_PAUSE_REASONS, PLAN_STATUSES, PLAN_STEP_STATUSES, threadPlanSchema } from "../src/plans/planModel";
import { PLAN_SNAPSHOT_SCHEMA_VERSION } from "../src/plans/planTools";

/**
 * The shared Swift plan DTOs restate the backend's status spellings as named
 * constants, because Swift cannot import them. planModel.ts is the source;
 * this suite keeps the Swift copies and the Swift decode fixture from drifting.
 */
const sharedClient = resolve(__dirname, "../../shared/AgentRoomClient");
const contracts = resolve(sharedClient, "Sources/AgentRoomClient/Contracts/ThreadPlan");

async function swiftConstants(file: string, type: string): Promise<string[]> {
  const source = await readFile(resolve(contracts, file), "utf8");
  const pattern = new RegExp(`static let \\w+ = ${type}\\(rawValue: "([^"]+)"\\)`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

describe("shared Swift thread plan contract", () => {
  it("names every backend status, step status, and pause reason", async () => {
    expect(await swiftConstants("ThreadPlanStatus.swift", "ThreadPlanStatus")).toEqual([...PLAN_STATUSES]);
    expect(await swiftConstants("ThreadPlanStepStatus.swift", "ThreadPlanStepStatus")).toEqual([...PLAN_STEP_STATUSES]);
    expect(await swiftConstants("ThreadPlanPauseReason.swift", "ThreadPlanPauseReason")).toEqual([...PLAN_PAUSE_REASONS]);
  });

  it("decodes a fixture the backend would store and serve", async () => {
    const source = await readFile(resolve(sharedClient, "Tests/AgentRoomClientTests/ThreadPlanContractTests.swift"), "utf8");
    const block = /BEGIN PLAN READ FIXTURE[\s\S]*?"""\n\s*(\{.*\})\n\s*"""[\s\S]*?END PLAN READ FIXTURE/.exec(source);
    expect(block).not.toBeNull();
    const response = JSON.parse(block![1]) as { schemaVersion: number; plan: unknown };
    expect(response.schemaVersion).toBe(PLAN_SNAPSHOT_SCHEMA_VERSION);
    const plan = threadPlanSchema.parse(response.plan);
    // The Swift suite asserts the same UTF-16 counts for these emoji strings.
    expect(plan.objective.length).toBe(20);
    expect(plan.steps[0].outcome?.length).toBe(29);
  });
});
