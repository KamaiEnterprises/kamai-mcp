import { afterEach, describe, expect, it, vi } from "vitest";

import printedTable from "./query/__fixtures__/printed-table.json" with { type: "json" };
import printedTablesIndex from "./query/__fixtures__/printed-tables-index.json" with { type: "json" };
import sheetText from "./query/__fixtures__/sheet-text.json" with { type: "json" };
import { RESULT_BUDGET } from "./query/budget.ts";
import { ROWS_PER_PAGE, WORDS_PER_PAGE } from "./query/drawing-text.ts";
import { connect, errorText, stubApi, structured, type ApiCall, type ApiReply } from "./testing/harness.ts";

// Fixtures are the API layer's own contract samples.

afterEach(() => vi.unstubAllGlobals());

const clone = <T>(value: T): T => structuredClone(value);
const P = "proj-eval";
const B = "bp-a";
const WORDS = `GET /v1/projects/${P}/blueprints/${B}/words`;
const TABLES = `POST /v1/projects/${P}/query/printed-tables`;

async function call(name: string, args: Record<string, unknown>, routes: Record<string, ApiReply>) {
  const calls = stubApi(routes);
  const client = await connect({ queryTools: true, printedTables: true });
  const result = await client.callTool({ name, arguments: args });
  return { result, calls };
}

describe("get_sheet_text", () => {
  it("passes every filter through as query parameters, with the default page size", async () => {
    const { result, calls } = await call(
      "get_sheet_text",
      { project_id: P, blueprint_id: B, q: "kitchen", room_id: "r1", source: "ocr", bbox: [0, 0, 0.5, 0.5], fields: ["rot", "conf"], cursor: "c1" },
      { [WORDS]: { body: clone(sheetText) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls).toEqual([
      {
        method: "GET",
        path: `/v1/projects/${P}/blueprints/${B}/words`,
        query: { q: "kitchen", room_id: "r1", source: "ocr", bbox: "0,0,0.5,0.5", fields: "text,bbox,source,room,rot,conf", cursor: "c1", limit: String(WORDS_PER_PAGE) },
        body: undefined,
      },
    ]);
  });

  it("asks for the default word fields along with the extras, so every word keeps its text", async () => {
    const { result, calls } = await call(
      "get_sheet_text",
      { project_id: P, blueprint_id: B, q: "DOOR", fields: ["conf", "polygon", "id", "text"] },
      { [WORDS]: { body: clone(sheetText) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls[0]?.query?.fields).toBe("text,bbox,source,room,conf,polygon,id");
  });

  it("returns the API's result unchanged", async () => {
    const { result } = await call("get_sheet_text", { project_id: P, blueprint_id: B }, { [WORDS]: { body: clone(sheetText) } });
    expect(structured(result)).toEqual(sheetText);
  });

  it("passes a sheet that was never read through with its status and note", async () => {
    const notRead = { status: "not_read", total: null, next_cursor: null, rooms: {}, words: [], note: "This sheet was never processed." };
    const { result } = await call("get_sheet_text", { project_id: P, blueprint_id: B }, { [WORDS]: { body: clone(notRead) } });
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(structured(result)).toEqual(notRead);
  });

  it("asks again with a smaller limit rather than dropping words from a page", async () => {
    const word = { text: "X".repeat(60), bbox: [0.1, 0.1, 0.2, 0.2], source: "digital", room_id: null };
    const page = (limit: number) => ({ status: "ok", total: 5000, next_cursor: String(limit), rooms: {}, words: Array.from({ length: limit }, () => word) });
    const { result, calls } = await call(
      "get_sheet_text",
      { project_id: P, blueprint_id: B, limit: 2000 },
      { [WORDS]: (c: ApiCall) => ({ body: page(Number(c.query.limit)) }) },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls.length).toBeGreaterThan(1);
    const last = Number(calls.at(-1)!.query.limit);
    expect(last).toBeLessThan(2000);
    const out = structured<{ words: unknown[]; next_cursor: string }>(result);
    expect(out.words).toHaveLength(last);
    expect(out.next_cursor).toBe(String(last));
    expect(JSON.stringify(out).length * 2).toBeLessThan(RESULT_BUDGET * 1.1);
  });

  it("flags a page that still does not fit instead of returning it as if it did", async () => {
    const word = { text: "X".repeat(RESULT_BUDGET), bbox: [0.1, 0.1, 0.2, 0.2], source: "digital", room_id: null };
    const { result } = await call(
      "get_sheet_text",
      { project_id: P, blueprint_id: B },
      { [WORDS]: { body: { status: "ok", total: 1, next_cursor: null, rooms: {}, words: [word] } } },
    );
    const out = structured<{ oversized?: boolean; notes?: string[]; words: unknown[] }>(result);
    expect(out.words).toHaveLength(1);
    expect(out.oversized).toBe(true);
    expect(out.notes?.at(-1)).toMatch(/smaller limit/);
  });

  it("passes the API layer's fix message for a bad request through to the model", async () => {
    const detail = "unknown fields: nope";
    const { result } = await call("get_sheet_text", { project_id: P, blueprint_id: B, fields: ["nope"] }, {
      [WORDS]: { status: 422, body: { code: "invalid_request", detail } },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe(detail);
  });

  it("finds the project from the blueprint when project_id is left out", async () => {
    const { calls } = await call(
      "get_sheet_text",
      { blueprint_id: B },
      {
        [`GET /v1/blueprints/${B}`]: { body: { blueprint_id: B, project_id: P } },
        [WORDS]: { body: clone(sheetText) },
      },
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/blueprints/${B}`, `GET /v1/projects/${P}/blueprints/${B}/words`]);
  });
});

describe("get_printed_tables", () => {
  it("lists tables: POSTs only what was given, plus the default page size", async () => {
    const { result, calls } = await call(
      "get_printed_tables",
      { project_id: P, blueprint_ids: [B], q: "door" },
      { [TABLES]: { body: clone(printedTablesIndex) } },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls[0]!.body).toEqual({ blueprint_ids: [B], q: "door", limit: ROWS_PER_PAGE });
    expect(structured(result)).toEqual(printedTablesIndex);
  });

  it("reads one table with its id, format and cursor passed through", async () => {
    const { result, calls } = await call(
      "get_printed_tables",
      { project_id: P, table_id: "bp-a.r3.t1", format: "rows", cursor: "c:1", limit: 50 },
      { [TABLES]: { body: clone(printedTable) } },
    );
    expect(calls[0]!.body).toEqual({ table_id: "bp-a.r3.t1", format: "rows", cursor: "c:1", limit: 50 });
    expect(structured(result)).toEqual(printedTable);
  });

  it("passes a re-extracted table through as not_found", async () => {
    const gone = { status: "not_found", reason: "re_extracted", note: "List the tables again." };
    const { result } = await call("get_printed_tables", { project_id: P, table_id: "bp-a.r2.t1" }, { [TABLES]: { body: clone(gone) } });
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(structured(result)).toEqual(gone);
  });

  it("needs a project or blueprints", async () => {
    const { result, calls } = await call("get_printed_tables", { table_id: "bp-a.r3.t1" }, {});
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/project_id/);
    expect(calls).toEqual([]);
  });

  it("is off without the query tools", async () => {
    const client = await connect({ queryTools: false, printedTables: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("get_printed_tables");
    expect(names).not.toContain("get_sheet_text");
  });

  it("stays off with the query tools until KAMAI_PRINTED_TABLES, and get_sheet_text does not name it", async () => {
    const tools = (await (await connect({ queryTools: true, printedTables: false })).listTools()).tools;
    expect(tools.map((t) => t.name)).toContain("get_sheet_text");
    expect(tools.map((t) => t.name)).not.toContain("get_printed_tables");
    expect(tools.find((t) => t.name === "get_sheet_text")!.description).not.toContain("get_printed_tables");
    const on = (await (await connect({ queryTools: true, printedTables: true })).listTools()).tools;
    expect(on.find((t) => t.name === "get_sheet_text")!.description).toContain("get_printed_tables");
  });
});

describe("sheet identity", () => {
  const identity = { sheet_number: "A-101", title: "FIRST FLOOR PLAN", discipline: "A", sheet_type: 1, sheet_type_label: "Plans", levels: ["L1"] };

  it("carries the nested identity on a project's blueprints and on a blueprint's detail", async () => {
    const { blueprintDetailSchema, projectDetailSchema } = await import("./api.ts");
    const detail = blueprintDetailSchema.parse({
      blueprint_id: B, name: "Ground", project_id: P, project_name: "Eval", state: "ready", progress: 100, failed: false, identity,
    });
    expect(detail.identity).toEqual(identity);
    const project = projectDetailSchema.parse({ id: P, name: "Eval", description: "", blueprints: [{ id: B, name: "Ground", ready: true, identity }], jobs: [] });
    expect(project.blueprints[0]!.identity).toEqual(identity);
  });

  it("reads a blueprint without identity, from an API that does not send it yet", async () => {
    const { blueprintDetailSchema } = await import("./api.ts");
    const detail = blueprintDetailSchema.parse({ blueprint_id: B, project_id: P, project_name: "Eval", state: "ready", progress: 100, failed: false });
    expect(detail.identity).toBeUndefined();
  });
});
