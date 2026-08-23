import type { FastifyInstance } from "fastify";
import { toPublicConfig } from "../config/serviceConfig";
import {
  ManagedSettingsFileError,
  isManagedSettingEnvLocked,
  managedSettingEntry,
  managedSettingsPatchSchema,
  normalizeManagedSettingsPatch,
  readManagedSettingsFile,
  updateManagedSettings
} from "../config/settingsStore";
import type { ServiceConfig } from "../domain/models";
import type { EventBus } from "../events/EventBus";
import type { ConfigReloadedPayload } from "../events/eventTypes";

// The managed settings surface. The read and the write live together because
// they are one contract: the metadata block the GET serves is what tells a
// client which keys the PATCH will accept.
export async function registerConfigRoutes(
  app: FastifyInstance,
  deps: { config: ServiceConfig; eventBus: EventBus }
): Promise<void> {
  // Compose-on-read, like the spatial scene service: the managed settings file
  // is re-read per request so the metadata can report what a restart would
  // produce, without a watcher or any cached state. A file we cannot use tells
  // us nothing about a restart, so pending state is omitted rather than guessed.
  app.get("/api/config", async () => {
    const path = deps.config.managedSettingsPath;
    if (!path) return toPublicConfig(deps.config);
    const onDisk = await readManagedSettingsFile(path);
    return toPublicConfig(deps.config, onDisk.issue ? undefined : onDisk.settings);
  });

  // Mutating PATCH, so the global preHandler in server.ts already requires the
  // bearer token when `AUTH_TOKEN` is configured; this handler deliberately does
  // not authenticate again. It writes exactly one JSON file in the backend-owned
  // config directory — never a registered workspace, never an executable path,
  // never a shell — and everything it writes applies on backend restart, so no
  // route is added or removed and no runner is reconfigured underneath a turn.
  app.patch("/api/config", async (request, reply) => {
    const path = deps.config.managedSettingsPath;
    if (!path) {
      // Only reachable from a hand-built ServiceConfig (route tests);
      // `getServiceConfig()` always resolves a path.
      return reply.code(503).send({ error: "Managed settings are not available on this backend" });
    }

    const parsed = managedSettingsPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid config patch payload" });
    }
    // A body may address a setting by its canonical version-2 path or by its
    // version-1 flat key, because a client and a backend upgrade independently.
    // Naming one setting twice is refused rather than resolved: assigning
    // precedence would silently apply a value the caller did not send.
    const { patch, addresses, duplicated } = normalizeManagedSettingsPatch(parsed.data);
    if (duplicated.length > 0) {
      return reply.code(400).send({
        error: "A setting was named twice in this patch, once per address form.",
        duplicatedKeys: duplicated
      });
    }

    // Authorization before state. The tier-2 gate is about *who is asking* —
    // the master switch is env-injected by the Mac app precisely so a bearer
    // token cannot grant it to itself — while the env lock below is a property
    // of the key. When both apply, "you may not change trust settings from
    // here" is the more actionable answer. See docs/safety/TRUST_AND_SAFETY.md.
    const restrictedKeys = deps.config.remoteSettingsAdmin
      ? []
      : addresses.filter((address) => managedSettingEntry(address)?.definition.tier === 2);
    if (restrictedKeys.length > 0) {
      return reply.code(403).send({
        error:
          "Trust settings can only be changed on the Mac. Turn on AgentRoom → Advanced → “Allow clients to change trust settings” first.",
        restrictedKeys
      });
    }

    const lockedKeys = Object.keys(patch).filter((key) => isManagedSettingEnvLocked(key));
    if (lockedKeys.length > 0) {
      return reply.code(409).send({
        error: "These settings are set by the environment on the Mac and cannot be changed here.",
        lockedKeys: lockedKeys.map((key) => managedSettingEntry(key)?.path ?? key)
      });
    }

    let update;
    try {
      update = await updateManagedSettings(path, patch);
    } catch (error) {
      if (error instanceof ManagedSettingsFileError) {
        // The store refuses to merge into a file it could not parse, because
        // that would silently drop the operator's other keys. Report the state
        // instead of rewriting the file from what this one request happens to
        // know; the backend is meanwhile running on conservative defaults.
        //
        // A file written against a newer settings schema gets the same refusal
        // and a different sentence: it is not damaged, so "reset it" would be
        // the wrong advice — the repair is on the Mac, by updating AgentRoom.
        if (error.unsupportedSchemaVersion !== undefined) {
          return reply.code(409).send({
            error:
              `The backend settings file was written for settings schema version ${error.unsupportedSchemaVersion}, `
              + "which this backend cannot read. Update AgentRoom on the Mac.",
            settingsSchemaVersion: error.unsupportedSchemaVersion
          });
        }
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }

    if (update.changedKeys.length > 0) {
      const trustKeys = update.changedKeys.filter((key) => managedSettingEntry(key)?.definition.tier === 2);
      if (trustKeys.length > 0) {
        // Same reflex as the terminal's startup warning: a trust-posture change
        // is worth a line in the operator's own log, names only.
        request.log.warn(
          { keys: trustKeys },
          "trust-posture settings changed through PATCH /api/config; applies on backend restart"
        );
      }
      const payload: ConfigReloadedPayload = {
        changedKeys: update.changedKeys,
        requiresRestart: true,
        audit: { changedKeys: update.changedKeys }
      };
      deps.eventBus.publish("config_reloaded", payload);
    }

    // The store just published these bytes, so they are the on-disk state the
    // pending-value derivation needs: no second read, and no window in which a
    // concurrent write could make the reply disagree with what we wrote. The
    // client re-renders the whole surface from this one response.
    return toPublicConfig(deps.config, update.settings);
  });
}
