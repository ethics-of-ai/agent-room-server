import { z } from "zod";

// Field grammars shared by every object kind. They live apart from
// `schemas.ts` so kind modules such as `pieceSchemas.ts` can use them without
// importing the schema module that imports them back.

export const sketchObjectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const sketchObjectIdSchema = z.string().regex(sketchObjectIdPattern, {
  message: "Object ids must match ^[a-z0-9][a-z0-9_-]{0,63}$"
});
export const sketchColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, {
    message: "Colors must be #RRGGBB or #RRGGBBAA"
  });

// An object of a kind outside `knownKinds`, kept verbatim. A malformed known
// kind fails the refinement, so it surfaces as a parse error. Each document
// version passes the kinds it defines.
export function unknownSketchObjectSchema(knownKinds: readonly string[]) {
  return z.object({ id: sketchObjectIdSchema, kind: z.string().min(1).max(64) }).passthrough().superRefine((object, context) => {
    if (knownKinds.includes(object.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Kind "${object.kind}" is a known kind and must match its strict schema`,
        path: ["kind"]
      });
    }
  });
}
