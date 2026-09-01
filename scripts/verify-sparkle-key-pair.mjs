#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { assertSparkleKeyPair } from "./macos-sparkle.mjs";

async function main() {
  const publicKey = process.argv[2];
  if (!publicKey) {
    throw new Error("Usage: verify-sparkle-key-pair.mjs <public-key>, with the private key on stdin");
  }
  const privateSecret = (await readFile(0, "utf8")).trim();
  assertSparkleKeyPair(privateSecret, publicKey);
  console.log("Sparkle private and public keys match.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
