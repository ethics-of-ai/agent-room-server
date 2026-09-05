import { pathToFileURL } from "node:url";
import type { LanguageServiceReadiness } from "../../domain/languageService";
import type { ServiceConfig } from "../../domain/models";
import { languageServiceClientCapabilities } from "./capabilities";
import { LanguageServiceError } from "./errors";
import { prepareLanguageServiceLaunch } from "./launch";
import { LspStdioClient } from "./LspStdioClient";
import type { LanguageServiceLimits } from "./limits";
import { languageServiceEnvironment } from "./registry";
import type {
  ChangeLanguageDocument,
  EditorLanguageService,
  LanguageFeatureRequest,
  LanguageFeatureRequestHandle,
  LanguageServiceDescriptor,
  LanguageServiceSpawner,
  OpenLanguageDocument
} from "./types";

export class LspEditorLanguageService implements EditorLanguageService {
  private client?: LspStdioClient;
  private ready = false;
  private closed = false;
  private probePromise?: Promise<LanguageServiceReadiness>;
  private launchCleanup?: () => Promise<void>;
  semanticTokenLegend?: { tokenTypes: string[]; tokenModifiers: string[] };

  constructor(private readonly deps: {
    descriptor: LanguageServiceDescriptor;
    config: ServiceConfig;
    projectRoot: string;
    projectName: string;
    limits: LanguageServiceLimits;
    spawner?: LanguageServiceSpawner;
    onNotification(method: string, params: unknown): void;
    onFatal(): void;
  }) {}

  descriptor(): LanguageServiceDescriptor {
    return this.deps.descriptor;
  }

  probe(): Promise<LanguageServiceReadiness> {
    if (this.closed) {
      return Promise.reject(new LanguageServiceError("service_unavailable", "Language service is closed"));
    }
    if (this.ready && this.client) return Promise.resolve("ready");
    if (!this.probePromise) {
      const pending = this.startClient();
      const tracked = pending.finally(() => {
        if (this.probePromise === tracked) this.probePromise = undefined;
      });
      this.probePromise = tracked;
    }
    return this.probePromise;
  }

  private async startClient(): Promise<LanguageServiceReadiness> {
    const executable = await prepareLanguageServiceLaunch(this.deps.descriptor, this.deps.config);
    this.launchCleanup = executable.cleanup;
    if (this.closed) {
      await this.cleanupLaunch();
      throw new LanguageServiceError("service_unavailable", "Language service is closed");
    }
    let client!: LspStdioClient;
    try {
      client = new LspStdioClient({
        command: executable.command,
        args: executable.args,
        cwd: this.deps.projectRoot,
        env: languageServiceEnvironment(this.deps.descriptor),
        limits: this.deps.limits,
        serverRequests: this.deps.descriptor.serverRequests,
        ...(this.deps.spawner ? { spawner: this.deps.spawner } : {}),
        handlers: {
          onNotification: (method, params) => {
            if (this.client === client) this.deps.onNotification(method, params);
          },
          onFatal: () => {
            if (this.client !== client) return;
            this.client = undefined;
            this.ready = false;
            void this.cleanupLaunch();
            this.deps.onFatal();
          }
        }
      });
      this.client = client;
      const initialized = await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.deps.projectRoot).toString(),
        workspaceFolders: [{ uri: pathToFileURL(this.deps.projectRoot).toString(), name: this.deps.projectName }],
        capabilities: languageServiceClientCapabilities,
        initializationOptions: executable.initializationOptions ?? this.deps.descriptor.initializationOptions
      }, this.deps.limits.initializeTimeoutMs);
      const capabilities = initializedCapabilities(initialized);
      const positionEncoding = capabilities.positionEncoding ?? "utf-16";
      if (positionEncoding !== this.deps.descriptor.positionEncoding) {
        throw new LanguageServiceError("unsupported_response", "Language server does not support UTF-16 positions");
      }
      this.semanticTokenLegend = semanticLegend(capabilities.semanticTokensProvider);
      client.notify("initialized", {});
      this.ready = true;
      return "ready";
    } catch (error) {
      if (this.client === client) this.client = undefined;
      this.ready = false;
      client?.dispose("Language service failed to initialize");
      await this.cleanupLaunch();
      throw error instanceof LanguageServiceError
        ? error
        : new LanguageServiceError("service_unavailable", "Language service failed to initialize");
    }
  }

  async openDocument(input: OpenLanguageDocument): Promise<void> {
    this.requireClient().notify("textDocument/didOpen", {
      textDocument: {
        uri: input.uri,
        languageId: input.languageId,
        version: input.lspVersion,
        text: input.text
      }
    });
  }

  async changeDocument(input: ChangeLanguageDocument): Promise<void> {
    this.requireClient().notify("textDocument/didChange", {
      textDocument: { uri: input.uri, version: input.lspVersion },
      contentChanges: [{ text: input.text }]
    });
  }

  request(input: LanguageFeatureRequest): LanguageFeatureRequestHandle {
    return this.requireClient().requestWithHandle(
      methodFor(input.kind),
      paramsFor(input.kind, input.uri, input.position),
      input.timeoutMs
    );
  }

  cancel(requestId: number): void {
    this.client?.cancel(requestId);
  }

  async closeDocument(_documentId: string, uri: string): Promise<void> {
    this.client?.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async close(options?: { force?: boolean }): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.ready = false;
    try {
      if (!client) return;
      if (options?.force) client.dispose("Language service stopped with the backend", true);
      else await client.shutdown();
    } finally {
      await this.cleanupLaunch();
    }
  }

  private async cleanupLaunch(): Promise<void> {
    const cleanup = this.launchCleanup;
    this.launchCleanup = undefined;
    await cleanup?.();
  }

  private requireClient(): LspStdioClient {
    if (!this.client || !this.ready) {
      throw new LanguageServiceError("service_unavailable", "Language service is unavailable");
    }
    return this.client;
  }
}

function initializedCapabilities(value: unknown): Record<string, unknown> {
  const response = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const capabilities = response?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new LanguageServiceError("unsupported_response", "Language server returned invalid capabilities");
  }
  return capabilities as Record<string, unknown>;
}

function semanticLegend(value: unknown): { tokenTypes: string[]; tokenModifiers: string[] } | undefined {
  const provider = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const legend = provider?.legend && typeof provider.legend === "object"
    ? provider.legend as Record<string, unknown>
    : undefined;
  if (!legend) return undefined;
  const bounded = (candidate: unknown, limit: number): string[] => Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string" && Buffer.byteLength(item, "utf8") <= 64).slice(0, limit)
    : [];
  return { tokenTypes: bounded(legend.tokenTypes, 128), tokenModifiers: bounded(legend.tokenModifiers, 64) };
}

function methodFor(kind: LanguageFeatureRequest["kind"]): string {
  return kind === "completion" ? "textDocument/completion"
    : kind === "hover" ? "textDocument/hover"
      : kind === "definition" ? "textDocument/definition"
        : kind === "document_symbols" ? "textDocument/documentSymbol"
          : "textDocument/semanticTokens/full";
}

function paramsFor(
  kind: LanguageFeatureRequest["kind"],
  uri: string,
  position?: { line: number; character: number }
): Record<string, unknown> {
  const textDocument = { uri };
  return ["completion", "hover", "definition"].includes(kind)
    ? { textDocument, position, ...(kind === "completion" ? { context: { triggerKind: 1 } } : {}) }
    : { textDocument };
}
