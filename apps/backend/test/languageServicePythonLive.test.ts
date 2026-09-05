import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pyrightLanguageServerDescriptor } from "../src/editor/languageServices/registry";
import {
  completionLabels,
  definitions,
  documentSymbolNames,
  hoverContents,
  LanguageServiceLiveTestHarness
} from "./support/languageServiceLiveTestHarness";

const fixtureSource = resolve(__dirname, "fixtures/pythonLanguageService");
let harness: LanguageServiceLiveTestHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("production Pyright language-service descriptor", () => {
  it("exercises every advertised feature while resolving standalone and Django symbols", async () => {
    harness = await LanguageServiceLiveTestHarness.create({
      fixtureSource,
      tempPrefix: "agentroom-python-live-",
      workspaceId: "workspace-python",
      workspaceName: "Python fixtures",
      descriptor: pyrightLanguageServerDescriptor
    });

    const standalone = await harness.open("standalone", "scratch.py", "python");
    expect(definitions(await harness.requestAt("standalone", standalone, "definition", "double", 1)))
      .toContainEqual(expect.objectContaining({ path: "scratch.py" }));
    expect(hoverContents(await harness.requestAt("standalone", standalone, "hover", "double", 1)))
      .toContain("double");
    expect(completionLabels(await harness.requestAt(
      "standalone",
      standalone,
      "completion",
      "result.bit_length",
      0,
      "result.".length
    ))).toContain("bit_length");
    expect(documentSymbolNames(await harness.requestFeature("standalone", {
      requestId: "standalone-document-symbols",
      clientVersion: 1,
      kind: "document_symbols"
    }))).toEqual(expect.arrayContaining(["double", "result"]));
    expect(harness.framesFor("standalone")).toContainEqual(expect.objectContaining({
      type: "status",
      readiness: "ready",
      project: { root: "." }
    }));
    expect(harness.diagnosticsFor("standalone")).toEqual([]);

    const django = await harness.open("django", "django/src/app/views.py", "python");
    expect(hoverContents(await harness.requestAt("django", django, "hover", "JsonResponse", 1)))
      .toContain("JsonResponse");
    expect(definitions(await harness.requestAt("django", django, "definition", "HttpRequest", 0)))
      .toContainEqual(expect.objectContaining({ path: "django/typings/django/http/__init__.pyi" }));
    expect(completionLabels(await harness.requestAt(
      "django",
      django,
      "completion",
      "request.method",
      0,
      "request.".length
    ))).toContain("method");
    expect(documentSymbolNames(await harness.requestFeature("django", {
      requestId: "django-document-symbols",
      clientVersion: 1,
      kind: "document_symbols"
    }))).toContain("health");
    expect(harness.framesFor("django")).toContainEqual(expect.objectContaining({
      type: "status",
      readiness: "ready",
      project: { root: "django", marker: "pyrightconfig.json" }
    }));
    expect(harness.diagnosticsFor("django")).toEqual([]);

    expect(harness.registry.projection()).toMatchObject([{ ready: true }]);
  }, 30_000);
});
