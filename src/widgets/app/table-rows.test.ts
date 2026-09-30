import { describe, expect, it } from "vitest";

import { highlightFor, rowElements, type KamaiCall } from "./table-rows";
import type { OutlinesPage, RowElements, TableData, TableRow } from "./types";

// Answers each tool by name, and records what it was asked.
function fakeCall(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call: KamaiCall = async <T>(name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return answers[name]!(args) as T;
  };
  return { call, calls };
}

const authoredTable = (row: TableRow): TableData => ({
  project_id: "p1",
  title: "Doors",
  columns: [{ key: "type", label: "Type" }],
  rows: [row],
  selections: ["c1.token"],
});

describe("rowElements for a model-authored row that points into a selection", () => {
  // What render_table puts on the row: the selection's first ids, already merged in.
  const fromOnly: TableRow = {
    cells: { type: "Doors" },
    element_ids: { bpA: ["d1", "d2", "d3"] },
    element_count: 3,
    from: { s: 0, group: { sub_class: "door" } },
  };
  const panel: RowElements = { element_ids: { bpA: ["d1", "d2", "d3"] }, element_count: 3, element_ids_truncated: false };

  it("counts a row with no ids of its own once, not twice", async () => {
    const { call } = fakeCall({ get_table_row_elements: () => panel });
    const out = await rowElements(call, authoredTable(fromOnly), fromOnly);
    expect(out.element_count).toBe(3);
    expect(out.element_ids).toEqual({ bpA: ["d1", "d2", "d3"] });
  });

  it("adds only the ids the model named that the selection does not hold", async () => {
    const both: TableRow = { ...fromOnly, element_ids: { bpA: ["d1", "d2", "d3", "w9"] }, element_count: 4 };
    const { call } = fakeCall({ get_table_row_elements: () => panel });
    const out = await rowElements(call, authoredTable(both), both);
    expect(out.element_count).toBe(4);
    expect(out.element_ids.bpA?.sort()).toEqual(["d1", "d2", "d3", "w9"]);
  });

  it("keeps the full fetch's count when it holds more than the row showed", async () => {
    const big: RowElements = { element_ids: { bpA: ["d1", "d2", "d3", "d4", "d5"] }, element_count: 5, element_ids_truncated: false };
    const { call } = fakeCall({ get_table_row_elements: () => big });
    const out = await rowElements(call, authoredTable(fromOnly), fromOnly);
    expect(out.element_count).toBe(5);
  });
});

describe("highlightFor", () => {
  const page = (features: string[], missing: string[]): OutlinesPage => ({
    blueprint_id: "bpA",
    grid: 1024,
    features: features.map((id) => ({ id, kind: "area", group: "Doors", cls: "door", color: null, pts: [0, 0, 1, 1] }) as never),
    missing,
  });

  it("refuses a plan when every element is gone from the blueprint", async () => {
    const { call } = fakeCall({ get_element_outlines: () => page([], ["d1", "d2"]) });
    await expect(highlightFor(call, "p1", "bpA", ["d1", "d2"])).rejects.toThrow(/no longer on this blueprint/);
  });

  it("names the elements that are gone when some are still there", async () => {
    const { call } = fakeCall({ get_element_outlines: () => page(["d1"], ["d2"]) });
    const out = await highlightFor(call, "p1", "bpA", ["d1", "d2"]);
    expect(out.features.map((f) => f.id)).toEqual(["d1"]);
    expect(out.missing).toEqual(["d2"]);
  });

  it("collects missing ids across pages", async () => {
    const ids = Array.from({ length: 401 }, (_, i) => `e${i}`);
    const { call, calls } = fakeCall({
      get_element_outlines: (args) => {
        const chunk = args.ids as string[];
        return chunk.length === 1 ? page([], chunk) : page(chunk.slice(1), [chunk[0]!]);
      },
    });
    const out = await highlightFor(call, "p1", "bpA", ids);
    expect(calls).toHaveLength(2);
    expect(out.missing.sort()).toEqual(["e0", "e400"]);
  });
});
