import { randomUUID } from "node:crypto";
import { sha256Hex } from "../util/hash";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AgentSession,
  AgentSessionAttachment,
  AgentSessionMessageContextAttachment,
  ServiceConfig
} from "../domain/models";
import { agentSessionAttachmentSchema } from "../domain/schemas";
import type { AgentRunnerInputPart } from "../runner/AgentRunner";

export const maxAgentAttachmentBytes = 10 * 1024 * 1024;

export class AgentAttachmentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface StoreAgentAttachmentInput {
  sessionId: string;
  sourceName: string;
  contentType: string;
  data: Buffer;
}

export class AgentAttachmentStore {
  private readonly rootPath: string;

  constructor(
    private readonly deps: {
      config: ServiceConfig;
      sessionLookup: {
        getSession(sessionId: string): AgentSession | undefined;
      };
    }
  ) {
    this.rootPath = join(deps.config.stateDir, "attachments");
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
  }

  async storeImage(input: StoreAgentAttachmentInput): Promise<AgentSessionAttachment> {
    const session = this.requireSession(input.sessionId);
    const contentType = normalizedImageContentType(input.contentType);
    if (!contentType) {
      throw new AgentAttachmentError("Attachment content type is not supported", 415);
    }
    if (input.data.length === 0) {
      throw new AgentAttachmentError("Attachment file is empty");
    }
    if (input.data.length > maxAgentAttachmentBytes) {
      throw new AgentAttachmentError("Attachment file is too large", 413);
    }
    if (!matchesImageSignature(input.data, contentType)) {
      throw new AgentAttachmentError("Attachment file does not match its declared image type");
    }

    const attachment: AgentSessionAttachment = {
      id: agentAttachmentId(),
      workspaceId: session.workspaceId,
      sessionId: session.id,
      kind: "image",
      sourceName: safeSourceName(input.sourceName),
      contentType,
      sizeBytes: input.data.length,
      sha256: sha256Hex(input.data),
      createdAt: new Date().toISOString()
    };
    const directory = this.attachmentDirectory(attachment.workspaceId, attachment.sessionId, attachment.id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "source"), input.data);
    await writeFile(join(directory, "metadata.json"), JSON.stringify({ attachment }, null, 2));
    return attachment;
  }

  async inputPartsForTurn(sessionId: string, attachmentIds: string[] | undefined): Promise<AgentRunnerInputPart[]> {
    if (!attachmentIds?.length) return [];
    const session = this.requireSession(sessionId);
    const uniqueIds = [...new Set(attachmentIds)];
    const parts: AgentRunnerInputPart[] = [];
    for (const attachmentId of uniqueIds) {
      const attachment = await this.readAttachment(session.workspaceId, session.id, attachmentId);
      parts.push({
        type: "localImage",
        path: this.sourcePath(attachment.workspaceId, attachment.sessionId, attachment.id),
        contentType: attachment.contentType
      });
    }
    return parts;
  }

  async contextAttachmentsForTurn(
    sessionId: string,
    attachmentIds: string[] | undefined
  ): Promise<AgentSessionMessageContextAttachment[]> {
    if (!attachmentIds?.length) return [];
    const session = this.requireSession(sessionId);
    const uniqueIds = [...new Set(attachmentIds)];
    const attachments: AgentSessionMessageContextAttachment[] = [];
    for (const attachmentId of uniqueIds) {
      const attachment = await this.readAttachment(session.workspaceId, session.id, attachmentId);
      attachments.push({
        id: attachment.id,
        kind: attachment.kind,
        sourceName: attachment.sourceName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes
      });
    }
    return attachments;
  }

  async deleteSessionAttachments(session: Pick<AgentSession, "workspaceId" | "id">): Promise<void> {
    await rm(this.sessionAttachmentDirectory(session.workspaceId, session.id), {
      recursive: true,
      force: true
    });
  }

  private async readAttachment(
    workspaceId: string,
    sessionId: string,
    attachmentId: string
  ): Promise<AgentSessionAttachment> {
    if (!/^attachment-[0-9a-f-]{36}$/.test(attachmentId)) {
      throw new AgentAttachmentError("Attachment was not found", 404);
    }
    try {
      const raw = await readFile(join(this.attachmentDirectory(workspaceId, sessionId, attachmentId), "metadata.json"), "utf8");
      const parsed = agentSessionAttachmentSchema.parse(JSON.parse(raw).attachment);
      if (parsed.workspaceId !== workspaceId || parsed.sessionId !== sessionId || parsed.id !== attachmentId) {
        throw new Error("Attachment metadata did not match the requested session");
      }
      return parsed;
    } catch {
      throw new AgentAttachmentError("Attachment was not found", 404);
    }
  }

  private requireSession(sessionId: string): AgentSession {
    const session = this.deps.sessionLookup.getSession(sessionId);
    if (!session) {
      throw new AgentAttachmentError("Agent session was not found", 404);
    }
    return session;
  }

  private sourcePath(workspaceId: string, sessionId: string, attachmentId: string): string {
    return join(this.attachmentDirectory(workspaceId, sessionId, attachmentId), "source");
  }

  private attachmentDirectory(workspaceId: string, sessionId: string, attachmentId: string): string {
    return join(this.sessionAttachmentDirectory(workspaceId, sessionId), attachmentId);
  }

  private sessionAttachmentDirectory(workspaceId: string, sessionId: string): string {
    return join(this.rootPath, workspaceId, sessionId);
  }
}

function agentAttachmentId(): string {
  return `attachment-${randomUUID()}`;
}

function normalizedImageContentType(value: string): AgentSessionAttachment["contentType"] | undefined {
  const normalized = value.toLowerCase().split(";")[0]?.trim();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp") {
    return normalized;
  }
  return undefined;
}

function matchesImageSignature(data: Buffer, contentType: AgentSessionAttachment["contentType"]): boolean {
  if (contentType === "image/png") {
    return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (contentType === "image/jpeg") {
    return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  }
  return data.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) &&
    data.subarray(8, 12).equals(Buffer.from([0x57, 0x45, 0x42, 0x50]));
}

function safeSourceName(value: string): string {
  const name = basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name.length > 0 ? name.slice(0, 160) : "attachment";
}
