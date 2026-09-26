import { z } from "zod";
import {
  SKETCH_MAX_EXTRUSION_DEPTH,
  SKETCH_MAX_TEXT_CHARACTERS,
  SKETCH_MAX_TEXT_FONT_SIZE,
  SKETCH_MAX_TEXT_SPANS,
  SKETCH_MIN_EXTRUSION_DEPTH,
  SKETCH_MIN_TEXT_FONT_SIZE
} from "./limits";

// Text box formatting. Bold, italic, underline and strikethrough sit on
// UTF-16 ranges; style, alignment and list sit on `\n`-separated paragraphs;
// family and size cover the whole box. Span flags are either `true` or
// absent, so each formatting has one encoding. The checks that need the text
// (paragraph count, span ranges, surrogate pairs, the merge rule) and the
// extruded caps live in `textBoxFormat.ts`.
// A version-3 text box may also hide its whole panel and show only its text.
// Planar shapes and version-2 text boxes keep the three visible choices.
export const sketchTextBoxAppearanceSchema = z.enum(["outline", "fill", "fillAndOutline", "none"]);
export const sketchTextFontFamilySchema = z.enum(["system", "rounded", "serif", "monospaced"]);
export const sketchTextFontSchema = z.object({
  family: sketchTextFontFamilySchema,
  size: z.number().finite().min(SKETCH_MIN_TEXT_FONT_SIZE).max(SKETCH_MAX_TEXT_FONT_SIZE)
}).strict();
export const sketchTextParagraphStyleSchema = z.enum(["title", "heading1", "heading2", "heading3", "body", "caption"]);
export const sketchTextAlignmentSchema = z.enum(["leading", "center", "trailing"]);
export const sketchTextListSchema = z.enum(["none", "bullet", "numbered"]);
export const sketchTextParagraphSchema = z.object({
  style: sketchTextParagraphStyleSchema,
  alignment: sketchTextAlignmentSchema,
  list: sketchTextListSchema
}).strict();
// One paragraph per `\n`-separated run of text, so at most one more than the
// character cap.
const textParagraphsSchema = z.array(sketchTextParagraphSchema).min(1).max(SKETCH_MAX_TEXT_CHARACTERS + 1);
export const sketchTextSpanSchema = z.object({
  start: z.number().int().min(0).max(SKETCH_MAX_TEXT_CHARACTERS),
  length: z.number().int().min(1).max(SKETCH_MAX_TEXT_CHARACTERS),
  bold: z.literal(true).optional(),
  italic: z.literal(true).optional(),
  underline: z.literal(true).optional(),
  strikethrough: z.literal(true).optional()
}).strict().refine(
  (span) => span.bold === true || span.italic === true || span.underline === true || span.strikethrough === true,
  { message: "A span must set at least one of bold, italic, underline or strikethrough" }
);
const textSpansSchema = z.array(sketchTextSpanSchema).max(SKETCH_MAX_TEXT_SPANS);
export const sketchTextRenderingSchema = z.enum(["flat", "extruded"]);
const extrusionDepthSchema = z.number().finite().min(SKETCH_MIN_EXTRUSION_DEPTH).max(SKETCH_MAX_EXTRUSION_DEPTH);

// Stored text boxes carry every formatting field. Creates and updates may
// leave any of them out: a create fills the defaults when it applies, which
// keeps a version-2 request's fingerprint unchanged after migration.
export const textBoxFormatFields = {
  font: sketchTextFontSchema,
  paragraphs: textParagraphsSchema,
  spans: textSpansSchema,
  rendering: sketchTextRenderingSchema,
  extrusionDepth: extrusionDepthSchema
} as const;
export const textBoxFormatOptionalFields = {
  font: sketchTextFontSchema.optional(),
  paragraphs: textParagraphsSchema.optional(),
  spans: textSpansSchema.optional(),
  rendering: sketchTextRenderingSchema.optional(),
  extrusionDepth: extrusionDepthSchema.optional()
} as const;
export const SKETCH_TEXT_BOX_FORMAT_KEYS = ["font", "paragraphs", "spans", "rendering", "extrusionDepth"] as const;

export type SketchTextBoxAppearance = z.infer<typeof sketchTextBoxAppearanceSchema>;
export type SketchTextFont = z.infer<typeof sketchTextFontSchema>;
export type SketchTextParagraph = z.infer<typeof sketchTextParagraphSchema>;
export type SketchTextSpan = z.infer<typeof sketchTextSpanSchema>;
