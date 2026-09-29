import { z } from "zod";

/**
 * Convert a canonical zod input schema into the JSON Schema a catalog
 * definition advertises, so a tool's validator and its advertisement come
 * from one declaration.
 *
 * It covers only the constructs AgentRoom tool inputs use and throws on
 * anything else, so a schema change that this conversion cannot express fails
 * at module load rather than advertising a looser contract. Refinements are
 * not expressible in JSON Schema and stay with the validator: the handler
 * still rejects what the advertisement cannot describe.
 *
 * `maxLength` in JSON Schema counts code points while zod counts UTF-16 code
 * units, so the advertised bound is never tighter than the enforced one.
 */
export function advertisedJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind };
  const described = (json: Record<string, unknown>) =>
    schema.description ? { ...json, description: schema.description } : json;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return advertisedJsonSchema((schema as z.ZodEffects<z.ZodTypeAny>).innerType());
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return advertisedJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const inner = schema as z.ZodDefault<z.ZodTypeAny>;
      return { ...advertisedJsonSchema(inner.removeDefault()), default: inner._def.defaultValue() };
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const object = schema as z.AnyZodObject;
      if (object._def.unknownKeys !== "strict") {
        throw new Error("Advertised tool objects must be strict");
      }
      const shape = object.shape as Record<string, z.ZodTypeAny>;
      const required = Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key);
      return described({
        type: "object",
        properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, advertisedJsonSchema(value)])),
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false
      });
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const array = schema as z.ZodArray<z.ZodTypeAny>;
      return described({
        type: "array",
        items: advertisedJsonSchema(array.element),
        ...(array._def.minLength ? { minItems: array._def.minLength.value } : {}),
        ...(array._def.maxLength ? { maxItems: array._def.maxLength.value } : {})
      });
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const json: Record<string, unknown> = { type: "string" };
      for (const check of (schema as z.ZodString)._def.checks) {
        if (check.kind === "min") json.minLength = check.value;
        else if (check.kind === "max") json.maxLength = check.value;
        else if (check.kind === "regex") json.pattern = check.regex.source;
        else throw new Error(`Unsupported string check "${check.kind}" in an advertised tool schema`);
      }
      return described(json);
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const json: Record<string, unknown> = { type: "number" };
      for (const check of (schema as z.ZodNumber)._def.checks) {
        if (check.kind === "int") json.type = "integer";
        else if (check.kind === "min") json[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
        else if (check.kind === "max") json[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
        else throw new Error(`Unsupported number check "${check.kind}" in an advertised tool schema`);
      }
      return described(json);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return described({ type: "boolean" });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return described({ type: "string", enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] });
    default:
      throw new Error(`Unsupported zod type "${def.typeName}" in an advertised tool schema`);
  }
}
