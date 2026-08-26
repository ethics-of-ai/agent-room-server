#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const require = createRequire(import.meta.url);

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) {
      throw new Error("usage: generate-release-manifest --output PATH --release-tag vX.Y.Z --dmg-name NAME --architecture arm64");
    }
    values.set(name.slice(2), value);
  }
  for (const required of ["output", "release-tag", "dmg-name", "architecture"]) {
    if (!values.has(required)) throw new Error(`missing --${required}`);
  }
  return values;
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArguments(argv);
  const modulePath = resolve(repoRoot, "apps/backend/dist/releaseManifest.js");
  const { buildReleaseManifest } = require(modulePath);
  const manifest = buildReleaseManifest({
    releaseTag: values.get("release-tag"),
    dmgName: values.get("dmg-name"),
    architecture: values.get("architecture")
  });
  await writeFile(resolve(values.get("output")), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
