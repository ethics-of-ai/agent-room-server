import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { formatAuthTokenInitMessages, initializeAuthToken } from "../src/config/authTokenBootstrap";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const result = await initializeAuthToken({
    envPath: resolve(repoRoot, ".env"),
    exampleEnvPath: resolve(repoRoot, ".env.example"),
    copyToClipboard: copyWithPbcopy
  });

  for (const message of formatAuthTokenInitMessages(result)) {
    console.log(message);
  }
}

async function copyWithPbcopy(token: string): Promise<boolean> {
  return new Promise((resolveCopy) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolveCopy(false));
    child.on("close", (code) => resolveCopy(code === 0));
    child.stdin.end(token);
  });
}
