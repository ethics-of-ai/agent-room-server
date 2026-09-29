import { createHash } from "node:crypto";
import { PLAN_LIMITS, type PlanMutationReceipt, type PlanMutationToolId } from "./planModel";

/**
 * Mutation receipts: the retry memory that lets a caller repeat a mutation
 * with its original operationId and learn what was applied, without storing
 * plan text or old snapshots.
 */

/** SHA-256 over canonical JSON: sorted object keys, array order preserved. */
export function planArgumentsHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type ReceiptMatch =
  | { kind: "none" }
  | { kind: "replay"; receipt: PlanMutationReceipt }
  | { kind: "conflict"; receipt: PlanMutationReceipt };

export function matchPlanReceipt(
  receipts: readonly PlanMutationReceipt[],
  operationId: string,
  toolId: PlanMutationToolId,
  argumentsHash: string
): ReceiptMatch {
  const receipt = receipts.find((entry) => entry.operationId === operationId);
  if (!receipt) return { kind: "none" };
  return receipt.toolId === toolId && receipt.argumentsHash === argumentsHash
    ? { kind: "replay", receipt }
    : { kind: "conflict", receipt };
}

/** Append a receipt, keeping the most recent ones within the retention bound. */
export function appendPlanReceipt(
  receipts: readonly PlanMutationReceipt[],
  receipt: PlanMutationReceipt
): PlanMutationReceipt[] {
  return [...receipts, receipt].slice(-PLAN_LIMITS.receipts);
}
