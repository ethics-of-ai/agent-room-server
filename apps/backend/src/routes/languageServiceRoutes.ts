import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { LANGUAGE_SERVICE_PROTOCOL_VERSION, type LanguageServiceServerFrame } from "../domain/languageService";
import {
  languageServiceClientFrameSchema,
  languageServiceServerFrameSchema,
  type LanguageServiceClientFrame
} from "../domain/languageServiceSchemas";
import type { ServiceConfig } from "../domain/models";
import { LanguageServiceError } from "../editor/languageServices/errors";
import type { LanguageServiceHost } from "../editor/languageServices/LanguageServiceHost";
import type { LanguageServiceLimits } from "../editor/languageServices/limits";
import { DEFAULT_LANGUAGE_SERVICE_LIMITS } from "../editor/languageServices/limits";
import type { LanguageServiceRegistry } from "../editor/languageServices/registry";
import { authorizedForRead } from "./readAuthorization";

const paramsSchema = z.object({ workspaceId: z.string().min(1).max(256) });

interface LanguageServiceSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: "message", handler: (raw: unknown) => void): void;
  on(event: "close", handler: () => void): void;
}

export class BoundedLanguageServiceSender {
  private readonly queue: Array<{ data: string; bytes: number }> = [];
  private queuedBytes = 0;
  private sending = false;
  private failed = false;

  constructor(
    private readonly socket: LanguageServiceSocket,
    private readonly limits: LanguageServiceLimits,
    private readonly onFailure: () => void
  ) {}

  send(frame: LanguageServiceServerFrame): void {
    if (this.failed || this.socket.readyState !== this.socket.OPEN) return;
    const parsed = languageServiceServerFrameSchema.safeParse(frame);
    if (!parsed.success) {
      this.abort("Invalid outbound frame");
      return;
    }
    const data = JSON.stringify(parsed.data);
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > this.limits.maxOutboundSocketFrameBytes) {
      this.abort("Outbound frame too large");
      return;
    }
    if (this.sending) {
      if (this.queue.length >= this.limits.maxQueuedSocketFrames
        || this.queuedBytes + bytes > this.limits.maxQueuedSocketBytes) {
        this.abort("Outbound queue limit reached");
        return;
      }
      this.queue.push({ data, bytes });
      this.queuedBytes += bytes;
      return;
    }
    this.write(data);
  }

  private write(data: string): void {
    this.sending = true;
    this.socket.send(data, (error) => {
      this.sending = false;
      if (error) {
        this.abort("Socket send failed");
        return;
      }
      const next = this.queue.shift();
      if (!next) return;
      this.queuedBytes -= next.bytes;
      this.write(next.data);
    });
  }

  private abort(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.socket.close(1011, reason);
    this.onFailure();
  }
}

export async function registerLanguageServiceRoutes(
  app: FastifyInstance,
  deps: {
    config: ServiceConfig;
    registry: LanguageServiceRegistry;
    host?: LanguageServiceHost;
    limits?: LanguageServiceLimits;
  }
): Promise<void> {
  app.get("/api/editor/language-services", async () => ({
    protocolVersion: LANGUAGE_SERVICE_PROTOCOL_VERSION,
    services: deps.registry.projection()
  }));

  if (!deps.host || deps.config.languageServicesEnabled !== true) return;
  if (!app.hasDecorator("websocketServer")) await app.register(websocket);
  const limits = deps.limits ?? DEFAULT_LANGUAGE_SERVICE_LIMITS;

  app.get(
    "/api/workspaces/:workspaceId/editor/language-service",
    { websocket: true },
    (socket: LanguageServiceSocket, request) => {
      if (!authorizedForRead(request.headers.authorization, deps.config)) {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: "error", code: "unauthorized", message: "Unauthorized" }));
        }
        socket.close(1008, "Unauthorized");
        return;
      }
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        socket.close(1008, "Invalid workspace");
        return;
      }
      const connectionId = randomUUID();
      let closed = false;
      let accepting = true;
      let ordered: Promise<void> = Promise.resolve();
      let queuedFrames = 0;
      let queuedBytes = 0;
      let cleanupQueued = false;
      const enqueueCleanup = (): void => {
        closed = true;
        accepting = false;
        if (cleanupQueued) return;
        cleanupQueued = true;
        const cancelOpening = deps.host!.closeConnection(connectionId).catch(() => undefined);
        ordered = ordered.catch(() => undefined)
          .then(async () => {
            await cancelOpening;
            await deps.host!.closeConnection(connectionId);
          })
          .catch(() => undefined);
      };
      const sender = new BoundedLanguageServiceSender(socket, limits, enqueueCleanup);
      const connection = {
        id: connectionId,
        workspaceId: params.data.workspaceId,
        send: (frame: LanguageServiceServerFrame) => sender.send(frame)
      };

      const report = (
        error: unknown,
        requestId?: string,
        languageId?: string,
        clientVersion?: number
      ): void => {
        const known = error instanceof LanguageServiceError
          ? error
          : new LanguageServiceError("server_failed", "Language-service request failed");
        if (languageId && clientVersion
          && ["ambiguous_project", "project_not_found", "service_unavailable"].includes(known.code)) {
          const readiness: "unavailable" | "ambiguous_project" | "project_not_found" =
            known.code === "service_unavailable" ? "unavailable"
              : known.code === "ambiguous_project" ? "ambiguous_project"
                : "project_not_found";
          const status = deps.host?.failureStatus(languageId, readiness, clientVersion);
          if (status) sender.send(status);
        }
        sender.send({
          type: "error",
          code: known.code,
          message: known.message.slice(0, 4 * 1024),
          ...(requestId ? { requestId } : {})
        });
        if (known.code === "resync_required") {
          socket.close(1008, "Resync required");
          enqueueCleanup();
        }
      };

      const enqueue = (
        frameBytes: number,
        operation: () => Promise<void>,
        requestId?: string,
        languageId?: string,
        clientVersion?: number
      ): void => {
        if (!accepting) return;
        if (queuedFrames >= limits.maxQueuedClientFrames
          || queuedBytes + frameBytes > limits.maxQueuedClientBytes) {
          report(new LanguageServiceError("resync_required", "Inbound operation queue limit reached"));
          return;
        }
        queuedFrames += 1;
        queuedBytes += frameBytes;
        ordered = ordered.then(async () => {
          if (!closed) await operation();
        }).catch((error) => report(error, requestId, languageId, clientVersion)).finally(() => {
          queuedFrames -= 1;
          queuedBytes -= frameBytes;
        });
      };

      socket.on("message", (raw) => {
        if (!accepting) return;
        const bytes = rawBytes(raw);
        if (!bytes || bytes.byteLength > limits.maxInboundSocketFrameBytes) {
          sender.send({ type: "error", code: "frame_too_large", message: "Frame exceeds the inbound limit" });
          socket.close(1009, "Frame too large");
          enqueueCleanup();
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(bytes.toString("utf8"));
        } catch {
          sender.send({ type: "error", code: "invalid_frame", message: "Frame must be JSON" });
          socket.close(1008, "Invalid frame");
          enqueueCleanup();
          return;
        }
        const candidate = value && typeof value === "object" ? value as { type?: unknown; text?: unknown } : undefined;
        if ((candidate?.type === "open" || candidate?.type === "change")
          && typeof candidate.text === "string"
          && Buffer.byteLength(candidate.text, "utf8") > limits.maxDocumentBytes) {
          sender.send({ type: "error", code: "document_too_large", message: "Document exceeds the 256 KiB limit" });
          return;
        }
        const parsed = languageServiceClientFrameSchema.safeParse(value);
        if (!parsed.success) {
          sender.send({ type: "error", code: "invalid_frame", message: "Frame does not match protocol version 1" });
          socket.close(1008, "Invalid frame");
          enqueueCleanup();
          return;
        }
        dispatchFrame(parsed.data, bytes.byteLength);
      });

      const dispatchFrame = (frame: LanguageServiceClientFrame, frameBytes: number): void => {
        if (frame.type === "open") {
          enqueue(
            frameBytes,
            () => deps.host!.openDocument(connection, frame),
            undefined,
            frame.languageId,
            frame.clientVersion
          );
        } else if (frame.type === "change") {
          enqueue(frameBytes, () => deps.host!.changeDocument(connectionId, frame.clientVersion, frame.text));
        } else if (frame.type === "request") {
          enqueue(frameBytes, async () => {
            const started = await deps.host!.startFeatureRequest(connectionId, frame);
            void started.response.then((response) => {
              if (response) sender.send(response);
            }).catch((error) => report(error, frame.requestId));
          }, frame.requestId);
        } else if (frame.type === "cancel") {
          enqueue(frameBytes, async () => deps.host!.cancelRequest(connectionId, frame.requestId));
        } else {
          enqueue(frameBytes, () => deps.host!.closeConnection(connectionId));
        }
      };

      socket.on("close", () => {
        enqueueCleanup();
      });
    }
  );
}

function rawBytes(raw: unknown): Buffer | undefined {
  if (Buffer.isBuffer(raw)) return raw;
  if (typeof raw === "string") return Buffer.from(raw, "utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw) && raw.every((item) => Buffer.isBuffer(item))) return Buffer.concat(raw);
  return undefined;
}
