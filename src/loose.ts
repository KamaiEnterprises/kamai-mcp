import type { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

// registerAppTool types its outputSchema as a Standard JSON Schema, which zod 4.1's own
// typings do not declare although the SDK serialises a ZodObject the same way at run
// time. Spelled from the function's own parameter type so it cannot drift.
type AppToolSchema = NonNullable<Parameters<typeof registerAppTool>[2]["outputSchema"]>;
type StandardWithJson = Extract<AppToolSchema, { readonly "~standard": unknown }>;
export type AdvertisedSchema = z.ZodObject & StandardWithJson;

/** A copy of `schema` that accepts unknown keys at every depth, for ADVERTISING as an
 * outputSchema.
 *
 * A plain z.object() converts to JSON Schema with `additionalProperties: false`, and a
 * client that validates structuredContent against the advertised schema (Open WebUI's
 * bridge, the Python SDK) then rejects any field the API layer added after this server
 * was deployed. Strict clients also keep a descriptor pinned for the life of a
 * conversation, so a closed schema turns every additive backend change into a broken
 * tool. What the tool actually emits is unaffected: widgetResult still parses with the
 * closed schema, so no structuredContent gains a field from this.
 *
 * Walks objects, arrays, optionals, nullables, records and unions; anything else is
 * returned as it is. Descriptions are carried over. */
export function deepLoose<T extends z.ZodType>(schema: T): z.ZodType {
  const out = loosen(schema);
  const description = schema.description;
  return description && out !== schema ? out.describe(description) : out;
}

function loosen(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      shape[key] = deepLoose(value);
    }
    return z.looseObject(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(deepLoose(schema.element as z.ZodType));
  if (schema instanceof z.ZodOptional) return deepLoose(schema.unwrap() as z.ZodType).optional();
  if (schema instanceof z.ZodNullable) return deepLoose(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodRecord) {
    return z.record(schema.keyType as z.ZodString, deepLoose(schema.valueType as z.ZodType));
  }
  if (schema instanceof z.ZodUnion) {
    const options = (schema.options as readonly z.ZodType[]).map((option) => deepLoose(option));
    return z.union(options as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  return schema;
}

/** deepLoose for the top-level object a tool advertises. Kept as a ZodObject (not its
 * shape) so the SDK does not re-wrap it in a closed z.object(). */
export function looseOutput(schema: z.ZodObject): AdvertisedSchema {
  return deepLoose(schema) as AdvertisedSchema;
}
