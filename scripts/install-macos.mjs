#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

const VOLUME_NAME_PATTERN = /^AgentRoom( \d+)?$/;
const APP_NAME_PATTERN = /^AgentRoom( \d+)?\.app$/;
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const LSREGISTER_DUMP_BUFFER_BYTES = 256 * 1024 * 1024;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

async function main() {
  assertMacOS();

  const args = parseArgs(process.argv.slice(2));
  const repoRoot = resolve(process.env.AGENTROOM_REPO_ROOT ?? defaultRepoRoot);
  const dmgPath = resolve(args.dmg ?? resolve(repoRoot, "build/distribution/macos/AgentRoom.dmg"));
  const installPath = resolve(args.target ?? "/Applications/AgentRoom.app");
  const installDir = dirname(installPath);

  if (args.cleanupOnly) {
    quitRunningAgentRoom();
    detachAgentRoomVolumes();
    cleanupLaunchServices({
      keepPath: existsSync(installPath) ? installPath : null,
      refreshDock: args.refreshDock
    });
    console.log("Done.");
    return;
  }

  if (!existsSync(dmgPath)) {
    throw new Error(`DMG not found at ${dmgPath}. Run "npx pnpm dist:macos" first.`);
  }

  quitRunningAgentRoom();
  detachAgentRoomVolumes();
  removeInstalledCopies(installDir, installPath, { removeDuplicates: args.removeDuplicates });

  const mountPoint = mkdtempSync(resolve(tmpdir(), "agentroom-install-"));
  try {
    console.log(`Mounting ${dmgPath}`);
    run("hdiutil", ["attach", dmgPath, "-mountpoint", mountPoint, "-nobrowse", "-quiet"]);

    const sourceApp = resolve(mountPoint, "AgentRoom.app");
    if (!existsSync(sourceApp)) {
      throw new Error(`AgentRoom.app not found at ${sourceApp}.`);
    }

    console.log(`Installing AgentRoom.app to ${installPath}`);
    run("ditto", [sourceApp, installPath]);
  } finally {
    run("hdiutil", ["detach", mountPoint, "-quiet", "-force"], { allowFailure: true });
    safeRmDir(mountPoint);
  }

  if (!args.keepQuarantine) {
    clearQuarantine(installPath);
  }

  if (!args.skipLaunchServicesCleanup) {
    cleanupLaunchServices({ keepPath: installPath, refreshDock: args.refreshDock });
  }

  if (!args.skipLaunch) {
    console.log(`Opening ${installPath}`);
    run("open", [installPath]);
  }

  console.log("Done.");
}

function quitRunningAgentRoom() {
  console.log("Quitting any running AgentRoom processes");
  run("osascript", ["-e", 'try', "-e", 'tell application "AgentRoom" to quit', "-e", "end try"], {
    allowFailure: true
  });
  waitForProcessesToExit("AgentRoom.app/Contents/MacOS/AgentRoom", { timeoutMs: 4000 });
  killLingeringAgentRoomProcesses();
}

function waitForProcessesToExit(pattern, { timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    if (result.status !== 0) {
      return;
    }
    spawnSync("sleep", ["0.25"]);
  }
}

export function cleanupLaunchServices({ keepPath, refreshDock }) {
  if (!existsSync(LSREGISTER)) {
    console.warn(`Skipping Launch Services cleanup: ${LSREGISTER} not found.`);
    return;
  }
  const dump = spawnSync(LSREGISTER, ["-dump"], {
    encoding: "utf8",
    maxBuffer: LSREGISTER_DUMP_BUFFER_BYTES
  });
  if (dump.status !== 0 || !dump.stdout) {
    console.warn("Skipping Launch Services cleanup: lsregister -dump failed.");
    return;
  }
  const paths = new Set();
  const re = /^\s*path:\s+(.+?\/AgentRoom\.app)\s*(?:\(0x[0-9a-f]+\))?\s*$/gm;
  let match;
  while ((match = re.exec(dump.stdout)) !== null) {
    paths.add(match[1].trim());
  }
  if (paths.size === 0) {
    return;
  }
  const normalizedKeep = keepPath ? resolve(keepPath) : null;
  const stale = [...paths].filter((path) => !normalizedKeep || resolve(path) !== normalizedKeep);
  if (stale.length === 0) {
    console.log("No stale AgentRoom.app entries registered with Launch Services.");
  } else {
    console.log(`Unregistering ${stale.length} stale Launch Services ${stale.length === 1 ? "entry" : "entries"}`);
    for (const path of stale) {
      console.log(`  unregister ${path}`);
      spawnSync(LSREGISTER, ["-u", path], { stdio: ["ignore", "ignore", "ignore"] });
    }
  }
  if (normalizedKeep && existsSync(normalizedKeep)) {
    console.log(`Re-registering ${normalizedKeep}`);
    spawnSync(LSREGISTER, ["-f", "-R", "-trusted", normalizedKeep], {
      stdio: ["ignore", "ignore", "ignore"]
    });
  }
  if (refreshDock) {
    console.log("Restarting Dock to refresh Launchpad/Spotlight icons");
    spawnSync("killall", ["Dock"], { stdio: ["ignore", "ignore", "ignore"] });
  } else if (stale.length > 0) {
    console.log("Run 'killall Dock' (or rerun with --refresh-dock) if Launchpad/Spotlight still show stale icons.");
  }
}

function clearQuarantine(appPath) {
  console.log("Clearing com.apple.quarantine for local launch");
  const display = `xattr -dr com.apple.quarantine ${quote(appPath)}`;
  console.log(`$ ${display}`);
  // Read-only nested files inside the bundle (e.g. bundled libnode) can refuse
  // attribute updates; the failure is harmless because the bundle root is what
  // Gatekeeper checks on first launch. Suppress stderr to keep the log clean.
  spawnSync("xattr", ["-dr", "com.apple.quarantine", appPath], {
    stdio: ["ignore", "inherit", "ignore"]
  });
}

function killLingeringAgentRoomProcesses() {
  const result = spawnSync("pgrep", ["-f", "AgentRoom.app/Contents/MacOS/AgentRoom"], { encoding: "utf8" });
  if (result.status !== 0) {
    return;
  }
  const pids = result.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (pids.length === 0) {
    return;
  }
  console.log(`Sending SIGTERM to lingering AgentRoom processes: ${pids.join(", ")}`);
  spawnSync("kill", pids, { stdio: "inherit" });
  waitForProcessesToExit("AgentRoom.app/Contents/MacOS/AgentRoom", { timeoutMs: 2000 });
}

function detachAgentRoomVolumes() {
  const volumesRoot = "/Volumes";
  let entries = [];
  try {
    entries = readdirSync(volumesRoot);
  } catch {
    return;
  }
  const matches = entries.filter((name) => VOLUME_NAME_PATTERN.test(name));
  if (matches.length === 0) {
    return;
  }
  for (const volumeName of matches) {
    const volumePath = `${volumesRoot}/${volumeName}`;
    console.log(`Detaching ${volumePath}`);
    run("hdiutil", ["detach", volumePath, "-quiet", "-force"], { allowFailure: true });
  }
}

function removeInstalledCopies(installDir, installPath, { removeDuplicates }) {
  if (existsSync(installPath)) {
    console.log(`Removing ${installPath}`);
    safeRm(installPath);
  }
  if (!removeDuplicates) {
    return;
  }
  let entries = [];
  try {
    entries = readdirSync(installDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!APP_NAME_PATTERN.test(entry)) continue;
    const candidate = resolve(installDir, entry);
    if (candidate === installPath) continue;
    console.log(`Removing duplicate ${candidate}`);
    safeRm(candidate);
  }
}

function safeRm(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(`Could not remove ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function safeRmDir(path) {
  try {
    if (statSync(path).isDirectory()) {
      rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    switch (arg) {
      case "--dmg":
        result.dmg = requireValue(argv, ++i, arg);
        break;
      case "--target":
        result.target = requireValue(argv, ++i, arg);
        break;
      case "--no-launch":
        result.skipLaunch = true;
        break;
      case "--keep-quarantine":
        result.keepQuarantine = true;
        break;
      case "--remove-duplicates":
        result.removeDuplicates = true;
        break;
      case "--cleanup-only":
        result.cleanupOnly = true;
        break;
      case "--skip-launch-services-cleanup":
        result.skipLaunchServicesCleanup = true;
        break;
      case "--refresh-dock":
        result.refreshDock = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }
  return result;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    console.error(`${flag} requires a value`);
    process.exit(1);
  }
  return value;
}

function printHelp() {
  const lines = [
    "Usage: node scripts/install-macos.mjs [options]",
    "",
    "Quits running AgentRoom processes, detaches mounted AgentRoom DMG volumes,",
    "removes the previously installed app bundle, installs a fresh copy from",
    "the built DMG, unregisters stale Launch Services entries (so Launchpad and",
    "Spotlight stop showing build-output duplicates), and opens the app.",
    "",
    "Options:",
    "  --dmg <path>                     Path to AgentRoom.dmg",
    "                                   (default: build/distribution/macos/AgentRoom.dmg)",
    "  --target <path>                  Install destination",
    "                                   (default: /Applications/AgentRoom.app)",
    "  --no-launch                      Do not open the app after installing",
    "  --keep-quarantine                Do not clear com.apple.quarantine on the new bundle",
    "  --remove-duplicates              Also remove sibling AgentRoom*.app bundles in the target directory",
    "  --cleanup-only                   Skip install; only unregister stale Launch Services entries",
    "  --skip-launch-services-cleanup   Install without cleaning Launch Services",
    "  --refresh-dock                   killall Dock after cleanup so Launchpad/Spotlight refresh now",
    "  -h, --help                       Show this help"
  ];
  console.log(lines.join("\n"));
}

function run(command, args, options = {}) {
  const display = [command, ...args].map(quote).join(" ");
  console.log(`$ ${display}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    if (options.allowFailure) {
      console.warn(`${command} failed: ${result.error.message}`);
      return;
    }
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function quote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("install-macos must run on macOS.");
  }
}
