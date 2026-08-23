import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolve(__dirname, "../../..");

// The public mirror (docs/operations/OPEN_SOURCE_MIRROR.md) ships the committed
// catalog without the visionOS tree it was synced from, so parity can only be
// checked where that tree is.
const appResourcesPresent = existsSync(resolve(repoRoot, "apps/visionos/AgentRoom/Resources"));

// The committed backend catalog (apps/backend/catalog-assets) is generated from
// the visionOS app's curated editor assets by sync-catalog-assets.mjs. If the app
// assets change but the backend copy is not re-synced, the served catalog drifts
// from the bundled fallback. This test fails loudly on that drift.
describe.skipIf(!appResourcesPresent)("catalog asset sync parity", () => {
  it("keeps the committed backend catalog byte-identical to the app's curated set", async () => {
    const sync = await import(
      pathToFileURL(resolve(repoRoot, "apps/backend/scripts/sync-catalog-assets.mjs")).href
    );
    const pairs: Array<{ source: string; dest: string }> = await sync.collectCatalogFiles(repoRoot);
    expect(pairs.length).toBeGreaterThan(0);

    const destRoot = resolve(repoRoot, sync.catalogAssetsDir);

    // Every synced source file is present and byte-equal in the committed dir.
    for (const { source, dest } of pairs) {
      const [sourceBytes, destBytes] = await Promise.all([readFile(source), readFile(resolve(destRoot, dest))]);
      expect(destBytes.equals(sourceBytes), `drift in ${dest}; re-run apps/backend/scripts/sync-catalog-assets.mjs`).toBe(
        true
      );
    }

    // And the committed dir holds nothing stale beyond the synced files + README.
    const entries = await readdir(destRoot, { recursive: true });
    const destFiles: string[] = [];
    for (const entry of entries) {
      const normalized = entry.split(sep).join("/");
      if ((await stat(resolve(destRoot, entry))).isFile()) destFiles.push(normalized);
    }
    expect(new Set(destFiles)).toEqual(new Set([...pairs.map((pair) => pair.dest), "README.md"]));
  });
});
