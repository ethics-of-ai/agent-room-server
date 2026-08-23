import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ServiceConfig } from "../domain/models";
import { publicRunnerDescriptors } from "../runner/registry";
import { logger } from "../logging/logger";

/**
 * `$AGENTROOM_HOME/config/runners.json` — the runner catalog the macOS app reads
 * when the backend is **not running**.
 *
 * Phase 5 of docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md requires an offline
 * floor, because the Mac's settings panes deliberately work with the backend
 * stopped — that is exactly when an operator is fixing why it would not start —
 * and `runnerKind` is a picker over runners only the backend knows. The app
 * bundles a floor of its own; this file is the *override* a backend that has
 * started successfully leaves behind, so a runner registered after the app
 * shipped still appears in that picker.
 *
 * It is the **same safe/public projection** `GET /api/runners` serves and
 * nothing more: an id, a display name, and the three availability states. No
 * descriptor policy field, and no tier-3 material — an executable path, an
 * environment name, a Keychain slot is not in a descriptor at all, which is why
 * this file can sit beside `settings.json` without becoming a secret.
 *
 * It deliberately stops short of that route's fourth state. Runtime readiness is
 * what a capability discovery *proved* in a running process; this file is
 * written at startup, before anything has been spawned, and is read when the
 * backend is not running at all, so a `ready` field here could only ever be a
 * stale claim. The serializer passes no readiness lookup, so the field is absent
 * by construction rather than by remembering to strip it.
 *
 * It is a cache, not a source of truth. A backend never reads it, the Mac
 * prefers its own bundle when the version is one it does not know, and a write
 * failure is logged and shrugged off — a read-only home must not stop the
 * backend from serving.
 */
export const RUNNER_CATALOG_SCHEMA_VERSION = 1;

export function resolveRunnerCatalogPath(agentRoomHome?: string, cwd = process.cwd()): string {
  const base = agentRoomHome ? resolve(agentRoomHome, "config") : resolve(cwd, ".agentroom", "config");
  return resolve(base, "runners.json");
}

export function serializeRunnerCatalog(config: ServiceConfig): string {
  return `${JSON.stringify(
    {
      schemaVersion: RUNNER_CATALOG_SCHEMA_VERSION,
      runners: publicRunnerDescriptors(config)
    },
    null,
    2
  )}\n`;
}

/**
 * Publishes the catalog atomically (sibling temp opened `O_EXCL`, then renamed),
 * the same discipline as the settings write, so the Mac never reads a torn file.
 * Never throws: this is a courtesy for an app that is not running yet.
 */
export async function writeRunnerCatalogFile(config: ServiceConfig): Promise<void> {
  const path = resolveRunnerCatalogPath(config.agentRoomHome);
  const encoded = serializeRunnerCatalog(config);
  const tmpPath = `${path}.${randomUUID()}.agentroom-tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmpPath, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await rename(tmpPath, path);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  } catch (error) {
    logger.warn({ path, error }, "Could not publish the offline runner catalog");
  }
}
