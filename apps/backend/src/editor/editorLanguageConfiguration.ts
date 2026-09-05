import { createScanner, LanguageVariant, parseConfigFileTextToJson, ScriptTarget, SyntaxKind } from "typescript";
import { z } from "zod";

const pair = z.tuple([z.string(), z.string()]);
const pattern = z.union([z.string(), z.object({ pattern: z.string(), flags: z.string().optional() })]);
const closingPair = z.union([pair, z.object({
  open: z.string(), close: z.string(), notIn: z.array(z.string()).optional()
})]);

// Unknown fields remain data for future configurations. Validate every field
// consumed by the bundled converter; the complete JSON also has a depth cap.
export const editorLanguageConfigurationSchema = z.object({
  comments: z.object({ lineComment: z.string().optional(), blockComment: pair.optional() }).optional(),
  brackets: z.array(pair).optional(),
  colorizedBracketPairs: z.array(pair).optional(),
  autoClosingPairs: z.array(closingPair).optional(),
  surroundingPairs: z.array(closingPair).optional(),
  autoCloseBefore: z.string().optional(),
  wordPattern: pattern.optional(),
  indentationRules: z.object({
    increaseIndentPattern: pattern, decreaseIndentPattern: pattern,
    indentNextLinePattern: pattern.optional(), unIndentedLinePattern: pattern.optional()
  }).optional(),
  folding: z.object({
    offSide: z.boolean().optional(),
    markers: z.object({ start: pattern, end: pattern }).optional()
  }).optional(),
  onEnterRules: z.array(z.object({
    beforeText: pattern, afterText: pattern.optional(), previousLineText: pattern.optional(),
    action: z.object({
      indent: z.enum(["none", "indent", "indentOutdent", "outdent"]),
      appendText: z.string().optional(), removeText: z.number().int().nonnegative().optional()
    })
  })).optional()
}).passthrough();

/** Use the already-bundled TypeScript JSONC parser, including its syntax errors. */
export function parseLanguageConfiguration(text: string): unknown {
  // The configuration parser treats an empty file as {}; the web client's
  // JSONC reader requires an actual object. Skip comments without altering strings.
  const scanner = createScanner(ScriptTarget.Latest, true, LanguageVariant.Standard, text);
  if (scanner.scan() !== SyntaxKind.OpenBraceToken) throw new Error("Language configuration must contain an object");
  const result = parseConfigFileTextToJson("language-configuration.json", text);
  if (result.error) throw new Error("Language configuration must be valid JSON or JSONC");
  return result.config as unknown;
}
