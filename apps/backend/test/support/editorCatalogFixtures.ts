import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The repository root, for tests that read the visionOS sources the catalog comes from. */
export const repoRoot = resolve(__dirname, "../../../..");

/** The committed backend catalog the editor catalog tests load. */
export const catalogAssetsDir = resolve(__dirname, "../../catalog-assets");

/** The visionOS resource directory the catalog is authored in. */
export const visionResourcesDir = resolve(repoRoot, "apps/visionos/AgentRoom/Resources");

/** A writable copy of the committed catalog, at `<tmp>/<prefix>…/catalog-assets`. */
export async function copyCatalog(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const catalog = join(root, "catalog-assets");
  await cp(catalogAssetsDir, catalog, { recursive: true });
  return catalog;
}

/** The path of a maintainer script in `apps/backend/scripts`. */
export function backendScriptPath(name: string): string {
  return resolve(repoRoot, "apps/backend/scripts", name);
}

/** Import a maintainer script by file URL, the way the importer tests load them. */
export function loadBackendScript<Module>(name: string): Promise<Module> {
  return import(pathToFileURL(backendScriptPath(name)).href) as Promise<Module>;
}
