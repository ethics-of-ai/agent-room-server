#!/usr/bin/env node
import { constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, open, readdir, readlink, rm, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { cleanupLaunchServices } from "./install-macos.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");

export function bundledResourcePaths(appPath) {
  const resources = resolve(appPath, "Contents/Resources");
  return {
    nodeExecutable: resolve(resources, "node/bin/node"),
    backendEntrypoint: resolve(resources, "backend/dist/index.js"),
    backendPublic: resolve(resources, "backend/public"),
    backendCatalogAssets: resolve(resources, "backend/catalog-assets")
  };
}

export const nodeRuntimeEntitlementsPath = resolve(dirname(scriptPath), "codesign/node-runtime.entitlements");

/**
 * `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` overrides for xcodebuild,
 * read from `AGENTROOM_MARKETING_VERSION` and `AGENTROOM_BUILD_NUMBER`. The
 * release workflow sets both from the tag and the run number; a local build
 * leaves them unset and takes the values in project.yml.
 */
export function xcodebuildVersionOverrides(env = process.env) {
  const overrides = [];
  const marketing = env.AGENTROOM_MARKETING_VERSION;
  if (marketing) {
    if (!/^\d+\.\d+\.\d+$/.test(marketing)) {
      throw new Error(`AGENTROOM_MARKETING_VERSION must look like X.Y.Z, got ${marketing}`);
    }
    overrides.push(`MARKETING_VERSION=${marketing}`);
  }
  const build = env.AGENTROOM_BUILD_NUMBER;
  if (build) {
    if (!/^\d+$/.test(build)) {
      throw new Error(`AGENTROOM_BUILD_NUMBER must be an integer, got ${build}`);
    }
    overrides.push(`CURRENT_PROJECT_VERSION=${build}`);
  }
  return overrides;
}

const MACH_O_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

/** True when the first four bytes are a thin or fat Mach-O magic number. */
export function isMachOHeader(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return MACH_O_MAGICS.has(bytes.readUInt32BE(0));
}

/**
 * Regular files under `root` that start with a Mach-O magic. Symlinks are
 * skipped: the pnpm layout reaches every real file through the virtual store,
 * so each binary is visited and signed once.
 */
export async function findMachOFiles(root) {
  const found = [];
  const header = Buffer.alloc(4);
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const handle = await open(path, "r");
      try {
        const { bytesRead } = await handle.read(header, 0, 4, 0);
        if (bytesRead === 4 && isMachOHeader(header)) found.push(path);
      } finally {
        await handle.close();
      }
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * The credential flags for one `notarytool` invocation, or null when neither a
 * keychain profile nor an Apple ID triple is configured. Split out of the
 * command builders below so `submit` and `log` can never authenticate
 * differently.
 */
function notaryCredentialArgs(env = process.env) {
  if (env.AGENTROOM_NOTARY_PROFILE) {
    return { args: ["--keychain-profile", env.AGENTROOM_NOTARY_PROFILE], redacted: new Set() };
  }

  const appleId = env.AGENTROOM_NOTARY_APPLE_ID;
  const teamId = env.AGENTROOM_NOTARY_TEAM_ID;
  const password = env.AGENTROOM_NOTARY_PASSWORD;
  if (!appleId || !teamId || !password) {
    return null;
  }

  return {
    args: ["--apple-id", appleId, "--team-id", teamId, "--password", password],
    redacted: new Set([password])
  };
}

export function notarySubmitCommand(artifactPath, env = process.env) {
  const credentials = notaryCredentialArgs(env);
  if (!credentials) return null;

  // `--output-format json` so the caller can read the verdict. `submit --wait`
  // exits 0 for a submission that completed with `status: Invalid`, so the exit
  // code alone would let a rejected build go on to be stapled.
  return commandWithDisplay([
    "notarytool",
    "submit",
    artifactPath,
    ...credentials.args,
    "--wait",
    "--output-format",
    "json"
  ], credentials.redacted);
}

/** Apple's per-issue rejection report for a finished submission. */
export function notaryLogCommand(submissionId, env = process.env) {
  const credentials = notaryCredentialArgs(env);
  if (!credentials) return null;

  return commandWithDisplay([
    "notarytool",
    "log",
    submissionId,
    ...credentials.args
  ], credentials.redacted);
}

export function relocatedPnpmSymlinkTarget({ linkPath, originalTarget, sourceVirtualStore, bundledVirtualStore }) {
  const sourceStore = resolve(sourceVirtualStore);
  const originalTargetPath = isAbsolute(originalTarget)
    ? resolve(originalTarget)
    : resolve(dirname(linkPath), originalTarget);

  if (originalTargetPath !== sourceStore && !originalTargetPath.startsWith(`${sourceStore}${sep}`)) {
    return null;
  }

  const packageStorePath = relative(sourceStore, originalTargetPath);
  return relative(dirname(linkPath), resolve(bundledVirtualStore, packageStorePath)) || ".";
}

export function relocatedWorkspaceSymlinkTarget({ linkPath, originalTarget, sourceWorkspace, bundledWorkspace }) {
  const sourceRoot = resolve(sourceWorkspace);
  const originalTargetPath = isAbsolute(originalTarget)
    ? resolve(originalTarget)
    : resolve(dirname(linkPath), originalTarget);

  if (originalTargetPath !== sourceRoot && !originalTargetPath.startsWith(`${sourceRoot}${sep}`)) {
    return null;
  }

  const workspacePath = relative(sourceRoot, originalTargetPath);
  return relative(dirname(linkPath), resolve(bundledWorkspace, workspacePath)) || ".";
}

function commandWithDisplay(args, redactedValues = new Set()) {
  return {
    args,
    display: args.map((arg) => redactedValues.has(arg) ? "<redacted>" : shellQuote(arg)).join(" ")
  };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main() {
  const repoRoot = resolve(process.env.AGENTROOM_REPO_ROOT ?? defaultRepoRoot);
  const outputRoot = resolve(repoRoot, process.env.AGENTROOM_MACOS_DIST_DIR ?? "build/distribution/macos");
  const derivedDataPath = resolve(outputRoot, "DerivedData");
  const appPath = resolve(outputRoot, "AgentRoom.app");
  const dmgStagingPath = resolve(outputRoot, "dmg-staging");
  const dmgPath = resolve(outputRoot, "AgentRoom.dmg");
  const signingIdentity = process.env.AGENTROOM_CODESIGN_IDENTITY;

  assertMacOS();
  await requireExecutable("npx");
  await requireExecutable("xcodegen");
  await requireExecutable("xcodebuild");
  await requireExecutable("hdiutil");

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  run("npx", ["pnpm", "--filter", "@agentroom/backend", "build"], { cwd: repoRoot });
  await packageBackendResources(repoRoot, resolve(outputRoot, "backend-resources"), process.env);

  run("xcodegen", ["generate"], { cwd: resolve(repoRoot, "apps/macos") });
  run("xcodebuild", [
    "-project",
    "AgentRoomMac.xcodeproj",
    "-scheme",
    "AgentRoomMac",
    "-configuration",
    "Release",
    "-derivedDataPath",
    derivedDataPath,
    "CODE_SIGNING_ALLOWED=NO",
    ...xcodebuildVersionOverrides(process.env),
    "build"
  ], { cwd: resolve(repoRoot, "apps/macos") });

  const builtAppPath = resolve(derivedDataPath, "Build/Products/Release/AgentRoom.app");
  await cp(builtAppPath, appPath, { recursive: true });
  await cp(resolve(outputRoot, "backend-resources/backend"), resolve(appPath, "Contents/Resources/backend"), {
    recursive: true,
    verbatimSymlinks: true
  });
  await cp(resolve(outputRoot, "backend-resources/node"), resolve(appPath, "Contents/Resources/node"), {
    recursive: true
  });
  await cp(resolve(outputRoot, "backend-resources/node_modules"), resolve(appPath, "Contents/Resources/node_modules"), {
    recursive: true,
    verbatimSymlinks: true
  });

  if (signingIdentity) {
    await requireExecutable("codesign");
    await signAppBundle(appPath, signingIdentity);
  } else {
    console.log("Skipping code signing because AGENTROOM_CODESIGN_IDENTITY is not set.");
  }

  await createDmgStaging(dmgStagingPath, appPath);
  run("hdiutil", [
    "create",
    "-volname",
    "AgentRoom",
    "-srcfolder",
    dmgStagingPath,
    "-ov",
    "-format",
    "UDZO",
    dmgPath
  ], { cwd: repoRoot });

  if (signingIdentity) {
    run("codesign", ["--force", "--timestamp", "--sign", signingIdentity, dmgPath], { cwd: repoRoot });
  }

  const notaryCommand = notarySubmitCommand(dmgPath, process.env);
  if (notaryCommand) {
    await requireExecutable("xcrun");
    const submission = runCapture("xcrun", notaryCommand.args, { cwd: repoRoot }, notaryCommand.display);
    const verdict = parseNotarySubmission(submission);

    if (verdict.status !== "Accepted") {
      // Stapling a rejected submission fails with "Record not found", which
      // reads as a stapler problem and hides Apple's actual reason. Print the
      // per-issue log instead and stop here.
      const logCommand = notaryLogCommand(verdict.id, process.env);
      if (verdict.id && logCommand) {
        console.log(`Notarization returned ${verdict.status}. Apple's report:`);
        spawnSync("xcrun", logCommand.args, { cwd: repoRoot, stdio: "inherit" });
      }
      throw new Error(
        `Notarization was not accepted (status: ${verdict.status}${verdict.id ? `, submission ${verdict.id}` : ""}).`
      );
    }

    run("xcrun", ["stapler", "staple", dmgPath], { cwd: repoRoot });
  } else {
    console.log("Skipping notarization because no AgentRoom notary profile or Apple ID credentials are configured.");
  }

  // Delete intermediates so Launch Services cannot re-index them and pollute
  // Launchpad/Spotlight with build-output duplicates. The .app and .dmg remain
  // as the documented artifacts.
  console.log("Removing dist intermediates (dmg-staging, DerivedData, backend-resources)");
  await rm(dmgStagingPath, { recursive: true, force: true });
  await rm(derivedDataPath, { recursive: true, force: true });
  await rm(resolve(outputRoot, "backend-resources"), { recursive: true, force: true });

  // Unregister any AgentRoom.app paths Launch Services still knows about that
  // are not the canonical /Applications copy. Keeps re-builds from accumulating
  // ghost icons.
  if (process.env.CI) {
    console.log("Skipping Launch Services cleanup under CI.");
  } else {
    cleanupLaunchServices({
      keepPath: "/Applications/AgentRoom.app",
      refreshDock: false
    });
  }

  console.log(`Packaged ${appPath}`);
  console.log(`Created ${dmgPath}`);
}

async function packageBackendResources(repoRoot, destinationRoot, env) {
  const backendRoot = resolve(repoRoot, "apps/backend");
  const backendDestination = resolve(destinationRoot, "backend");
  const nodeDestination = resolve(destinationRoot, "node");

  await mkdir(destinationRoot, { recursive: true });
  await cp(resolve(backendRoot, "dist"), resolve(backendDestination, "dist"), {
    recursive: true,
    dereference: true
  });
  await cp(resolve(backendRoot, "public"), resolve(backendDestination, "public"), {
    recursive: true,
    dereference: true
  });
  // Phase C editor language catalog assets, served at runtime from
  // `resolve(__dirname, "..", "catalog-assets")` (i.e. backend/catalog-assets) just like
  // backend/public. dereference so a synced symlink becomes real bytes in the bundle.
  await cp(resolve(backendRoot, "catalog-assets"), resolve(backendDestination, "catalog-assets"), {
    recursive: true,
    dereference: true
  });
  await cp(resolve(backendRoot, "package.json"), resolve(backendDestination, "package.json"));
  await copyBackendDependencies({
    backendSource: backendRoot,
    backendDestination,
    backendNodeModules: resolve(backendRoot, "node_modules"),
    virtualStore: resolve(repoRoot, "node_modules/.pnpm"),
    backendDestinationNodeModules: resolve(backendDestination, "node_modules"),
    resourceNodeModules: resolve(destinationRoot, "node_modules")
  });
  await copyNodeRuntime(nodeDestination, env);
}

async function copyBackendDependencies(paths) {
  await assertPath(paths.backendNodeModules, "Backend node_modules is missing. Run npx pnpm install before packaging.");
  await assertPath(paths.virtualStore, "Root pnpm virtual store is missing. Run npx pnpm install before packaging.");
  await cp(paths.backendNodeModules, paths.backendDestinationNodeModules, {
    recursive: true,
    dereference: false
  });
  await mkdir(paths.resourceNodeModules, { recursive: true });
  await cp(paths.virtualStore, resolve(paths.resourceNodeModules, ".pnpm"), {
    recursive: true,
    dereference: false
  });
  await rewriteBundledDependencySymlinks({
    root: paths.backendDestinationNodeModules,
    sourceVirtualStore: paths.virtualStore,
    bundledVirtualStore: resolve(paths.resourceNodeModules, ".pnpm")
  });
  await rewriteBundledDependencySymlinks({
    root: resolve(paths.resourceNodeModules, ".pnpm"),
    sourceVirtualStore: paths.virtualStore,
    bundledVirtualStore: resolve(paths.resourceNodeModules, ".pnpm"),
    workspaceSymlinks: [{
      source: paths.backendSource,
      destination: paths.backendDestination
    }]
  });
}

async function rewriteBundledDependencySymlinks({ root, sourceVirtualStore, bundledVirtualStore, workspaceSymlinks = [] }) {
  const entries = await readdir(root);
  for (const entry of entries) {
    const entryPath = resolve(root, entry);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      const target = await readlink(entryPath);
      const relocated = relocatedPnpmSymlinkTarget({
        linkPath: entryPath,
        originalTarget: target,
        sourceVirtualStore,
        bundledVirtualStore
      });
      const workspaceRelocated = relocated ?? workspaceSymlinks
        .map(({ source, destination }) => relocatedWorkspaceSymlinkTarget({
          linkPath: entryPath,
          originalTarget: target,
          sourceWorkspace: source,
          bundledWorkspace: destination
        }))
        .find((candidate) => candidate !== null);

      if (workspaceRelocated) {
        await unlink(entryPath);
        await symlink(workspaceRelocated, entryPath);
      }
      continue;
    }
    if (stats.isDirectory()) {
      await rewriteBundledDependencySymlinks({ root: entryPath, sourceVirtualStore, bundledVirtualStore, workspaceSymlinks });
    }
  }
}

async function copyNodeRuntime(destination, env) {
  const runtimeDir = env.AGENTROOM_NODE_RUNTIME_DIR;
  if (runtimeDir) {
    await cp(resolve(runtimeDir), destination, { recursive: true, dereference: true });
    await assertPath(resolve(destination, "bin/node"), "AGENTROOM_NODE_RUNTIME_DIR must contain bin/node.");
    await chmod(resolve(destination, "bin/node"), 0o755);
    return;
  }

  const inferredRuntimeRoot = dirname(dirname(process.execPath));
  await cp(inferredRuntimeRoot, destination, { recursive: true, dereference: true });
  await assertPath(resolve(destination, "bin/node"), `Could not infer a Node runtime root from ${process.execPath}.`);
  await chmod(resolve(destination, "bin/node"), 0o755);
  console.log(
    `Copied the current Node runtime from ${inferredRuntimeRoot}. For portable release builds, set AGENTROOM_NODE_RUNTIME_DIR to a full Node.js macOS runtime.`
  );
}

async function createDmgStaging(stagingPath, appPath) {
  await rm(stagingPath, { recursive: true, force: true });
  await mkdir(stagingPath, { recursive: true });
  await cp(appPath, resolve(stagingPath, "AgentRoom.app"), { recursive: true });
  try {
    await symlink("/Applications", resolve(stagingPath, "Applications"));
  } catch {
    // The staging directory is freshly created; ignore only unusual filesystem symlink failures.
  }
}

/**
 * Binaries the signing pass leaves exactly as their publisher shipped them.
 * Anthropic's terms for preinstalling Claude Code require the binary to run as
 * published, so the Claude Agent SDK's platform package (which carries it) is
 * never re-signed; it ships with Anthropic's own signature.
 */
export function isPublisherSignedBinary(path) {
  return /\/@anthropic-ai\/claude-agent-sdk-darwin-[^/]+\//.test(path);
}

/**
 * Signs inside-out with the hardened runtime, which is what notarization
 * checks: every Mach-O under Contents/Resources first (the node-pty addon and
 * its spawn-helper, any dylib the runtime carries), then the node binary with
 * its JIT entitlements, then the app bundle. `--deep` is deliberately not
 * used: it does not reach binaries under Resources, and re-signing node
 * through it would drop the entitlements V8 needs under the hardened runtime.
 */
async function signAppBundle(appPath, identity) {
  const paths = bundledResourcePaths(appPath);
  await assertPath(nodeRuntimeEntitlementsPath, `Missing node entitlements at ${nodeRuntimeEntitlementsPath}.`);
  const resourcesRoot = resolve(appPath, "Contents/Resources");
  const found = (await findMachOFiles(resourcesRoot)).filter((path) => path !== paths.nodeExecutable);
  const binaries = found.filter((path) => !isPublisherSignedBinary(path));
  const skipped = found.length - binaries.length;
  console.log(`Signing ${binaries.length} bundled binaries under Contents/Resources (${skipped} left with their publisher's signature)`);
  for (const binary of binaries) {
    run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, binary]);
  }
  run("codesign", [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    nodeRuntimeEntitlementsPath,
    "--sign",
    identity,
    paths.nodeExecutable
  ]);
  run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, appPath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function run(command, args, options = {}, displayOverride) {
  const display = displayOverride ?? [command, ...args].map(shellQuote).join(" ");
  console.log(`$ ${display}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

/**
 * Like `run`, but returns stdout as well as echoing it, for a command whose
 * output the caller has to read. stderr still streams to the console.
 */
function runCapture(command, args, options = {}, displayOverride) {
  const display = displayOverride ?? [command, ...args].map(shellQuote).join(" ");
  console.log(`$ ${display}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"]
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? "";
  if (stdout) {
    process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return stdout;
}

/**
 * The `{ id, status }` of a `notarytool submit --output-format json` reply.
 * Unparseable output is reported as an unknown status rather than assumed good,
 * so a notarytool that changes its output shape fails the release instead of
 * stapling a build nobody checked.
 */
export function parseNotarySubmission(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return { id: parsed?.id ?? null, status: parsed?.status ?? "unknown" };
  } catch {
    return { id: null, status: "unreadable" };
  }
}

async function requireExecutable(name) {
  const result = spawnSync("/usr/bin/env", ["which", name], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Missing required executable: ${name}`);
  }
}

async function assertPath(path, message) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(message);
  }
}

function assertMacOS() {
  if (process.platform !== "darwin") {
    throw new Error("macOS distribution packaging must run on macOS.");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
