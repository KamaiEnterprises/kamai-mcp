import { z } from "zod";

import {
  BLUEPRINT_IDS_GUIDE,
  CATEGORY_GUIDE,
  CLASS_GUIDE,
  HANDING_GUIDE,
  IN_FOLDER_GUIDE,
  NAME_CONTAINS_GUIDE,
  PROJECT_ID_GUIDE,
  RELATED_TO_GUIDE,
  SUB_CLASS_GUIDE,
  TAG_GUIDE,
  WHERE_GUIDE,
} from "./descriptions.ts";
import { vocabulary } from "./vocabulary.ts";

// A ref is `s<sheet hash>:<local id>`, the handle every query row carries.
export const REF_RE = /^s[0-9a-f]{4,16}:.{1,200}$/;
// A selection token minted by the API layer: q1 for count/find, w1 for wall surface.
export const SELECTION_RE = /^[qw]1\.[A-Za-z0-9_-]{1,4092}$/;

export const selectionSchema = z.string().regex(SELECTION_RE);

export const scopeShape = {
  project_id: z.string().min(1).optional().describe(PROJECT_ID_GUIDE),
  blueprint_ids: z.array(z.string().min(1)).min(1).max(25).optional().describe(BLUEPRINT_IDS_GUIDE),
};

// The API layer decides which sheets a project-wide room or wall query reads;
// kamai-mcp only asks for it. "auto" is always sent: explicit blueprint_ids, a discipline filter
// or a non-room query come back unchanged with a reason.
export const ROOM_SCOPE = "auto";

/** The filter fields of a query tool, their enums taken from Kamai's vocabulary as it is now. */
export const filterShape = (v = vocabulary()) => ({
  category: z.enum(v.categories).optional().describe(CATEGORY_GUIDE),
  class: z.array(z.enum(v.classes)).min(1).max(8).optional().describe(CLASS_GUIDE),
  sub_class: z.array(z.enum(v.sub_classes)).min(1).max(15).optional().describe(SUB_CLASS_GUIDE),
  name_contains: z.string().min(1).max(200).optional().describe(NAME_CONTAINS_GUIDE),
  tag: z.array(z.string().min(1).max(100)).min(1).max(100).optional().describe(TAG_GUIDE),
  in_folder: z.string().min(1).max(200).optional().describe(IN_FOLDER_GUIDE),
  handing: z.array(z.enum(v.handing)).min(1).max(4).optional().describe(HANDING_GUIDE),
  related_to: z.array(z.string().regex(REF_RE)).min(1).max(50).optional().describe(RELATED_TO_GUIDE),
  where: z.union([z.record(z.string(), z.unknown()), z.string().max(8192)]).optional().describe(WHERE_GUIDE),
});

const FILTER_KEYS = Object.keys(filterShape()) as Array<keyof ReturnType<typeof filterShape>>;

const COMBINATOR: Record<string, string> = { any: "any", anyof: "any", or: "any", all: "all", allof: "all", and: "all" };
const FIELD_ALIAS: Record<string, string> = { id: "ref" };

/** Coerce the `where` shapes models actually send into the one the API takes, instead
 * of refusing them: each refusal costs a whole model round trip over the full context.
 *
 * Applied at every nested node. A JSON string is parsed (a double-encoded filter); `{}`, `[]` and
 * `""` mean no filter (undefined); `anyOf` / `or` / `ALL` / `and` and the like become
 * `any` / `all`, at any depth: inside `any`, `all`, `not`, `related.match`, `related.via`
 * and `spatial.of`. A leaf keyed `name` instead of `field` gets `field`, and field `id`
 * (which the grammar has no other meaning for) becomes `ref`; a bare element id is then
 * refused by the grammar with what a ref looks like. Anything else passes through
 * untouched for the API's grammar to judge: this fixes shapes, never meaning. Two keys
 * that would land on one combinator ({any, or}) keep their own names, so the grammar
 * refuses the node instead of one branch silently replacing the other. A string
 * that is not JSON is passed through as it is, so the grammar can say what is wrong with it. */
export function repairWhere(where: unknown): unknown {
  if (typeof where === "string") {
    const trimmed = where.trim();
    if (!trimmed) return undefined;
    try {
      where = JSON.parse(trimmed);
    } catch {
      return where;
    }
  }
  if (Array.isArray(where) && where.length === 0) return undefined;
  if (isRecord(where) && Object.keys(where).length === 0) return undefined;
  return repairNode(where);
}

function repairNode(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  const canonOf = (key: string) => COMBINATOR[key.toLowerCase()] ?? key;
  const keys = Object.keys(node);
  for (const [key, value] of Object.entries(node)) {
    const canon = canonOf(key);
    out[keys.filter((k) => canonOf(k) === canon).length > 1 ? key : canon] = value;
  }
  if ("op" in out && !("field" in out) && typeof out.name === "string") {
    out.field = out.name;
    delete out.name;
  }
  if (typeof out.field === "string") out.field = FIELD_ALIAS[out.field.toLowerCase()] ?? out.field;
  for (const combo of ["any", "all"]) {
    const parts = out[combo];
    if (Array.isArray(parts)) out[combo] = parts.map(repairNode);
  }
  if ("not" in out) out.not = repairNode(out.not);
  if (isRecord(out.related)) {
    const related = { ...out.related };
    if ("match" in related) related.match = repairNode(related.match);
    if ("via" in related) related.via = repairNode(related.via);
    out.related = related;
  }
  if (isRecord(out.spatial)) {
    const spatial = { ...out.spatial };
    if ("of" in spatial) spatial.of = repairNode(spatial.of);
    out.spatial = spatial;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The filter fields of a tool call as the API's filter body: only what was
 * given, with `where` repaired and dropped when it means no filter. */
export function filterBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (key === "where") {
      const repaired = repairWhere(value);
      if (repaired !== undefined) body.where = repaired;
      continue;
    }
    body[key] = value;
  }
  return body;
}
