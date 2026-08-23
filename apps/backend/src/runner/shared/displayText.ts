import { objectValue } from "./jsonValues";

export function displayTextValue(value: unknown): string | undefined {
  if (typeof value === "string") return compactDisplayText(value);
  if (typeof value === "number" || typeof value === "boolean") return compactDisplayText(String(value));
  if (Array.isArray(value)) {
    const parts = value.flatMap((item) => {
      const text = displayTextValue(item);
      return text ? [text] : [];
    });
    return parts.length > 0 ? compactDisplayText(parts.join(" ")) : undefined;
  }
  const object = objectValue(value);
  if (object) {
    return stringFromFields(object, ["command", "cmd", "query", "path", "pattern", "name", "type", "input", "inputText"]);
  }
  return undefined;
}

function stringFromFields(object: Record<string, unknown> | undefined, fields: string[]): string | undefined {
  if (!object) return undefined;
  for (const field of fields) {
    const value = displayTextValue(object[field]);
    if (value) return value;
  }
  return undefined;
}

export function compactDisplayText(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/g, " ").trim();
  if (!compacted) return undefined;
  return compacted.slice(0, 500);
}
