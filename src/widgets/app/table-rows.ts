import type { GeometryFeature, IdMap, OutlinesPage, RowElements, TableData, TableRow } from "./types";

/** A Kamai tool call that resolves to its payload, or throws the error it carried. */
export type KamaiCall = <T>(name: string, args: Record<string, unknown>, looksRight: (value: T) => boolean) => Promise<T>;

// Outlines per get_element_outlines call (the tool's own ceiling).
export const OUTLINES_PER_CALL = 400;

export const hasIds = (value: RowElements) => typeof value?.element_count === "number" && !!value.element_ids;

export const idCount = (map: IdMap) => Object.values(map).reduce((sum, ids) => sum + ids.length, 0);

export function mergeIds(a: IdMap, b: IdMap): IdMap {
  const out: IdMap = {};
  for (const map of [a, b]) {
    for (const [blueprintId, ids] of Object.entries(map)) {
      out[blueprintId] = [...new Set([...(out[blueprintId] ?? []), ...ids])];
    }
  }
  return out;
}

/** The complete id set of one row: the panel's own fetch, never the capped ids the model saw.
 * A Kamai-built row is fetched by its key, never its position: the table is rebuilt from
 * the drawing as it is now, and a group deleted since shifts every row after it. */
export async function rowElements(call: KamaiCall, data: TableData, row: TableRow): Promise<RowElements> {
  if (data.selection && row.key) {
    return call<RowElements>(
      "get_table_row_elements",
      {
        project_id: data.project_id,
        table: data.selection,
        row_key: row.key,
        ...(typeof row.index === "number" ? { row: row.index } : {}),
      },
      hasIds,
    );
  }
  const authored: RowElements = {
    element_ids: row.element_ids ?? {},
    element_count: row.element_count,
    element_ids_truncated: !!row.element_ids_truncated,
  };
  if (!row.from || !data.selections?.length) return authored;
  const resolved = await call<RowElements>(
    "get_table_row_elements",
    { project_id: data.project_id, selections: data.selections, from: row.from },
    hasIds,
  );
  // The row's ids are the selection's first few, already merged by render_table, plus any
  // the model named itself. The full fetch holds the first kind, so only ids it does not
  // hold add to its count: adding the row's whole count counted the selection twice.
  const known = new Map(Object.entries(resolved.element_ids).map(([blueprintId, ids]) => [blueprintId, new Set(ids)]));
  let extra = 0;
  for (const [blueprintId, ids] of Object.entries(authored.element_ids)) {
    const seen = known.get(blueprintId) ?? new Set<string>();
    known.set(blueprintId, seen);
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        extra += 1;
      }
    }
  }
  const element_ids = mergeIds(resolved.element_ids, authored.element_ids);
  return { ...resolved, element_ids, element_count: resolved.element_count + extra };
}

export type Outlines = { features: GeometryFeature[]; grid: number; missing: string[] };

/** Outlines of `ids` on one blueprint, in calls of at most OUTLINES_PER_CALL. Ids the tool
 * left out for size come back in `omitted` and are asked for again; ids that are not on the
 * blueprint any more come back in `missing` and are kept, so the plan can say so. */
export async function outlinesFor(call: KamaiCall, projectId: string, blueprintId: string, ids: string[]): Promise<Outlines> {
  const features: GeometryFeature[] = [];
  const missing: string[] = [];
  const queue = [...ids];
  let grid = 0;
  for (let calls = 0; queue.length && calls < 20; calls += 1) {
    const chunk = queue.splice(0, OUTLINES_PER_CALL);
    const page = await call<OutlinesPage>(
      "get_element_outlines",
      { project_id: projectId, blueprint_id: blueprintId, ids: chunk },
      (value) => Array.isArray(value?.features),
    );
    grid = page.grid || grid;
    features.push(...page.features);
    missing.push(...(page.missing ?? []));
    const omitted = page.omitted ?? [];
    if (omitted.length >= chunk.length) break;
    queue.unshift(...omitted);
  }
  return { features, grid, missing };
}

/** The outlines a plan highlights. A row whose every element is gone from the blueprint
 * (deleted since the table was drawn) is refused, rather than opening a plan that lights
 * nothing and still reads as the row's elements. */
export async function highlightFor(call: KamaiCall, projectId: string, blueprintId: string, ids: string[]): Promise<Outlines> {
  const outlines = await outlinesFor(call, projectId, blueprintId, ids);
  if (!outlines.features.length && ids.length && outlines.missing.length >= new Set(ids).size) {
    throw new Error(
      ids.length === 1
        ? "This row's element is no longer on this blueprint."
        : `This row's ${ids.length} elements are no longer on this blueprint.`,
    );
  }
  return outlines;
}
