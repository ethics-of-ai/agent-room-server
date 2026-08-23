import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { formatAuthTokenInitMessages, initializeAuthToken } from "../src/config/authTokenBootstrap";

async function tempDir(): Promise<string> {
  const dir = join(tmpdir(), `agentroom-auth-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("initializeAuthToken", () => {
  test("creates .env from the template and fills an empty auth token", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    const exampleEnvPath = join(dir, ".env.example");
    await writeFile(exampleEnvPath, "PORT=8787\nAUTH_TOKEN=\n", "utf8");

    const result = await initializeAuthToken({
      envPath,
      exampleEnvPath,
      generateToken: () => "generated-token",
      copyToClipboard: async () => true
    });

    expect(result).toEqual({
      token: "generated-token",
      generated: true,
      copiedToClipboard: true,
      envPath
    });
    await expect(readFile(envPath, "utf8")).resolves.toBe("PORT=8787\nAUTH_TOKEN=generated-token\n");
  });

  test("preserves an existing auth token", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    await writeFile(envPath, "AUTH_TOKEN=existing-token\nPORT=8787\n", "utf8");

    const result = await initializeAuthToken({
      envPath,
      generateToken: () => "new-token",
      copyToClipboard: async () => true
    });

    expect(result.token).toBe("existing-token");
    expect(result.generated).toBe(false);
    await expect(readFile(envPath, "utf8")).resolves.toBe("AUTH_TOKEN=existing-token\nPORT=8787\n");
  });

  test("preserves dotenv-quoted auth tokens without copying quote characters", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    await writeFile(envPath, "AUTH_TOKEN=\"existing-token\"\n", "utf8");

    const result = await initializeAuthToken({
      envPath,
      generateToken: () => "new-token",
      copyToClipboard: async () => true
    });

    expect(result.token).toBe("existing-token");
    expect(result.generated).toBe(false);
    await expect(readFile(envPath, "utf8")).resolves.toBe("AUTH_TOKEN=\"existing-token\"\n");
  });

  test("generates a token for dotenv-quoted empty auth tokens", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    await writeFile(envPath, "AUTH_TOKEN=\"\"\n", "utf8");

    await initializeAuthToken({
      envPath,
      generateToken: () => "generated-token",
      copyToClipboard: async () => false
    });

    await expect(readFile(envPath, "utf8")).resolves.toBe("AUTH_TOKEN=generated-token\n");
  });

  test("appends auth token when .env exists without one", async () => {
    const dir = await tempDir();
    const envPath = join(dir, ".env");
    await writeFile(envPath, "PORT=8787", "utf8");

    await initializeAuthToken({
      envPath,
      generateToken: () => "generated-token",
      copyToClipboard: async () => false
    });

    await expect(readFile(envPath, "utf8")).resolves.toBe("PORT=8787\nAUTH_TOKEN=generated-token\n");
  });

  test("does not include the token in CLI output when clipboard copy succeeds", () => {
    expect(formatAuthTokenInitMessages({
      envPath: "/repo/.env",
      generated: true,
      copiedToClipboard: true,
      token: "secret-token"
    })).toEqual([
      "Generated AUTH_TOKEN in /repo/.env",
      "Copied AUTH_TOKEN value to the macOS clipboard for Universal Clipboard paste.",
      "Restart the backend after changing .env, then paste the token into the visionOS app settings."
    ]);
  });

  test("includes the token in CLI output when clipboard copy fails", () => {
    expect(formatAuthTokenInitMessages({
      envPath: "/repo/.env",
      generated: false,
      copiedToClipboard: false,
      token: "secret-token"
    })).toEqual([
      "Using existing AUTH_TOKEN in /repo/.env",
      "Could not copy to clipboard automatically; copy the AUTH_TOKEN value below.",
      "AUTH_TOKEN=secret-token",
      "Restart the backend after changing .env, then paste the token into the visionOS app settings."
    ]);
  });
});
