import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServiceConfig } from "../../../domain/models";

/** The profile name AgentRoom boots. Not a shipped template, so the launcher never seeds it. */
export const DEEPSEEK_PROFILE_NAME = "agentroom";

const EMPTY_PATCH = "[]\n";
const MANIFEST = `${JSON.stringify({
  name: `dsh-profile-${DEEPSEEK_PROFILE_NAME}`,
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: [] } }
}, undefined, 2)}\n`;

/**
 * The Harness home every AgentRoom-launched runtime uses.
 *
 * The launcher reads profiles, a home-level patch layer, credentials, and a
 * `.env` file from its home. Pinning it under `STATE_DIR` keeps an operator's
 * `~/.dsh` from adding rows to AgentRoom's graph or values to its environment.
 */
export function deepseekHome(config: ServiceConfig): string {
  return resolve(config.stateDir, "deepseek", "home");
}

/**
 * Write the empty profile the overlay is applied to. Its bundle list, its own
 * patch layer, and the home-level patch layer are all empty, so the selected
 * `--patch` file is the whole graph.
 */
export async function prepareDeepSeekProfile(config: ServiceConfig): Promise<string> {
  const home = deepseekHome(config);
  const profile = join(home, "profiles", DEEPSEEK_PROFILE_NAME);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  for (const directory of [home, join(home, "profiles"), profile]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error("DeepSeek Harness home must be a regular directory.");
  }
  await writeIfChanged(join(profile, "package.json"), MANIFEST);
  await writeIfChanged(join(profile, "cordis.patch.yml"), EMPTY_PATCH);
  await writeIfChanged(join(home, "cordis.patch.yml"), EMPTY_PATCH);
  return home;
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isFile() && await readFile(path, "utf8") === content) return;
    if (!info.isFile()) throw new Error(`DeepSeek Harness profile file ${path} must be a regular file.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, content, { mode: 0o600 });
}
