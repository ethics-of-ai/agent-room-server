import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";

export interface InitializeAuthTokenInput {
  envPath: string;
  exampleEnvPath?: string;
  generateToken?: () => string;
  copyToClipboard?: (token: string) => Promise<boolean>;
}

export interface InitializeAuthTokenResult {
  token: string;
  generated: boolean;
  copiedToClipboard: boolean;
  envPath: string;
}

export type AuthTokenInitMessagesInput = InitializeAuthTokenResult;

export async function initializeAuthToken(input: InitializeAuthTokenInput): Promise<InitializeAuthTokenResult> {
  const env = await readEnvFile(input.envPath, input.exampleEnvPath);
  const existingToken = findAuthToken(env);
  const token = existingToken ?? (input.generateToken ?? generateAuthToken)();
  const generated = !existingToken;
  const nextEnv = generated ? setAuthToken(env, token) : env;

  if (generated) {
    await writeFile(input.envPath, nextEnv, "utf8");
  }

  const copiedToClipboard = input.copyToClipboard ? await input.copyToClipboard(token) : false;
  return { token, generated, copiedToClipboard, envPath: input.envPath };
}

export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

export function formatAuthTokenInitMessages(result: AuthTokenInitMessagesInput): string[] {
  const status = result.generated ? "Generated AUTH_TOKEN" : "Using existing AUTH_TOKEN";
  const messages = [`${status} in ${result.envPath}`];
  if (result.copiedToClipboard) {
    messages.push("Copied AUTH_TOKEN value to the macOS clipboard for Universal Clipboard paste.");
  } else {
    messages.push("Could not copy to clipboard automatically; copy the AUTH_TOKEN value below.");
    messages.push(`AUTH_TOKEN=${result.token}`);
  }
  messages.push("Restart the backend after changing .env, then paste the token into the visionOS app settings.");
  return messages;
}

function findAuthToken(env: string): string | undefined {
  const value = dotenv.parse(env).AUTH_TOKEN?.trim();
  return value && value.length > 0 ? value : undefined;
}

function setAuthToken(env: string, token: string): string {
  const lines = env.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trimStart().startsWith("AUTH_TOKEN="));
  if (index >= 0) {
    lines[index] = `AUTH_TOKEN=${token}`;
    return ensureTrailingNewline(lines.join("\n"));
  }
  return `${ensureTrailingNewline(env)}AUTH_TOKEN=${token}\n`;
}

async function readEnvFile(envPath: string, exampleEnvPath?: string): Promise<string> {
  if (existsSync(envPath)) {
    return readFile(envPath, "utf8");
  }
  if (exampleEnvPath && existsSync(exampleEnvPath)) {
    return readFile(exampleEnvPath, "utf8");
  }
  return "";
}

function ensureTrailingNewline(value: string): string {
  return value.length === 0 || value.endsWith("\n") ? value : `${value}\n`;
}
