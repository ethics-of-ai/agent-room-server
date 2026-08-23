import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

loadDotenvFiles();

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

export function numberEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric env var ${name}`);
  }
  return parsed;
}

export function booleanEnv(name: string, fallback = false): boolean {
  const value = optionalEnv(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function listEnv(name: string, fallback: string[]): string[] {
  const value = optionalEnv(name);
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function resolveDotenvPaths(
  cwd = process.cwd(),
  configDir = __dirname,
  agentRoomHome = process.env.AGENTROOM_HOME
): string[] {
  return uniquePaths([
    resolve(cwd, ".env"),
    resolve(configDir, "../../../..", ".env"),
    ...(agentRoomHome ? [resolve(agentRoomHome, "config", ".env")] : [])
  ]);
}

export function loadDotenvFiles(
  cwd = process.cwd(),
  configDir = __dirname,
  protectedEnv = new Set(Object.keys(process.env))
): void {
  const loaded = new Set<string>();
  for (const path of resolveDotenvPaths(cwd, configDir, undefined)) {
    loadDotenvFile(path, loaded);
  }
  const agentRoomHome = process.env.AGENTROOM_HOME;
  if (agentRoomHome) {
    loadDotenvFile(resolve(agentRoomHome, "config", ".env"), loaded, { override: true, protectedEnv });
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function loadDotenvFile(
  path: string,
  loaded: Set<string>,
  options: { override?: boolean; protectedEnv?: ReadonlySet<string> } = {}
): void {
  if (loaded.has(path) || !existsSync(path)) return;
  const values = dotenv.parse(readFileSync(path));
  for (const [name, value] of Object.entries(values)) {
    if (process.env[name] === undefined || (options.override && !options.protectedEnv?.has(name))) {
      process.env[name] = value;
    }
  }
  loaded.add(path);
}
