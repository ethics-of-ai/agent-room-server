import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256 of a buffer or string. The single hashing primitive shared by the editor
 * catalog manifest/version, workspace-id derivation, and attachment content addressing, so the
 * algorithm/encoding is defined in one place rather than re-rolled inline per call site.
 */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
