import { afterEach, describe, expect, it, vi } from "vitest";

import geometrySelect from "./query/__fixtures__/geometry-select.json" with { type: "json" };
import resolve from "./query/__fixtures__/resolve.json" with { type: "json" };
import tableFind from "./query/__fixtures__/table-find.json" with { type: "json" };
import tableRow from "./query/__fixtures__/table-row.json" with { type: "json" };
import tableWall from "./query/__fixtures__/table-wall-surface.json" with { type: "json" };
import table from "./query/__fixtures__/table.json" with { type: "json" };
import { RESULT_BUDGET } from "./query/budget.ts";
import { connect, errorText, stubApi, structured, type ApiReply } from "./testing/harness.ts";
import { widgetUri } from "./widgets/index.ts";

afterEach(() => vi.unstubAllGlobals());

// Fixtures under query/__fixtures__ are samples captured from the real routes on a
// synthetic "Eval Tower" project.
const P = "projEvalTower";
const COUNT = "q1.countToken";
const FIND = "q1.findToken";
const clone = <T>(value: T): T => structuredClone(value);

const project = {
  id: P,
  name: "Eval Tower",
  description: "",
  blueprints: [
    { id: "bpEval_a", name: "Ground Floor", ready: true },
    { id: "bpEval_b", name: "First Floor", ready: true },
  ],
  jobs: [],
};

async function call(name: string, args: Record<string, unknown>, routes: Record<string, ApiReply>) {
  const calls = stubApi(routes);
  const client = await connect({ queryTools: true });
  const result = await client.callTool({ name, arguments: args });
  return { result, calls };
}

type Table = {
  title: string;
  built_by: string;
  selection?: string;
  selections?: string[];
  rows: Array<{ cells: Record<string, unknown>; kind?: string; element_count: number; element_ids?: Record<string, string[]>; from?: unknown; element_ids_truncated?: boolean }>;
  problems: Array<{ row: number; reason: string }>;
  blueprints: Array<{ blueprint_id: string; name: string }>;
};

describe("render_table from a result", () => {
  it("asks the API to build the table and returns its cells exactly", async () => {
    const { result, calls } = await call(
      "render_table",
      { project_id: P, title: "Door schedule", language: "en", from_result: COUNT },
      { [`POST /v1/projects/${P}/query/table`]: { body: clone(table) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls).toEqual([
      {
        method: "POST",
        path: `/v1/projects/${P}/query/table`,
        query: {},
        body: { selection: COUNT, language: "en", ids_per_row: 25, max_ids: 500 },
      },
    ]);
    const out = structured<Table>(result);
    expect(out.title).toBe("Door schedule");
    expect(out.built_by).toBe("kamai");
    expect(out.selection).toBe(COUNT);
    expect(out.rows.map((r) => r.cells)).toEqual(table.rows.map((r) => r.cells));
    expect(out.rows[1]!.element_ids).toEqual({ bpEval_a: ["d1"] });
    // The total row carries every item row's ids, across blueprints.
    const total = out.rows.find((r) => r.kind === "total")!;
    expect(total.element_ids).toEqual({ bpEval_a: ["d1", "d2", "d3", "d4", "d5"], bpEval_b: ["d_wc"] });
    expect(total.element_count).toBe(6);
    // Rendered as the table widget.
    expect((result._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri).toBe(widgetUri("table"));
  });

  it("passes each kind of API-built table through with its cells and ids untouched", async () => {
    // Count and find tables carry display strings; the wall-surface table carries numbers
    // with a column unit. All three decode, and nothing is rewritten.
    for (const [name, sample] of [["count", table], ["find", tableFind], ["wall_surface", tableWall]] as const) {
      const { result } = await call("render_table", { project_id: P, title: name, from_result: COUNT }, {
        [`POST /v1/projects/${P}/query/table`]: { body: clone(sample) },
      });
      expect(result.isError, `${name}: ${errorText(result)}`).toBeFalsy();
      const out = structured<Table & { source: string; columns: unknown[] }>(result);
      expect(out.source).toBe(name);
      expect(out.columns, name).toEqual(sample.columns);
      expect(out.rows.map((r) => r.cells), name).toEqual(sample.rows.map((r) => r.cells));
      expect(out.rows.map((r) => r.element_ids), name).toEqual(sample.rows.map((r) => r.element_ids));
    }
  });

  it("surfaces the API's refusal of another project's selection", async () => {
    const detail = "That selection belongs to a different project; run the query again for this project.";
    const { result } = await call("render_table", { project_id: P, title: "T", from_result: COUNT }, {
      [`POST /v1/projects/${P}/query/table`]: { status: 400, body: { code: "invalid_request", detail } },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(detail);
  });

  it("holds a huge table under the budget", async () => {
    const big = clone(table) as Record<string, unknown>;
    big.rows = Array.from({ length: 200 }, (_, i) => ({
      index: i,
      cells: { folder: `F${i} ${"x".repeat(800)}`, count: 1 },
      kind: "item",
      element_ids: { "bp-a": [`e${i}`] },
      element_count: 1,
      element_ids_truncated: false,
    }));
    const { result } = await call("render_table", { project_id: P, title: "T", from_result: COUNT }, {
      [`POST /v1/projects/${P}/query/table`]: { body: big },
    });
    expect(JSON.stringify(result.content).length + JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(RESULT_BUDGET);
    expect(structured<Table>(result).rows.length).toBeLessThan(200);
  });
});

describe("render_table with authored rows", () => {
  const columns = [
    { key: "type", label: "Type" },
    { key: "count", label: "Count", type: "count" },
    { key: "paint", label: "Paint", type: "number", unit: "L" },
  ];

  it("resolves every pointed row in one request and keeps `from` for the panel", async () => {
    // The four rows the contract sample was captured for: a count group, the whole count,
    // a find row by ref, and a group that names too few group_by fields.
    const d4 = { folder: "Doors", sub_class: "double swing door", tag: "D4" };
    const { result, calls } = await call(
      "render_table",
      {
        project_id: P,
        title: "Doors",
        selections: [COUNT, FIND],
        columns,
        rows: [
          { cells: { type: "double swing door", count: 1 }, from: { s: 0, group: d4 } },
          { cells: { type: "all doors", count: 6 }, kind: "total", from: { s: 0 } },
          { cells: { type: "D1", count: 1 }, from: { s: 1, group: { ref: "se0951e:d1" } } },
          { cells: { type: "sliding door", count: 1 }, from: { s: 0, group: { sub_class: "sliding door" } } },
          { cells: { type: "note", count: null }, kind: "note" },
        ],
      },
      {
        [`GET /v1/projects/${P}`]: { body: project },
        [`POST /v1/projects/${P}/query/resolve`]: { body: clone(resolve) },
      },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    const resolveCalls = calls.filter((c) => c.path.endsWith("/query/resolve"));
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]!.body).toEqual({
      selections: [COUNT, FIND],
      rows: [
        { s: 0, group: d4 },
        { s: 0 },
        { s: 1, group: { ref: "se0951e:d1" } },
        { s: 0, group: { sub_class: "sliding door" } },
      ],
      ids_per_row: 25,
      max_ids: 500,
    });
    const out = structured<Table>(result);
    expect(out.built_by).toBe("model");
    expect(out.selections).toEqual([COUNT, FIND]);
    expect(out.rows[0]).toMatchObject({ element_count: 1, element_ids: { bpEval_a: ["d4"] }, from: { s: 0 } });
    expect(out.rows[1]).toMatchObject({
      kind: "total",
      element_count: 6,
      element_ids: { bpEval_a: ["d1", "d2", "d3", "d4", "d5"], bpEval_b: ["d_wc"] },
    });
    expect(out.rows[2]).toMatchObject({ element_count: 1, element_ids: { bpEval_a: ["d1"] } });
    expect(out.rows[3]!.element_count).toBe(0);
    expect(out.rows[4]).toMatchObject({ kind: "note", element_count: 0 });
    expect(out.problems).toEqual([{ row: 3, reason: resolve.rows[3]!.problem }]);
    expect(out.blueprints.map((b) => b.blueprint_id)).toEqual(["bpEval_a", "bpEval_b"]);
  });

  it("counts an element once when a row names it and its group holds it too", async () => {
    // A row's own ids and its resolved ids were added, so D4 named by the model AND found
    // by its group counted as two elements.
    const d4 = { folder: "Doors", sub_class: "double swing door", tag: "D4" };
    const { result } = await call(
      "render_table",
      {
        project_id: P,
        title: "Overlap",
        selections: [COUNT],
        columns,
        rows: [
          { cells: { type: "D4" }, element_ids: { bpEval_a: ["d4"] }, from: { s: 0, group: d4 } },
          { cells: { type: "D4 twice" }, element_ids: { bpEval_a: ["d4", "d4", "d9"] }, from: { s: 0, group: d4 } },
        ],
      },
      {
        [`GET /v1/projects/${P}`]: { body: project },
        [`POST /v1/projects/${P}/query/resolve`]: { body: { rows: [clone(resolve.rows[0]!), clone(resolve.rows[0]!)] } },
      },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    const out = structured<Table>(result);
    expect(out.rows[0]).toMatchObject({ element_count: 1, element_ids: { bpEval_a: ["d4"] } });
    expect(out.rows[1]).toMatchObject({ element_count: 2, element_ids: { bpEval_a: ["d4", "d9"] } });
  });

  it("puts each resolved id set on the row that pointed at it, after rows that point nowhere", async () => {
    // Every pointed row came first, so taking resolved.rows[i] (the row's position) for
    // resolved.rows[j] (its place among pointed rows) passed, and so did overwriting a row's own element_ids with its resolved ones.
    const d4 = { folder: "Doors", sub_class: "double swing door", tag: "D4" };
    const { result, calls } = await call(
      "render_table",
      {
        project_id: P,
        title: "Mixed",
        selections: [COUNT, FIND],
        columns,
        rows: [
          { cells: { type: "a note first" }, kind: "note" },
          { cells: { type: "typed ids only" }, element_ids: { bpEval_b: ["d_wc"] } },
          { cells: { type: "all doors", count: 6 }, kind: "total", from: { s: 0 } },
          { cells: { type: "D4 and D1" }, element_ids: { bpEval_a: ["d1"] }, from: { s: 0, group: d4 } },
          { cells: { type: "D1" }, from: { s: 1, group: { ref: "se0951e:d1" } } },
        ],
      },
      {
        [`GET /v1/projects/${P}`]: { body: project },
        [`POST /v1/projects/${P}/query/resolve`]: {
          body: { rows: [clone(resolve.rows[1]!), clone(resolve.rows[0]!), clone(resolve.rows[2]!)] },
        },
      },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls.find((c) => c.path.endsWith("/query/resolve"))!.body).toMatchObject({
      rows: [{ s: 0 }, { s: 0, group: d4 }, { s: 1, group: { ref: "se0951e:d1" } }],
    });
    const out = structured<Table>(result);
    expect(out.rows[0]).toMatchObject({ kind: "note", element_count: 0, element_ids: {} });
    expect(out.rows[1]).toMatchObject({ element_count: 1, element_ids: { bpEval_b: ["d_wc"] } });
    expect(out.rows[2]).toMatchObject({ kind: "total", element_count: 6 });
    expect(out.rows[2]!.element_ids).toEqual(resolve.rows[1]!.element_ids);
    // its own id AND the resolved one, merged, each counted
    expect(out.rows[3]).toMatchObject({ element_count: 2, element_ids: { bpEval_a: ["d1", "d4"] } });
    expect(out.rows[4]).toMatchObject({ element_count: 1, element_ids: { bpEval_a: ["d1"] } });
    expect(out.problems).toEqual([]);
  });

  it("refuses an answer that does not line up with the rows it resolved", async () => {
    // One resolved row too many would shift nothing today and misalign silently tomorrow.
    const { result } = await call(
      "render_table",
      { project_id: P, title: "T", selections: [COUNT], columns, rows: [{ cells: { type: "x" }, from: { s: 0 } }] },
      {
        [`GET /v1/projects/${P}`]: { body: project },
        [`POST /v1/projects/${P}/query/resolve`]: { body: { rows: [clone(resolve.rows[1]!), clone(resolve.rows[0]!)] } },
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("d4");
  });

  it("refuses a row group with more keys than any count has, before any request", async () => {
    const group = { a: "1", b: "2", c: "3", d: "4", e: "5" };
    const { result, calls } = await call(
      "render_table",
      { project_id: P, title: "T", selections: [COUNT], columns, rows: [{ cells: { type: "x" }, from: { s: 0, group } }] },
      {},
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("drops the problems of rows it cut for size, so problems cannot outgrow the budget", async () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      cells: { type: `${"x".repeat(290)}${i}` },
      from: { s: 0, group: { sub_class: `t${i}` } },
    }));
    const problem = "group must name exactly the count's group_by fields (folder, sub_class, tag).";
    const { result } = await call(
      "render_table",
      { project_id: P, title: "Big", selections: [COUNT], columns, rows },
      {
        [`GET /v1/projects/${P}`]: { body: project },
        [`POST /v1/projects/${P}/query/resolve`]: {
          body: { rows: rows.map(() => ({ element_ids: {}, element_count: 0, element_ids_truncated: false, problem })) },
        },
      },
    );
    const out = structured<Table>(result);
    expect(out.rows.length).toBeLessThan(200);
    expect(out.problems.length).toBe(out.rows.length);
    expect(Math.max(...out.problems.map((p) => p.row))).toBe(out.rows.length - 1);
    expect(JSON.stringify(result.content).length + JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(RESULT_BUDGET);
  });

  it("drops element_ids that name a blueprint outside the project", async () => {
    const { result, calls } = await call(
      "render_table",
      {
        project_id: P,
        title: "Mine",
        columns,
        rows: [
          { cells: { type: "mine" }, element_ids: { bpEval_a: ["d1"] } },
          { cells: { type: "theirs" }, element_ids: { bpEval_a: ["d2"], bpEval_victim: ["door0"] } },
        ],
      },
      { [`GET /v1/projects/${P}`]: { body: project } },
    );
    const out = structured<Table>(result);
    expect(out.rows[0]).toMatchObject({ element_count: 1, element_ids: { bpEval_a: ["d1"] } });
    expect(out.rows[1]).toMatchObject({ element_count: 0, element_ids: {} });
    expect(JSON.stringify(out)).not.toContain("door0");
    expect(out.problems).toEqual([{ row: 1, reason: "element_ids names a blueprint outside this project" }]);
    expect(calls.some((c) => c.path.endsWith("/query/resolve"))).toBe(false);
  });

  const refused = async (args: Record<string, unknown>) => {
    const { result, calls } = await call("render_table", { project_id: P, title: "T", ...args }, {});
    expect(result.isError, JSON.stringify(args)).toBe(true);
    expect(calls, JSON.stringify(args)).toHaveLength(0);
    return errorText(result);
  };

  it("refuses from.s past the selections, before any request", async () => {
    expect(
      await refused({ selections: [COUNT], columns, rows: [{ cells: { type: "x" }, from: { s: 1 } }] }),
    ).toBe("Row 0: from.s is 1, but selections holds 1.");
    expect(await refused({ columns, rows: [{ cells: { type: "x" }, from: { s: 0 } }] })).toMatch(/pass the selections/);
  });

  it("refuses more than five selections", async () => {
    await refused({ selections: [COUNT, COUNT, COUNT, COUNT, COUNT, COUNT], columns, rows: [{ cells: { type: "x" } }] });
  });

  it("refuses both ways at once, neither way, and half of one", async () => {
    expect(await refused({ from_result: COUNT, columns, rows: [{ cells: { type: "x" } }] })).toMatch(/not both/);
    expect(await refused({})).toMatch(/Pass from_result/);
    expect(await refused({ columns })).toMatch(/columns and rows go together/);
    expect(await refused({ from_result: COUNT, selections: [FIND] })).toMatch(/selections goes with rows/);
  });

  it("refuses a cell with no column and a column twice", async () => {
    expect(await refused({ columns, rows: [{ cells: { colour: "red" } }] })).toBe("Row 0: cell 'colour' is not a column key.");
    expect(await refused({ columns: [...columns, { key: "type", label: "Again" }], rows: [{ cells: {} }] })).toMatch(/appears twice/);
  });
});

describe("app-only helpers", () => {
  it("are hidden from the model", async () => {
    stubApi({});
    const client = await connect({ queryTools: true });
    const tools = (await client.listTools()).tools;
    for (const name of ["get_table_row_elements", "get_element_outlines"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect((tool._meta as { ui: { visibility: string[] } }).ui.visibility, name).toEqual(["app"]);
    }
  });

  it("resolves a built table's row by its key, with the panel's larger id budget", async () => {
    // table-row.json is the API's answer to exactly this request: the THIRD row of
    // table.json, fetched by its key.
    const third = table.rows[2]!;
    expect(tableRow.rows[0]!.key).toEqual(third.key);
    const { result, calls } = await call(
      "get_table_row_elements",
      { project_id: P, table: COUNT, row: 2, row_key: third.key },
      { [`POST /v1/projects/${P}/query/table`]: { body: clone(tableRow) } },
    );
    expect(calls[0]!.body).toEqual({ selection: COUNT, row: 2, row_key: third.key, ids_per_row: 1500, max_ids: 1500 });
    expect(structured(result)).toEqual({
      element_ids: third.element_ids,
      element_count: third.element_count,
      element_ids_truncated: false,
    });
    expect(third.element_ids).toEqual({ bpEval_a: ["d2"] });
  });

  it("answers every row of the table with that row's own ids, whatever its position now", async () => {
    // Only row 0 was ever fetched, and the row was picked by position, so answering
    // every row with the first row's ids passed. Here the API answers with the
    // rebuilt table's rows in a different order (a group was deleted and the rest moved up):
    // the panel must still get the row whose key it asked for.
    const items = table.rows.filter((r) => r.kind !== "note");
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const [at, row] of items.entries()) {
      const shuffled = [...items.slice(at + 1), ...items.slice(0, at + 1)].map((r, i) => ({ ...clone(r), index: i }));
      const { result } = await call(
        "get_table_row_elements",
        { project_id: P, table: COUNT, row: row.index, row_key: row.key },
        { [`POST /v1/projects/${P}/query/table`]: { body: { ...clone(tableRow), rows: shuffled } } },
      );
      expect(structured(result), JSON.stringify(row.key)).toEqual({
        element_ids: row.element_ids,
        element_count: row.element_count,
        element_ids_truncated: false,
      });
    }
  });

  it("resolves an authored row through its selection", async () => {
    const { result, calls } = await call(
      "get_table_row_elements",
      { project_id: P, selections: [COUNT], from: { s: 0, group: { folder: "Doors", sub_class: "double swing door", tag: "D4" } } },
      { [`POST /v1/projects/${P}/query/resolve`]: { body: { rows: [clone(resolve.rows[0]!)] } } },
    );
    expect(calls[0]!.body).toEqual({
      selections: [COUNT],
      rows: [{ s: 0, group: { folder: "Doors", sub_class: "double swing door", tag: "D4" } }],
      ids_per_row: 1500,
      max_ids: 1500,
    });
    expect(structured(result)).toMatchObject({ element_count: 1, element_ids: { bpEval_a: ["d4"] } });
  });

  it("refuses a half-specified row, and a row named by its index alone", async () => {
    for (const args of [
      { table: COUNT },
      { table: COUNT, row: 0 },
      { selections: [COUNT] },
      { table: COUNT, row_key: {}, from: { s: 0 } },
      { table: COUNT, row_key: { a: "1", b: "2", c: "3", d: "4", e: "5" } },
      {},
    ]) {
      const { result, calls } = await call("get_table_row_elements", { project_id: P, ...args }, {});
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(calls).toHaveLength(0);
    }
  });

  it("reads outlines for specific ids, and names the ones it left out for size", async () => {
    let { result, calls } = await call(
      "get_element_outlines",
      { project_id: P, blueprint_id: "bpEval_a", ids: ["kitchen", "d1", "not-there"] },
      { [`POST /v1/projects/${P}/blueprints/bpEval_a/geometry/select`]: { body: clone(geometrySelect) } },
    );
    expect(calls[0]!.body).toEqual({ ids: ["kitchen", "d1", "not-there"] });
    expect(structured(result)).toMatchObject({ blueprint_id: "bpEval_a", missing: ["not-there"] });
    expect(structured<{ features: Array<{ id: string }> }>(result).features.map((f) => f.id).sort()).toEqual(["d1", "kitchen"]);
    expect(structured(result)).not.toHaveProperty("omitted");

    const ring = Array.from({ length: 4000 }, (_, i) => i);
    const heavy = {
      ...clone(geometrySelect),
      features: Array.from({ length: 10 }, (_, i) => ({ i, id: `w${i}`, cls: "wall", name: "Wall", rings: [ring] })),
      missing: [],
    };
    ({ result } = await call(
      "get_element_outlines",
      { project_id: P, blueprint_id: "bpEval_a", ids: heavy.features.map((f) => f.id) },
      { [`POST /v1/projects/${P}/blueprints/bpEval_a/geometry/select`]: { body: heavy } },
    ));
    const out = structured<{ features: Array<{ id: string }>; omitted: string[] }>(result);
    expect(out.features.length + out.omitted.length).toBe(10);
    expect(out.omitted.length).toBeGreaterThan(0);
    expect(out.omitted).toEqual(heavy.features.slice(out.features.length).map((f) => f.id));
  });
});

describe("get_table_row_elements on a row that is gone", () => {
  const gone = {
    element_ids: {},
    element_count: 0,
    element_ids_truncated: false,
    problem: "That row is not in the table now.",
  };

  it("says so instead of answering with another row", async () => {
    const key = { folder: "Doors", sub_class: "double swing door", tag: "D4" };
    const { result } = await call("get_table_row_elements", { project_id: P, table: COUNT, row: 7, row_key: key }, {
      [`POST /v1/projects/${P}/query/table`]: { body: { ...clone(table), rows: [] } },
    });
    expect(structured(result)).toEqual(gone);
  });

  it("never takes a row with another key, even at the index it asked for", async () => {
    // The API answered with a row at the same index but a different key: that is another
    // row's elements under this row's label, which is exactly what must not be lit.
    const asked = table.rows[1]!;
    const other = { ...clone(table.rows[2]!), index: asked.index };
    const { result } = await call(
      "get_table_row_elements",
      { project_id: P, table: COUNT, row: asked.index, row_key: asked.key },
      { [`POST /v1/projects/${P}/query/table`]: { body: { ...clone(table), rows: [other] } } },
    );
    expect(structured(result)).toEqual(gone);
  });
});
