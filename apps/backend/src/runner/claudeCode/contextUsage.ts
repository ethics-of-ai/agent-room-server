import { booleanValue, objectValue, positiveIntegerValue } from "../shared/jsonValues";

/**
 * The auto-compaction threshold out of a `get_context_usage` response.
 *
 * `undefined` means the control response is unavailable or malformed, so a
 * caller must preserve any cached value. `null` is an authoritative clear: the
 * child says auto-compaction is off or an otherwise valid enabled response has
 * no usable threshold. A fraction of `maxTokens` would be a number AgentRoom
 * invented, so it is never used as a fallback.
 */
export function compactionThresholdFromContextUsage(value: unknown): number | null | undefined {
  const usage = objectValue(value);
  if (!usage) return undefined;
  const isAutoCompactEnabled = booleanValue(usage.isAutoCompactEnabled);
  if (isAutoCompactEnabled === undefined) return undefined;
  if (!isAutoCompactEnabled) return null;
  return positiveIntegerValue(usage.autoCompactThreshold) ?? null;
}
