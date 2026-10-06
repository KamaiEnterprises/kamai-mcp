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
      rows: [{ id: "r1", cells: { type: "Single", count: 2 }, element_ids: ["a", "b"] }],
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
