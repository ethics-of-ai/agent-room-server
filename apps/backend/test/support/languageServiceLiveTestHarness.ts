import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  LanguageServiceDefinition,
  LanguageServiceDocumentSymbol,
  LanguageServiceServerFrame
} from "../../src/domain/languageService";
import type { LocalWorkspace, ServiceConfig } from "../../src/domain/models";
import {
  LanguageServiceHost,
  type LanguageServiceConnectionPort
} from "../../src/editor/languageServices/LanguageServiceHost";
import { LanguageServiceRegistry } from "../../src/editor/languageServices/registry";
import type { LanguageServiceDescriptor } from "../../src/editor/languageServices/types";
import type { LocalWorkspaceRegistry } from "../../src/workspace/LocalWorkspaceRegistry";

type FeatureRequest = Parameters<LanguageServiceHost["requestFeature"]>[1];
type PositionedFeatureKind = Extract<FeatureRequest["kind"], "completion" | "hover" | "definition">;

interface LiveTestHarnessOptions {
  fixtureSource: string;
  tempPrefix: string;
  workspaceId: string;
  workspaceName: string;
  descriptor: LanguageServiceDescriptor;
  configOverrides?: Partial<ServiceConfig>;
  diagnosticsTimeoutMs?: number;
  awaitDiagnostics?: boolean;
}

export class LanguageServiceLiveTestHarness {
  readonly registry: LanguageServiceRegistry;

  private readonly frames = new Map<string, LanguageServiceServerFrame[]>();
  private readonly host: LanguageServiceHost;

  private constructor(
    private readonly root: string,
    private readonly workspace: LocalWorkspace,
    config: ServiceConfig,
    descriptor: LanguageServiceDescriptor,
    private readonly diagnosticsTimeoutMs: number,
    private readonly awaitDiagnostics: boolean
  ) {
    this.registry = new LanguageServiceRegistry(config, [descriptor]);
    const workspaces = {
      findByIdWithoutGitRefresh: async () => workspace
    } as unknown as LocalWorkspaceRegistry;
    this.host = new LanguageServiceHost({ config, registry: this.registry, workspaces });
  }

  static async create(options: LiveTestHarnessOptions): Promise<LanguageServiceLiveTestHarness> {
    const root = await mkdtemp(join(tmpdir(), options.tempPrefix));
    try {
      await cp(options.fixtureSource, root, { recursive: true });
      const workspace: LocalWorkspace = {
        id: options.workspaceId,
        name: options.workspaceName,
        path: root,
        kind: "user_selected",
        trustedAt: new Date(0).toISOString(),
        lastOpenedAt: new Date(0).toISOString(),
        git: { isRepository: false }
      };
      const config: ServiceConfig = {
        runnerKind: "codex",
        host: "127.0.0.1",
        port: 8787,
        workspaceRoot: root,
        stateDir: join(root, ".state"),
        editorCatalogDir: join(root, ".catalog"),
        requireAuth: false,
        gitCommandTimeoutMs: 30_000,
        codexArgs: [],
        languageServicesEnabled: true,
        ...options.configOverrides
      };
      return new LanguageServiceLiveTestHarness(
        root,
        workspace,
        config,
        options.descriptor,
        options.diagnosticsTimeoutMs ?? 5_000,
        options.awaitDiagnostics ?? true
      );
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async open(id: string, path: string, languageId: string): Promise<string> {
    this.frames.set(id, []);
    const text = await readFile(join(this.root, path), "utf8");
    await this.host.openDocument(this.connection(id), { path, languageId, clientVersion: 1, text });
    if (this.awaitDiagnostics) {
      await waitForDiagnostics(this.framesFor(id), this.diagnosticsTimeoutMs);
    }
    return text;
  }

  requestFeature(id: string, input: FeatureRequest): Promise<LanguageServiceServerFrame | undefined> {
    return this.host.requestFeature(id, input);
  }

  requestAt(
    id: string,
    text: string,
    kind: PositionedFeatureKind,
    needle: string,
    occurrence = 0,
    offset = 1
  ): Promise<LanguageServiceServerFrame | undefined> {
    const position = positionOf(text, needle, occurrence);
    position.character += offset;
    return this.requestFeature(id, {
      requestId: `${id}-${kind}`,
      clientVersion: 1,
      kind,
      position
    });
  }

  framesFor(id: string): LanguageServiceServerFrame[] {
    return this.frames.get(id) ?? [];
  }

  diagnosticsFor(id: string): unknown[] {
    const frame = this.framesFor(id).findLast((candidate) => candidate.type === "diagnostics");
    return frame?.type === "diagnostics" ? frame.diagnostics : [];
  }

  async close(): Promise<void> {
    try {
      await this.host.close();
    } finally {
      await rm(this.root, { recursive: true, force: true });
    }
  }

  private connection(id: string): LanguageServiceConnectionPort {
    return {
      id,
      workspaceId: this.workspace.id,
      send: (frame) => this.frames.get(id)?.push(frame)
    };
  }
}

export function definitions(frame: LanguageServiceServerFrame | undefined): LanguageServiceDefinition[] {
  if (frame?.type !== "response" || frame.result.kind !== "definition") {
    throw new Error("Expected a definition response");
  }
  return frame.result.locations;
}

export function hoverContents(frame: LanguageServiceServerFrame | undefined): string {
  if (frame?.type !== "response" || frame.result.kind !== "hover") {
    throw new Error("Expected a hover response");
  }
  return frame.result.hover?.contents ?? "";
}

export function completionLabels(frame: LanguageServiceServerFrame | undefined): string[] {
  if (frame?.type !== "response" || frame.result.kind !== "completion") {
    throw new Error("Expected a completion response");
  }
  return frame.result.items.map((item) => item.label);
}

export function documentSymbolNames(frame: LanguageServiceServerFrame | undefined): string[] {
  if (frame?.type !== "response" || frame.result.kind !== "document_symbols") {
    throw new Error("Expected a document-symbol response");
  }
  return symbolNames(frame.result.symbols);
}

export function semanticTokenData(frame: LanguageServiceServerFrame | undefined): number[] {
  if (frame?.type !== "response" || frame.result.kind !== "semantic_tokens") {
    throw new Error("Expected a semantic-token response");
  }
  return frame.result.tokens.data;
}

function positionOf(text: string, needle: string, occurrence = 0): { line: number; character: number } {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = text.indexOf(needle, offset + 1);
  }
  if (offset < 0) throw new Error(`Missing fixture token: ${needle}`);
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function symbolNames(symbols: LanguageServiceDocumentSymbol[]): string[] {
  return symbols.flatMap((symbol) => [symbol.name, ...symbolNames(symbol.children)]);
}

async function waitForDiagnostics(frames: LanguageServiceServerFrame[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!frames.some((frame) => frame.type === "diagnostics")) {
    if (Date.now() >= deadline) throw new Error("Language-service diagnostics timed out");
    await new Promise((resolveValue) => setTimeout(resolveValue, 10));
  }
}
