import type { GeometryFeature, IdMap, OutlinesPage, RowElements, TableData, TableRow } from "./types";

/** A Kamai tool call that resolves to its payload, or throws the error it carried. */
export type KamaiCall = <T>(name: string, args: Record<string, unknown>, looksRight: (value: T) => boolean) => Promise<T>;

// Outlines per get_element_outlines call (the tool's own ceiling).
export const OUTLINES_PER_CALL = 400;

export const hasIds = (value: RowElements) => typeof value?.element_count === "number" && !!value.element_ids;

export const idCount = (map: IdMap) => Object.values(map).reduce((sum, ids) => sum + ids.length, 0);

/** The complete id set of one row: the panel's own fetch, never the capped ids the model saw.
 * A Kamai-built row is fetched by its key, never its position: the table is rebuilt from
 * the drawing as it is now, and a group deleted since shifts every row after it. */
/** A row's sheets that hold ids, in the project's sheet order (`data.blueprints`, Kamai's order); unknown ones last. */
export function sheetsInOrder(map: IdMap, blueprints: TableData["blueprints"]): Array<[string, string[]]> {
  const at = new Map((blueprints ?? []).map((b, i) => [b.blueprint_id, i]));
  return Object.entries(map)
    .filter(([, ids]) => ids.length)
    .sort(([a], [b]) => (at.get(a) ?? Infinity) - (at.get(b) ?? Infinity));
}

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
  // Kamai merges the row's ids into the full fetch and counts an id both hold once.
  return call<RowElements>(
    "get_table_row_elements",
    {
      project_id: data.project_id,
      selections: data.selections,
      from: row.from,
      ...(idCount(authored.element_ids) ? { ids: authored.element_ids } : {}),
    },
    hasIds,
  );
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
