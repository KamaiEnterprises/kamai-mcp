import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, errorText, stubApi, structured } from "./testing/harness.ts";

// `export` is a thin client like every other tool: it calls the MCP API layer with the user's
// token. The export service and its credentials live behind that layer, never here.

const OK = { format: "xlsx", url: "https://signed.example/x.xlsx", file_name: "Doors.xlsx", bytes: 1234, expires_in: 900, badges: 3 };

afterEach(() => vi.unstubAllGlobals());

describe("export", () => {
  it("is a query tool: absent when the query tools are off", async () => {
    const off = await connect({ queryTools: false });
    expect((await off.listTools()).tools.map((t) => t.name)).not.toContain("export");
    const on = await connect({ queryTools: true });
    expect((await on.listTools()).tools.map((t) => t.name)).toContain("export");
  });

  it("posts the table to the API layer with the user's token and nothing else", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: OK } });
    const stub = globalThis.fetch;
    const seen: Array<{ url: string; auth?: string }> = [];
    vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) => {
      seen.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return stub(input, init);
    });
    const client = await connect({ queryTools: true });
    const table = {
      name: "Doors",
      columns: [{ key: "type", label: "Type" }, { key: "count", label: "Count", type: "number" }],
      rows: [{ id: "r1", cells: { type: "Single", count: 2 }, element_ids: { bp1: ["a", "b"] } }],
    };
    const result = await client.callTool({
      name: "export",
      arguments: { project_id: "p1", format: "xlsx", blueprint_id: "bp1", table },
    });
    expect(structured(result)).toMatchObject({ file_name: "Doors.xlsx", badges: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ format: "xlsx", blueprint_id: "bp1", table });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe("Bearer test");
    expect(seen[0]!.url).toContain("/v1/projects/p1/export");
    expect(seen[0]!.url).not.toContain("metadata.google.internal");
  });

  // A model copying render_table's rows passed 25 ids per row, so door 26 of 26 got no #N.
  // By selection, Kamai builds the rows itself with every id.
  it("passes a selection, its name and language through to Kamai, and no table", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: OK } });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({
      name: "export",
      arguments: { project_id: "p1", format: "pdf", blueprint_id: "bp1", selection: "q1.abc", name: "Doors", language: "he" },
    });
    expect(structured(result)).toMatchObject({ file_name: "Doors.xlsx" });
    expect(calls[0]!.body).toEqual({ format: "pdf", blueprint_id: "bp1", selection: "q1.abc", name: "Doors", language: "he" });
  });

  it("takes exactly one of selection, table or saved_table_id", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: OK } });
    const client = await connect({ queryTools: true });
    // A selection is a q1/w1 token, checked here before Kamai sees it
    const bad = await client.callTool({ name: "export", arguments: { project_id: "p1", format: "xlsx", selection: "all" } });
    expect(bad.isError).toBe(true);
    for (const extra of [{}, { selection: "q1.abc", saved_table_id: "s1" }]) {
      const result = await client.callTool({ name: "export", arguments: { project_id: "p1", format: "xlsx", ...extra } });
      expect(errorText(result)).toMatch(/one of `selection`, `table` or `saved_table_id`/);
    }
    expect(calls).toHaveLength(0);
  });

  const PLAN = {
    blueprint_id: "bp1", name: "Ground Floor", project_id: "p1", project_name: "Tower",
    url: "https://signed.example/plan.pdf", file_name: "Ground Floor - marked.pdf", format: "pdf",
    expires_in: 900, bytes: 99, elements: 8, unmatched_highlight: ["zeppelin"], missing_ids: [],
    legend: [{ label: "single swing door", count: 3, color: { r: 1, g: 2, b: 3, a: 255 } }],
  };

  it("exports a plan when no table is given: the drawing alone, the legend only when asked", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: PLAN } });
    const client = await connect({ queryTools: true });
    const plain = await client.callTool({ name: "export", arguments: { project_id: "p1", blueprint_id: "bp1", highlight: ["doors, windows"] } });
    await client.callTool({ name: "export", arguments: { project_id: "p1", blueprint_id: "bp1", format: "pdf", legend: true } });
    expect(calls.map((c) => c.body)).toEqual([{ highlight: ["doors", "windows"] }, { legend: true }]);
    expect(structured(plain)).toMatchObject({ file_name: PLAN.file_name, elements: 8, unmatched_highlight: ["zeppelin"] });
  });

  it("finds a plan's project from its blueprint", async () => {
    const calls = stubApi({
      "GET /v1/blueprints/bp1": { body: { project_id: "p1", project_name: "Tower", blueprint_id: "bp1", name: "Ground Floor" } },
      "POST /v1/projects/p1/blueprints/bp1/export": { body: PLAN },
    });
    const client = await connect({ queryTools: true });
    await client.callTool({ name: "export", arguments: { blueprint_id: "bp1", element_ids: ["d1"] } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/blueprints/bp1", "POST /v1/projects/p1/blueprints/bp1/export"]);
    expect(calls[1]!.body).toEqual({ element_ids: ["d1"] });
  });

  it("keeps plan and table arguments apart", async () => {
    const calls = stubApi({});
    const client = await connect({ queryTools: true });
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ project_id: "p1", blueprint_id: "bp1", format: "xlsx" }, /plan export is a pdf/],
      [{ project_id: "p1", blueprint_ids: ["bp1", "bp2"] }, /one sheet/],
      [{ project_id: "p1", blueprint_id: "bp1", blueprint_ids: ["bp2"] }, /one sheet/],
      [{ project_id: "p1", blueprint_id: "bp1", name: "Doors" }, /belong to a table export/],
      [{ project_id: "p1", blueprint_id: "bp1", language: "he" }, /belong to a table export/],
      [{ project_id: "p1", format: "xlsx", saved_table_id: "s1", blueprint_ids: ["bp1", "bp2"] }, /Only a pdf draws several sheets/],
      [{ project_id: "p1", format: "xlsx", include_plan: true, table: { columns: [{ key: "a", label: "A" }], rows: [] } }, /`include_plan` needs `blueprint_id`/],
      [{ project_id: "p1", blueprint_id: "bp1", include_plan: true }, /belong to a table export/],
      [{ project_id: "p1", format: "pdf", saved_table_id: "s1", highlight: ["doors"] }, /belong to a plan export/],
      [{ project_id: "p1", format: "pdf", saved_table_id: "s1", legend: false }, /belong to a plan export/],
      [{ project_id: "p1", saved_table_id: "s1" }, /needs `format`/],
      [{ project_id: "p1", format: "pdf", include_plan: true, table: { columns: [{ key: "a", label: "A" }], rows: [] } }, /with `include_plan` needs `blueprint_id`/],
    ];
    for (const [args, message] of cases) {
      expect(errorText(await client.callTool({ name: "export", arguments: args })), JSON.stringify(args)).toMatch(message);
    }
    expect(calls).toHaveLength(0);
  });

  it("sends include_plan as given: a pdf of the table alone needs no sheet", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: OK } });
    const client = await connect({ queryTools: true });
    const table = { columns: [{ key: "a", label: "A" }], rows: [{ id: "r1", cells: { a: 1 } }] };
    await client.callTool({ name: "export", arguments: { project_id: "p1", format: "pdf", table } });
    await client.callTool({ name: "export", arguments: { project_id: "p1", format: "pdf", table, blueprint_id: "bp1", include_plan: true } });
    await client.callTool({ name: "export", arguments: { project_id: "p1", format: "xlsx", table, blueprint_id: "bp1", include_plan: false } });
    await client.callTool({ name: "export", arguments: { project_id: "p1", format: "csv_cf", table, include_plan: true } });
    expect(calls.map((c) => { const b = c.body as Record<string, unknown>; return [b.format, b.include_plan, b.blueprint_id]; })).toEqual([
      ["pdf", undefined, undefined], ["pdf", true, "bp1"], ["xlsx", false, "bp1"], ["csv_cf", true, undefined],
    ]);
  });

  it("takes several sheets for a table with no drawing, and finds the project from them", async () => {
    const calls = stubApi({
      "GET /v1/blueprints/bp1": { body: { project_id: "p1", project_name: "Tower", blueprint_id: "bp1", name: "Ground Floor" } },
      "POST /v1/projects/p1/export": { body: OK },
    });
    const client = await connect({ queryTools: true });
    const table = { columns: [{ key: "a", label: "A" }], rows: [{ id: "r1", cells: { a: 1 } }] };
    await client.callTool({ name: "export", arguments: { format: "xlsx", table, blueprint_ids: ["bp1", "bp2"], include_plan: false } });
    await client.callTool({ name: "export", arguments: { format: "pdf", table, blueprint_ids: ["bp1", "bp2"], include_plan: true } });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/blueprints/bp1", "POST /v1/projects/p1/export", "GET /v1/blueprints/bp1", "POST /v1/projects/p1/export",
    ]);
  });

  // Copilot: a table export by selection came without project_id once project_id stopped being required.
  it("says a table needs project_id, in the parameter and in the refusal", async () => {
    const calls = stubApi({});
    const client = await connect({ queryTools: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === "export")!;
    expect((tool.inputSchema.properties as any).project_id.description).toMatch(/Required for a table/);
    expect(tool.description).toMatch(/A table: give `project_id`/);
    const result = await client.callTool({ name: "export", arguments: { format: "pdf", selection: "q1.abc" } });
    expect(errorText(result)).toMatch(/A table export needs `project_id`: the project the table's elements are in/);
    expect(calls).toHaveLength(0);
  });

  it("says files are made here, never in a code sandbox, and leads with selection", async () => {
    const tool = (await (await connect({ queryTools: true })).listTools()).tools.find((t) => t.name === "export")!;
    expect(tool.description).toMatch(/never build a spreadsheet, PDF or CSV yourself in a code sandbox/);
    expect(tool.description!.indexOf("`selection`")).toBeLessThan(tool.description!.indexOf("`table`"));
  });

  // Microsoft 365 Copilot never offered export while element_ids was array-or-map (2026-10-12 23:5xZ); render_table's
  // map-only form is offered. Keep the export input free of an anyOf that mixes an array and an object.
  it("declares element_ids as one {blueprint_id: [ids]} map, never array-or-map", async () => {
    const client = await connect({ queryTools: true });
    const tool = (await client.listTools()).tools.find((t) => t.name === "export")!;
    const rows = (tool.inputSchema.properties as any).table.properties.rows.items.properties;
    expect(rows.element_ids.type).toBe("object");
    expect(rows.element_ids.additionalProperties.type).toBe("array");
    const mixed = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(mixed);
      if (!node || typeof node !== "object") return false;
      const o = node as Record<string, unknown>;
      const types = Array.isArray(o.anyOf) ? (o.anyOf as Array<{ type?: string }>).map((x) => x.type) : [];
      return (types.includes("array") && types.includes("object")) || Object.values(o).some(mixed);
    };
    expect(mixed(tool.inputSchema)).toBe(false);
  });

  it("still takes the old bare-array element_ids and hands it to the API as it came", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: OK } });
    const client = await connect({ queryTools: true });
    const table = { columns: [{ key: "k", label: "K" }], rows: [{ cells: { k: 1 }, element_ids: ["a", "b"] }, { cells: { k: 2 }, element_ids: { bp1: ["c"] } }] };
    const result = await client.callTool({ name: "export", arguments: { project_id: "p1", format: "xlsx", blueprint_id: "bp1", table } });
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.body).toEqual({ format: "xlsx", blueprint_id: "bp1", table });
  });

  it("never drops a map's other sheets, whatever its keys", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: OK } });
    const client = await connect({ queryTools: true });
    const table = { columns: [{ key: "k", label: "K" }], rows: [{ cells: { k: 1 }, element_ids: { "\u0000bare": ["a"], bp2: ["b"] } }] };
    await client.callTool({ name: "export", arguments: { project_id: "p1", format: "xlsx", blueprint_id: "bp1", table } });
    expect(calls[0]!.body).toEqual({ format: "xlsx", blueprint_id: "bp1", table });
  });

  it("passes a render_table result through as returned", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: OK } });
    const client = await connect({ queryTools: true });
    const table = {
      title: "Doors",
      columns: [{ key: "type", label: "Type", unit: null, align: "left" }],
      rows: [{ index: 0, kind: "group", cells: { type: "Single" }, element_ids: { bp1: ["a"] }, element_count: 1, element_ids_truncated: false }],
    };
    const result = await client.callTool({ name: "export", arguments: { project_id: "p1", format: "png", blueprint_id: "bp1", table } });
    expect(result.isError).toBeFalsy();
    expect((calls[0]!.body as { table: unknown }).table).toEqual(table);
  });

  it("sends every sheet of a multi-sheet pdf", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: { ...OK, format: "pdf" } } });
    const client = await connect({ queryTools: true });
    const table = {
      columns: [{ key: "type", label: "Type" }],
      rows: [{ index: 0, cells: { type: "Door" }, element_ids: { bp1: ["a"], bp2: ["b"] } }],
    };
    const result = await client.callTool({
      name: "export",
      arguments: { project_id: "p1", format: "pdf", blueprint_ids: ["bp1", "bp2"], table },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.body).toEqual({ format: "pdf", blueprint_ids: ["bp1", "bp2"], table });
  });

  it("refuses several sheets for a png before calling anything", async () => {
    const calls = stubApi({});
    const client = await connect({ queryTools: true });
    const table = { columns: [{ key: "type", label: "Type" }], rows: [] };
    const result = await client.callTool({
      name: "export",
      arguments: { project_id: "p1", format: "png", blueprint_ids: ["bp1", "bp2"], table },
    });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("Only a pdf");
    expect(calls).toHaveLength(0);
  });

  it("refuses an empty sheet id before calling anything", async () => {
    const calls = stubApi({});
    const client = await connect({ queryTools: true });
    const table = { columns: [{ key: "type", label: "Type" }], rows: [] };
    const result = await client.callTool({
      name: "export",
      arguments: { project_id: "p1", format: "pdf", blueprint_ids: ["bp1", ""], table },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("passes a saved table by id", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/export": { body: { ...OK, format: "pdf" } } });
    const client = await connect({ queryTools: true });
    await client.callTool({ name: "export", arguments: { project_id: "p1", format: "pdf", saved_table_id: "s1" } });
    expect(calls[0]!.body).toEqual({ format: "pdf", saved_table_id: "s1" });
  });

  it("asks for a table or a saved table before calling anything", async () => {
    const calls = stubApi({});
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "export", arguments: { project_id: "p1", format: "xlsx" } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("saved_table_id");
    expect(calls).toHaveLength(0);
  });

  it("uses the shared refusal wording", async () => {
    stubApi({ "POST /v1/projects/p9/export": { status: 404, body: { code: "not_found", detail: "Project not found" } } });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "export", arguments: { project_id: "p9", format: "pdf", saved_table_id: "s1" } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toContain("nothing with that id");
  });

  it("says when the API layer does not have the route yet", async () => {
    stubApi({});
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "export", arguments: { project_id: "p1", format: "pdf", saved_table_id: "s1" } });
    expect(errorText(result)).toContain("not available on the server yet");
  });
});
