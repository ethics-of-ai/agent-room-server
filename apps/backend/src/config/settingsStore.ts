import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z, type ZodTypeAny } from "zod";
import type { ServiceConfig } from "../domain/models";
import type {
  ManagedSettingDefinition,
  ManagedSettingTier,
  ManagedSettingValue,
  ManagedSettingValueKind
} from "../domain/managedSettings";
import { managedSettingScope, runnerManagedSettings, type ManagedSettingScope } from "../runner/registry";
import { booleanEnv, numberEnv, optionalEnv } from "./env";
import { globalSettingDefinitions } from "./globalManagedSettings";

// The backend-owned managed settings file.
//
// Four rules give this module its shape:
//
// 1. One file, managed keys only. Bootstrap/secret/execution settings — the
//    ones that must exist before the process starts (`AUTH_TOKEN`, executable
//    paths, host/port, the storage dirs) — never enter the file, the metadata,
//    or a PATCH body. A file cannot configure the process that has not started,
//    and that seam is exactly the never-remote tier.
// 2. One precedence rule: env wins and locks the key; else file; else default.
//    This extends the model `config/env.ts` already has, where real process env
//    is protected from the `$AGENTROOM_HOME/config/.env` overlay.
// 3. One restart rule: everything here applies on backend restart. Config is
//    snapshotted once by `getServiceConfig()` and routes are registered-or-absent
//    at startup, so a uniform "applies on restart" is both the simplest rule and
//    the true one.
// 4. One admission list. *Which* settings exist is not written down here: the
//    global ones are declared in `globalManagedSettings.ts` and every runner's on its own
//    `RunnerDescriptor` (`runner/registry.ts`), and this module walks both. A
//    runner's settings work everywhere because the registry declared them, not
//    because several tables were edited together.
//
// Safety note: every declaration's schema is at least as strict as the same key
// in `serviceConfigSchema` (they reuse the same schema objects), so a file that
// parses here can never make the service config parse throw. A file that does
// *not* parse is dropped whole, which lands every key on its code default — and
// every trust-posture default is the conservative one (terminal off, no
// workspace network access), so the fail-safe direction is the safe one.

// Runtime-only managed-settings metadata stays beside its assembler. Every
// field is optional so hand-built ServiceConfig values in tests still typecheck.
declare module "../domain/models" {
  interface ServiceConfig {
    /** Per-key provenance, snapshotted at startup — the file can change under us. */
    settingsMeta?: ManagedSettingSources;
    /**
     * The resolved managed values this process is running with, keyed by their
     * version-1 flat key.
     *
     * The metadata projection reads the running value from here rather than from
     * the same-named `ServiceConfig` field, which is what lets a runner register
     * a setting without `domain/models.ts` having to grow a field for it.
     */
    settingsValues?: ManagedSettingValues;
    /** Absolute path of the managed settings file this process resolved. Internal. */
    managedSettingsPath?: string;
    /** `REMOTE_SETTINGS_ADMIN`: env-only master switch for remote tier-2 edits. */
    remoteSettingsAdmin?: boolean;
  }
  interface PublicServiceConfig {
    settings?: PublicManagedSettings;
    remoteSettingsAdmin?: boolean;
    settingsSchemaVersion?: number;
  }
}

/** The two sections of a version-2 document. Every canonical address starts here. */
const GLOBAL_SECTION = "global";
const RUNNERS_SECTION = "runners";

/**
 * One managed setting, at both of its addresses.
 *
 * `key` is the version-1 flat name — still the internal id, because it is also
 * the `ServiceConfig` field name every adapter reads. `path` is the version-2
 * address the file, the metadata block, and `PATCH /api/config` now speak.
 */
export interface ManagedSettingEntry {
  readonly key: string;
  readonly path: string;
  readonly scope: ManagedSettingScope;
  readonly definition: ManagedSettingDefinition;
}

let managedSettingEntries: readonly ManagedSettingEntry[] = [];

/** Stable key order: the metadata block and every written file follow it. */
export let managedSettingKeys: string[] = [];

/** The same settings at their canonical version-2 addresses, in the same order. */
export let managedSettingPaths: string[] = [];

let entriesByKey = new Map<string, ManagedSettingEntry>();
let entriesByPath = new Map<string, ManagedSettingEntry>();

export type ManagedSettingKey = string;

export type { ManagedSettingTier, ManagedSettingValue };

/** A settings document as this backend resolves it: version-1 flat keys. */
export type ManagedSettings = { [key: string]: ManagedSettingValue | undefined };

/** `null` clears a key back to its code default; absent leaves it untouched. */
export type ManagedSettingsPatch = { [key: string]: ManagedSettingValue | null | undefined };

export type ManagedSettingSource = "env" | "file" | "default";

export let managedSettingsSchema: z.ZodObject<z.ZodRawShape, "strict"> = z.object({}).strict();

export let managedSettingTiers: Record<string, ManagedSettingTier> = {};

export let managedSettingEnvNames: Record<string, string> = {};

// The code defaults, and the single source of truth for them: `getServiceConfig`
// resolves through this map, so a default cannot drift between the resolver and
// the pending-value derivation that predicts a restart.
export let managedSettingDefaults: ManagedSettings = {};

/**
 * The `PATCH /api/config` body: a partial record over the managed settings where
 * an explicit `null` clears a key back to its code default, and an absent key is
 * left untouched.
 *
 * Both address forms are accepted — the canonical version-2 path and the
 * version-1 flat key — because a client and a backend upgrade independently and
 * the metadata block advertises both for the same reason (see
 * {@link buildPublicManagedSettings}). `.strict()` on purpose: an unknown key is
 * a `400`, never a silently ignored field. A tier-3 key (`AUTH_TOKEN`, an
 * executable path, the bind address) has no entry here *by construction*, since
 * this is built from the declarations, so asking to PATCH one is
 * indistinguishable from a typo and is refused the same way. Per-key values
 * reuse the declaration's own schema, which is already at least as strict as
 * `serviceConfigSchema`, so an accepted patch can never write a file that makes
 * the next startup throw.
 */
export let managedSettingsPatchSchema: z.ZodObject<z.ZodRawShape, "strict"> = z.object({}).strict();

/**
 * Rebuild the managed setting table from the current registry.
 *
 * External adapters join the registry during startup, after module import. A
 * module-level table would omit their file values, metadata, patch schema,
 * environment resolution, and permission policy.
 *
 * So the derived structures are live bindings and this recomputes them. It is
 * called once at module load and again by `config/serviceConfig.ts` immediately
 * after stage 1 admits external adapters — from there rather than from the
 * registry, because the dependency runs that way: the settings layer imports the
 * registry, and the registry must not import back.
 */
export function rebuildManagedSettings(): void {
  managedSettingEntries = [
    ...globalSettingDefinitions.map((definition) => ({
      key: definition.field,
      path: `${GLOBAL_SECTION}.${definition.field}`,
      scope: { scope: "global" } as const,
      definition
    })),
    ...runnerManagedSettings().map(({ runnerKind, key, definition }) => ({
      key,
      path: `${RUNNERS_SECTION}.${runnerKind}.${definition.field}`,
      scope: { scope: "runner", runnerKind, field: definition.field } as const,
      definition
    }))
  ];
  managedSettingKeys = managedSettingEntries.map((entry) => entry.key);
  managedSettingPaths = managedSettingEntries.map((entry) => entry.path);
  entriesByKey = new Map(managedSettingEntries.map((entry) => [entry.key, entry]));
  entriesByPath = new Map(managedSettingEntries.map((entry) => [entry.path, entry]));
  managedSettingsSchema = z
    .object(Object.fromEntries(managedSettingEntries.map((entry) => [entry.key, entry.definition.schema])))
    .strict();
  managedSettingTiers = Object.fromEntries(
    managedSettingEntries.map((entry) => [entry.key, entry.definition.tier])
  );
  managedSettingEnvNames = Object.fromEntries(
    managedSettingEntries.map((entry) => [entry.key, entry.definition.env])
  );
  managedSettingDefaults = Object.fromEntries(
    managedSettingEntries.map((entry) => [entry.key, entry.definition.defaultValue])
  );
  managedSettingsPatchSchema = z
    .object(
      Object.fromEntries(
        managedSettingEntries.flatMap((entry) => [
          [entry.path, entry.definition.schema.nullable()],
          [entry.key, entry.definition.schema.nullable()]
        ])
      )
    )
    .strict();
}

rebuildManagedSettings();

export type ManagedSettingValues = ManagedSettings;

export type ManagedSettingSources = Record<string, ManagedSettingSource>;

export interface ResolvedManagedSettings {
  values: ManagedSettingValues;
  sources: ManagedSettingSources;
}

export interface PublicManagedSetting {
  /** The value this process is running with; absent when the key is unset. */
  value?: ManagedSettingValue;
  source: ManagedSettingSource;
  tier: ManagedSettingTier;
  /**
   * The shape of this setting's value, reported for every setting including one
   * whose `value` is absent — which is exactly the case a client could not infer
   * a shape from.
   *
   * This lets a client choose a control for a setting it does not recognize. A
   * registered runner may carry a setting that predates the client, and the
   * operator still needs to inspect and edit it.
   */
  valueKind: ManagedSettingValueKind;
  /**
   * The values this setting's declaration accepts, when it bounds them. Absent
   * for an open value (a model id, a timeout), where the backend's schema stays
   * the authority for what is too long or too large.
   *
   * This is a contract field rather than a client's guess. Without it, an
   * unfamiliar closed vocabulary would be
   * rendered as free text, so writing a value the PATCH refuses would *look*
   * like a valid edit. It reports the shape of the key rather than the
   * operator's posture — the same class as `tier` — so it does not change what
   * this ungated read exposes.
   */
  options?: readonly ManagedSettingValue[];
  /**
   * Whether `PATCH /api/config` would accept a change to this key right now:
   * env-locked keys never, tier-2 keys only while `remoteSettingsAdmin` is on.
   * The macOS app writes the file directly and is bound only by the env lock,
   * so it reads `source === "env"` rather than this flag.
   */
  editable: boolean;
  requiresRestart: true;
  /**
   * The value a backend restart would produce, when the file on disk no longer
   * agrees with the running snapshot. `null` means the key would be unset.
   * Absent when the key is env-locked (a file value is inert, not pending) or
   * when the file could not be read.
   */
  pendingValue?: ManagedSettingValue | null;
}

export type PublicManagedSettings = Record<string, PublicManagedSetting>;

/**
 * The settings schema this backend applies and writes, and the one it can still
 * read.
 *
 * Version 2 is the nested `global`/`runners` document: settings addressed by the
 * runner that owns them rather than by a flat name only a hand-maintained table
 * could explain. Version 1 is the flat legacy document — still read, still
 * migrated on the next write, and still what
 * {@link serializeManagedSettingsDocument} emits for the deliberate rollback
 * path, because an older AgentRoom cannot read a newer file.
 */
export const SETTINGS_SCHEMA_VERSION = 2;
export const LEGACY_SETTINGS_SCHEMA_VERSION = 1;

/**
 * The document sections this backend cannot interpret, carried back out on the
 * next write: an unregistered runner's namespace, and a field a later release
 * adds to a runner this one knows.
 *
 * Deliberately `unknown` values rather than a decoded struct: decoding into a
 * shape this backend understands would drop data written by a newer release.
 */
export interface PreservedManagedSettings {
  global?: Record<string, unknown>;
  runners?: Record<string, Record<string, unknown>>;
}

export interface ManagedSettingsRead {
  settings: ManagedSettings;
  /** The version the document declared; absent `schemaVersion` *is* version 1. */
  schemaVersion?: number;
  /** Sections this backend does not interpret, to be written back untouched. */
  preserved?: PreservedManagedSettings;
  /** Set when a file existed but could not be used; `settings` is then empty. */
  issue?: string;
  /**
   * Set when the file declares a settings schema this backend cannot apply.
   * `issue` is set too — an inapplicable file is dropped exactly like a broken
   * one — but this separates the two states, because their repairs differ: a
   * newer schema is fixed by updating AgentRoom, a broken file by resetting it.
   * Resetting a newer file would destroy a posture the operator did author.
   */
  unsupportedSchemaVersion?: number;
}

export interface ManagedSettingsUpdate {
  settings: ManagedSettings;
  previous: ManagedSettings;
  /** Canonical paths only — a change event must never carry values. */
  changedKeys: string[];
  /** True when this write also converted a version-1 document to version 2. */
  migrated: boolean;
}

/**
 * `$AGENTROOM_HOME/config/settings.json`, mirroring how `stateDir` falls back to
 * `<cwd>/.agentroom` for dev runs.
 */
export function resolveManagedSettingsPath(agentRoomHome?: string, cwd = process.cwd()): string {
  const base = agentRoomHome ? resolve(agentRoomHome, "config") : resolve(cwd, ".agentroom", "config");
  return resolve(base, "settings.json");
}

export function isManagedSettingKey(key: string): boolean {
  return entriesByKey.has(key);
}

/** Resolves either address form — canonical path or legacy flat key — to one entry. */
export function managedSettingEntry(address: string): ManagedSettingEntry | undefined {
  return entriesByPath.get(address) ?? entriesByKey.get(address);
}

/** The canonical version-2 address of a managed setting, from either address form. */
export function managedSettingPath(address: string): string | undefined {
  return managedSettingEntry(address)?.path;
}

/** True when process env supplies this key, which wins and locks it. */
export function isManagedSettingEnvLocked(key: string): boolean {
  const entry = entriesByKey.get(key);
  return entry !== undefined && optionalEnv(entry.definition.env) !== undefined;
}

export function resolveManagedSettings(fileSettings: ManagedSettings = {}): ResolvedManagedSettings {
  const values: ManagedSettingValues = {};
  const sources: ManagedSettingSources = {};

  for (const entry of managedSettingEntries) {
    const fromEnv = readManagedSettingEnv(entry.definition);
    if (fromEnv.present) {
      values[entry.key] = fromEnv.value;
      sources[entry.key] = "env";
      continue;
    }
    const fromFile = fileSettings[entry.key];
    if (fromFile !== undefined) {
      values[entry.key] = fromFile;
      sources[entry.key] = "file";
      continue;
    }
    values[entry.key] = entry.definition.defaultValue;
    sources[entry.key] = "default";
  }

  return { values, sources };
}

export function parseManagedSettingsText(text: string): ManagedSettingsRead {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { settings: {}, issue: "not valid JSON" };
  }
  if (!isJsonObject(data)) {
    return { settings: {}, issue: "not a JSON object" };
  }

  const declaredVersion = data.schemaVersion;
  if (declaredVersion !== undefined
    && (typeof declaredVersion !== "number" || !Number.isInteger(declaredVersion))) {
    return { settings: {}, issue: "has an unexpected value for schemaVersion" };
  }
  // An absent `schemaVersion` means version 1. The next write migrates it.
  const version = declaredVersion ?? LEGACY_SETTINGS_SCHEMA_VERSION;

  if (version === SETTINGS_SCHEMA_VERSION) return parseVersionTwoDocument(data);
  if (version === LEGACY_SETTINGS_SCHEMA_VERSION) return parseLegacyDocument(data);

  // Recognized as a document, and still not applied: a version this backend does
  // not know could mean anything, including a trust posture inverted. The
  // conservative defaults stand exactly as they do for an unusable file — what
  // differs is that the caller can say which state this is.
  return {
    settings: {},
    schemaVersion: version,
    unsupportedSchemaVersion: version,
    issue: `uses settings schema version ${version}, which this backend does not know`
  };
}

export function readManagedSettingsFileSync(path: string): ManagedSettingsRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return missingOrUnreadable(error);
  }
  return parseManagedSettingsText(text);
}

export async function readManagedSettingsFile(path: string): Promise<ManagedSettingsRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return missingOrUnreadable(error);
  }
  return parseManagedSettingsText(text);
}

export interface ManagedSettingsWriteOptions {
  /**
   * The document shape to emit. Defaults to {@link SETTINGS_SCHEMA_VERSION}.
   *
   * {@link LEGACY_SETTINGS_SCHEMA_VERSION} is the deliberate **rollback** path,
   * not a fallback: a genuinely older AgentRoom cannot be taught to read the
   * nested document, so converting back is the only honest way to run one. The
   * conversion is total in both directions for the settings this backend knows,
   * which is what makes the round trip a downgrade rather than a data loss —
   * except for sections only a newer release understands, which a version-1
   * document can carry but not address.
   */
  schemaVersion?: number;
}

/**
 * Serializes a settings document. Pure — it touches no filesystem — so the
 * migration and its reverse are testable as functions rather than as writes,
 * and both writers (this one and the macOS app's) can be held to the same bytes.
 */
export function serializeManagedSettingsDocument(
  settings: ManagedSettings,
  preserved?: PreservedManagedSettings,
  options: ManagedSettingsWriteOptions = {}
): string {
  const validated = managedSettingsSchema.parse(settings) as ManagedSettings;
  const schemaVersion = options.schemaVersion ?? SETTINGS_SCHEMA_VERSION;
  const document = schemaVersion === LEGACY_SETTINGS_SCHEMA_VERSION
    ? legacyDocument(validated, preserved)
    : versionTwoDocument(validated, preserved);
  // Sorted at every level, which is what makes "canonical" a property of the
  // bytes rather than of one writer's insertion order: the macOS app writes the
  // same file (its panes must work while the backend is stopped), and Swift's
  // encoder can only promise sorted keys. Same settings in, same bytes out, from
  // either side — so a diff of this file reads as the operator's edit.
  return `${JSON.stringify(sortObject(document), null, 2)}\n`;
}

/**
 * Atomic publish (sibling temp opened `O_EXCL`, then renamed), mirroring the
 * discipline `WorkspaceExplorer.writeTextFile` uses, so a reader never observes
 * a torn settings file. Validates before writing: we never write bytes our own
 * reader would reject.
 */
export async function writeManagedSettings(
  path: string,
  settings: ManagedSettings,
  preserved?: PreservedManagedSettings,
  options: ManagedSettingsWriteOptions = {}
): Promise<void> {
  const schemaVersion = options.schemaVersion ?? SETTINGS_SCHEMA_VERSION;
  if (schemaVersion !== SETTINGS_SCHEMA_VERSION && schemaVersion !== LEGACY_SETTINGS_SCHEMA_VERSION) {
    // Enforced rather than remembered: a writer that emitted a version it cannot
    // itself apply would strand the operator on a file only a future backend can
    // open.
    throw new ManagedSettingsFileError(
      `Refusing to write settings schema version ${schemaVersion}; this backend writes `
        + `version ${SETTINGS_SCHEMA_VERSION} and version ${LEGACY_SETTINGS_SCHEMA_VERSION}`
    );
  }
  const encoded = serializeManagedSettingsDocument(settings, preserved, { schemaVersion });

  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomUUID()}.agentroom-tmp`;
  await writeFile(tmpPath, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

/** A settings file that exists but cannot be used. Never thrown on read — only
 * on the read-merge-write, where merging into a file we could not parse would
 * silently drop the operator's other keys. */
export class ManagedSettingsFileError extends Error {
  /** Set when the refusal is a schema this backend cannot apply, not damage. */
  readonly unsupportedSchemaVersion?: number;

  constructor(message: string, unsupportedSchemaVersion?: number) {
    super(message);
    this.unsupportedSchemaVersion = unsupportedSchemaVersion;
  }
}

let updateChain: Promise<unknown> = Promise.resolve();

/**
 * Read-merge-write, serialized per process so two concurrent updates cannot
 * lose each other's keys. Cross-process contention with the macOS app remains
 * last-write-wins.
 *
 * A version-1 file is migrated **whole** by the first write that changes
 * anything — not key by key, and never into a dual-shape document, because two
 * addresses for one setting is a precedence question nobody should have to
 * answer. A file that changes nothing is left exactly as it is, so simply
 * reading settings never rewrites an operator's file underneath them.
 */
export function updateManagedSettings(path: string, patch: ManagedSettingsPatch): Promise<ManagedSettingsUpdate> {
  const run = async (): Promise<ManagedSettingsUpdate> => {
    const read = await readManagedSettingsFile(path);
    if (read.issue) {
      throw new ManagedSettingsFileError(
        `Managed settings file is unusable: ${read.issue}`,
        read.unsupportedSchemaVersion
      );
    }
    const previous = read.settings;
    const merged: ManagedSettings = { ...previous };
    const changedKeys: string[] = [];

    for (const entry of managedSettingEntries) {
      if (!Object.prototype.hasOwnProperty.call(patch, entry.key)) continue;
      const requested = patch[entry.key];
      const next = requested === null ? undefined : requested;
      if (next === previous[entry.key]) continue;
      if (next === undefined) {
        delete merged[entry.key];
      } else {
        merged[entry.key] = next;
      }
      changedKeys.push(entry.path);
    }

    const settings = managedSettingsSchema.parse(merged) as ManagedSettings;
    const migrated = changedKeys.length > 0 && read.schemaVersion === LEGACY_SETTINGS_SCHEMA_VERSION;
    if (changedKeys.length > 0) {
      // The preserved sections ride back out untouched. A toggle of a setting
      // this backend knows must not be the reason a section it does not read
      // disappears from the operator's file.
      await writeManagedSettings(path, settings, read.preserved);
    }
    return { settings, previous, changedKeys, migrated };
  };

  const result = updateChain.then(run, run);
  updateChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * The additive `settings` metadata block on `GET /api/config`. Tier-3 keys are
 * absent by construction — they are not declarations — so this projection cannot
 * grow a secret.
 *
 * Every setting is reported at **both** addresses: its canonical version-2 path
 * and its version-1 flat key. That is the same dual-emission the canonical event
 * contract uses, and for the same reason — a headset and a backend upgrade
 * independently, so a client that only knows flat keys must keep working against
 * a backend that has moved on, and a client that knows paths must not have to
 * guess which backend it is talking to. `settingsSchemaVersion` on the same
 * response says which set is canonical; the legacy aliases retire with the
 * advertised floor, not before.
 */
export function buildPublicManagedSettings(
  config: ServiceConfig,
  onDiskSettings?: ManagedSettings
): PublicManagedSettings {
  const remoteSettingsAdmin = config.remoteSettingsAdmin ?? false;
  const result: PublicManagedSettings = {};

  for (const entry of managedSettingEntries) {
    // A config that never went through `getServiceConfig` (a hand-built one in a
    // test) carries no provenance; env presence is still knowable, so report that
    // much rather than claiming a file the resolver never read.
    const source = config.settingsMeta?.[entry.key]
      ?? (isManagedSettingEnvLocked(entry.key) ? "env" : "default");
    const tier = entry.definition.tier;
    // Read from the resolved values the startup snapshot carries, falling back to
    // the same-named `ServiceConfig` field for a hand-built config. Reading the
    // field *first* would mean a runner could not register a setting without
    // `domain/models.ts` growing a field for it.
    const running = config.settingsValues?.[entry.key]
      ?? ((config as unknown as Record<string, unknown>)[entry.key] as ManagedSettingValue | undefined);

    const options = managedSettingOptions(entry.definition.schema);
    const setting: PublicManagedSetting = {
      source,
      tier,
      valueKind: entry.definition.valueKind,
      editable: source !== "env" && (tier === 1 || remoteSettingsAdmin),
      requiresRestart: true
    };
    if (options) setting.options = options;
    if (running !== undefined) setting.value = running;

    if (source !== "env" && onDiskSettings) {
      const afterRestart = onDiskSettings[entry.key] !== undefined
        ? onDiskSettings[entry.key]
        : entry.definition.defaultValue;
      if (afterRestart !== running) {
        setting.pendingValue = afterRestart === undefined ? null : afterRestart;
      }
    }

    result[entry.path] = setting;
    result[entry.key] = setting;
  }

  return result;
}

/**
 * Resolves a `PATCH /api/config` body's addresses to internal keys.
 *
 * A body may use either address form, but not both for one setting: two
 * addresses for the same key is a precedence question, and answering it silently
 * is how an operator ends up with the value they did not send.
 */
export function normalizeManagedSettingsPatch(
  body: Record<string, ManagedSettingValue | null | undefined>
): { patch: ManagedSettingsPatch; addresses: string[]; duplicated: string[] } {
  const patch: ManagedSettingsPatch = {};
  const addresses: string[] = [];
  const duplicated: string[] = [];

  for (const [address, value] of Object.entries(body)) {
    const entry = managedSettingEntry(address);
    if (!entry) continue;
    if (Object.prototype.hasOwnProperty.call(patch, entry.key)) {
      if (!duplicated.includes(entry.path)) duplicated.push(entry.path);
      continue;
    }
    patch[entry.key] = value === undefined ? null : value;
    addresses.push(entry.path);
  }

  return { patch, addresses, duplicated };
}

/**
 * The closed vocabulary a declaration accepts, or `undefined` where the value is
 * open.
 *
 * Read out of the declaration's **own schema** rather than declared beside it,
 * for the same reason the patch schema is: that schema is what
 * `PATCH /api/config` validates against, so a hand-written second list is a list
 * that can disagree with the refusal a client would actually receive — which is
 * worse than no list, because it looks authoritative.
 *
 * A vocabulary that is not a literal set is deliberately not synthesized here.
 * `runnerKind`'s values are the live registry's answer, and `GET /api/runners`
 * is where a client already reads them; restating them in this block would be a
 * second admission list, and a stale one the moment an adapter is configured.
 */
function managedSettingOptions(schema: ZodTypeAny): readonly ManagedSettingValue[] | undefined {
  let inner = schema;
  // A declaration wraps its vocabulary to say "absent is allowed"; the
  // vocabulary itself is underneath the wrapper.
  while (
    inner instanceof z.ZodOptional
    || inner instanceof z.ZodDefault
    || inner instanceof z.ZodNullable
  ) {
    inner = inner._def.innerType as ZodTypeAny;
  }
  return inner instanceof z.ZodEnum ? (inner.options as readonly ManagedSettingValue[]) : undefined;
}

function readManagedSettingEnv(definition: ManagedSettingDefinition): { present: boolean; value?: ManagedSettingValue } {
  const name = definition.env;
  if (optionalEnv(name) === undefined) return { present: false };
  switch (definition.valueKind) {
    case "boolean":
      return { present: true, value: booleanEnv(name) };
    case "number":
      // The fallback is unreachable (the value is present); a non-numeric value
      // still throws here, exactly as it did before these keys were managed.
      return { present: true, value: numberEnv(name, 0) };
    default:
      return { present: true, value: optionalEnv(name) };
  }
}

function versionTwoDocument(
  settings: ManagedSettings,
  preserved?: PreservedManagedSettings
): Record<string, unknown> {
  // These keys partly come from a newer backend this one does not understand.
  // A regular object would make names such as `constructor`, `toString`, or
  // `__proto__` collide with Object.prototype instead of behaving like JSON
  // object keys, so every dynamic document map is deliberately prototype-free.
  const global = jsonRecord<unknown>();
  const runners = jsonRecord<Record<string, unknown>>();

  for (const entry of managedSettingEntries) {
    const value = settings[entry.key];
    if (value === undefined) continue;
    if (entry.scope.scope === "global") {
      global[entry.definition.field] = value;
      continue;
    }
    const section = hasOwn(runners, entry.scope.runnerKind)
      ? runners[entry.scope.runnerKind]
      : jsonRecord<unknown>();
    section[entry.definition.field] = value;
    runners[entry.scope.runnerKind] = section;
  }

  // Last, and verbatim: this backend does not read these and must not be the
  // reason they are lost. A preserved field never overwrites an applied one —
  // it is only ever an address this backend has no declaration for.
  for (const [field, value] of Object.entries(preserved?.global ?? {})) {
    if (!hasOwn(global, field)) global[field] = value;
  }
  for (const [runnerKind, section] of Object.entries(preserved?.runners ?? {})) {
    const merged = hasOwn(runners, runnerKind)
      ? runners[runnerKind]
      : jsonRecord<unknown>();
    for (const [field, value] of Object.entries(section)) {
      if (!hasOwn(merged, field)) merged[field] = value;
    }
    runners[runnerKind] = merged;
  }

  const document = jsonRecord<unknown>();
  document.schemaVersion = SETTINGS_SCHEMA_VERSION;
  if (Object.keys(global).length > 0) document[GLOBAL_SECTION] = global;
  if (Object.keys(runners).length > 0) document[RUNNERS_SECTION] = runners;
  return document;
}

/**
 * The reverse serializer for an older AgentRoom that reads the flat version-1 document.
 * reads. `schemaVersion` is deliberately absent, because an absent version *is*
 * version 1 — stamping it would produce a file an older reader treats as
 * malformed, which is the opposite of a rollback.
 */
function legacyDocument(
  settings: ManagedSettings,
  preserved?: PreservedManagedSettings
): Record<string, unknown> {
  const document = jsonRecord<unknown>();
  for (const entry of managedSettingEntries) {
    if (settings[entry.key] !== undefined) document[entry.key] = settings[entry.key];
  }
  // A version-1 document has nowhere to *address* these, but it can still carry
  // them. The version-1 reader tolerates both names and writes them back
  // untouched.
  if (preserved?.global && Object.keys(preserved.global).length > 0) {
    document[GLOBAL_SECTION] = preserved.global;
  }
  if (preserved?.runners && Object.keys(preserved.runners).length > 0) {
    document[RUNNERS_SECTION] = preserved.runners;
  }
  return document;
}

function parseLegacyDocument(data: Record<string, unknown>): ManagedSettingsRead {
  const flat: Record<string, unknown> = { ...data };
  for (const field of [GLOBAL_SECTION, RUNNERS_SECTION, "schemaVersion"]) delete flat[field];

  const parsed = managedSettingsSchema.safeParse(flat);
  if (!parsed.success) {
    // Dropped whole rather than per-key: a partially applied trust file is a
    // worse answer than the conservative defaults. See the header note.
    return { settings: {}, issue: describeSchemaIssues(parsed.error) };
  }

  const preserved: PreservedManagedSettings = {};
  for (const [field, section] of [[GLOBAL_SECTION, data[GLOBAL_SECTION]], [RUNNERS_SECTION, data[RUNNERS_SECTION]]] as const) {
    if (section === undefined) continue;
    if (!isJsonObject(section)) return { settings: {}, issue: `has an unexpected value for ${field}` };
  }

  const global = data[GLOBAL_SECTION];
  if (isJsonObject(global)) {
    // Known addresses are dropped rather than carried forward. In a version-1
    // document they were never applied — the flat key is what this backend
    // resolved — so preserving one across the migration would silently *activate*
    // a trust value the operator's running backend had been ignoring.
    const unknown = Object.fromEntries(
      Object.entries(global).filter(([field]) => !entriesByPath.has(`${GLOBAL_SECTION}.${field}`))
    );
    if (Object.keys(unknown).length > 0) preserved.global = unknown;
  }

  const runners = data[RUNNERS_SECTION];
  if (isJsonObject(runners)) {
    const sections = jsonRecord<Record<string, unknown>>();
    for (const [runnerKind, section] of Object.entries(runners)) {
      if (!isJsonObject(section)) return { settings: {}, issue: `has an unexpected value for runners.${runnerKind}` };
      const unknown = Object.fromEntries(
        Object.entries(section).filter(
          ([field]) => !entriesByPath.has(`${RUNNERS_SECTION}.${runnerKind}.${field}`)
        )
      );
      if (Object.keys(unknown).length > 0) sections[runnerKind] = unknown;
    }
    if (Object.keys(sections).length > 0) preserved.runners = sections;
  }

  return {
    settings: parsed.data as ManagedSettings,
    schemaVersion: LEGACY_SETTINGS_SCHEMA_VERSION,
    ...(Object.keys(preserved).length > 0 ? { preserved } : {})
  };
}

function parseVersionTwoDocument(data: Record<string, unknown>): ManagedSettingsRead {
  const legacyKey = managedSettingKeys.find((key) => data[key] !== undefined);
  if (legacyKey) {
    // One file, exactly one schema. Assigning precedence between a version-2
    // section and a legacy key at the top level would be a silent answer to a
    // question the operator did not know they were asking.
    return {
      settings: {},
      issue: `declares schema version ${SETTINGS_SCHEMA_VERSION} alongside the legacy key ${legacyKey}`
    };
  }
  const unexpected = Object.keys(data).find(
    (field) => ![GLOBAL_SECTION, RUNNERS_SECTION, "schemaVersion"].includes(field)
  );
  if (unexpected) return { settings: {}, issue: `has an unexpected key ${unexpected}` };

  const settings: ManagedSettings = jsonRecord<ManagedSettingValue | undefined>();
  const preserved: PreservedManagedSettings = {};

  const global = data[GLOBAL_SECTION];
  if (global !== undefined) {
    if (!isJsonObject(global)) return { settings: {}, issue: `has an unexpected value for ${GLOBAL_SECTION}` };
    const unknown = jsonRecord<unknown>();
    for (const [field, value] of Object.entries(global)) {
      const path = `${GLOBAL_SECTION}.${field}`;
      const entry = entriesByPath.get(path);
      if (!entry) {
        // Forward compatibility: preserved, never applied.
        unknown[field] = value;
        continue;
      }
      const parsed = entry.definition.schema.safeParse(value);
      // A malformed *known* value still makes the file unusable — the trust rule
      // that outranks forward compatibility.
      if (!parsed.success) return { settings: {}, issue: `has an unexpected value for ${path}` };
      settings[entry.key] = parsed.data as ManagedSettingValue | undefined;
    }
    if (Object.keys(unknown).length > 0) preserved.global = unknown;
  }

  const runners = data[RUNNERS_SECTION];
  if (runners !== undefined) {
    if (!isJsonObject(runners)) return { settings: {}, issue: `has an unexpected value for ${RUNNERS_SECTION}` };
    const unknownSections = jsonRecord<Record<string, unknown>>();
    for (const [runnerKind, section] of Object.entries(runners)) {
      if (!isJsonObject(section)) {
        return { settings: {}, issue: `has an unexpected value for ${RUNNERS_SECTION}.${runnerKind}` };
      }
      const unknown = jsonRecord<unknown>();
      for (const [field, value] of Object.entries(section)) {
        const path = `${RUNNERS_SECTION}.${runnerKind}.${field}`;
        const entry = entriesByPath.get(path);
        if (!entry) {
          // An unregistered runner's whole namespace lands here too, one field at
          // a time: this backend cannot validate what it did not register.
          unknown[field] = value;
          continue;
        }
        const parsed = entry.definition.schema.safeParse(value);
        if (!parsed.success) return { settings: {}, issue: `has an unexpected value for ${path}` };
        settings[entry.key] = parsed.data as ManagedSettingValue | undefined;
      }
      if (Object.keys(unknown).length > 0) unknownSections[runnerKind] = unknown;
    }
    if (Object.keys(unknownSections).length > 0) preserved.runners = unknownSections;
  }

  return {
    settings,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    ...(Object.keys(preserved).length > 0 ? { preserved } : {})
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON object whose caller-controlled keys cannot resolve through a prototype. */
function jsonRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Key-sorted at every level, so "canonical" is a property of the bytes. */
function sortObject(value: Record<string, unknown>): Record<string, unknown> {
  const sorted = jsonRecord<unknown>();
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJsonValue(value[key]);
  }
  return sorted;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  return isJsonObject(value) ? sortObject(value) : value;
}

function missingOrUnreadable(error: unknown): ManagedSettingsRead {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {} };
  return { settings: {}, issue: "could not be read" };
}

function describeSchemaIssues(error: z.ZodError): string {
  const described = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  const suffix = error.issues.length > 3 ? ` (+${error.issues.length - 3} more)` : "";
  return `${described}${suffix}`.slice(0, 500);
}

// `managedSettingScope` is the registry's answer to which runner owns a flat key,
// and it is what makes the version-2 addresses above derived rather than
// tabulated here. Re-exported so callers that only need the address form do not
// have to reach into the runner layer for it.
export { managedSettingScope };
