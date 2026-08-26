import { objectValue, stringValue } from "../shared/jsonValues";

/** Maximum shell-output bytes the host forwards for one Cursor run. */
export const MAX_CURSOR_FORWARDED_DELTA_BYTES_PER_RUN = 256 * 1024;

export interface CursorShellDelta {
  data: string;
  stream?: "stdout" | "stderr";
  callId?: string;
}

/**
 * Read both the SDK's real oneof shape and the normalized host wire shape.
 * SDK 1.0.28 emits `{ event: { case, value: { data } } }`; the host reduces
 * that to `{ stream, data }` before it crosses stdio.
 */
export function decodeCursorShellDelta(update: unknown): CursorShellDelta | undefined {
  const object = objectValue(update);
  if (!object || stringValue(object.type) !== "shell-output-delta") return undefined;

  const event = objectValue(object.event);
  const eventValue = objectValue(event?.value);
  const data =
    stringValue(object.data) ??
    stringValue(eventValue?.data) ??
    stringValue(event?.output) ??
    stringValue(event?.text);
  if (!data) return undefined;

  const rawStream = stringValue(object.stream) ?? stringValue(event?.case);
  const stream = rawStream === "stdout" || rawStream === "stderr" ? rawStream : undefined;
  const callId = stringValue(object.callId) ?? stringValue(event?.callId) ?? stringValue(eventValue?.callId);
  return { data, ...(stream ? { stream } : {}), ...(callId ? { callId } : {}) };
}

/** Normalize one delta and trim its text to the remaining per-run byte budget. */
export function boundedCursorShellDelta(
  update: unknown,
  remainingBytes: number
): { update: Record<string, unknown>; bytes: number } | undefined {
  const decoded = decodeCursorShellDelta(update);
  if (!decoded || remainingBytes <= 0) return undefined;
  const data = boundedUtf8Prefix(decoded.data, remainingBytes);
  if (data.length === 0) return undefined;
  return {
    update: {
      type: "shell-output-delta",
      ...(decoded.callId ? { callId: decoded.callId } : {}),
      ...(decoded.stream ? { stream: decoded.stream } : {}),
      data
    },
    bytes: Buffer.byteLength(data, "utf8")
  };
}

function boundedUtf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maxBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return text.slice(0, end);
}
