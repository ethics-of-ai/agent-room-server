import { basename } from "node:path";
import { objectValue, stringValue } from "../shared/jsonValues";

export function codexExecJsonOutput(args: string[]): boolean {
  return args.includes("--json");
}

export function codexTextOutputFilter(executable: string | undefined, args: string[]): CodexExecTextOutputFilter {
  const executableName = executable ? basename(executable) : "";
  const enabled = !codexExecJsonOutput(args) && /^codex(?:-|$)/.test(executableName);
  return new CodexExecTextOutputFilter(enabled);
}

export class CodexExecTextOutputFilter {
  private buffer = "";
  private sawCodexPreamble = false;
  private inAssistantSection = false;
  private suppressRemaining = false;

  constructor(readonly enabled: boolean) {}

  append(chunk: string): string[] {
    if (!this.enabled) return [chunk];

    const messages: string[] = [];
    this.buffer += chunk;
    let start = 0;
    let index = this.buffer.indexOf("\n", start);
    while (index >= 0) {
      const message = this.processLine(this.buffer.slice(start, index), true);
      if (message !== undefined) messages.push(message);
      start = index + 1;
      index = this.buffer.indexOf("\n", start);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return messages;
  }

  flush(): string[] {
    if (!this.enabled || this.buffer.length === 0) return [];

    const message = this.processLine(this.buffer, false);
    this.buffer = "";
    return message === undefined ? [] : [message];
  }

  private processLine(line: string, hasNewline: boolean): string | undefined {
    if (this.suppressRemaining) return undefined;

    const trimmed = line.trim();
    if (isCodexTextMetadataLine(trimmed)) {
      this.sawCodexPreamble = true;
      if (isCodexTokenUsageLine(trimmed)) {
        this.inAssistantSection = false;
        this.suppressRemaining = true;
      }
      return undefined;
    }

    if (isCodexTextRoleLine(trimmed)) {
      this.sawCodexPreamble = true;
      this.inAssistantSection = true;
      return undefined;
    }

    if (this.sawCodexPreamble && !this.inAssistantSection) {
      return undefined;
    }

    if (!this.inAssistantSection && trimmed.length === 0) {
      return undefined;
    }

    return hasNewline ? `${line}\n` : line;
  }
}

export function assistantTextFromCodexExecJsonLine(line: string, hasEmittedAssistantContent: boolean): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  const object = objectValue(event);
  if (!object) return undefined;

  const type = stringValue(object.type);
  const method = stringValue(object.method);
  if (method === "item/agentMessage/delta") {
    return textFromCodexJsonValue(objectValue(object.params)?.delta);
  }

  if (type === "agent_message_content_delta") {
    return textFromCodexJsonFields(object, ["delta", "text", "content", "message"]);
  }

  if (type === "agent_message") {
    return textFromCodexJsonFields(object, ["message", "content", "text"]);
  }

  if (type === "task_complete" || type === "turn.completed" || type === "turn_complete") {
    if (hasEmittedAssistantContent) return undefined;
    return textFromCodexJsonFields(object, [
      "last_agent_message",
      "lastAgentMessage",
      "message",
      "content",
      "text"
    ]);
  }

  return undefined;
}

function textFromCodexJsonFields(object: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const text = textFromCodexJsonValue(object[field]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function textFromCodexJsonValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    const text = value.flatMap((item) => {
      const part = textFromCodexJsonValue(item);
      return part === undefined ? [] : [part];
    }).join("");
    return text.length > 0 ? text : undefined;
  }

  const object = objectValue(value);
  if (!object) return undefined;
  return textFromCodexJsonFields(object, ["text", "output_text", "outputText", "content", "message"]);
}

function isCodexTextRoleLine(value: string): boolean {
  return value === "codex" || value === "assistant";
}

function isCodexTokenUsageLine(value: string): boolean {
  return value === "tokens used" || value === "token usage";
}

function isCodexTextMetadataLine(value: string): boolean {
  if (!value) return false;
  if (isCodexTokenUsageLine(value)) return true;
  if (/^-{3,}$/.test(value)) return true;
  return [
    "Reading prompt from stdin...",
    "OpenAI Codex"
  ].some((prefix) => value.startsWith(prefix)) ||
    [
      "workdir:",
      "model:",
      "provider:",
      "approval:",
      "sandbox:",
      "reasoning summaries:"
    ].some((prefix) => value.startsWith(prefix));
}
