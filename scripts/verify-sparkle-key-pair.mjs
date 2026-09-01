#!/usr/bin/env node
import { assertSparkleKeyPair } from "./macos-sparkle.mjs";

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const publicKey = process.argv[2];
  if (!publicKey) {
    throw new Error("Usage: verify-sparkle-key-pair.mjs <public-key>, with the private key on stdin");
  }
  const privateSecret = (await readStdin()).trim();
  assertSparkleKeyPair(privateSecret, publicKey);
  console.log("Sparkle private and public keys match.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
