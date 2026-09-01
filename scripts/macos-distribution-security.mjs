import { constants } from "node:fs";
import { access, open, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sparkleBundlePaths } from "./macos-sparkle.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const nodeRuntimeEntitlementsPath = resolve(dirname(scriptPath), "codesign/node-runtime.entitlements");

const MACH_O_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

/** True when the first four bytes are a thin or fat Mach-O magic number. */
export function isMachOHeader(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return MACH_O_MAGICS.has(bytes.readUInt32BE(0));
}

/** Regular Mach-O files under `root`; symlinks are deliberately skipped. */
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

function notaryCredentialArgs(env = process.env) {
  if (env.AGENTROOM_NOTARY_PROFILE) {
    return { args: ["--keychain-profile", env.AGENTROOM_NOTARY_PROFILE], redacted: new Set() };
  }

  const appleId = env.AGENTROOM_NOTARY_APPLE_ID;
  const teamId = env.AGENTROOM_NOTARY_TEAM_ID;
  const password = env.AGENTROOM_NOTARY_PASSWORD;
  if (!appleId || !teamId || !password) return null;
  return {
    args: ["--apple-id", appleId, "--team-id", teamId, "--password", password],
    redacted: new Set([password])
  };
}

function commandWithDisplay(args, redactedValues = new Set()) {
  return {
    args,
    display: args.map((arg) => redactedValues.has(arg) ? "<redacted>" : shellQuote(arg)).join(" ")
  };
}

export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function notarySubmitCommand(artifactPath, env = process.env) {
  const credentials = notaryCredentialArgs(env);
  if (!credentials) return null;
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

export function notaryLogCommand(submissionId, env = process.env) {
  const credentials = notaryCredentialArgs(env);
  if (!credentials) return null;
  return commandWithDisplay(["notarytool", "log", submissionId, ...credentials.args], credentials.redacted);
}

/** Publisher-signed binaries that the AgentRoom signing pass leaves untouched. */
export function isPublisherSignedBinary(path) {
  return (
    /\/@anthropic-ai\/claude-agent-sdk-darwin-[^/]+\//.test(path) ||
    /\/@cursor\/sdk-darwin-[^/]+\//.test(path)
  );
}

async function assertPath(path, message) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(message);
  }
}

/** Signs Sparkle, bundled native executables, Node, and the app inside-out. */
export async function signAppBundle({ appPath, identity, run }) {
  const nodeExecutable = resolve(appPath, "Contents/Resources/node/bin/node");
  const sparkle = sparkleBundlePaths(appPath);
  await assertPath(nodeRuntimeEntitlementsPath, `Missing node entitlements at ${nodeRuntimeEntitlementsPath}.`);
  for (const [name, path] of Object.entries(sparkle)) {
    await assertPath(path, `Missing Sparkle ${name} at ${path}. Check the pinned Sparkle version's framework layout.`);
  }

  run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, sparkle.installer]);
  run("codesign", [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--preserve-metadata=entitlements",
    "--sign",
    identity,
    sparkle.downloader
  ]);
  run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, sparkle.autoupdate]);
  run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, sparkle.updater]);
  run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, sparkle.framework]);

  const resourcesRoot = resolve(appPath, "Contents/Resources");
  const found = (await findMachOFiles(resourcesRoot)).filter((path) => path !== nodeExecutable);
  const binaries = found.filter((path) => !isPublisherSignedBinary(path));
  console.log(
    `Signing ${binaries.length} bundled binaries under Contents/Resources (${found.length - binaries.length} left with their publisher's signature)`
  );
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
    nodeExecutable
  ]);
  run("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, appPath]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}
