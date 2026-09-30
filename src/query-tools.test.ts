import { afterEach, describe, expect, it, vi } from "vitest";

import aggregateText from "./query/__fixtures__/aggregate-text.json" with { type: "json" };
import aggregate from "./query/__fixtures__/aggregate.json" with { type: "json" };
import scale from "./query/__fixtures__/scale.json" with { type: "json" };
import select from "./query/__fixtures__/select.json" with { type: "json" };
import wall from "./query/__fixtures__/wall-surface-area.json" with { type: "json" };
import { RESULT_BUDGET, capIds, compact, fitResult, resultCost } from "./query/budget.ts";
import { repairWhere } from "./query/filters.ts";
import { connect, errorText, stubApi, structured, type ApiReply } from "./testing/harness.ts";

// The query tools against the API contract. Fixtures under query/__fixtures__ are
// samples captured from the real routes on a synthetic "Eval Tower" project; fetch is
// the only stub.

afterEach(() => vi.unstubAllGlobals());

const clone = <T>(value: T): T => structuredClone(value);
const P = "proj-eval";

async function call(name: string, args: Record<string, unknown>, routes: Record<string, ApiReply>) {
  const calls = stubApi(routes);
  const client = await connect({ queryTools: true });
  const result = await client.callTool({ name, arguments: args });
  return { result, calls };
}

describe("request shape", () => {
  it("count_elements POSTs the filter to /query/aggregate", async () => {
    const { result, calls } = await call(
      "count_elements",
      { project_id: P, category: "doors", group_by: ["folder", "sub_class", "tag"], ids_per_group: 10, blueprint_ids: ["bp-a"] },
      { [`POST /v1/projects/${P}/query/aggregate`]: { body: clone(aggregate) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls).toEqual([
      {
        method: "POST",
        path: `/v1/projects/${P}/query/aggregate`,
        query: {},
        body: { category: "doors", blueprint_ids: ["bp-a"], group_by: ["folder", "sub_class", "tag"], ids_per_group: 10 },
      },
    ]);
  });

  it("find_elements POSTs order, limit and offset to /query/select", async () => {
    const { calls } = await call(
      "find_elements",
      { project_id: P, category: "rooms", name_contains: "kitchen", order_by: [{ field: "area_m2", dir: "desc" }], limit: 20, offset: 40 },
      { [`POST /v1/projects/${P}/query/select`]: { body: clone(select) } },
    );
    expect(calls[0]).toEqual({
      method: "POST",
      path: `/v1/projects/${P}/query/select`,
      query: {},
      body: { category: "rooms", name_contains: "kitchen", order_by: [{ field: "area_m2", dir: "desc" }], limit: 20, offset: 40 },
    });
  });

  it("sends `class` by its own name and every named filter as given", async () => {
    const { calls } = await call(
      "find_elements",
      {
        project_id: P,
        class: ["opening"],
        sub_class: ["single swing door"],
        tag: ["D1"],
        in_folder: "Doors",
        handing: ["LH"],
        related_to: ["s3f9a2c:room-kitchen"],
      },
      { [`POST /v1/projects/${P}/query/select`]: { body: clone(select) } },
    );
    expect(calls[0]!.body).toEqual({
      class: ["opening"],
      sub_class: ["single swing door"],
      tag: ["D1"],
      in_folder: "Doors",
      handing: ["LH"],
      related_to: ["s3f9a2c:room-kitchen"],
    });
  });

  it("looks the project up from the first blueprint when only blueprint_ids is given", async () => {
    const { calls } = await call("count_elements", { blueprint_ids: ["bp-a"], sub_class: ["toilet", "sink"] }, {
      "GET /v1/blueprints/bp-a": { body: { project_id: P, project_name: "Eval Tower", blueprint_id: "bp-a", name: "Ground Floor" } },
      [`POST /v1/projects/${P}/query/aggregate`]: { body: clone(aggregate) },
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/blueprints/bp-a",
      `POST /v1/projects/${P}/query/aggregate`,
    ]);
  });

  it("refuses a call with neither project_id nor blueprint_ids, before any request", async () => {
    const { result, calls } = await call("count_elements", { category: "doors" }, {});
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe("Pass project_id (list_blueprints lists them) or blueprint_ids.");
    expect(calls).toHaveLength(0);
  });

  it("calculate_wall_surface_area sends heights as stated, never converted", async () => {
    const { result, calls } = await call(
      "calculate_wall_surface_area",
      {
        project_id: P,
        name_contains: "kitchen",
        room_height: 2.7,
        room_height_unit: "m",
        room_height_quote: "Ceilings are 2.7 m.",
      },
      { [`POST /v1/projects/${P}/query/wall-surface-area`]: { body: clone(wall) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls[0]).toEqual({
      method: "POST",
      path: `/v1/projects/${P}/query/wall-surface-area`,
      query: {},
      body: {
        rooms: { name_contains: "kitchen" },
        room_height: { value: 2.7, unit: "m", quote: "Ceilings are 2.7 m." },
      },
    });
  });

  it("sends each opening height in its own slot, with its own words", async () => {
    // Not sending either one, or swapping them, passed all 253 tests.
    const { result, calls } = await call(
      "calculate_wall_surface_area",
      {
        project_id: P,
        blueprint_ids: ["bp-a"],
        door_height: 80,
        door_height_unit: "in",
        door_height_quote: "doors are 6'8\" high",
        window_height: 110,
        window_height_unit: "cm",
        window_height_quote: "windows are 110 cm",
      },
      { [`POST /v1/projects/${P}/query/wall-surface-area`]: { body: clone(wall) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls[0]!.body).toEqual({
      blueprint_ids: ["bp-a"],
      door_height: { value: 80, unit: "in", quote: "doors are 6'8\" high" },
      window_height: { value: 110, unit: "cm", quote: "windows are 110 cm" },
    });
  });

  it("sends a room choice by sub_class or folder as `rooms`, exactly", async () => {
    // Dropping either field from `rooms` measured every room ("wall area of the wet
    // rooms" priced the kitchen).
    const routes = { [`POST /v1/projects/${P}/query/wall-surface-area`]: { body: clone(wall) } };
    let { calls } = await call("calculate_wall_surface_area", { project_id: P, sub_class: ["wet room"] }, routes);
    expect(calls[0]!.body).toEqual({ rooms: { sub_class: ["wet room"] } });
    ({ calls } = await call("calculate_wall_surface_area", { project_id: P, in_folder: "Rooms", blueprint_ids: ["bp-a"] }, routes));
    expect(calls[0]!.body).toEqual({ blueprint_ids: ["bp-a"], rooms: { in_folder: "Rooms" } });
    ({ calls } = await call(
      "calculate_wall_surface_area",
      { project_id: P, name_contains: "bath", sub_class: ["wet room"], in_folder: "Rooms" },
      routes,
    ));
    expect(calls[0]!.body).toEqual({ rooms: { name_contains: "bath", sub_class: ["wet room"], in_folder: "Rooms" } });
  });

  it("passes a selection and room_refs through unchanged", async () => {
    const routes = { [`POST /v1/projects/${P}/query/wall-surface-area`]: { body: clone(wall) } };
    let { calls } = await call("calculate_wall_surface_area", { project_id: P, selection: select.selection }, routes);
    expect(calls[0]!.body).toEqual({ selection: select.selection });
    ({ calls } = await call("calculate_wall_surface_area", { project_id: P, room_refs: ["s3f9a2c:room-bath"] }, routes));
    expect(calls[0]!.body).toEqual({ room_refs: ["s3f9a2c:room-bath"] });
    ({ calls } = await call("calculate_wall_surface_area", { project_id: P, blueprint_ids: ["bp-a"] }, routes));
    expect(calls[0]!.body).toEqual({ blueprint_ids: ["bp-a"] });
  });

  it("set_scale PUTs the label", async () => {
    const { result, calls } = await call(
      "set_scale",
      { project_id: P, blueprint_id: "bp-a", scale: "1:100" },
      { [`PUT /v1/projects/${P}/blueprints/bp-a/scale`]: { body: clone(scale) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls[0]).toEqual({ method: "PUT", path: `/v1/projects/${P}/blueprints/bp-a/scale`, query: {}, body: { label: "1:100" } });
    expect(structured(result)).toMatchObject({ previous: { label: "1:100" }, stored_heights_reinterpreted: 1 });
  });

  it("set_scale reports a scale it set even when the previous one had no label", async () => {
    // The pipeline saves an unreadable sheet with a placeholder ratio and NO label. The
    // null failed the decode after the PUT had landed:
    // "internal error, try once more", the scan cache left stale, the reinterpreted
    // heights count lost.
    const unlabelled = { ...clone(scale), previous: { label: null, type: "metric", units: "si" } };
    const { result, calls } = await call(
      "set_scale",
      { project_id: P, blueprint_id: "bp-a", scale: "1:100" },
      { [`PUT /v1/projects/${P}/blueprints/bp-a/scale`]: { body: unlabelled } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(structured(result)).toMatchObject({
      previous: { label: null, type: "metric" },
      scale: { label: "1:100" },
      stored_heights_reinterpreted: scale.stored_heights_reinterpreted,
    });
  });
});

describe("strict inputs", () => {
  it("refuses an unknown key", async () => {
    const { result, calls } = await call("count_elements", { project_id: P, clas: "opening" }, {});
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/Unrecognized key/);
    expect(calls).toHaveLength(0);
  });

  it("refuses sub_class 'door' and lists the legal values", async () => {
    const { result, calls } = await call("count_elements", { project_id: P, sub_class: ["door"] }, {});
    expect(result.isError).toBe(true);
    const said = errorText(result);
    expect(said).toContain("single swing door");
    expect(said).toContain("safe room window");
    expect(calls).toHaveLength(0);
  });

  it("refuses a ref that is not a ref", async () => {
    const { result } = await call("find_elements", { project_id: P, related_to: ["room-kitchen"] }, {});
    expect(result.isError).toBe(true);
  });
});

describe("where repair", () => {
  it("drops the empty forms", () => {
    expect(repairWhere({})).toBeUndefined();
    expect(repairWhere([])).toBeUndefined();
    expect(repairWhere("")).toBeUndefined();
    expect(repairWhere("  {} ")).toBeUndefined();
    expect(repairWhere("[]")).toBeUndefined();
  });

  it("parses a double-encoded filter", () => {
    expect(repairWhere('{"field":"tag","op":"eq","value":"D1"}')).toEqual({ field: "tag", op: "eq", value: "D1" });
  });

  it("passes a string that is not JSON through for the grammar to judge", () => {
    expect(repairWhere("tag = D1")).toBe("tag = D1");
  });

  it("renames combinators at every depth, including inside not and related.match", () => {
    const repaired = repairWhere({
      allOf: [
        { not: { anyOf: [{ field: "tag", op: "eq", value: "D1" }] } },
        { related: { match: { ANY: [{ field: "class", op: "eq", value: "opening" }] }, count: { op: "gte", value: 2 } } },
        { spatial: { op: "near", of: { AllOf: [{ field: "kind", op: "eq", value: "text" }] }, distance_m: 1 } },
      ],
    });
    expect(repaired).toEqual({
      all: [
        { not: { any: [{ field: "tag", op: "eq", value: "D1" }] } },
        { related: { match: { any: [{ field: "class", op: "eq", value: "opening" }] }, count: { op: "gte", value: 2 } } },
        { spatial: { op: "near", of: { all: [{ field: "kind", op: "eq", value: "text" }] }, distance_m: 1 } },
      ],
    });
  });

  it("never rewrites meaning", () => {
    const leaf = { field: "Class", op: "EQ", value: "Opening" };
    expect(repairWhere(leaf)).toEqual(leaf);
  });

  it("is applied before the request: an empty where is not sent", async () => {
    const routes = { [`POST /v1/projects/${P}/query/aggregate`]: { body: clone(aggregate) } };
    let { calls } = await call("count_elements", { project_id: P, category: "walls", where: {} }, routes);
    expect(calls[0]!.body).toEqual({ category: "walls" });
    ({ calls } = await call("count_elements", { project_id: P, category: "walls", where: '{"anyOf":[{"field":"tag","op":"eq","value":"W1"}]}' }, routes));
    expect(calls[0]!.body).toEqual({ category: "walls", where: { any: [{ field: "tag", op: "eq", value: "W1" }] } });
  });
});

describe("errors", () => {
  const refuse = (status: number, body: unknown): ApiReply => ({ status, body });

  it("surfaces an invalid_request detail verbatim", async () => {
    const detail = "unknown field 'colour'. Known fields: kind, class, sub_class, color, …";
    const { result } = await call("count_elements", { project_id: P, where: { field: "colour", op: "eq", value: 1 } }, {
      [`POST /v1/projects/${P}/query/aggregate`]: refuse(400, { code: "invalid_request", detail }),
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(detail);
  });

  it("surfaces the validation handler's 422 the same way", async () => {
    const detail = "limit: Input should be less than or equal to 200";
    const { result } = await call("find_elements", { project_id: P, category: "rooms" }, {
      [`POST /v1/projects/${P}/query/select`]: refuse(422, { code: "invalid_request", detail }),
    });
    expect(errorText(result)).toBe(detail);
  });

  it("words a 403 and a 404 identically", async () => {
    const forbidden = await call("count_elements", { project_id: "theirs", category: "doors" }, {
      "POST /v1/projects/theirs/query/aggregate": refuse(403, { code: "forbidden" }),
    });
    const missing = await call("count_elements", { project_id: "nope", category: "doors" }, {
      "POST /v1/projects/nope/query/aggregate": refuse(404, { code: "not_found", detail: "No blueprint with that id is in this project." }),
    });
    expect(errorText(forbidden.result)).toBe(errorText(missing.result));
    expect(errorText(forbidden.result)).toMatch(/nothing with that id in this account/);
  });

  it("reads a bare 404 as a feature the server does not have yet", async () => {
    const { result } = await call("count_elements", { project_id: P, category: "doors" }, {});
    expect(errorText(result)).toMatch(/not available on the server yet\. Do not call it again/);
  });

  it("asks a busy caller to wait", async () => {
    const { result } = await call("count_elements", { project_id: P, category: "doors" }, {
      [`POST /v1/projects/${P}/query/aggregate`]: refuse(429, { code: "busy" }),
    });
    expect(errorText(result)).toMatch(/still running this account's other queries/);
  });

  it("points a scaleless blueprint at set_scale", async () => {
    const { result } = await call("calculate_wall_surface_area", { project_id: P, blueprint_ids: ["bp-u"] }, {
      [`POST /v1/projects/${P}/query/wall-surface-area`]: refuse(400, { code: "needs_scale" }),
    });
    expect(errorText(result)).toMatch(/set it with set_scale/);
  });

  it("calls a malformed response an internal error rather than passing it on", async () => {
    const bad = clone(select) as Record<string, unknown>;
    (bad.rows as Array<Record<string, unknown>>)[0]!.area = 12.4;
    const { result } = await call("find_elements", { project_id: P, category: "rooms" }, {
      [`POST /v1/projects/${P}/query/select`]: { body: bad },
    });
    expect(errorText(result)).toMatch(/internal error on find_elements/);
    expect(errorText(result)).not.toContain("12.4");
  });
});

describe("wall surface choices", () => {
  it("refuses a partial height before any request", async () => {
    for (const partial of [
      { room_height: 2.7, room_height_unit: "m" },
      { door_height: 2.1, door_height_quote: "doors are 2.1 m" },
      { window_height_unit: "cm", window_height_quote: "120 cm windows" },
    ]) {
      const { result, calls } = await call("calculate_wall_surface_area", { project_id: P, blueprint_ids: ["bp-a"], ...partial }, {});
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/or none of them/);
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses rooms chosen two ways", async () => {
    const { result, calls } = await call(
      "calculate_wall_surface_area",
      { project_id: P, selection: select.selection, name_contains: "bath" },
      {},
    );
    expect(errorText(result)).toMatch(/Choose the rooms one way/);
    expect(calls).toHaveLength(0);
  });

  it("needs blueprint_ids to measure every room", async () => {
    const { result, calls } = await call("calculate_wall_surface_area", { project_id: P }, {});
    expect(errorText(result)).toMatch(/Pass blueprint_ids/);
    expect(calls).toHaveLength(0);
  });

  it("allows only 'wet room' as a sub_class", async () => {
    const { result } = await call("calculate_wall_surface_area", { project_id: P, sub_class: ["toilet"] }, {});
    expect(result.isError).toBe(true);
  });
});

describe("result shaping", () => {
  it("never passes a raw SI field to the model", async () => {
    const sneaky = clone(aggregate) as Record<string, unknown>;
    (sneaky.groups as Array<Record<string, unknown>>)[0]!.width_min_m = 1.4;
    (sneaky.total as Record<string, unknown>).area_m2 = 99;
    const { result } = await call("count_elements", { project_id: P, category: "doors" }, {
      [`POST /v1/projects/${P}/query/aggregate`]: { body: sneaky },
    });
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/_m2?"/);
  });

  it("hoists what every row shares into rows_common", async () => {
    const { result } = await call("find_elements", { project_id: P, category: "doors" }, {
      [`POST /v1/projects/${P}/query/select`]: { body: clone(select) },
    });
    const out = structured<{ rows: Array<Record<string, unknown>>; rows_common: Record<string, unknown> }>(result);
    expect(out.rows_common).toMatchObject({
      blueprint_id: "bpEval_a",
      class: "opening",
      kind: "object",
      sub_class: "single swing door",
      folder: "Doors",
    });
    expect(out.rows[0]).not.toHaveProperty("class");
    expect(out.rows[0]).toMatchObject({ id: "d1", ref: "se0951e:d1", area: "0.40 m²", width: "100 cm wide" });
    // A field only one row carries is left on that row.
    expect(out.rows[0]).toMatchObject({ handing: "LH" });
    expect(out.rows[1]).not.toHaveProperty("handing");
  });

  it("keeps word ids apart from element ids, and caps them per result too", async () => {
    // Words came back as element_ids, which no editing tool takes and the outline route
    // cannot draw. aggregate-text.json is the API's real answer for a word count.
    const { result } = await call("count_elements", { project_id: P, category: "text", group_by: ["name"] }, {
      [`POST /v1/projects/${P}/query/aggregate`]: { body: clone(aggregateText) },
    });
    expect(result.isError, errorText(result)).toBeFalsy();
    type G = { element_ids?: unknown; element_count: number; text_ids: Record<string, string[]> };
    const out = structured<{ groups: G[] }>(result);
    expect(out.groups.map((g) => g.text_ids)).toEqual(aggregateText.groups.map((g) => g.text_ids));
    for (const group of out.groups) {
      expect(group.element_ids ?? {}).toEqual({});
      expect(group.element_count).toBe(0);
    }
    const many = clone(aggregateText) as Record<string, unknown>;
    many.groups = Array.from({ length: 30 }, (_, g) => ({
      name: `W${g}`,
      count: 25,
      element_count: 0,
      text_ids: { bpEval_a: Array.from({ length: 25 }, (_, i) => `t${g}_${i}`) },
      text_ids_truncated: false,
    }));
    const capped = await call("count_elements", { project_id: P, category: "text", group_by: ["name"] }, {
      [`POST /v1/projects/${P}/query/aggregate`]: { body: many },
    });
    const groups = structured<{ groups: Array<G & { text_ids_truncated?: boolean }> }>(capped.result).groups;
    expect(groups.reduce((n, g) => n + Object.values(g.text_ids ?? {}).flat().length, 0)).toBe(500);
    expect(groups[groups.length - 1]!.text_ids_truncated).toBe(true);
  });

  it("keeps a count's selection and element ids", async () => {
    const { result } = await call("count_elements", { project_id: P, category: "doors" }, {
      [`POST /v1/projects/${P}/query/aggregate`]: { body: clone(aggregate) },
    });
    const out = structured<{ selection: string; groups: Array<{ element_ids: Record<string, string[]> }> }>(result);
    expect(out.selection).toBe(aggregate.selection);
    // Ids are keyed by the blueprint each element is on, as the API returns them.
    expect(out.groups[1]!.element_ids).toEqual({ bpEval_a: ["d1"] });
    expect(out.groups[5]!.element_ids).toEqual({ bpEval_b: ["d_wc"] });
  });

  it("caps model-visible ids at 500 per result and flags the rows that lost some", async () => {
    const many = clone(aggregate) as Record<string, unknown>;
    many.groups = Array.from({ length: 30 }, (_, g) => ({
      folder: `F${g}`,
      count: 25,
      element_count: 25,
      element_ids: { "bp-a": Array.from({ length: 25 }, (_, i) => `e${g}-${i}`) },
      element_ids_truncated: false,
    }));
    const { result } = await call("count_elements", { project_id: P, category: "doors", group_by: ["folder"] }, {
      [`POST /v1/projects/${P}/query/aggregate`]: { body: many },
    });
    const out = structured<{ groups: Array<Record<string, unknown>>; groups_common: Record<string, unknown> }>(result);
    const groups = out.groups;
    const shown = groups.reduce((sum, g) => sum + Object.values((g.element_ids ?? {}) as Record<string, string[]>).flat().length, 0);
    expect(shown).toBe(500);
    expect(groups[19]!.element_ids_truncated).toBe(false);
    expect(groups[20]!.element_ids_truncated).toBe(true);
    // Every group has 25 elements, and the count stays on each group all the same.
    expect(groups[29]!.element_count).toBe(25);
    expect(out.groups_common?.element_count).toBeUndefined();
  });

  it("holds a count under the result budget, both copies counted", async () => {
    const huge = clone(aggregate) as Record<string, unknown>;
    huge.groups = Array.from({ length: 200 }, (_, g) => ({
      folder: `Folder ${g} ${"x".repeat(900)}`,
      count: 1,
      element_count: 1,
      element_ids: { "bp-a": [`e${g}`] },
    }));
    huge.groups_total = 200;
    const { result } = await call("count_elements", { project_id: P, category: "doors", group_by: ["folder"] }, {
      [`POST /v1/projects/${P}/query/aggregate`]: { body: huge },
    });
    const out = structured<{ groups: unknown[]; groups_truncated: boolean; groups_total: number; notes: string[]; total: { count: number } }>(result);
    // The whole result as a host receives it: content text plus structuredContent.
    expect(JSON.stringify(result.content).length + JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(RESULT_BUDGET);
    expect(out.groups.length).toBeLessThan(200);
    expect(out.groups_truncated).toBe(true);
    expect(out.groups_total).toBe(200);
    expect(out.total.count).toBe(aggregate.total.count);
    expect(out.notes.join(" ")).toMatch(/`total` still covers every group/);
  });

  it("asks for a smaller find page instead of cutting one, so selection and next_offset stay exact", async () => {
    const row = (i: number) => ({
      ref: `s3f9a2c:w${i}`,
      id: `w${i}`,
      blueprint_id: "bp-a",
      kind: "text",
      class: null,
      name: `WORD${i} ${"y".repeat(700)}`,
    });
    const page = (limit: number, offset: number) => ({
      ...clone(select),
      rows: Array.from({ length: limit }, (_, i) => row(offset + i)),
      total: 1000,
      returned: limit,
      offset,
      next_offset: offset + limit,
      selection: `q1.limit${limit}`,
    });
    const { result, calls } = await call("find_elements", { project_id: P, category: "text", limit: 200 }, {
      [`POST /v1/projects/${P}/query/select`]: (c) => {
        const body = c.body as { limit: number; offset?: number };
        return { body: page(body.limit, body.offset ?? 0) };
      },
    });
    expect(calls).toHaveLength(2);
    const smaller = (calls[1]!.body as { limit: number }).limit;
    expect(smaller).toBeLessThan(200);
    const out = structured<{ rows: unknown[]; next_offset: number; selection: string; notes: string[] }>(result);
    expect(out.rows).toHaveLength(smaller);
    expect(out.next_offset).toBe(smaller);
    expect(out.selection).toBe(`q1.limit${smaller}`);
    expect(out.notes.join(" ")).toMatch(/next_offset continues/);
    expect(resultCost(result.structuredContent)).toBeLessThanOrEqual(RESULT_BUDGET);
  });

  it("withdraws the selection of a page it had to cut, and moves next_offset back", async () => {
    const row = (i: number, size: number) => ({ ref: `s3f9a2c:w${i}`, id: `w${i}`, blueprint_id: "bp-a", name: `W${i} ${"y".repeat(size)}` });
    let reads = 0;
    const { result } = await call("find_elements", { project_id: P, category: "text", limit: 200 }, {
      [`POST /v1/projects/${P}/query/select`]: (c) => {
        reads += 1;
        const limit = (c.body as { limit: number }).limit;
        // The second read comes back bigger than the first: rows grew in between.
        const size = reads === 1 ? 700 : 1400;
        return { body: { ...clone(select), rows: Array.from({ length: limit }, (_, i) => row(i, size)), total: 1000, returned: limit, next_offset: limit, selection: "q1.x" } };
      },
    });
    const out = structured<{ rows: unknown[]; returned: number; next_offset: number; selection: string | null }>(result);
    expect(out.selection).toBeNull();
    expect(out.returned).toBe(out.rows.length);
    expect(out.next_offset).toBe(out.rows.length);
  });

  it("caps wall-surface element and opening ids separately", async () => {
    const big = clone(wall) as Record<string, unknown>;
    big.rooms = Array.from({ length: 40 }, (_, r) => ({
      ...(wall.rooms[0] as Record<string, unknown>),
      ref: `s3f9a2c:r${r}`,
      id: `r${r}`,
      element_ids: { "bp-a": Array.from({ length: 25 }, (_, i) => `f${r}-${i}`) },
      element_count: 60,
      element_ids_truncated: true,
      opening_ids: { "bp-a": Array.from({ length: 25 }, (_, i) => `o${r}-${i}`) },
      opening_count: 25,
      opening_ids_truncated: false,
    }));
    const { result } = await call("calculate_wall_surface_area", { project_id: P, blueprint_ids: ["bp-a"] }, {
      [`POST /v1/projects/${P}/query/wall-surface-area`]: { body: big },
    });
    const rooms = structured<{ rooms: Array<Record<string, Record<string, string[]>>> }>(result).rooms;
    const count = (key: string) => rooms.reduce((sum, r) => sum + Object.values(r[key] ?? {}).flat().length, 0);
    expect(count("element_ids")).toBe(500);
    expect(count("opening_ids")).toBe(500);
    expect(rooms[39]!.opening_ids_truncated).toBe(true);
  });
});

describe("budget helpers", () => {
  it("fitResult counts both copies and never drops the last entry", () => {
    const rows = Array.from({ length: 10 }, () => ({ blob: "z".repeat(60_000) }));
    const result: Record<string, unknown> = { rows, notes: [] };
    const dropped = fitResult(result, rows, (n) => `dropped ${n}`);
    expect(rows).toHaveLength(1);
    expect(dropped).toBe(9);
    expect(result.truncated).toBe(true);
    expect(result.notes).toEqual(["dropped 9"]);
  });

  it("fitResult leaves a result that fits alone", () => {
    const rows = [{ a: 1 }];
    const result: Record<string, unknown> = { rows, notes: [] };
    expect(fitResult(result, rows, () => "x")).toBe(0);
    expect(result).not.toHaveProperty("truncated");
    expect(resultCost(result)).toBeLessThan(RESULT_BUDGET);
  });

  it("capIds keeps row order and a row's count", () => {
    const rows = [
      { element_ids: { a: ["1", "2", "3"] }, element_count: 3 },
      { element_ids: { a: ["4"], b: ["5", "6"] }, element_count: 3 },
    ];
    capIds(rows, 4);
    expect(rows[0]).toEqual({ element_ids: { a: ["1", "2", "3"] }, element_count: 3 });
    expect(rows[1]).toEqual({ element_ids: { a: ["4"] }, element_count: 3, element_ids_truncated: true });
  });

  it("compact never hoists a count or a measurement, even when every row agrees", () => {
    const result: Record<string, unknown> = {
      groups: [
        { tag: "D1", count: 1, element_count: 1, width_min: "0.90 m", area: null },
        { tag: "D2", count: 1, element_count: 1, width_min: "0.90 m", area: null },
      ],
    };
    compact(result);
    expect(result).toEqual({
      groups: [
        { tag: "D1", count: 1, element_count: 1, width_min: "0.90 m" },
        { tag: "D2", count: 1, element_count: 1, width_min: "0.90 m" },
      ],
    });
  });

  it("compact drops what every row leaves empty and states constants once", () => {
    const result: Record<string, unknown> = {
      rows: [
        { id: "1", class: "room", tag: null, name: "A" },
        { id: "2", class: "room", tag: null, name: "B" },
      ],
    };
    compact(result);
    expect(result).toEqual({ rows: [{ id: "1", name: "A" }, { id: "2", name: "B" }], rows_common: { class: "room" } });
  });
});
