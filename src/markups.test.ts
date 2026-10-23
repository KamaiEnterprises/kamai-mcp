import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, errorText, stubApi, structured } from "./testing/harness.ts";

const base = "/v1/projects/p1/blueprints/bp1/markups";
const cloud = {
  id: "mk_1", kind: "cloud", blueprint_id: "bp1", box: [0.1, 0.1, 0.3, 0.3], text: null,
  delta: 1, version: 1, can_edit: true, style: { color: "#E4462A" },
};
const MARKUP_TOOLS = ["add_markup", "clip_markups", "delete_markup", "list_markups", "update_markup"];

async function tools(markups: boolean) {
  const client = await connect({ markups });
  return (await client.listTools()).tools;
}

describe("markup tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mark every change to an existing markup destructive (ChatGPT's review holds update_markup otherwise)", async () => {
    const hints = Object.fromEntries((await tools(true)).filter((t) => MARKUP_TOOLS.includes(t.name)).map((t) => [t.name, t.annotations]));
    expect(hints.update_markup).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(hints.delete_markup).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hints.add_markup).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.list_markups).toMatchObject({ readOnlyHint: true });
    expect(hints.clip_markups).toMatchObject({ readOnlyHint: true });
  });

  it("are listed only with the flag, and download_plan gains include_markups only then", async () => {
    const off = await tools(false);
    expect(off.map((t) => t.name).filter((n) => MARKUP_TOOLS.includes(n))).toEqual([]);
    expect(off.find((t) => t.name === "download_plan")!.inputSchema.properties).not.toHaveProperty("include_markups");
    const on = await tools(true);
    expect(on.map((t) => t.name).filter((n) => MARKUP_TOOLS.includes(n)).sort()).toEqual(MARKUP_TOOLS);
    expect(on.find((t) => t.name === "download_plan")!.inputSchema.properties).toHaveProperty("include_markups");
    for (const t of on.filter((t) => MARKUP_TOOLS.includes(t.name))) {
      expect(Object.keys(t.annotations ?? {}).sort()).toEqual(
        ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"]);
    }
  });

  it("pass add_markup through unchanged and return only data", async () => {
    const calls = stubApi({ [`POST ${base}`]: { body: { status: "created", markup: cloud } } });
    const client = await connect({ markups: true });
    const result = await client.callTool({
      name: "add_markup",
      arguments: { blueprint_id: "bp1", project_id: "p1", kind: "note", box: [0.5, 0.5, 0.7, 0.55], pointer: [0.2, 0.8], text: "Missing door?" },
    });
    expect(calls[0]!.body).toEqual({ kind: "note", box: [0.5, 0.5, 0.7, 0.55], pointer: [0.2, 0.8], text: "Missing door?" });
    expect(structured(result)).toMatchObject({ status: "created", markup: { id: "mk_1" } });
    expect((result.content as { type: string }[]).length).toBe(1);
  });

  it("sends the version on update and delete, and hands a conflict back as data", async () => {
    const calls = stubApi({
      [`PATCH ${base}/mk_1`]: { body: { status: "conflict", markup: { ...cloud, version: 2 } } },
      [`DELETE ${base}/mk_1`]: { body: { status: "deleted", markup: { ...cloud, deleted: true } } },
    });
    const client = await connect({ markups: true });
    const up = await client.callTool({ name: "update_markup", arguments: { blueprint_id: "bp1", project_id: "p1", markup_id: "mk_1", version: 1, text: "x" } });
    expect(calls[0]!.body).toEqual({ version: 1, text: "x" });
    expect(structured(up)).toMatchObject({ status: "conflict", markup: { version: 2 } });
    await client.callTool({ name: "delete_markup", arguments: { blueprint_id: "bp1", project_id: "p1", markup_id: "mk_1", version: 2 } });
    expect(calls[1]!.query).toEqual({ version: "2" });
  });

  it("returns the clip link as data, with no instruction text in the result", async () => {
    const clip = {
      blueprint_id: "bp1", name: "Ground Floor", url: "https://storage.googleapis.com/x.pdf?sig=s",
      file_name: "Ground Floor - clip.pdf", bytes: 999, expires_in: 900, page: "A4", markups: 1,
    };
    const calls = stubApi({ [`POST ${base}/clip`]: { body: clip } });
    const client = await connect({ markups: true });
    const result = await client.callTool({ name: "clip_markups", arguments: { blueprint_id: "bp1", project_id: "p1", box: [0.1, 0.1, 0.5, 0.5] } });
    expect(calls[0]!.body).toEqual({ box: [0.1, 0.1, 0.5, 0.5] });
    const texts = (result.content as { text: string }[]).map((c) => c.text);
    expect(texts).toHaveLength(1);
    expect(JSON.parse(texts[0]!)).toEqual(clip);
  });

  it("refuses positions outside the page before calling the API", async () => {
    const calls = stubApi({});
    const client = await connect({ markups: true });
    const result = await client.callTool({ name: "add_markup", arguments: { blueprint_id: "bp1", project_id: "p1", kind: "cloud", box: [0.1, 0.1, 1.5, 0.2] } });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("shows the API layer's fix message for a refused markup", async () => {
    stubApi({ [`POST ${base}`]: { status: 400, body: { code: "invalid_request", status: 400, detail: "a highlight takes points (the stroke), not a box" } } });
    const client = await connect({ markups: true });
    const result = await client.callTool({ name: "add_markup", arguments: { blueprint_id: "bp1", project_id: "p1", kind: "highlight", box: [0.1, 0.1, 0.2, 0.2] } });
    expect(errorText(result)).toBe("a highlight takes points (the stroke), not a box");
  });

  it("sends include_markups on download_plan only when asked", async () => {
    const exported = {
      blueprint_id: "bp1", project_id: "p1", url: "u", file_name: "f.pdf", format: "pdf", expires_in: 900,
      bytes: 1, elements: 0, legend: [], unmatched_highlight: [], missing_ids: [], markups: 2,
    };
    const calls = stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: exported } });
    const client = await connect({ markups: true });
    await client.callTool({ name: "download_plan", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    await client.callTool({ name: "download_plan", arguments: { blueprint_id: "bp1", project_id: "p1", include_markups: true } });
    expect(calls.map((c) => c.body)).toEqual([{}, { include_markups: true }]);
  });
});
