import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/domain/models";
import { fillThreadTitle, THREAD_TITLE_MAX_CHARACTERS, threadTitleFromMessage } from "../src/domain/threadTitles";

describe("threadTitleFromMessage", () => {
  it("takes the first line", () => {
    expect(threadTitleFromMessage("Fix the login redirect\nIt loops after sign-in.")).toBe("Fix the login redirect");
    expect(threadTitleFromMessage("Windows line\r\nsecond")).toBe("Windows line");
  });

  it("skips blank lines and lines that are only a code fence", () => {
    expect(threadTitleFromMessage("\n   \n```\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(threadTitleFromMessage("```ts\n\nexport {}\n")).toBe("export {}");
    expect(threadTitleFromMessage("~~~\n~~~~ \nRun the suite")).toBe("Run the suite");
  });

  it("strips heading and quote markers", () => {
    expect(threadTitleFromMessage("# Release notes")).toBe("Release notes");
    expect(threadTitleFromMessage("> quoted ask")).toBe("quoted ask");
    expect(threadTitleFromMessage(">> ## nested")).toBe("nested");
    expect(threadTitleFromMessage("#\nnext line")).toBe("next line");
    expect(threadTitleFromMessage("#123 is broken")).toBe("#123 is broken");
  });

  it("collapses inner whitespace", () => {
    expect(threadTitleFromMessage("  tidy \t  these    words  ")).toBe("tidy these words");
  });

  it("cuts a long sentence at a space within the cap", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const title = threadTitleFromMessage(words);
    expect(title).toBeDefined();
    expect(Array.from(title!).length).toBeLessThanOrEqual(THREAD_TITLE_MAX_CHARACTERS);
    expect(words.startsWith(`${title} `)).toBe(true);
  });

  it("keeps a word that ends exactly at the cap", () => {
    const line = `${"a".repeat(THREAD_TITLE_MAX_CHARACTERS)} tail`;
    expect(threadTitleFromMessage(line)).toBe("a".repeat(THREAD_TITLE_MAX_CHARACTERS));
  });

  it("hard-cuts a word longer than the cap", () => {
    expect(threadTitleFromMessage("x".repeat(200))).toBe("x".repeat(THREAD_TITLE_MAX_CHARACTERS));
  });

  it("does not split an emoji at the cap", () => {
    const title = threadTitleFromMessage(`${"b".repeat(THREAD_TITLE_MAX_CHARACTERS - 1)}😀😀`);
    expect(title).toBe(`${"b".repeat(THREAD_TITLE_MAX_CHARACTERS - 1)}😀`);
  });

  it("returns undefined when no line has text", () => {
    expect(threadTitleFromMessage("```\n\n```\n  \n~~~")).toBeUndefined();
    expect(threadTitleFromMessage("")).toBeUndefined();
  });
});

describe("fillThreadTitle", () => {
  const untitled = () => ({ id: "agent-session-1" }) as AgentSession;

  it("titles an untitled session from a person's message", () => {
    const session = untitled();
    fillThreadTitle(session, "Ship it\nnow");
    expect(session.title).toBe("Ship it");
  });

  it("leaves the title alone for a titled session or a message with no text", () => {
    const titled = { ...untitled(), title: "Kept" } as AgentSession;
    fillThreadTitle(titled, "Other");
    expect(titled.title).toBe("Kept");

    const fencesOnly = untitled();
    fillThreadTitle(fencesOnly, "```\n```");
    expect(fencesOnly.title).toBeUndefined();
  });
});
