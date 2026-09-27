import { describe, expect, it } from "vitest";
import { codexLoginCheck, readCodexLoginCheck } from "../src/runner/codex/login";

describe("Codex sign-in check", () => {
  it("reads a ChatGPT or API key account as signed in and never echoes identity", () => {
    const chatgpt = codexLoginCheck({
      account: { type: "chatgpt", email: "someone@example.com", planType: "pro" },
      requiresOpenaiAuth: true
    });
    expect(chatgpt).toEqual({ id: "codex_login", status: "ready", message: "Codex is signed in." });
    expect(JSON.stringify(chatgpt)).not.toContain("someone@example.com");
    expect(codexLoginCheck({ account: { type: "apiKey" }, requiresOpenaiAuth: true }).status).toBe("ready");
  });

  it("reads no account as signed out only when the provider needs OpenAI auth", () => {
    expect(codexLoginCheck({ account: null, requiresOpenaiAuth: true })).toEqual({
      id: "codex_login",
      status: "unavailable",
      message: "Codex is not signed in. Sign in to Codex, then check again."
    });
    expect(codexLoginCheck({ account: null, requiresOpenaiAuth: false }).status).toBe("ready");
  });

  it("does not guess from a reply it cannot read", () => {
    expect(codexLoginCheck(undefined).status).toBe("not_checked");
    expect(codexLoginCheck({ requiresOpenaiAuth: true }).status).toBe("not_checked");
    expect(codexLoginCheck({ account: { email: "x" }, requiresOpenaiAuth: true }).status).toBe("not_checked");
  });

  it("reads the stored sign-in without a refresh and survives a Codex that rejects the method", async () => {
    const calls: unknown[] = [];
    const signedIn = await readCodexLoginCheck({
      request: async (method, params) => {
        calls.push({ method, params });
        return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      }
    });
    expect(calls).toEqual([{ method: "account/read", params: { refreshToken: false } }]);
    expect(signedIn.status).toBe("ready");

    const older = await readCodexLoginCheck({ request: async () => { throw new Error("Method not found"); } });
    expect(older.status).toBe("not_checked");
  });
});
