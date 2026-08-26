import { describe, expect, it } from "vitest";
import { CURSOR_LOGIN_API_KEY_NAME, runCursorLogin, type CursorLoginIO } from "../src/runner/cursor/login";
import type { CursorSdkAuth, CursorSdkAuthStatus, CursorSdkLoginOptions } from "../src/runner/cursor/sdk";

const FIXTURE_KEY = "fixture-cursor-key-do-not-print";
const LOGIN_URL = "https://cursor.com/loginDeepControl?challenge=fixture";

function capture(): { io: CursorLoginIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

function fakeAuth(options: {
  statuses: CursorSdkAuthStatus[];
  login?: (options?: CursorSdkLoginOptions) => Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }>;
}): { auth: CursorSdkAuth; loginCalls: CursorSdkLoginOptions[] } {
  const loginCalls: CursorSdkLoginOptions[] = [];
  const statuses = [...options.statuses];
  const auth: CursorSdkAuth = {
    status: async () => statuses.length > 1 ? statuses.shift()! : statuses[0],
    login: async (loginOptions) => {
      loginCalls.push(loginOptions ?? {});
      loginOptions?.onLoginUrl?.(LOGIN_URL);
      if (options.login) return options.login(loginOptions);
      return { apiKey: FIXTURE_KEY, email: "operator@example.com", apiKeyExpiresAtMs: Date.UTC(2026, 10, 24) };
    }
  };
  return { auth, loginCalls };
}

describe("cursor:login", () => {
  it("prints the login URL, reports the stored sign-in afterwards, and never prints the key", async () => {
    const { auth, loginCalls } = fakeAuth({
      statuses: [
        { status: "logged-out" },
        { status: "logged-in", email: "operator@example.com", apiKeyExpiresAtMs: Date.UTC(2026, 10, 24) }
      ]
    });
    const { io, out, err } = capture();

    const code = await runCursorLogin(auth, io);

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toContain(LOGIN_URL);
    expect(out.join("\n")).toContain("Cursor is signed in as operator@example.com (key expires 2026-11-24)");
    expect([...out, ...err].some((line) => line.includes(FIXTURE_KEY))).toBe(false);
    // The dashboard names the key after the product that minted it, and the
    // browser decision stays the SDK's own (SSH and NO_OPEN_BROWSER aware).
    expect(loginCalls).toHaveLength(1);
    expect(loginCalls[0].apiKeyName).toBe(CURSOR_LOGIN_API_KEY_NAME);
    expect(loginCalls[0].openBrowser).toBeUndefined();
  });

  it("says so when a sign-in already exists and still mints a fresh one", async () => {
    const { auth, loginCalls } = fakeAuth({
      statuses: [{ status: "logged-in", email: "operator@example.com", apiKeyExpiresAtMs: Date.UTC(2026, 8, 1) }]
    });
    const { io, out } = capture();

    const code = await runCursorLogin(auth, io);

    expect(code).toBe(0);
    expect(out[0]).toContain("already signed in as operator@example.com (key expires 2026-09-01)");
    expect(loginCalls).toHaveLength(1);
  });

  it("fails with the SDK's message when the sign-in is refused", async () => {
    const { auth } = fakeAuth({
      statuses: [{ status: "logged-out" }],
      login: async () => {
        throw new Error("[plan_required] Cloud Agent is not available for free users");
      }
    });
    const { io, out, err } = capture();

    const code = await runCursorLogin(auth, io);

    expect(code).toBe(1);
    expect(err).toEqual(["Cursor sign-in failed: [plan_required] Cloud Agent is not available for free users"]);
    expect(out).toContain(LOGIN_URL);
  });

  it("fails when the sign-in resolved but nothing was stored", async () => {
    const { auth } = fakeAuth({ statuses: [{ status: "logged-out" }] });
    const { io, err } = capture();

    const code = await runCursorLogin(auth, io);

    expect(code).toBe(1);
    expect(err[0]).toContain("left no stored login behind");
  });
});
