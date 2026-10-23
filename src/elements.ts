import { z } from "zod";

import { geometryPageSchema, type GeometryFeature, type GeometryPage } from "./api.ts";

// view_takeoff answers "how many doors"; this answers "which doors, where, and how big".
// The whole reason the tool exists is that the geometry the blueprint widget draws was
// never reachable as data — a user who wanted a shape had to read it off the picture.
//
// Two limits, because a row with geometry and a row without are not the same size — and a
// row count alone cannot bound either. `text()` in server.ts emits the payload TWICE, once
// JSON-escaped inside content[0].text and again as structuredContent, so the tool result
// is about twice the page; the ~150k-character ceiling past which a host writes the result
// to the sandbox instead of rendering it is on that whole result.
// Measured end to end through an in-memory MCP client at 60-point rings: 50 rows is 69k
// characters, 100 rows is 137k, 150 rows is 205k and never renders. And ring length is
// whatever tracing produced — the route quantises to the grid and drops repeated points
// but never simplifies — so 50 rows of 500-point rings is 466k. A row count is therefore
// only the coarse limit. RESULT_BUDGET below is the one that actually holds.
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 400;
export const GEOMETRY_PAGE_MAX = 100;

// Ceiling on the whole tool result, both copies, with room for the envelope and notes.
// Rows past it are dropped from the end of the page and the drop is reported in `notes`.
export const RESULT_BUDGET = 140_000;
const ENVELOPE_RESERVE = 6_000;
const ELEMENT_BUDGET = RESULT_BUDGET - ENVELOPE_RESERVE;

/** A caller mistake whose message is already the fix. Distinguished from anything else
 * this module can throw so server.ts can pass it through instead of flattening it into
 * the generic "something went wrong on the Kamai side". */
export class BadArgument extends Error {}

export const elementSchema = z.object({
  i: z.number().describe("The element's index on the sheet. Stable within one blueprint."),
  id: z
    .string()
    .nullish()
    .describe("Blueprint-local id. Pass this to update_elements, move_elements, or create_folder. Do not show it to the user unless they ask."),
  cls: z
    .string()
    .describe("Class from Kamai's taxonomy: room, wall, door, window, opening, a fixture type, or Unclassified."),
  folder: z
    .string()
    .nullable()
    .describe("The group the user filed this element under in the drawing, or null if it sits outside the tree."),
  name: z.string().describe("The element's display name on the drawing."),
  area: z
    .number()
    .nullable()
    .describe("Measured area in `units.area`. Null for a line or a point, and null for everything when `needs_scale` is true."),
  len: z
    .number()
    .nullable()
    .describe("Measured length in `units.length`. Null for an area or a point, and null for everything when `needs_scale` is true."),
  rings: z
    .array(z.array(z.number()))
    .nullish()
    .describe("Closed polygon outlines, each a flat [x0,y0,x1,y1,...] run of drawing-space integers. Absent when include_geometry is false."),
  lines: z
    .array(z.array(z.number()))
    .nullish()
    .describe("Open paths, same flat [x0,y0,...] form as rings. Absent when include_geometry is false."),
  pts: z
    .array(z.number())
    .nullish()
    .describe("Point positions, flat [x0,y0,...]. Absent when include_geometry is false."),
});

export const listElementsOutput = z.object({
  blueprint_id: z.string(),
  blueprint_name: z.string().nullable().describe("Call the blueprint this in your reply, not by its id."),
  project_id: z.string(),
  project_name: z.string(),
  state: geometryPageSchema.shape.state,
  grid: z
    .number()
    .describe("Width of the drawing space every coordinate is expressed in. The page spans 0..grid horizontally; y uses the same scale and runs past grid on a portrait sheet."),
  units: geometryPageSchema.shape.units,
  scale_label: z.string().nullable(),
  needs_scale: z
    .boolean()
    .describe("True when the blueprint has no scale, in which case every area and len is null. Do not derive measurements from the coordinates instead."),
  scale_unconfirmed: z
    .boolean()
    .describe("True when a scale exists but nobody has confirmed it, so the measurements are provisional."),
  elements: z.array(elementSchema),
  returned: z
    .number()
    .describe("Elements in this response. Never assume it is the whole blueprint — check `truncated`. It can be smaller than `limit` even mid-blueprint, because a page of outlines is also held to a size budget."),
  total: z
    .number()
    .describe("Rows in the blueprint's source collection. Higher than the number of elements you can ever receive: the folder rows of the drawing's hierarchy are counted here but carry no shape and are never returned."),
  truncated: z.boolean().describe("True when this response is not the whole answer, whether or not `next_cursor` can reach the rest."),
  next_cursor: z
    .string()
    .nullable()
    .describe("Pass back as `cursor` for the next page, together with the identical cls, folder and name. A filtered cursor is an offset into that one filter's matches and is refused if the filter changes. Null when there is no reachable next page."),
  filtered: z.boolean(),
  matched: z
    .number()
    .nullable()
    .describe("Elements on the blueprint matching the filter, counted by Kamai over the whole sheet. Null when no filter was given, or while the blueprint is not ready."),
  filter_scanned: z
    .number()
    .nullable()
    .describe("Rows Kamai examined for the filter: every row on the blueprint. Null when no filter was given."),
  filter_complete: z
    .boolean()
    .nullable()
    .describe("True when a filter was given: Kamai checks every row on the blueprint. Null when no filter was given."),
  geometry_included: z.boolean(),
  notes: z
    .array(z.string())
    .describe("Caveats about this exact response — truncation, an unread tail, a missing scale. Read them before describing the blueprint to the user."),
});

export type Element = z.infer<typeof elementSchema>;
export type ListElementsPage = z.infer<typeof listElementsOutput>;

export type ListElementsArgs = {
  cls?: string;
  folder?: string;
  name?: string;
  include_geometry?: boolean;
  limit?: number;
  cursor?: string;
};

export type GeometryFilter = { cls?: string; folder?: string; name?: string };

export type FetchGeometry = (limit: number, cursor?: string, filter?: GeometryFilter) => Promise<GeometryPage>;

function toElement(feature: GeometryFeature, includeGeometry: boolean): Element {
  const row: Element = {
    i: feature.i,
    cls: feature.cls,
    folder: feature.folder ?? null,
    name: feature.name,
    area: feature.area ?? null,
    len: feature.len ?? null,
  };
  if (feature.id) row.id = feature.id;
  // Omitted, not nulled, when geometry was declined: three null keys per row is pure
  // payload, and `geometry_included` already says why they are gone.
  if (includeGeometry) {
    row.rings = feature.rings ?? null;
    row.lines = feature.lines ?? null;
    row.pts = feature.pts ?? null;
  }
  return row;
}

/** What one row costs the host: its own JSON, plus that JSON escaped into the text copy,
 * plus the separators. Both copies are counted because server.ts sends both. */
function rowCost(row: Element): number {
  const json = JSON.stringify(row);
  return json.length + JSON.stringify(json).length + 2;
}

/** How many rows of this page fit the budget. Never zero: a page with nothing in it
 * answers nothing, and a single oversized row is reported rather than silently dropped. */
function fitToBudget(rows: Element[]): number {
  let spent = 0;
  for (let n = 0; n < rows.length; n += 1) {
    spent += rowCost(rows[n]!);
    if (spent > ELEMENT_BUDGET) return Math.max(n, 1);
  }
  return rows.length;
}

/** Where an unfiltered page must resume after the budget dropped rows the route already
 * read. The route pages by a plain row offset and `i` is the row's index in that same
 * collection, but that is its business, not a contract — so an offset is only minted when
 * this exact response proves the shape: an offset cursor in, an offset cursor back out,
 * rows indexed at or past where we started, and a resume point inside the window the route
 * says it read. Short of that proof it returns null and the caller asks the route for the
 * smaller page, rather than inventing a cursor that quietly loses the rows in between. */
function resumeAfterRow(page: GeometryPage, cursor: string | undefined, lastRow: number): string | null {
  const offset = cursor === undefined ? 0 : /^\d+$/.test(cursor) ? Number(cursor) : null;
  if (offset === null) return null;
  const first = page.features[0]?.i;
  if (first === undefined || first < offset) return null;
  const next = page.next_cursor;
  if (!next || !/^\d+$/.test(next)) return null;
  const resume = lastRow + 1;
  return resume > offset && resume <= Number(next) ? String(resume) : null;
}

/** The filters as the route takes them: only those given. The route applies them to the
 * whole sheet and refuses a blank one or a cursor from another filter with a fix message. */
function filterQuery(args: ListElementsArgs): GeometryFilter | undefined {
  const filter: GeometryFilter = {};
  if (args.cls !== undefined) filter.cls = args.cls;
  if (args.folder !== undefined) filter.folder = args.folder;
  if (args.name !== undefined) filter.name = args.name;
  return Object.keys(filter).length ? filter : undefined;
}

export async function buildElementsPage(
  fetchPage: FetchGeometry,
  args: ListElementsArgs,
): Promise<ListElementsPage> {
  const geometryIncluded = args.include_geometry ?? true;
  const requested = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const limit = geometryIncluded ? Math.min(requested, GEOMETRY_PAGE_MAX) : requested;
  const filter = filterQuery(args);
  const filtered = filter !== undefined;

  const notes: string[] = [];
  let head = await fetchPage(limit, args.cursor, filter);
  // A route without the filter answers an unfiltered page, which must never read as the
  // matches.
  if (filtered && head.state === "ready" && typeof head.matched !== "number") {
    throw new Error("geometry route did not apply the cls/folder/name filter");
  }
  let elements = head.features.map((f) => toElement(f, geometryIncluded));
  let truncated = head.truncated;
  let nextCursor = head.next_cursor ?? null;
  let budgetDropped = 0;

  const fit = fitToBudget(elements);
  if (fit < elements.length) {
    budgetDropped = elements.length - fit;
    const resume = filtered ? null : resumeAfterRow(head, args.cursor, elements[fit - 1]!.i);
    if (resume !== null) {
      elements = elements.slice(0, fit);
    } else {
      // No cursor of the route's that resumes where this page now stops, and minting one
      // by guesswork is how a caller silently loses rows. Ask for the smaller page and
      // let the route mint its own.
      head = await fetchPage(fit, args.cursor, filter);
      elements = head.features.map((f) => toElement(f, geometryIncluded));
    }
    truncated = true;
    nextCursor = resume ?? head.next_cursor ?? null;
  }
  const matched = filtered ? (head.matched ?? null) : null;

  if (head.state === "failed") {
    notes.push("This blueprint failed to process, so Kamai holds no elements for it.");
  } else if (head.state === "processing") {
    notes.push("This blueprint is still being processed, so it has no elements yet. Try again shortly.");
  }

  if (head.needs_scale) {
    notes.push(
      "This blueprint has no scale set, so every area and len is null. Tell the user the " +
        "measurements are unavailable until a scale is set — do not estimate them from the " +
        "coordinates, which are drawing space, not metres.",
    );
  } else if (head.scale_unconfirmed) {
    notes.push(
      "The scale on this blueprint has not been confirmed, so every area and length is " +
        "provisional. Say so when you quote one.",
    );
  }

  if (!geometryIncluded) {
    notes.push(
      "Geometry was not requested, so rings, lines and pts are absent. Call list_elements " +
        "again with include_geometry true to get the shapes themselves.",
    );
  }

  if (geometryIncluded && requested > GEOMETRY_PAGE_MAX) {
    notes.push(
      `limit was reduced from ${requested} to ${GEOMETRY_PAGE_MAX} because geometry was ` +
        "included; a larger page of outlines does not survive the host's result-size limit. " +
        "Page through with the cursor, or set include_geometry false for a longer list.",
    );
  }

  if (budgetDropped > 0) {
    notes.push(
      `${budgetDropped} element(s) this page had room for were left out of it to keep the ` +
        `response under ~${RESULT_BUDGET} characters, which is the point past which a host ` +
        `stops delivering a tool result to the model. Outlines are what make a row big: ` +
        `follow the cursor for the rest, or call again with include_geometry false.`,
    );
  }

  if (geometryIncluded && elements.length === 1 && rowCost(elements[0]!) > ELEMENT_BUDGET) {
    notes.push(
      "This single element's outline is on its own larger than the result-size budget, so " +
        "this response may not reach the model at all. Call list_elements again with " +
        "include_geometry false to get its class, name and measurements without the shape.",
    );
  }

  if (truncated) {
    notes.push(
      nextCursor
        ? `This is a partial list: ${elements.length} element(s) here, and this is not the whole ` +
            `blueprint. Call list_elements again with cursor "${nextCursor}" and the same ` +
            `arguments before you describe what the blueprint contains.`
        : "This is a partial list and there is no cursor that reaches the rest. Do not present " +
            "it as everything on the blueprint.",
    );
  }

  return {
    blueprint_id: head.blueprint_id,
    blueprint_name: head.name ?? null,
    project_id: head.project_id,
    project_name: head.project_name,
    state: head.state,
    grid: head.grid,
    units: head.units,
    scale_label: head.scale_label ?? null,
    needs_scale: head.needs_scale,
    scale_unconfirmed: head.scale_unconfirmed,
    elements,
    returned: elements.length,
    total: head.total,
    truncated,
    next_cursor: nextCursor,
    filtered,
    matched,
    filter_scanned: filtered ? head.total : null,
    filter_complete: filtered ? true : null,
    geometry_included: geometryIncluded,
    notes,
  };
}
