import {
  SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS,
  SKETCH_MAX_TOTAL_EXTRUDED_TEXT_CHARACTERS
} from "./limits";
import type { SketchTextBoxObject } from "./schemas";
import type { SketchTextParagraph, SketchTextSpan } from "./textBoxSchemas";

// Text box checks that need the text itself. Schemas bound each field; these
// tie the fields to the text they describe and cap extruded text, whose mesh
// cost grows with every glyph. Offsets and lengths count UTF-16 code units,
// the same unit as the text cap.

export type TextBoxFormatIssue =
  | { kind: "text_format"; message: string }
  | { kind: "extruded_text_characters"; message: string }
  | { kind: "total_extruded_text_characters"; message: string };

export function defaultTextParagraphs(text: string): SketchTextParagraph[] {
  return text.split("\n").map(() => ({ style: "body", alignment: "leading", list: "none" }));
}

export function checkTextBoxFormat(object: SketchTextBoxObject): TextBoxFormatIssue | null {
  const paragraphCount = object.text.split("\n").length;
  if (object.paragraphs.length !== paragraphCount) {
    return {
      kind: "text_format",
      message: `Text box "${object.id}" has ${paragraphCount} paragraph(s) of text but ${object.paragraphs.length} paragraph format(s)`
    };
  }
  const spanIssue = checkSpans(object.text, object.spans);
  if (spanIssue !== null) {
    return { kind: "text_format", message: `Text box "${object.id}" ${spanIssue}` };
  }
  if (object.rendering === "extruded" && object.text.length > SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS) {
    return {
      kind: "extruded_text_characters",
      message: `Extruded text box "${object.id}" has ${object.text.length} characters; the maximum is ${SKETCH_MAX_EXTRUDED_TEXT_CHARACTERS}`
    };
  }
  return null;
}

export function checkTotalExtrudedText(objects: SketchTextBoxObject[]): TextBoxFormatIssue | null {
  let total = 0;
  for (const object of objects) {
    if (object.rendering === "extruded") total += object.text.length;
  }
  if (total <= SKETCH_MAX_TOTAL_EXTRUDED_TEXT_CHARACTERS) return null;
  return {
    kind: "total_extruded_text_characters",
    message: `Extruded text boxes may hold at most ${SKETCH_MAX_TOTAL_EXTRUDED_TEXT_CHARACTERS} characters in a sketch (got ${total})`
  };
}

// Spans are sorted, disjoint, inside the text, never split a surrogate pair,
// and adjacent spans differ in their flags. Together these give each
// formatting exactly one encoding.
function checkSpans(text: string, spans: SketchTextSpan[]): string | null {
  let previous: SketchTextSpan | undefined;
  for (const [index, span] of spans.entries()) {
    const end = span.start + span.length;
    if (end > text.length) {
      return `span ${index} ends at ${end}, past the text's ${text.length} UTF-16 code units`;
    }
    if (splitsSurrogatePair(text, span.start) || splitsSurrogatePair(text, end)) {
      return `span ${index} splits a surrogate pair`;
    }
    if (previous !== undefined) {
      const previousEnd = previous.start + previous.length;
      if (span.start < previousEnd) {
        return `span ${index} overlaps or precedes the span before it`;
      }
      if (span.start === previousEnd && sameFlags(previous, span)) {
        return `span ${index} touches the span before it with the same formatting; merge them`;
      }
    }
    previous = span;
  }
  return null;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function sameFlags(left: SketchTextSpan, right: SketchTextSpan): boolean {
  return left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.strikethrough === right.strikethrough;
}
