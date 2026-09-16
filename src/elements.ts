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

// The geometry endpoint's own ceiling. It loads the whole feature collection on every
// call and then slices, so one big page costs it strictly less than five small ones.
export const SCAN_PAGE = 2000;
// A filter scan is bounded so a pathological sheet cannot turn one tool call into an
// unbounded read. Hitting it is reported, never swallowed.
export const MAX_SCAN_PAGES = 5;

// That scan is the expensive thing this tool does: the route assembles the whole feature
// collection, measuring every feature, before it slices, so one filtered call is up to
// five full assemblies and paging through 20 pages of matches would be a hundred of
// them. The scan is therefore held for a minute, keyed by the caller's own scope (see
// buildElementsPage's `scope`), which turns those 20 pages into one scan. One minute
// because it is long enough to cover a model paging through a listing and short enough
// that an edit in the app shows up in the next question rather than the next session;
// the unfiltered path never reads it.
export const SCAN_CACHE_TTL_MS = 60_000;
const SCAN_CACHE_MAX = 2;

// Filtered listings count matches; unfiltered ones count rows on the sheet. The two are
// not interchangeable, so a filtered cursor is prefixed AND carries a fingerprint of the
// filter that made it: an offset into "the doors" means nothing in "the windows", and
// replaying one against another filter silently answers a question nobody asked.
const MATCH_CURSOR = "m:";

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
    .describe("Elements matching the filter across everything the filter read. Null when no filter was given, and a floor rather than a count when `filter_complete` is false."),
  filter_scanned: z
    .number()
    .nullable()
    .describe("Rows the filter actually examined. Null when no filter was given."),
  filter_complete: z
    .boolean()
    .nullable()
    .describe("True only when the filter examined every row on the blueprint. False means elements exist that were never checked. Null when no filter was given."),
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

export type FetchGeometry = (limit: number, cursor?: string) => Promise<GeometryPage>;

// The filter as it is actually applied: trimmed and lower-cased once, here, rather than
// per row per field over ten thousand rows. `null` means "not filtering on this", which a
// blank string is not — a whitespace-only value passes the schema's .min(1), matches every
// row, and would otherwise buy a five-page scan to filter nothing.
type Filters = { cls: string | null; folder: string | null; name: string | null };

function needle(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new BadArgument(
      `\`${field}\` was only whitespace. Pass the text to match — "door", "Apartment 5" — or ` +
        `leave ${field} out to list everything.`,
    );
  }
  return trimmed;
}

function toFilters(args: ListElementsArgs): Filters {
  return {
    cls: needle(args.cls, "cls"),
    folder: needle(args.folder, "folder"),
    name: needle(args.name, "name"),
  };
}

const isFiltered = (f: Filters): boolean => f.cls !== null || f.folder !== null || f.name !== null;

const contains = (needle: string | null, hay: string | null | undefined): boolean =>
  needle === null || (hay ?? "").toLowerCase().includes(needle);

function matchesFilter(feature: GeometryFeature, filters: Filters): boolean {
  return (
    contains(filters.cls, feature.cls) &&
    contains(filters.folder, feature.folder) &&
    contains(filters.name, feature.name)
  );
}

/** Fingerprint of the filter a cursor was minted under. Not a secret and not a checksum of
 * the data — just enough to tell "offset 10 into the doors" from "offset 10 into the doors
 * in Apartment 5", which are different lists that happen to share a number. FNV-1a. */
function filterKey(filters: Filters): string {
  const source = JSON.stringify([filters.cls, filters.folder, filters.name]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const matchCursor = (filters: Filters, start: number): string =>
  `${MATCH_CURSOR}${filterKey(filters)}:${start}`;

/** The offset a filtered cursor carries, or a refusal. A cursor that came from a different
 * filter is the dangerous case: its offset is a real number in a list this call is not
 * building, so following it skips a head the caller was never shown and the result reads
 * as a complete, caveat-free answer. It is refused before the scan, not paged into. */
function matchCursorStart(cursor: string, filters: Filters): number {
  const body = cursor.slice(MATCH_CURSOR.length);
  const split = body.indexOf(":");
  const key = split === -1 ? "" : body.slice(0, split);
  const offset = split === -1 ? "" : body.slice(split + 1);

  if (key !== filterKey(filters)) {
    throw new BadArgument(
      "That cursor was made by a listing with different cls/folder/name filters. A filtered " +
        "cursor is an offset into that one filter's matches, so it means nothing here. Repeat " +
        "the filters it came from, or start this listing again without a cursor.",
    );
  }
  // Deliberately strict: "0x10", " 5" and "1e3" all coerce to a number and would each page
  // into somewhere the caller never asked for.
  if (!/^\d+$/.test(offset)) {
    throw new BadArgument("That cursor is not valid. Pass back a `next_cursor` exactly as it was given.");
  }
  const start = Number(offset);
  if (!Number.isSafeInteger(start)) {
    throw new BadArgument("That cursor is not valid. Pass back a `next_cursor` exactly as it was given.");
  }
  return start;
}

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

type Scan = {
  head: GeometryPage;
  features: GeometryFeature[];
  scanned: number;
  complete: boolean;
};

const scanCache = new Map<string, { at: number; scan: Scan }>();

/** Only for tests: the cache is process-local and keyed by caller, so nothing else needs
 * to reach into it. */
export function clearScanCache(): void {
  scanCache.clear();
}

/** Drop the filtered-scan copy for one caller/blueprint after a legend write. */
export function invalidateScanCache(scope: string): void {
  scanCache.delete(scope);
}

function cachedScan(scope: string | undefined): Scan | undefined {
  if (scope === undefined) return undefined;
  const hit = scanCache.get(scope);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SCAN_CACHE_TTL_MS) {
    scanCache.delete(scope);
    return undefined;
  }
  return hit.scan;
}

function rememberScan(scope: string | undefined, scan: Scan): void {
  if (scope === undefined) return;
  scanCache.set(scope, { at: Date.now(), scan });
  for (const [key, entry] of scanCache) {
    if (Date.now() - entry.at > SCAN_CACHE_TTL_MS) scanCache.delete(key);
  }
  while (scanCache.size > SCAN_CACHE_MAX) {
    const oldest = scanCache.keys().next().value;
    if (oldest === undefined) break;
    scanCache.delete(oldest);
  }
}

/** Rows this response says it read, rather than rows we asked it for. The route's cursor
 * is a plain row offset, so the cursor it hands back is exactly how far it got; a route
 * that clamped the page size would otherwise be reported as having read rows it never
 * touched. Anything that is not a forward-moving offset falls back to the estimate. */
function rowsScanned(before: number, result: GeometryPage): number {
  if (!result.truncated) return result.total;
  const next = result.next_cursor;
  if (next && /^\d+$/.test(next)) {
    const offset = Number(next);
    if (offset > before && offset <= result.total) return offset;
  }
  return Math.min(before + SCAN_PAGE, result.total);
}

/** Read the whole sheet so a client-side filter can honestly say what it saw. */
async function scanAll(fetchPage: FetchGeometry): Promise<Scan> {
  const features: GeometryFeature[] = [];
  let head: GeometryPage | undefined;
  let cursor: string | undefined;
  let scanned = 0;
  let complete = false;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const result = await fetchPage(SCAN_PAGE, cursor);
    head ??= result;
    features.push(...result.features);
    scanned = rowsScanned(scanned, result);
    // Two different endings, and only one of them means the sheet was read. "There is more
    // and here is where it is" is the loop; "there is more and no way to reach it" is an
    // unread tail, and calling that complete would turn it into a confident total.
    if (!result.truncated) {
      complete = true;
      break;
    }
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }

  return { head: head!, features, scanned, complete };
}

/**
 * @param scope Opaque per-caller key for the filtered scan cache — it must identify the
 * principal as well as the blueprint, since the scan holds one user's data. Omit it and
 * every call reads live.
 */
export async function buildElementsPage(
  fetchPage: FetchGeometry,
  args: ListElementsArgs,
  scope?: string,
): Promise<ListElementsPage> {
  const geometryIncluded = args.include_geometry ?? true;
  const requested = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const limit = geometryIncluded ? Math.min(requested, GEOMETRY_PAGE_MAX) : requested;
  const filters = toFilters(args);
  const filtered = isFiltered(filters);
  const isMatchCursor = args.cursor?.startsWith(MATCH_CURSOR) ?? false;

  if (filtered && args.cursor && !isMatchCursor) {
    throw new BadArgument(
      "That cursor came from an unfiltered listing and counts rows, not matches. Drop the " +
        "filter, or start the filtered listing again without a cursor.",
    );
  }
  if (!filtered && isMatchCursor) {
    throw new BadArgument(
      "That cursor came from a filtered listing. Pass the same cls, folder and name filters " +
        "along with it, or start again without a cursor.",
    );
  }

  const notes: string[] = [];
  let head: GeometryPage;
  let elements: Element[];
  let matched: number | null = null;
  let filterScanned: number | null = null;
  let filterComplete: boolean | null = null;
  let truncated: boolean;
  let nextCursor: string | null;
  let budgetDropped = 0;

  if (filtered) {
    // Refused before the read: a cursor from another filter is a caller mistake, and
    // proving it costs nothing while the scan costs the route the whole sheet.
    const start = args.cursor ? matchCursorStart(args.cursor, filters) : 0;

    const cached = cachedScan(scope);
    const scan = cached ?? (await scanAll(fetchPage));
    if (!cached) rememberScan(scope, scan);

    head = scan.head;
    const matches = scan.features.filter((f) => matchesFilter(f, filters));
    // An offset past the end is not an empty page: it is a cursor that no longer describes
    // this list, and answering "0 elements, nothing more to see" would be a lie about five
    // doors that are right there.
    if (start > matches.length) {
      throw new BadArgument(
        `That cursor starts past the end of this filter's ${matches.length} match(es) — the ` +
          "blueprint or the filter is not what it was when the cursor was made. Start the " +
          "listing again without a cursor.",
      );
    }
    const window = matches.slice(start, start + limit).map((f) => toElement(f, geometryIncluded));
    const fit = fitToBudget(window);
    budgetDropped = window.length - fit;

    elements = window.slice(0, fit);
    matched = matches.length;
    filterScanned = scan.scanned;
    filterComplete = scan.complete;
    const moreMatches = start + elements.length < matches.length;
    // Unread rows count as truncation even when every match found so far has been
    // handed over: "no more matches in what I read" is not "no more matches".
    truncated = moreMatches || !scan.complete;
    nextCursor = moreMatches ? matchCursor(filters, start + elements.length) : null;
  } else {
    head = await fetchPage(limit, args.cursor);
    elements = head.features.map((f) => toElement(f, geometryIncluded));
    truncated = head.truncated;
    nextCursor = head.next_cursor ?? null;

    const fit = fitToBudget(elements);
    if (fit < elements.length) {
      budgetDropped = elements.length - fit;
      const resume = resumeAfterRow(head, args.cursor, elements[fit - 1]!.i);
      if (resume !== null) {
        elements = elements.slice(0, fit);
      } else {
        // No cursor of the route's that resumes where this page now stops, and minting one
        // by guesswork is how a caller silently loses rows. Ask for the smaller page and
        // let the route mint its own.
        head = await fetchPage(fit, args.cursor);
        elements = head.features.map((f) => toElement(f, geometryIncluded));
      }
      truncated = true;
      nextCursor = resume ?? head.next_cursor ?? null;
    }
  }

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

  if (filtered && filterComplete === false) {
    notes.push(
      `The cls/folder/name filter is applied by this tool, not by Kamai, and it only read the ` +
        `first ${filterScanned} of ${head.total} rows on this blueprint. Nothing past that was ` +
        `checked, so "matched" is a floor, not a count. Narrow the filter or use view_takeoff ` +
        `for whole-blueprint totals.`,
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
    filter_scanned: filterScanned,
    filter_complete: filterComplete,
    geometry_included: geometryIncluded,
    notes,
  };
}
