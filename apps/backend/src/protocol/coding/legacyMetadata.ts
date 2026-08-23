import type { RunnerMetadata } from "../../runner/AgentRunner";
import type { CodingClaudeCodeMetadata, CodingCodexMetadata, CodingRunnerMetadata } from "./eventSchemas";

/**
 * The bounded compatibility shim for the pre-canonical `coding_*` wire shape.
 *
 * Everything the backend actually reasons with is the canonical `runner`
 * envelope. This module exists only so an independently upgraded client can
 * meet an older or newer peer: it rebuilds the legacy per-runner `codex` and
 * `claudeCode` blocks from that envelope, and it is the **one** place in the
 * mapper allowed to spell a runner's name. The core mapper's rule is "no
 * behavioral branch on a runner name", not the impossible claim that no
 * compatibility code may name a runner while those blocks are still emitted.
 *
 * Retire this file — and the two schema fields it fills — when the advertised
 * contract floor moves past `CODING_EVENT_CONTRACT_VERSION` 2.
 */

// The `native` blob is bounded on construction rather than trimmed: a
// half-serialized correlation blob reads as complete and would be worse than
// its absence, so an over-limit blob is dropped whole and flagged.
const MAX_NATIVE_KEYS = 16;
const MAX_NATIVE_DEPTH = 3;
const MAX_NATIVE_STRING_LENGTH = 500;
const MAX_NATIVE_SERIALIZED_BYTES = 4_096;

export function boundedRunnerMetadata(metadata: RunnerMetadata | undefined): CodingRunnerMetadata | undefined {
  if (!metadata) return undefined;
  const native = boundedNative(metadata.native);
  const posture = metadata.posture
    ? {
        label: clamp(metadata.posture.label),
        value: clamp(metadata.posture.value)
      }
    : undefined;
  const bounded: CodingRunnerMetadata = {
    ...(metadata.nativeSessionId ? { nativeSessionId: clamp(metadata.nativeSessionId) } : {}),
    ...(metadata.nativeTurnId ? { nativeTurnId: clamp(metadata.nativeTurnId) } : {}),
    ...(metadata.nativeItemId ? { nativeItemId: clamp(metadata.nativeItemId) } : {}),
    ...(metadata.model ? { model: clamp(metadata.model) } : {}),
    ...(metadata.cwd ? { cwd: clamp(metadata.cwd) } : {}),
    ...(posture ? { posture } : {}),
    ...(metadata.sandbox !== undefined ? { sandbox: metadata.sandbox } : {}),
    ...(native.value ? { native: native.value } : {}),
    ...(native.truncated ? { nativeTruncated: true } : {})
  };
  return Object.keys(bounded).length > 0 ? bounded : undefined;
}

/**
 * Rebuild the legacy `codex` block. Reads only the canonical envelope plus the
 * `native.method` the Codex adapter puts there, so it stays a projection rather
 * than a second source of truth.
 */
export function legacyCodexMetadata(
  runnerKind: string,
  metadata: CodingRunnerMetadata | undefined
): CodingCodexMetadata | undefined {
  if (runnerKind !== "codex" || !metadata) return undefined;
  const method = nativeString(metadata, "method");
  const approvalPolicy = metadata.posture?.label === "approvalPolicy" ? metadata.posture.value : undefined;
  const block: CodingCodexMetadata = {
    ...(method ? { method } : {}),
    ...(metadata.nativeSessionId ? { threadId: metadata.nativeSessionId } : {}),
    ...(metadata.nativeTurnId ? { turnId: metadata.nativeTurnId } : {}),
    ...(metadata.nativeItemId ? { itemId: metadata.nativeItemId } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(metadata.sandbox !== undefined ? { sandbox: metadata.sandbox } : {})
  };
  return Object.keys(block).length > 0 ? block : undefined;
}

/** Rebuild the legacy `claudeCode` block. Same projection rule as above. */
export function legacyClaudeCodeMetadata(
  runnerKind: string,
  metadata: CodingRunnerMetadata | undefined
): CodingClaudeCodeMetadata | undefined {
  if (runnerKind !== "claude_code" || !metadata) return undefined;
  const permissionMode = metadata.posture?.label === "permissionMode" ? metadata.posture.value : undefined;
  const block: CodingClaudeCodeMetadata = {
    ...(metadata.nativeSessionId ? { sessionId: metadata.nativeSessionId } : {}),
    ...(nativeString(metadata, "messageUuid") ? { messageUuid: nativeString(metadata, "messageUuid") } : {}),
    ...(nativeString(metadata, "parentToolUseId")
      ? { parentToolUseId: nativeString(metadata, "parentToolUseId") }
      : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
    ...(permissionMode ? { permissionMode } : {})
  };
  return Object.keys(block).length > 0 ? block : undefined;
}

function nativeString(metadata: CodingRunnerMetadata, key: string): string | undefined {
  const value = metadata.native?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedNative(
  value: Record<string, unknown> | undefined
): { value?: Record<string, unknown>; truncated: boolean } {
  if (!value) return { truncated: false };
  const entries = Object.entries(value);
  if (entries.length === 0) return { truncated: false };
  if (entries.length > MAX_NATIVE_KEYS) return { truncated: true };

  const bounded: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const nested = boundedNativeValue(item, 1);
    if (nested.truncated) return { truncated: true };
    bounded[clamp(key, 100)] = nested.value;
  }
  if (JSON.stringify(bounded).length > MAX_NATIVE_SERIALIZED_BYTES) return { truncated: true };
  return { value: bounded, truncated: false };
}

function boundedNativeValue(value: unknown, depth: number): { value?: unknown; truncated: boolean } {
  if (typeof value === "string") {
    return value.length > MAX_NATIVE_STRING_LENGTH ? { truncated: true } : { value, truncated: false };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) {
    return { value, truncated: false };
  }
  if (depth >= MAX_NATIVE_DEPTH) return { truncated: true };
  if (Array.isArray(value)) {
    if (value.length > MAX_NATIVE_KEYS) return { truncated: true };
    const items: unknown[] = [];
    for (const item of value) {
      const nested = boundedNativeValue(item, depth + 1);
      if (nested.truncated) return { truncated: true };
      items.push(nested.value);
    }
    return { value: items, truncated: false };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_NATIVE_KEYS) return { truncated: true };
  const bounded: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    const nested = boundedNativeValue(item, depth + 1);
    if (nested.truncated) return { truncated: true };
    bounded[clamp(key, 100)] = nested.value;
  }
  return { value: bounded, truncated: false };
}

function clamp(value: string, maxLength = MAX_NATIVE_STRING_LENGTH): string {
  return value.slice(0, maxLength);
}
