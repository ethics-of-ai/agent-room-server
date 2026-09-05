import type { LanguageServicePosition, LanguageServiceRange } from "../../domain/languageService";

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function clampUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  // If the first excluded byte is a continuation byte, the byte ceiling split
  // one scalar. Back up to that scalar's leading byte before decoding.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

export function validPosition(text: string, position: LanguageServicePosition): boolean {
  const lines = text.split("\n");
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)) return false;
  if (position.line < 0 || position.line >= lines.length || position.character < 0) return false;
  const line = lines[position.line].endsWith("\r") ? lines[position.line].slice(0, -1) : lines[position.line];
  // JavaScript string lengths count UTF-16 code units, which is exactly LSP's
  // frozen coordinate space. A surrogate pair therefore advances by two, but
  // a position between its high and low surrogates is not a text boundary.
  if (position.character > line.length) return false;
  if (position.character > 0 && position.character < line.length) {
    const previous = line.charCodeAt(position.character - 1);
    const current = line.charCodeAt(position.character);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return false;
  }
  return true;
}

export function comparePositions(left: LanguageServicePosition, right: LanguageServicePosition): number {
  return left.line - right.line || left.character - right.character;
}

export function validRange(text: string, range: LanguageServiceRange): boolean {
  return validPosition(text, range.start)
    && validPosition(text, range.end)
    && comparePositions(range.start, range.end) <= 0;
}
