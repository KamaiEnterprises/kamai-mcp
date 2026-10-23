import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "./server.ts";

/** A floor plan states no vertical dimension, so every height this tool writes
 * is a figure a person supplied. The tests are weighted at the seams that
 * matter: a figure without its unit must not reach the wire, and an element
 * the API layer turned away must never be counted inside a success.
 *
 * Everything drives the registered MCP tool over an in-memory transport, the
 * way the list_elements tests do, so what is exercised is the tool a host
 * actually calls and not a function only the tests can reach. `fetch` is the
 * only stub. */
describe("set_opening_height", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function connect(queryTools = false) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    const server = buildServer({ uid: "test", token: "test" }, {}, { queryTools });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  type Call = { url: string; method: string; body: Record<string, unknown> };
  type Reply = { status: number; body: unknown };

  /** The API layer's batch route: POST /v1/projects/{p}/blueprints/{b}/opening-pieces with the
   * whole selection. Kamai decides what is written and what is
   * refused; this stub does what the route does.
   *
   * `replies` is keyed by element id. A 409 or a coded 404 refuses that element alone
   * (wrong_class / not_found) and the rest are written; any other reply refuses the whole call
   * and is the route's answer; an id with no entry is written and read back. */
  function stubPatch(calls: Call[], replies: Record<string, Reply> = {}) {
    vi.stubGlobal("fetch", async (url: URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: String(url), method: init?.method ?? "GET", body });
      const height = body.height as { value: number } | undefined;
      const respond = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      const written: unknown[] = [];
      const refused: unknown[] = [];
      for (const id of [...new Set(body.ids as string[])]) {
        const reply = replies[id];
        const coded = (reply?.body as { code?: string } | undefined)?.code;
        if (reply?.status === 409) refused.push({ id, code: "wrong_class", detail: "wrong class" });
        else if (reply?.status === 404 && coded === "not_found") refused.push({ id, code: "not_found", detail: "gone" });
        else if (reply && reply.status !== 200) return respond(reply.status, reply.body);
        else
          written.push(reply?.body ?? {
            id,
            tag: body.tag ?? null,
            height_units: height === undefined ? null : 100,
            height_m: height === undefined ? null : 2.1,
            feature_class: "wall_surface_with_opening",
          });
      }
      const fields = [...(height === undefined ? [] : ["height"]), ...(body.tag === undefined ? [] : ["tag"])];
      return respond(200, { applied: written.length > 0, changed: written.length, fields, written, refused });
    });
  }

  /** What the API layer sends when the write is refused, as problem+json with the
   * frozen `code` vocabulary. The wrong-class refusal is invalid_request with 409:
   * per element, so it must never stop the rest of the selection. */
  const wrongClass: Reply = {
    status: 409,
    body: { code: "invalid_request", detail: "That element is class wall, not wall_surface_with_opening." },
  };
  const noScale: Reply = { status: 400, body: { code: "needs_scale", title: "Blueprint has no scale" } };
  // An API layer older than the problem vocabulary: a bare detail string, status only.
  const legacyNoScale: Reply = { status: 400, body: { detail: "this sheet has no usable scale" } };
  const unwitnessed: Reply = {
    status: 422,
    body: {
      code: "invalid_request",
      detail:
        "height must be a height the user stated: height_quote has to be the user's own words containing that number and unit, next to the word for what it measures. If the user did not state it, leave height out.",
    },
  };
  const QUOTE = "the doors are 7 ft tall";

  it("is advertised as a write, not a read", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === "set_opening_height");
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?._meta?.ui).toBeUndefined();
    // The three rules the model cannot read off the schema.
    expect(tool?.description).toMatch(/never pass a standard, typical or assumed/i);
    expect(tool?.description).toContain("height_quote");
    expect(tool?.annotations?.idempotentHint).toBe(true);
    expect(tool?.description).toMatch(/printed on the sheet/i);
    expect(tool?.description).toContain("wall_surface_with_opening");
    // No worked figure anywhere in the prose the model reads: a plausible
    // number offered here is a number that gets copied onto a real drawing.
    expect(JSON.stringify(tool)).not.toMatch(/\d\.\d\s*m\b/);
  });

  it("POSTs the whole selection in one call", async () => {
    const calls: Call[] = [];
    stubPatch(calls);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: {
        blueprint_id: "bp1",
        project_id: "pr1",
        ids: ["op-1", "op-2"],
        height: 7,
        height_unit: "ft",
        height_quote: QUOTE,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://127.0.0.1:8005/v1/projects/pr1/blueprints/bp1/opening-pieces");
    // The height travels exactly as the user stated it; the server witnesses the words
    // and does every conversion. No metres are computed here.
    expect(calls[0]!.body).toEqual({ ids: ["op-1", "op-2"], height: { value: 7, unit: "ft", quote: QUOTE } });
    expect(calls[0]!.body).not.toHaveProperty("height_m");
    expect(calls[0]!.body).not.toHaveProperty("height_unit");
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.applied).toBe(true);
    expect(structured.changed).toBe(2);
    expect(structured.fields).toEqual(["height"]);
    expect(structured.refused).toEqual([]);
    expect((structured.written as Array<Record<string, unknown>>).map((row) => row.id)).toEqual([
      "op-1",
      "op-2",
    ]);
  });

  it("sends the figure and unit unconverted", async () => {
    const calls: Call[] = [];
    stubPatch(calls);
    const client = await connect();
    await client.callTool({
      name: "set_opening_height",
      arguments: {
        blueprint_id: "bp1",
        project_id: "pr1",
        ids: ["op-1"],
        height: 90,
        height_unit: "cm",
        height_quote: "90 cm doors",
      },
    });
    expect(calls[0]!.body.height).toEqual({ value: 90, unit: "cm", quote: "90 cm doors" });
    expect(calls[0]!.body).not.toHaveProperty("tag");
  });

  it("refuses a height without the user's words, before calling the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["op-1"], height: 7, height_unit: "ft" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/height_quote/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses words with no height", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["op-1"], height_quote: QUOTE, tag: "door" },
    });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces the server's refusal of unstated words and stops after the first", async () => {
    const calls: Call[] = [];
    const ids = Array.from({ length: 12 }, (_, i) => `op-${i}`);
    stubPatch(calls, Object.fromEntries(ids.map((id) => [id, unwitnessed])));
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids, height: 7, height_unit: "ft", height_quote: "make them standard" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("must be a height the user stated");
    expect(calls).toHaveLength(1);
  });

  // A bare 404 means the API has no such route. That is not "no such element", and one
  // answer is enough to know every other element gets the same.
  it("reads a bare 404 as a missing route and stops the fan-out", async () => {
    const calls: Call[] = [];
    const ids = Array.from({ length: 12 }, (_, i) => `op-${i}`);
    const bare: Reply = { status: 404, body: { detail: "Not Found" } };
    stubPatch(calls, Object.fromEntries(ids.map((id) => [id, bare])));
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids, tag: "door" },
    });
    expect(result.isError).toBe(true);
    const said = JSON.stringify(result.content);
    expect(said).toMatch(/not available on the server yet/);
    expect(said).not.toMatch(/No element with that id/);
    expect(calls).toHaveLength(1);
  });

  it("keeps going past a coded not_found, which is per element", async () => {
    const calls: Call[] = [];
    stubPatch(calls, {
      "gone-1": { status: 404, body: { code: "not_found", detail: "No element with that id is on this blueprint." } },
    });
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["gone-1", "op-2", "op-3"], tag: "door" },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { changed: number; refused: Array<{ id: string; reason: string }> };
    expect(structured.changed).toBe(2);
    expect(structured.refused.map((r) => r.id)).toEqual(["gone-1"]);
    expect(calls).toHaveLength(1);
  });

  it("points at find_elements for the ids when the query tools are on", async () => {
    const calls: Call[] = [];
    stubPatch(calls, { "wall-9": wrongClass });
    const client = await connect(true);
    const tool = (await client.listTools()).tools.find((t) => t.name === "set_opening_height");
    expect(tool?.description).toContain("find_elements with category opening_pieces");
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["wall-9"], tag: "door" },
    });
    expect(JSON.stringify(result.content)).toContain("find_elements with category opening_pieces");
  });

  it("writes a tag on its own and reports back what is now stored", async () => {
    const calls: Call[] = [];
    stubPatch(calls, {
      "op-1": {
        status: 200,
        body: {
          id: "op-1",
          tag: "window",
          height_units: 120,
          height_m: 1.2,
          feature_class: "wall_surface_with_opening",
        },
      },
    });
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["op-1"], tag: "window" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ ids: ["op-1"], tag: "window" });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.fields).toEqual(["tag"]);
    // Read back from the row, not echoed from the request: a tag-only write
    // still reports the height already sitting on the piece.
    expect((structured.written as Array<Record<string, unknown>>)[0]).toMatchObject({
      tag: "window",
      height_m: 1.2,
      height_units: 120,
    });
  });

  it("explains a refusal on an element that is not an opening piece", async () => {
    const calls: Call[] = [];
    stubPatch(calls, { "wall-9": wrongClass });
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["wall-9"], tag: "door" },
    });
    expect(result.isError).toBe(true);
    const said = JSON.stringify(result.content);
    expect(said).toMatch(/not a wall-surface opening piece/i);
    // The class that IS writable, and how to select it.
    expect(said).toContain("wall_surface_with_opening");
    expect(said).toContain("list_elements");
    // Nothing was written, so nothing may read as applied.
    expect(said).not.toMatch(/"applied":\s*true/);
    // The transport's own status is not the user's business.
    expect(said).not.toMatch(/\b409\b/);
  });

  it("says the sheet needs a scale before a height can be converted", async () => {
    const calls: Call[] = [];
    stubPatch(calls, { "op-1": noScale });
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: {
        blueprint_id: "bp1",
        project_id: "pr1",
        ids: ["op-1"],
        height: 90,
        height_unit: "cm",
        height_quote: "90 cm doors",
      },
    });
    expect(result.isError).toBe(true);
    const said = JSON.stringify(result.content);
    expect(said).toMatch(/no usable scale/i);
    expect(said).toMatch(/scale has to be set in Kamai first/i);
    expect(said).not.toMatch(/\b400\b/);
  });

  it("names set_scale for a scaleless sheet when the query tools are on", async () => {
    const calls: Call[] = [];
    stubPatch(calls, { "op-1": noScale });
    const client = await connect(true);
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["op-1"], height: 90, height_unit: "cm", height_quote: "90 cm doors" },
    });
    expect(JSON.stringify(result.content)).toMatch(/set it with set_scale/);
  });

  it("sends the selection once when the sheet turns out to have no scale", async () => {
    const calls: Call[] = [];
    stubPatch(calls, { "op-1": noScale, "op-2": noScale, "op-3": noScale, "op-4": noScale });
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: {
        blueprint_id: "bp1",
        project_id: "pr1",
        ids: ["op-1", "op-2", "op-3", "op-4", "op-5", "op-6", "op-7", "op-8"],
        height: 90,
        height_unit: "cm",
        height_quote: "90 cm doors",
      },
    });
    expect(result.isError).toBe(true);
    // One call: Kamai refuses the whole selection before writing any of it.
    expect(calls).toHaveLength(1);
  });

  it("reports a mixed batch per id, and never as an overall success", async () => {
    const calls: Call[] = [];
    stubPatch(calls, { "wall-9": wrongClass });
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: {
        blueprint_id: "bp1",
        project_id: "pr1",
        ids: ["op-1", "wall-9"],
        height: 7,
        height_unit: "ft",
        height_quote: QUOTE,
      },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.changed).toBe(1);
    const written = structured.written as Array<Record<string, unknown>>;
    const refused = structured.refused as Array<Record<string, unknown>>;
    expect(written.map((row) => row.id)).toEqual(["op-1"]);
    expect(refused.map((row) => row.id)).toEqual(["wall-9"]);
    expect(String(refused[0]!.reason)).toMatch(/not a wall-surface opening piece/i);
    // The id that was turned away is not hiding inside the count.
    expect(written.map((row) => row.id)).not.toContain("wall-9");
  });

  it("refuses a height with no unit, before calling the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["op-1"], height: 2.4 },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/height_unit/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a unit with no height", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["op-1"], height_unit: "m" },
    });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an ids-only call that would change nothing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["op-1"] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/height .*or tag/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  /** An `opening` element's tag is the mark the drawing prints on it, and the
   * server reads a height out of that mark. The tool is the one place a model
   * could overwrite it, so the mark cannot even be spelled as an argument: the
   * tag is door or window and nothing else, refused in the schema, before a
   * request exists. */
  it("refuses to write an opening's printed mark as a tag, before any HTTP call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    for (const mark of ["W01", "D10", "80/210"]) {
      const result = await client.callTool({
        name: "set_opening_height",
        arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["opening-1"], tag: mark },
      });
      expect(result.isError, `tag ${mark} must be refused`).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a height at or below zero", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: {
        blueprint_id: "bp1",
        project_id: "pr1",
        ids: ["op-1"],
        height: 0,
        height_unit: "m",
        height_quote: "0 m",
      },
    });
    expect(result.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a selection too large to write one element at a time", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "set_opening_height",
      arguments: {
        blueprint_id: "bp1",
        project_id: "pr1",
        ids: Array.from({ length: 201 }, (_, i) => `op-${i}`),
        tag: "door",
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/split the selection/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
