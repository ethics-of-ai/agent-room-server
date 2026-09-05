import { pathToFileURL } from "node:url";
import type { LanguageServiceServerFrame, LanguageServiceStatusFrame } from "../../domain/languageService";
import type { ServiceConfig } from "../../domain/models";
import type { LocalWorkspaceRegistry } from "../../workspace/LocalWorkspaceRegistry";
import { LanguageServiceError } from "./errors";
import { LspEditorLanguageService } from "./LspEditorLanguageService";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS, type LanguageServiceLimits } from "./limits";
import { normalizeDiagnostics, normalizeFeatureResult } from "./normalize";
import { languageServiceInstanceKey, resolveLanguageServiceProject } from "./projectRoot";
import { LanguageServiceRegistry } from "./registry";
import { utf8Bytes, validPosition, validRange } from "./text";
import type { EditorLanguageService, LanguageServiceSpawner } from "./types";
import { failureStatusFrame, instanceStatusFrame } from "./status";
import type {
  DocumentShadow,
  LanguageServiceConnectionPort,
  OutstandingRequest,
  ServiceInstance,
  StartFeatureRequestInput
} from "./hostTypes";
export type { LanguageServiceConnectionPort } from "./hostTypes";

export class LanguageServiceHost {
  private readonly instances = new Map<string, ServiceInstance>();
  private readonly leases = new Map<string, string>();
  private readonly lspVersions = new Map<string, number>();
  private readonly openingConnections = new Map<string, { cancelled: boolean; workspaceId: string }>();
  private globalDocumentBytes = 0;
  private closing = false;

  constructor(private readonly deps: {
    config: ServiceConfig;
    workspaces: LocalWorkspaceRegistry;
    registry: LanguageServiceRegistry;
    limits?: LanguageServiceLimits;
    spawner?: LanguageServiceSpawner;
    now?: () => number;
  }) {}

  private get limits(): LanguageServiceLimits {
    return this.deps.limits ?? DEFAULT_LANGUAGE_SERVICE_LIMITS;
  }

  async openDocument(
    connection: LanguageServiceConnectionPort,
    input: { path: string; languageId: string; clientVersion: number; text: string }
  ): Promise<void> {
    if (!Number.isSafeInteger(input.clientVersion) || input.clientVersion <= 0) {
      throw new LanguageServiceError("resync_required", "Document version must be a positive integer");
    }
    if (this.findDocument(connection.id) || this.openingConnections.has(connection.id)) {
      throw new LanguageServiceError("invalid_frame", "This connection already has an open document");
    }
    const bytes = utf8Bytes(input.text);
    if (bytes > this.limits.maxDocumentBytes) {
      throw new LanguageServiceError("document_too_large", "Document exceeds the 256 KiB limit");
    }
    const opening = { cancelled: false, workspaceId: connection.workspaceId };
    this.openingConnections.set(connection.id, opening);
    let instance: ServiceInstance | undefined;
    let leaseKey: string | undefined;
    let reserved = false;
    let openedUri: string | undefined;
    try {
      this.assertOpening(opening);
      const workspace = await this.deps.workspaces.findByIdWithoutGitRefresh(connection.workspaceId);
      if (!workspace) throw new LanguageServiceError("workspace_not_found", "Workspace is not registered");
      this.assertOpening(opening);
      const descriptors = this.deps.registry.supporting(input.languageId);
      const project = await resolveLanguageServiceProject(workspace, input.path, input.languageId, descriptors);
      this.assertOpening(opening);
      leaseKey = `${connection.workspaceId}\0${project.relativePath}`;
      if (this.leases.has(leaseKey)) {
        throw new LanguageServiceError("document_busy", "Document is already open in another editor tab");
      }

      const key = languageServiceInstanceKey(connection.workspaceId, project.descriptor.id, project.projectRoot);
      instance = this.instances.get(key);
      if (!instance) {
        this.enforceProcessLimits(connection.workspaceId);
        instance = {
          key,
          workspaceId: connection.workspaceId,
          project,
          descriptor: project.descriptor,
          replayRequired: false,
          documents: new Map(),
          pendingDocuments: 0,
          outstanding: new Map(),
          restartTimes: [],
          terminalFailure: false
        };
        this.instances.set(key, instance);
      }
      if (instance.documents.size + instance.pendingDocuments >= this.limits.maxDocumentsPerProcess) {
        throw new LanguageServiceError("document_limit", "Language-service process has too many open documents");
      }
      if (this.globalDocumentBytes + bytes > this.limits.maxGlobalDocumentBytes) {
        throw new LanguageServiceError("global_document_limit", "Open documents exceed the global shadow limit");
      }
      instance.pendingDocuments += 1;
      this.globalDocumentBytes += bytes;
      reserved = true;
      this.leases.set(leaseKey, connection.id);
      if (instance.idleTimer) {
        clearTimeout(instance.idleTimer);
        instance.idleTimer = undefined;
      }

      await this.ensureStarted(instance);
      this.assertOpening(opening);
      const shadow: DocumentShadow = {
        connection,
        relativePath: project.relativePath,
        uri: pathToFileURL(project.filePath).toString(),
        languageId: input.languageId,
        text: input.text,
        clientVersion: input.clientVersion,
        mappedClientVersion: input.clientVersion,
        lspVersion: this.nextLspVersion(connection.workspaceId, project.relativePath),
        closed: false
      };
      const service = instance.service;
      if (!service) throw new LanguageServiceError("service_unavailable", "Language service is restarting");
      await service.openDocument({
        documentId: connection.id,
        uri: shadow.uri,
        languageId: shadow.languageId,
        lspVersion: shadow.lspVersion,
        text: shadow.text
      });
      openedUri = shadow.uri;
      this.assertOpening(opening);
      instance.documents.set(connection.id, shadow);
      instance.pendingDocuments -= 1;
      reserved = false;
      this.openingConnections.delete(connection.id);
      connection.send(instanceStatusFrame(instance, "ready", shadow.clientVersion));
    } catch (error) {
      if (openedUri && instance?.service) {
        await instance.service.closeDocument(connection.id, openedUri).catch(() => undefined);
      }
      if (reserved && instance) {
        instance.pendingDocuments -= 1;
        this.globalDocumentBytes -= bytes;
      }
      if (leaseKey && this.leases.get(leaseKey) === connection.id) this.leases.delete(leaseKey);
      this.openingConnections.delete(connection.id);
      if (instance && instance.documents.size === 0 && instance.pendingDocuments === 0) {
        if (this.closing) await this.disposeInstance(instance, true);
        else if (instance.service) this.scheduleIdleClose(instance);
        else this.instances.delete(instance.key);
      }
      throw error;
    }
  }

  async changeDocument(connectionId: string, clientVersion: number, text: string): Promise<void> {
    const found = this.requireDocument(connectionId);
    if (!Number.isSafeInteger(clientVersion) || clientVersion <= found.shadow.clientVersion) {
      throw new LanguageServiceError("resync_required", "Document versions must increase monotonically");
    }
    const bytes = utf8Bytes(text);
    if (bytes > this.limits.maxDocumentBytes) {
      throw new LanguageServiceError("document_too_large", "Document exceeds the 256 KiB limit");
    }
    const nextGlobalBytes = this.globalDocumentBytes - utf8Bytes(found.shadow.text) + bytes;
    if (nextGlobalBytes > this.limits.maxGlobalDocumentBytes) {
      throw new LanguageServiceError("global_document_limit", "Open documents exceed the global shadow limit");
    }
    this.globalDocumentBytes = nextGlobalBytes;
    found.shadow.text = text;
    found.shadow.clientVersion = clientVersion;
    this.scheduleChange(found.instance, found.shadow);
  }

  async requestFeature(
    connectionId: string,
    input: StartFeatureRequestInput
  ): Promise<LanguageServiceServerFrame | undefined> {
    const started = await this.startFeatureRequest(connectionId, input);
    return started.response;
  }

  async startFeatureRequest(
    connectionId: string,
    input: StartFeatureRequestInput
  ): Promise<{ response: Promise<LanguageServiceServerFrame | undefined> }> {
    const { instance, shadow } = this.requireDocument(connectionId);
    if (input.clientVersion !== shadow.clientVersion) {
      throw new LanguageServiceError("stale_document", "Request version does not match the current document");
    }
    if (!instance.descriptor.featureKinds.includes(input.kind)) {
      throw new LanguageServiceError("invalid_frame", "Feature is not supported by this language service");
    }
    if (["completion", "hover", "definition"].includes(input.kind)) {
      if (!input.position || !validPosition(shadow.text, input.position)) {
        throw new LanguageServiceError("invalid_position", "Request position is outside the document");
      }
    }
    if (input.range && !validRange(shadow.text, input.range)) {
      throw new LanguageServiceError("invalid_position", "Request range is outside the document");
    }
    await this.flushChange(instance, shadow);
    await this.ensureStarted(instance);
    if (shadow.closed || instance.documents.get(connectionId) !== shadow) {
      throw new LanguageServiceError("cancelled", "Document closed before the request started");
    }
    if (shadow.mappedClientVersion !== input.clientVersion) {
      throw new LanguageServiceError("stale_document", "Document version is not synchronized");
    }
    const socketOutstanding = [...instance.outstanding.values()]
      .filter((request) => request.connectionId === connectionId).length;
    if (socketOutstanding >= this.limits.maxOutstandingPerSocket
      || instance.outstanding.size >= this.limits.maxOutstandingPerProcess) {
      throw new LanguageServiceError("request_limit", "Too many language-service requests are outstanding");
    }
    const requestKey = `${connectionId}\0${input.requestId}`;
    if (instance.outstanding.has(requestKey)) {
      throw new LanguageServiceError("invalid_frame", "Request id is already outstanding");
    }
    const service = instance.service;
    if (!service) throw new LanguageServiceError("service_unavailable", "Language service is restarting");
    const handle = service.request({
      kind: input.kind,
      uri: shadow.uri,
      position: input.position,
      timeoutMs: this.limits.featureTimeoutMs
    });
    const outstanding: OutstandingRequest = {
      connectionId,
      requestId: input.requestId,
      clientVersion: input.clientVersion,
      lspId: handle.id,
      cancelled: false
    };
    instance.outstanding.set(requestKey, outstanding);
    return { response: this.finishFeatureRequest(instance, shadow, requestKey, input, outstanding, handle.promise) };
  }

  private async finishFeatureRequest(
    instance: ServiceInstance,
    shadow: DocumentShadow,
    requestKey: string,
    input: StartFeatureRequestInput,
    outstanding: OutstandingRequest,
    response: Promise<unknown>
  ): Promise<LanguageServiceServerFrame | undefined> {
    try {
      let raw: unknown;
      try {
        raw = await response;
      } catch (error) {
        if (outstanding.cancelled) return undefined;
        throw error;
      }
      const current = instance.outstanding.get(requestKey);
      if (!current || current.cancelled || instance.documents.get(outstanding.connectionId) !== shadow
        || shadow.clientVersion !== input.clientVersion || shadow.mappedClientVersion !== input.clientVersion) {
        return undefined;
      }
      const result = await normalizeFeatureResult(input.kind, raw, {
        text: shadow.text,
        workspaceRoot: instance.project.workspaceRoot
      });
      return { type: "response", requestId: input.requestId, clientVersion: input.clientVersion, result };
    } finally {
      instance.outstanding.delete(requestKey);
      this.scheduleIdleClose(instance);
    }
  }

  cancelRequest(connectionId: string, requestId: string): void {
    const found = this.findDocument(connectionId);
    if (!found) return;
    const pending = found.instance.outstanding.get(`${connectionId}\0${requestId}`);
    if (!pending) return;
    pending.cancelled = true;
    found.instance.service?.cancel(pending.lspId);
  }

  async closeConnection(connectionId: string): Promise<void> {
    const opening = this.openingConnections.get(connectionId);
    if (opening) opening.cancelled = true;
    const found = this.findDocument(connectionId);
    if (!found) return;
    const { instance, shadow } = found;
    shadow.closed = true;
    if (shadow.changeTimer) clearTimeout(shadow.changeTimer);
    for (const pending of instance.outstanding.values()) {
      if (pending.connectionId === connectionId) {
        pending.cancelled = true;
        instance.service?.cancel(pending.lspId);
      }
    }
    instance.documents.delete(connectionId);
    this.globalDocumentBytes -= utf8Bytes(shadow.text);
    this.leases.delete(`${instance.workspaceId}\0${shadow.relativePath}`);
    try {
      await instance.service?.closeDocument(connectionId, shadow.uri);
    } finally {
      this.scheduleIdleClose(instance);
    }
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    for (const opening of this.openingConnections.values()) {
      if (opening.workspaceId === workspaceId) opening.cancelled = true;
    }
    const connectionIds = [...this.instances.values()]
      .filter((instance) => instance.workspaceId === workspaceId)
      .flatMap((instance) => [...instance.documents.keys()]);
    await Promise.all(connectionIds.map((id) => this.closeConnection(id)));
    const instances = [...this.instances.values()].filter((instance) => instance.workspaceId === workspaceId);
    await Promise.all(instances.map((instance) => this.disposeInstance(instance)));
    for (const key of this.lspVersions.keys()) {
      if (key.startsWith(`${workspaceId}\0`)) this.lspVersions.delete(key);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const opening of this.openingConnections.values()) opening.cancelled = true;
    for (const instance of [...this.instances.values()]) {
      for (const connectionId of [...instance.documents.keys()]) await this.closeConnection(connectionId);
      await this.disposeInstance(instance, true);
    }
    this.leases.clear();
    this.lspVersions.clear();
  }

  failureStatus(
    languageId: string,
    readiness: "ambiguous_project" | "project_not_found" | "unavailable" | "failed",
    clientVersion: number
  ): LanguageServiceStatusFrame | undefined {
    return failureStatusFrame(this.deps.registry, languageId, readiness, clientVersion);
  }

  private async ensureStarted(instance: ServiceInstance): Promise<void> {
    if (instance.replayRequired) {
      await this.ensureReplayed(instance);
      return;
    }
    await this.ensureProcessStarted(instance);
  }

  private async ensureProcessStarted(instance: ServiceInstance): Promise<void> {
    if (instance.service) return;
    if (instance.terminalFailure) {
      throw new LanguageServiceError("service_unavailable", "Language service exceeded its restart budget");
    }
    if (!instance.startPromise) {
      instance.startPromise = this.start(instance).finally(() => { instance.startPromise = undefined; });
    }
    await instance.startPromise;
  }

  private async start(instance: ServiceInstance): Promise<void> {
    let service!: LspEditorLanguageService;
    service = new LspEditorLanguageService({
      descriptor: instance.descriptor,
      config: this.deps.config,
      projectRoot: instance.project.projectRoot,
      projectName: instance.project.marker ?? "workspace",
      limits: this.limits,
      ...(this.deps.spawner ? { spawner: this.deps.spawner } : {}),
      onNotification: (method, params) => this.onNotification(instance, service, method, params),
      onFatal: () => this.onFatal(instance, service)
    });
    instance.startingService = service;
    try {
      const readiness = await service.probe();
      if (readiness !== "ready") {
        throw new LanguageServiceError("service_unavailable", "Language service is unavailable");
      }
      instance.semanticTokenLegend = service.semanticTokenLegend;
      instance.service = service;
      instance.healthySince = (this.deps.now ?? Date.now)();
      this.deps.registry.observe(instance.descriptor.id, true);
    } catch (error) {
      await service.close();
      this.deps.registry.observe(instance.descriptor.id, false);
      throw error instanceof LanguageServiceError
        ? error
        : new LanguageServiceError("service_unavailable", "Language service failed to initialize");
    } finally {
      if (instance.startingService === service) instance.startingService = undefined;
    }
  }

  private scheduleChange(instance: ServiceInstance, shadow: DocumentShadow): void {
    if (shadow.changeTimer) clearTimeout(shadow.changeTimer);
    shadow.changeTimer = setTimeout(() => {
      void this.flushChange(instance, shadow).catch(() => undefined);
    }, this.limits.changeDebounceMs);
    shadow.changeTimer.unref?.();
  }

  private async flushChange(instance: ServiceInstance, shadow: DocumentShadow): Promise<void> {
    if (shadow.flushInProgress) return shadow.flushInProgress;
    if (shadow.closed || shadow.mappedClientVersion === shadow.clientVersion) return;
    shadow.flushInProgress = this.performFlushChange(instance, shadow);
    try {
      await shadow.flushInProgress;
    } finally {
      shadow.flushInProgress = undefined;
    }
  }

  private async performFlushChange(instance: ServiceInstance, shadow: DocumentShadow): Promise<void> {
    if (shadow.changeTimer) clearTimeout(shadow.changeTimer);
    shadow.changeTimer = undefined;
    while (!shadow.closed && shadow.mappedClientVersion !== shadow.clientVersion) {
      const clientVersion = shadow.clientVersion;
      const text = shadow.text;
      await this.ensureStarted(instance);
      if (shadow.closed) break;
      const service = instance.service;
      if (!service) throw new LanguageServiceError("service_unavailable", "Language service is restarting");
      shadow.lspVersion = this.nextLspVersion(instance.workspaceId, shadow.relativePath);
      await service.changeDocument({
        uri: shadow.uri,
        lspVersion: shadow.lspVersion,
        text
      });
      shadow.mappedClientVersion = clientVersion;
    }
  }

  private onNotification(instance: ServiceInstance, service: EditorLanguageService, method: string, params: unknown): void {
    if (instance.service !== service || method !== "textDocument/publishDiagnostics") return;
    const uri = typeof (params as { uri?: unknown } | null)?.uri === "string"
      ? (params as { uri: string }).uri
      : undefined;
    const shadow = [...instance.documents.values()].find((document) => document.uri === uri);
    if (!shadow) return;
    const version = (params as { version?: unknown } | null)?.version;
    if (typeof version === "number" && version !== shadow.lspVersion) return;
    const normalized = normalizeDiagnostics(params, shadow.text);
    shadow.connection.send({
      type: "diagnostics",
      clientVersion: shadow.mappedClientVersion,
      ...normalized
    });
  }

  private onFatal(instance: ServiceInstance, service: EditorLanguageService): void {
    if (instance.service !== service || this.closing) return;
    instance.service = undefined;
    this.deps.registry.observe(instance.descriptor.id, false);
    const now = (this.deps.now ?? Date.now)();
    if (instance.healthySince !== undefined && now - instance.healthySince >= this.limits.healthyRestartResetMs) {
      instance.restartTimes = [];
    }
    instance.restartTimes = instance.restartTimes.filter((time) => now - time <= this.limits.restartWindowMs);
    instance.restartTimes.push(now);
    if (instance.restartTimes.length > this.limits.restartLimit) {
      instance.terminalFailure = true;
      instance.replayRequired = false;
      this.broadcastStatus(instance, "failed");
      return;
    }
    if (instance.documents.size === 0) {
      this.scheduleIdleClose(instance);
      return;
    }
    instance.replayRequired = true;
    this.broadcastStatus(instance, "restarting");
    void this.ensureReplayed(instance).catch(() => undefined);
  }

  private async ensureReplayed(instance: ServiceInstance): Promise<void> {
    if (!instance.replayPromise) {
      const replay = this.restartAndReplay(instance);
      instance.replayPromise = replay;
      void replay.then(
        () => { if (instance.replayPromise === replay) instance.replayPromise = undefined; },
        () => { if (instance.replayPromise === replay) instance.replayPromise = undefined; }
      );
    }
    await instance.replayPromise;
  }

  private async restartAndReplay(instance: ServiceInstance): Promise<void> {
    try {
      await this.ensureProcessStarted(instance);
      for (const [connectionId, shadow] of instance.documents) {
        if (shadow.closed || instance.documents.get(connectionId) !== shadow) continue;
        if (shadow.changeTimer) clearTimeout(shadow.changeTimer);
        shadow.changeTimer = undefined;
        shadow.lspVersion = this.nextLspVersion(instance.workspaceId, shadow.relativePath);
        shadow.mappedClientVersion = shadow.clientVersion;
        const service = instance.service;
        if (!service) throw new LanguageServiceError("service_unavailable", "Language service restart was interrupted");
        await service.openDocument({
          documentId: shadow.connection.id,
          uri: shadow.uri,
          languageId: shadow.languageId,
          lspVersion: shadow.lspVersion,
          text: shadow.text
        });
        if (shadow.closed || instance.documents.get(connectionId) !== shadow) {
          await service.closeDocument(connectionId, shadow.uri);
          continue;
        }
      }
      instance.replayRequired = false;
      this.broadcastStatus(instance, "ready");
      this.scheduleIdleClose(instance);
    } catch (error) {
      if (!instance.terminalFailure) this.broadcastStatus(instance, "failed");
      throw error;
    }
  }

  private broadcastStatus(instance: ServiceInstance, readiness: LanguageServiceStatusFrame["readiness"]): void {
    for (const shadow of instance.documents.values()) {
      shadow.connection.send(instanceStatusFrame(instance, readiness, shadow.clientVersion));
    }
  }

  private findDocument(connectionId: string): { instance: ServiceInstance; shadow: DocumentShadow } | undefined {
    for (const instance of this.instances.values()) {
      const shadow = instance.documents.get(connectionId);
      if (shadow) return { instance, shadow };
    }
    return undefined;
  }

  private requireDocument(connectionId: string): { instance: ServiceInstance; shadow: DocumentShadow } {
    const found = this.findDocument(connectionId);
    if (!found) throw new LanguageServiceError("invalid_frame", "No document is open on this connection");
    return found;
  }

  private enforceProcessLimits(workspaceId: string): void {
    if (this.instances.size >= this.limits.maxProcesses
      || [...this.instances.values()].filter((instance) => instance.workspaceId === workspaceId).length
        >= this.limits.maxProcessesPerWorkspace) {
      throw new LanguageServiceError("process_limit", "Language-service process limit reached");
    }
  }

  private nextLspVersion(workspaceId: string, relativePath: string): number {
    const key = `${workspaceId}\0${relativePath}`;
    const version = (this.lspVersions.get(key) ?? 0) + 1;
    this.lspVersions.set(key, version);
    return version;
  }

  private scheduleIdleClose(instance: ServiceInstance): void {
    if (instance.documents.size > 0 || instance.pendingDocuments > 0
      || instance.outstanding.size > 0 || instance.idleTimer) return;
    instance.idleTimer = setTimeout(() => { void this.disposeInstance(instance); }, this.limits.idleTimeoutMs);
    instance.idleTimer.unref?.();
  }

  private async disposeInstance(instance: ServiceInstance, force = false): Promise<void> {
    if (instance.idleTimer) clearTimeout(instance.idleTimer);
    if (this.instances.get(instance.key) === instance) this.instances.delete(instance.key);
    const services = new Set([instance.service, instance.startingService].filter(
      (service): service is EditorLanguageService => service !== undefined
    ));
    instance.service = undefined;
    instance.startingService = undefined;
    await Promise.all([...services].map((service) => service.close({ force })));
  }

  private assertOpening(opening: { cancelled: boolean }): void {
    if (this.closing || opening.cancelled) {
      throw new LanguageServiceError("cancelled", "Document open was cancelled");
    }
  }
}
