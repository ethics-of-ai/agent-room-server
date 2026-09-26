import type { RunnerDescriptor } from "./registry";

/**
 * Derived managed-settings scopes: the flat version-1 key → version-2 address
 * map rebuilt from the live descriptor table.
 *
 * Split out of `registry.ts` so the descriptor table owns declarations while
 * this module owns only what is derived from them. It imports the registry as
 * a type only and receives the descriptor list explicitly, so the dependency
 * stays one-directional: the registry may call the rebuild, the settings layer
 * may read the map, and neither order can re-enter the other at load time.
 */

/**
 * Where a managed setting lives in the version-2 settings document:
 * `global.<field>`, or `runners.<runnerKind>.<field>`.
 *
 * Resolving it from the declarations rather than a hand-written table in
 * `config/` is what keeps the settings layer free of runner literals — a table
 * there would be a second admission list to maintain, and adding a runner
 * would again mean editing a file outside `runner/`.
 */
export type ManagedSettingScope =
  | { readonly scope: "global" }
  | { readonly scope: "runner"; readonly runnerKind: string; readonly field: string };

/** The flat version-1 key a runner-owned managed setting answers to. */
export function runnerSettingKey(prefix: string, field: string): string {
  return `${prefix}${field[0].toUpperCase()}${field.slice(1)}`;
}

/**
 * Flat version-1 key → the version-2 address that owns it. Rebuilt whenever
 * the descriptor set changes, so a configured adapter's settings are
 * addressable the moment it is admitted.
 */
const runnerSettingScopes = new Map<string, ManagedSettingScope>();

export function rebuildRunnerSettingScopes(descriptors: readonly RunnerDescriptor[]): void {
  runnerSettingScopes.clear();
  for (const descriptor of descriptors) {
    for (const definition of descriptor.settings) {
      runnerSettingScopes.set(runnerSettingKey(descriptor.settingsKeyPrefix, definition.field), {
        scope: "runner",
        runnerKind: descriptor.id,
        field: definition.field
      });
    }
  }
}

export function managedSettingScope(key: string): ManagedSettingScope {
  const owned = runnerSettingScopes.get(key);
  // A key no descriptor declares is global — including one that merely *looks*
  // like a runner's (`codexish`), which belongs to nobody rather than silently
  // becoming `runners.codex.ish`. The declarations answer it exactly.
  return owned ?? { scope: "global" };
}
