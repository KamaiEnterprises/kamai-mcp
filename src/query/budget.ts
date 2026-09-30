import { RESULT_BUDGET } from "../elements.ts";

export { RESULT_BUDGET };

// Element ids the model sees per result. Per row the API already caps them;
// complete sets go only to the table panel, through app-only tools.
export const IDS_PER_RESULT = 500;

// Held back from the budget for what fitting itself adds: the `truncated` flag and a note.
const NOTE_RESERVE = 1_500;

/** What a result costs a host: its own JSON plus that JSON escaped into the text copy.
 * Both copies are counted because every tool here returns content AND structuredContent,
 * and the ~150k-character ceiling is on the whole result. */
export function resultCost(value: unknown): number {
  const json = JSON.stringify(value);
  return json.length + JSON.stringify(json).length;
}

/** Drop entries from the END of `list` (which must be an array inside `result`) until the
 * whole result fits RESULT_BUDGET. Never below one entry: a result with nothing in it
 * answers nothing, and one oversized entry is reported rather than silently dropped.
 *
 * Returns how many entries were dropped. When any were, `result.truncated` is set and
 * `note(dropped)` is appended to `result.notes`. */
export function fitResult(
  result: Record<string, unknown>,
  list: unknown[],
  note: (dropped: number) => string,
  budget = RESULT_BUDGET,
): number {
  const limit = budget - NOTE_RESERVE;
  let total = resultCost(result);
  if (total <= limit) return 0;
  // Each entry's cost in both copies, plus its separator in each. Summing these avoids
  // re-serialising the whole result once per dropped entry.
  const costs = list.map((entry) => resultCost(entry) + 2);
  let dropped = 0;
  while (total > limit && list.length - dropped > 1) {
    total -= costs[list.length - 1 - dropped]!;
    dropped += 1;
  }
  list.splice(list.length - dropped, dropped);
  // The estimate ignores escaping differences between an entry alone and in place; the
  // exact cost settles it.
  while (resultCost(result) > limit && list.length > 1) {
    list.pop();
    dropped += 1;
  }
  if (dropped > 0) {
    result.truncated = true;
    const notes = Array.isArray(result.notes) ? (result.notes as string[]) : [];
    notes.push(note(dropped));
    result.notes = notes;
  }
  return dropped;
}

type IdMap = Record<string, string[]>;

/** Trim the id maps of `rows` so the whole result carries at most `perResult` ids under
 * `key`, taken in row order. A row that lost ids gets `<key>_truncated: true`; its
 * `*_count` still states the full number. */
export function capIds(
  rows: ReadonlyArray<Record<string, unknown>>,
  perResult = 500,
  key = "element_ids",
): void {
  let left = perResult;
  const flag = `${key}_truncated`;
  for (const row of rows) {
    const map = row[key] as IdMap | null | undefined;
    if (!map || typeof map !== "object") continue;
    const next: IdMap = {};
    let trimmed = false;
    for (const [blueprintId, ids] of Object.entries(map)) {
      if (!Array.isArray(ids)) continue;
      if (left <= 0) {
        if (ids.length) trimmed = true;
        continue;
      }
      const kept = ids.slice(0, left);
      left -= kept.length;
      if (kept.length < ids.length) trimmed = true;
      if (kept.length) next[blueprintId] = kept;
    }
    row[key] = next;
    if (trimmed) row[flag] = true;
  }
}

/** State once what every entry of a block says identically, in place.
 *
 * A field every entry of `rows`/`groups` shares moves into `rows_common`/`groups_common`,
 * and a field every entry leaves empty is dropped. A field that varies is untouched. A
 * result the model reads is re-read on every later call in the turn, so the constant
 * third of a block is paid for many times over. */
export function compact(
  result: Record<string, unknown>,
  keys: readonly string[] = ["rows", "groups"],
  keep: ReadonlySet<string> = ANSWER_FIELDS,
): void {
  for (const key of keys) {
    const block = result[key];
    if (!Array.isArray(block) || block.length < 2) continue;
    if (!block.every((row) => row !== null && typeof row === "object" && !Array.isArray(row))) continue;
    const rows = block as Array<Record<string, unknown>>;
    const fields = new Set<string>();
    for (const row of rows) for (const field of Object.keys(row)) fields.add(field);
    const common: Record<string, unknown> = {};
    for (const field of [...fields].sort()) {
      const first = JSON.stringify(rows[0]![field] ?? null);
      if (rows.some((row) => JSON.stringify(row[field] ?? null) !== first)) continue;
      const value = rows[0]![field];
      // An answer field stays on every row even when every row agrees: the descriptions
      // tell the model an absent measurement does not apply, so a count or an area moved
      // into `*_common` could be read as missing rather than shared.
      if (keep.has(field) && !isEmpty(value)) continue;
      for (const row of rows) delete row[field];
      if (!isEmpty(value)) common[field] = value;
    }
    if (Object.keys(common).length) result[`${key}_common`] = common;
  }
}

/** The figures a row exists to report. Never hoisted by compact(). */
export const ANSWER_FIELDS: ReadonlySet<string> = new Set([
  "count",
  "element_count",
  "area",
  "perimeter",
  "length",
  "width",
  "width_min",
  "width_max",
]);

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Remove any raw SI measurement field (`*_m2`, `*_m`) from the entries of `rows`.
 * The API layer's query routes never send one; this is the second lock on the model's
 * side of the door, because a bare metre figure is a figure a model will quote in feet. */
export function stripSi(rows: ReadonlyArray<Record<string, unknown>>): void {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (/_m2?$/.test(key)) delete row[key];
    }
  }
}
