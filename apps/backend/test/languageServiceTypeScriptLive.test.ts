import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { typeScriptLanguageServerDescriptor } from "../src/editor/languageServices/registry";
import {
  completionLabels,
  definitions,
  documentSymbolNames,
  hoverContents,
  LanguageServiceLiveTestHarness,
  semanticTokenData
} from "./support/languageServiceLiveTestHarness";

const fixtureSource = resolve(__dirname, "fixtures/typescriptLanguageService");
let harness: LanguageServiceLiveTestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("production TypeScript language-service descriptor", () => {
  it("exercises every feature while resolving standalone JavaScript, React JSX, and Next.js symbols", async () => {
    harness = await LanguageServiceLiveTestHarness.create({
      fixtureSource,
      tempPrefix: "agentroom-typescript-live-",
      workspaceId: "workspace-typescript",
      workspaceName: "TypeScript fixtures",
      descriptor: typeScriptLanguageServerDescriptor
    });

    const standalone = await harness.open("standalone", "scratch.js", "javascript");
    expect(definitions(await harness.requestAt("standalone", standalone, "definition", "double", 1)))
      .toContainEqual(expect.objectContaining({ path: "scratch.js" }));
    expect(completionLabels(await harness.requestAt(
      "standalone",
      standalone,
      "completion",
      "toFixed",
      0,
      2
    ))).toContain("toFixed");
    expect(harness.framesFor("standalone")).toContainEqual(expect.objectContaining({
      type: "status",
      readiness: "ready",
      project: { root: "." }
    }));
    expect(harness.diagnosticsFor("standalone")).toEqual([]);

    const react = await harness.open("react", "react/src/Counter.tsx", "typescriptreact");
    const componentHover = hoverContents(await harness.requestAt("react", react, "hover", "<Counter"));
    expect(componentHover).toContain("function Counter");
    expect(componentHover).toContain("CounterProps");
    expect(definitions(await harness.requestAt("react", react, "definition", "initialCount={2}")))
      .toContainEqual(expect.objectContaining({ path: "react/src/Counter.tsx" }));
    expect(documentSymbolNames(await harness.requestFeature("react", {
      requestId: "react-document-symbols",
      clientVersion: 1,
      kind: "document_symbols"
    }))).toEqual(expect.arrayContaining(["CounterProps", "Counter", "preview"]));
    const tokenData = semanticTokenData(await harness.requestFeature("react", {
      requestId: "react-semantic-tokens",
      clientVersion: 1,
      kind: "semantic_tokens"
    }));
    expect(tokenData.length).toBeGreaterThan(0);
    expect(tokenData.length % 5).toBe(0);
    expect(harness.framesFor("react")).toContainEqual(expect.objectContaining({
      type: "status",
      readiness: "ready",
      project: { root: "react", marker: "tsconfig.json" }
    }));
    expect(harness.diagnosticsFor("react")).toEqual([]);

    const next = await harness.open("next", "next/src/route.ts", "typescript");
    expect(hoverContents(await harness.requestAt("next", next, "hover", "json", 0)))
      .toContain("NextResponse.json");
    expect(harness.framesFor("next")).toContainEqual(expect.objectContaining({
      type: "status",
      readiness: "ready",
      project: { root: "next", marker: "tsconfig.json" }
    }));
    expect(harness.diagnosticsFor("next")).toEqual([]);

    expect(harness.registry.projection()).toMatchObject([{ ready: true }]);
  }, 30_000);
});
