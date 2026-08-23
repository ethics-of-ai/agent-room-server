import type { CodingArtifactKind } from "../protocol/coding/eventSchemas";

// In-memory, per-session storage for model-authored artifacts streamed in-band
// during a turn. Mirrors the lifecycle of other per-session runner resources:
// it is released when the AgentRoom session is deleted (see
// AgentSessionService.deleteSession). Nothing is written to disk or into the
// registered workspace. Content is bounded so a runaway turn cannot grow an
// artifact without limit.

// Bound is measured in UTF-8 bytes so the cap holds regardless of multibyte
// content (the `coding_artifact_completed` event reports the same byte count).
const MAX_ARTIFACT_CONTENT_BYTES = 64 * 1024;
const MAX_ARTIFACTS_PER_SESSION = 32;

export interface ArtifactSnapshot {
  id: string;
  sessionId: string;
  turnId: string;
  kind: CodingArtifactKind;
  title?: string;
  content: string;
  version: number;
  isOpen: boolean;
  truncated: boolean;
  updatedAt: string;
}

// Internal record: the body is held as a chunk list (joined lazily) so appends
// stay O(1) instead of rebuilding the whole accumulated string per delta, and a
// running byte count avoids re-scanning the content on every append/complete.
interface StoredArtifact {
  id: string;
  sessionId: string;
  turnId: string;
  kind: CodingArtifactKind;
  title?: string;
  chunks: string[];
  byteLength: number;
  version: number;
  isOpen: boolean;
  truncated: boolean;
  updatedAt: string;
}

/** What `append` actually retained, so the live event stream matches the store. */
export interface ArtifactAppendResult {
  appended: string;
  truncated: boolean;
}

/** Final byte size and truncation state reported when an artifact closes. */
export interface ArtifactCompleteResult {
  byteLength: number;
  truncated: boolean;
}

export class ArtifactStore {
  private readonly bySession = new Map<string, Map<string, StoredArtifact>>();

  start(input: {
    sessionId: string;
    turnId: string;
    artifactId: string;
    kind: CodingArtifactKind;
    title?: string;
    at: string;
  }): ArtifactSnapshot | undefined {
    const artifacts = this.ensureSession(input.sessionId);
    if (!artifacts.has(input.artifactId) && artifacts.size >= MAX_ARTIFACTS_PER_SESSION) {
      return undefined;
    }
    const artifact: StoredArtifact = {
      id: input.artifactId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: input.kind,
      ...(input.title ? { title: input.title } : {}),
      chunks: [],
      byteLength: 0,
      version: 0,
      isOpen: true,
      truncated: false,
      updatedAt: input.at
    };
    artifacts.set(input.artifactId, artifact);
    return toSnapshot(artifact);
  }

  append(input: {
    sessionId: string;
    artifactId: string;
    delta: string;
    at: string;
  }): ArtifactAppendResult | undefined {
    const artifact = this.bySession.get(input.sessionId)?.get(input.artifactId);
    if (!artifact || !artifact.isOpen) return undefined;
    const remaining = MAX_ARTIFACT_CONTENT_BYTES - artifact.byteLength;
    if (remaining <= 0) {
      artifact.truncated = true;
      return { appended: "", truncated: true };
    }
    let slice = input.delta;
    let sliceBytes = Buffer.byteLength(slice, "utf8");
    if (sliceBytes > remaining) {
      // Trim on a code-point boundary so a multibyte character is never split.
      slice = boundedUtf8Prefix(input.delta, remaining);
      sliceBytes = Buffer.byteLength(slice, "utf8");
      artifact.truncated = true;
    }
    if (slice.length === 0) {
      // Nothing fits (e.g. a single multibyte char larger than the remaining
      // budget); leave the artifact unchanged but flagged truncated.
      return { appended: "", truncated: artifact.truncated };
    }
    artifact.chunks.push(slice);
    artifact.byteLength += sliceBytes;
    artifact.version += 1;
    artifact.updatedAt = input.at;
    return { appended: slice, truncated: artifact.truncated };
  }

  complete(input: { sessionId: string; artifactId: string; at: string }): ArtifactCompleteResult | undefined {
    const artifact = this.bySession.get(input.sessionId)?.get(input.artifactId);
    if (!artifact) return undefined;
    artifact.isOpen = false;
    artifact.updatedAt = input.at;
    return { byteLength: artifact.byteLength, truncated: artifact.truncated };
  }

  snapshot(sessionId: string): ArtifactSnapshot[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])].map(toSnapshot);
  }

  releaseSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private ensureSession(sessionId: string): Map<string, StoredArtifact> {
    let artifacts = this.bySession.get(sessionId);
    if (!artifacts) {
      artifacts = new Map<string, StoredArtifact>();
      this.bySession.set(sessionId, artifacts);
    }
    return artifacts;
  }
}

function toSnapshot(artifact: StoredArtifact): ArtifactSnapshot {
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    turnId: artifact.turnId,
    kind: artifact.kind,
    ...(artifact.title ? { title: artifact.title } : {}),
    content: artifact.chunks.join(""),
    version: artifact.version,
    isOpen: artifact.isOpen,
    truncated: artifact.truncated,
    updatedAt: artifact.updatedAt
  };
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never
 * splitting a multibyte code point (iterates by code point, not code unit). */
function boundedUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return text.slice(0, end);
}
