import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";

export const SPARKLE_FEED_URLS = Object.freeze({
  rc: "https://github.com/ethics-of-ai/agent-room-server/releases/download/rc/appcast.xml",
  stable: "https://github.com/ethics-of-ai/agent-room-server/releases/latest/download/appcast.xml"
});

/** The source-controlled updater policy for this build. */
export function sparkleUpdateChannel(env = process.env) {
  const channel = env.AGENTROOM_SPARKLE_UPDATE_CHANNEL || "disabled";
  if (channel !== "disabled" && channel !== "rc" && channel !== "stable") {
    throw new Error("AGENTROOM_SPARKLE_UPDATE_CHANNEL must be disabled, rc, or stable");
  }
  return channel;
}

/** Enabled update channels are release artifacts and must be signed. */
export function assertSparklePackagingMode(channel, signingIdentity) {
  sparkleUpdateChannel({ AGENTROOM_SPARKLE_UPDATE_CHANNEL: channel });
  if (channel !== "disabled" && !signingIdentity) {
    throw new Error(`The ${channel} update channel requires AGENTROOM_CODESIGN_IDENTITY`);
  }
}

function decodeCanonicalBase64(value, label, allowedLengths) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  const decoded = Buffer.from(value, "base64");
  if (!allowedLengths.includes(decoded.length) || decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64 encoding ${allowedLengths.join(" or ")} bytes`);
  }
  return decoded;
}

function assertSparklePublicKey(publicKey, channel) {
  if (!publicKey) {
    throw new Error(`${channel} channel requires AGENTROOM_SPARKLE_PUBLIC_ED_KEY`);
  }
  try {
    decodeCanonicalBase64(publicKey, "AGENTROOM_SPARKLE_PUBLIC_ED_KEY", [32]);
  } catch {
    throw new Error("AGENTROOM_SPARKLE_PUBLIC_ED_KEY must be a base64-encoded 32-byte Ed25519 public key");
  }
}

/**
 * Derives Sparkle's public Ed25519 key from an exported private secret.
 * New exports are a 32-byte seed. Sparkle's legacy export is the 64-byte
 * private key followed by its 32-byte public key.
 */
export function sparklePublicKeyFromPrivateSecret(privateSecret) {
  const secret = decodeCanonicalBase64(
    privateSecret.trim(),
    "SPARKLE_PRIVATE_ED_KEY private key",
    [32, 96]
  );
  if (secret.length === 96) {
    return secret.subarray(64).toString("base64");
  }

  // RFC 8410 PKCS#8 wrapper for a raw Ed25519 seed. Node then derives the
  // corresponding SPKI public key using the same Ed25519 operation Sparkle uses.
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, secret]),
    format: "der",
    type: "pkcs8"
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  if (publicKey.length !== spkiPrefix.length + 32 || !publicKey.subarray(0, spkiPrefix.length).equals(spkiPrefix)) {
    throw new Error("Could not derive the Sparkle Ed25519 public key from SPARKLE_PRIVATE_ED_KEY");
  }
  return publicKey.subarray(spkiPrefix.length).toString("base64");
}

/** Fails before packaging when the release private seed and public key differ. */
export function assertSparkleKeyPair(privateSecret, publicKey) {
  assertSparklePublicKey(publicKey, "enabled");
  const derived = Buffer.from(sparklePublicKeyFromPrivateSecret(privateSecret), "base64");
  const configured = Buffer.from(publicKey, "base64");
  if (!timingSafeEqual(derived, configured)) {
    throw new Error("SPARKLE_PRIVATE_ED_KEY and SPARKLE_PUBLIC_ED_KEY do not match");
  }
}

/**
 * Sparkle build overrides derived from one closed channel value. Disabled is
 * the default and embeds neither authority nor destination. RC and stable use
 * fixed feeds and require the release public key.
 */
export function xcodebuildSparkleOverrides(env = process.env) {
  const channel = sparkleUpdateChannel(env);
  const publicKey = env.AGENTROOM_SPARKLE_PUBLIC_ED_KEY;
  if (env.AGENTROOM_SPARKLE_FEED_URL) {
    throw new Error("AGENTROOM_SPARKLE_FEED_URL is derived from AGENTROOM_SPARKLE_UPDATE_CHANNEL; do not set it directly");
  }

  if (channel === "disabled") {
    if (publicKey) {
      throw new Error("The disabled channel must not receive AGENTROOM_SPARKLE_PUBLIC_ED_KEY");
    }
    return [];
  }

  assertSparklePublicKey(publicKey, channel);
  return [
    `AGENTROOM_SPARKLE_PUBLIC_ED_KEY=${publicKey}`,
    `AGENTROOM_SPARKLE_FEED_URL=${SPARKLE_FEED_URLS[channel]}`
  ];
}

function embeddedPlistString(plistText, key) {
  const match = new RegExp(`<key>${key}</key>\\s*(?:<string>([^<]*)</string>|<string/>)`).exec(plistText);
  return match ? (match[1] ?? "").trim() : "";
}

/** Checks the built app against the selected updater policy before signing. */
export async function assertEmbeddedSparkleConfiguration(appPath, channel) {
  sparkleUpdateChannel({ AGENTROOM_SPARKLE_UPDATE_CHANNEL: channel });
  const infoPlistPath = resolve(appPath, "Contents/Info.plist");
  try {
    await access(infoPlistPath, constants.R_OK);
  } catch {
    throw new Error(`Missing ${infoPlistPath}.`);
  }
  const plistText = await readFile(infoPlistPath, "utf8");
  const publicKey = embeddedPlistString(plistText, "SUPublicEDKey");
  const feedURL = embeddedPlistString(plistText, "SUFeedURL");

  if (channel === "disabled") {
    if (publicKey || feedURL) {
      throw new Error("A disabled build must not embed a Sparkle public key or feed URL");
    }
    return { channel, feedURL, publicKey };
  }

  if (!publicKey) {
    throw new Error(`An ${channel} build must embed the Sparkle public key. Set AGENTROOM_SPARKLE_PUBLIC_ED_KEY.`);
  }
  assertSparklePublicKey(publicKey, channel);
  const expectedFeedURL = SPARKLE_FEED_URLS[channel];
  if (feedURL !== expectedFeedURL) {
    throw new Error(`An ${channel} build must embed the ${channel} Sparkle feed at ${expectedFeedURL}`);
  }
  return { channel, feedURL, publicKey };
}

/** The nested Sparkle code that its manual distribution signing order requires. */
export function sparkleBundlePaths(appPath) {
  const framework = resolve(appPath, "Contents/Frameworks/Sparkle.framework");
  const version = resolve(framework, "Versions/B");
  return {
    framework,
    installer: resolve(version, "XPCServices/Installer.xpc"),
    downloader: resolve(version, "XPCServices/Downloader.xpc"),
    autoupdate: resolve(version, "Autoupdate"),
    updater: resolve(version, "Updater.app")
  };
}
