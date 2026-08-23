import type { ZodTypeAny } from "zod";

/**
 * What a *managed* setting is, in a module with no runtime imports.
 *
 * Phase 5 of docs/engineering/UNIVERSAL_RUNNER_BOUNDARY.md moves the per-runner
 * managed keys onto the runner descriptors that own them, so adding a runner
 * stops meaning "and edit the settings schema, the env table, the defaults map,
 * the tier map, and both Swift mirrors". The declaration is this shape; the
 * settings layer (`config/settingsStore.ts`) assembles the global declarations
 * and every descriptor's into one table and does the rest generically.
 *
 * The type lives in `domain/` rather than beside either consumer because both
 * consumers are downstream of it: `runner/registry.ts` declares runner settings
 * and `config/settingsStore.ts` reads them, and the registry may not import the
 * settings layer (that layer already imports the registry).
 */

/**
 * Tier 1 is a preference. Tier 2 is a trust-posture decision that stays on the
 * Mac unless the operator flips the `REMOTE_SETTINGS_ADMIN` master switch.
 *
 * There is deliberately no tier 3 here: bootstrap, secret, and execution
 * settings are not managed settings at all, and their *absence* from this table
 * is what keeps the ungated `GET /api/config` non-secret. A tier-3 value cannot
 * be excluded by a filter it is never handed to.
 * See docs/safety/TRUST_AND_SAFETY.md.
 */
export type ManagedSettingTier = 1 | 2;

/** Everything a managed setting can hold. JSON scalars only — never a section. */
export type ManagedSettingValue = string | number | boolean;

/** How this key's environment string is read, using `config/env.ts`'s parsers. */
export type ManagedSettingValueKind = "string" | "boolean" | "number";

export interface ManagedSettingDefinition {
  /**
   * The camelCase field name inside this setting's own scope: `runnerKind` for a
   * global, `sandboxMode` for a runner's. The version-2 document addresses it as
   * `global.<field>` or `runners.<runnerKind>.<field>`, and the version-1
   * document as the flat `<prefix><Field>` key.
   */
  readonly field: string;
  /**
   * The value vocabulary, as an *optional* schema — an absent key means "use the
   * code default", which is a different statement from any value.
   *
   * Must be at least as strict as the same key in `serviceConfigSchema`, so a
   * settings file that parses can never make startup throw. Every declaration
   * gets that by construction rather than by review: they reuse the very schema
   * objects `serviceConfigSchema` is built from.
   */
  readonly schema: ZodTypeAny;
  readonly tier: ManagedSettingTier;
  /** The environment variable that wins and *locks* this key. */
  readonly env: string;
  readonly valueKind: ManagedSettingValueKind;
  /** The code default. `undefined` means the key simply stays unset. */
  readonly defaultValue?: ManagedSettingValue;
}
