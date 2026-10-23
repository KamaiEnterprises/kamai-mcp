import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GEOMETRY_PAGE_MAX, RESULT_BUDGET, buildElementsPage, type FetchGeometry, type GeometryFilter } from "./elements.ts";
import type { GeometryFeature, GeometryPage } from "./api.ts";
import { buildServer } from "./server.ts";

// A row the geometry endpoint returns with no coordinates: the folder/legend entries
// ride in the same collection as real shapes and are counted by `total`, but the route
// skips them when it builds `features`. Modelled here because it is the reason a page
// can be complete while holding fewer features than the caller's limit.
const FOLDER_ROW = null;

function feature(i: number, over: Partial<GeometryFeature> = {}): GeometryFeature {
  return {
    i,
    cls: "room",
    folder: "Group 1",
    name: `Shape ${i + 1}`,
    color: { r: 1, g: 2, b: 3, a: 4 },
    rings: [[0, 0, 20, 0, 20, 20]],
    lines: null,
    pts: null,
    area: 12.5,
    len: null,
    ...over,
  };
}

// Emulates the real route: it slices the raw collection by an offset cursor, drops the
// coordinate-less rows from `features`, and computes truncated/next_cursor from the
// number of raw rows taken — not from the number of features handed back. With a filter
// it does what the API layer does: trimmed, case-insensitive contains
// over every feature, `matched`, and a cursor into the matches tagged with the filter.
function sheet(
  rows: Array<GeometryFeature | null>,
  over: Partial<GeometryPage> = {},
): FetchGeometry & { calls: Array<{ limit: number; cursor?: string; filter?: GeometryFilter }> } {
  const calls: Array<{ limit: number; cursor?: string; filter?: GeometryFilter }> = [];
  const fetchPage = async (limit: number, cursor?: string, filter?: GeometryFilter): Promise<GeometryPage> => {
    calls.push({ limit, cursor, filter });
    const base = {
      blueprint_id: "bp1",
      name: "Level 2",
      project_id: "pr1",
      project_name: "Tower",
      state: "ready" as const,
      grid: 2000,
      image: { url: "https://example/x.png", w: 100, h: 50 },
      total: rows.length,
      scale_label: "1:100",
      needs_scale: false,
      scale_unconfirmed: false,
      units: { area: "m²", length: "m" },
    };
    if (filter) {
      const needles = Object.entries(filter).map(([k, v]) => [k, v!.trim().toLowerCase()] as const);
      const key = JSON.stringify(needles.sort());
      const matches = rows.filter(
        (r): r is GeometryFeature =>
          r !== null && needles.every(([k, n]) => String(r[k as keyof GeometryFeature] ?? "").toLowerCase().includes(n)),
      );
      if (cursor && !cursor.startsWith(`m${key}:`)) throw new Error("cursor from another filter");
      const offset = cursor ? Number(cursor.split(":").at(-1)) : 0;
      const features = matches.slice(offset, offset + limit);
      const more = offset + features.length < matches.length;
      return { ...base, features, matched: matches.length, truncated: more,
        next_cursor: more ? `m${key}:${offset + features.length}` : null, ...over };
    }
    const offset = cursor ? Number(cursor) : 0;
    const window = rows.slice(offset, offset + limit);
    const taken = window.length;
    const total = rows.length;
    return {
      blueprint_id: "bp1",
      name: "Level 2",
      project_id: "pr1",
      project_name: "Tower",
      state: "ready",
      grid: 2000,
      image: { url: "https://example/x.png", w: 100, h: 50 },
      features: window.filter((r): r is GeometryFeature => r !== null),
      total,
      truncated: offset + taken < total,
      next_cursor: offset + taken < total ? String(offset + taken) : null,
      scale_label: "1:100",
      needs_scale: false,
      scale_unconfirmed: false,
      units: { area: "m²", length: "m" },
      ...over,
    };
  };
  return Object.assign(fetchPage, { calls });
}

const notes = (result: { notes: string[] }) => result.notes.join(" | ");

describe("list_elements pages", () => {
  it("returns one row per element, with its geometry", async () => {
    const page = await buildElementsPage(sheet([feature(0), feature(1)]), {});
    expect(page.returned).toBe(2);
    expect(page.geometry_included).toBe(true);
    expect(page.elements[0]?.rings).toEqual([[0, 0, 20, 0, 20, 20]]);
    expect(page.elements[0]?.folder).toBe("Group 1");
    expect(page.elements[0]?.area).toBe(12.5);
    expect(page.truncated).toBe(false);
    expect(page.next_cursor).toBeNull();
  });

  it("counts the folder rows in total but never returns them as elements", async () => {
    // total counts every row in the source collection, so a page can be complete and
    // still hold fewer elements than `total` — that must not read as "some were dropped".
    const page = await buildElementsPage(sheet([feature(0), FOLDER_ROW, feature(2)]), {});
    expect(page.total).toBe(3);
    expect(page.returned).toBe(2);
    expect(page.truncated).toBe(false);
  });

  it("never lets a truncated page look complete", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => feature(i));
    const page = await buildElementsPage(sheet(rows), { limit: 4 });
    expect(page.returned).toBe(4);
    expect(page.total).toBe(10);
    expect(page.truncated).toBe(true);
    expect(page.next_cursor).toBe("4");
    expect(notes(page)).toContain("4");
    expect(notes(page)).toMatch(/not the whole blueprint|partial/i);
  });

  it("follows its own next_cursor to the rest of the blueprint", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => feature(i));
    const first = await buildElementsPage(sheet(rows), { limit: 3 });
    const second = await buildElementsPage(sheet(rows), { limit: 3, cursor: first.next_cursor! });
    expect(second.elements.map((e) => e.i)).toEqual([3, 4]);
    expect(second.truncated).toBe(false);
    expect(second.next_cursor).toBeNull();
  });
});

describe("list_elements filters", () => {
  it("filters by class, folder and name, case-insensitively", async () => {
    const rows = [
      feature(0, { cls: "door", folder: "Apartment 5", name: "Front door" }),
      feature(1, { cls: "room", folder: "Apartment 5", name: "Kitchen" }),
      feature(2, { cls: "door", folder: "Apartment 6", name: "Back door" }),
    ];
    expect((await buildElementsPage(sheet(rows), { cls: "DOOR" })).returned).toBe(2);
    expect((await buildElementsPage(sheet(rows), { folder: "apartment 6" })).returned).toBe(1);
    expect((await buildElementsPage(sheet(rows), { name: "kitchen" })).returned).toBe(1);
  });

  it("says the filter ran here and saw the whole blueprint", async () => {
    const rows = [feature(0, { cls: "door" }), feature(1, { cls: "room" })];
    const page = await buildElementsPage(sheet(rows), { cls: "door" });
    expect(page.filtered).toBe(true);
    expect(page.filter_complete).toBe(true);
    expect(page.matched).toBe(1);
    expect(page.filter_scanned).toBe(2);
    expect(page.truncated).toBe(false);
  });

  it("asks Kamai to filter the whole sheet in one call and relays its count", async () => {
    const rows = Array.from({ length: 4200 }, (_, i) => feature(i, { cls: i % 2 === 0 ? "door" : "room" }));
    const fetcher = sheet(rows);
    const page = await buildElementsPage(fetcher, { cls: "door", folder: "group", limit: 5 });
    expect(fetcher.calls).toEqual([{ limit: 5, cursor: undefined, filter: { cls: "door", folder: "group" } }]);
    expect(page.matched).toBe(2100);
    expect(page.filter_complete).toBe(true);
    expect(page.filter_scanned).toBe(4200);
    expect(notes(page)).not.toMatch(/floor/i);
  });

  it("reports no match count while the blueprint is not ready", async () => {
    const processing = sheet([], { state: "processing", matched: null });
    const page = await buildElementsPage(processing, { cls: "door" });
    expect(page.matched).toBeNull();
    expect(notes(page)).toMatch(/still being processed/);
  });

  it("never presents an unfiltered page as the matches", async () => {
    // A route without the filter ignores the arguments and answers the whole sheet.
    const unfiltering: FetchGeometry = (limit, cursor) => sheet([feature(0, { cls: "room" })])(limit, cursor);
    await expect(buildElementsPage(unfiltering, { cls: "door" })).rejects.toThrow(/filter/i);
  });

  it("pages the matches with the route's cursor", async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      feature(i, { cls: i < 4 ? "door" : "room" }),
    );
    const first = await buildElementsPage(sheet(rows), { cls: "door", limit: 2 });
    expect(first.matched).toBe(4);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toMatch(/:2$/);
    const second = await buildElementsPage(sheet(rows), {
      cls: "door",
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(second.elements.map((e) => e.i)).toEqual([2, 3]);
    expect(second.truncated).toBe(false);
    expect(second.next_cursor).toBeNull();
  });

});

describe("list_elements payload", () => {
  it("drops the geometry when it was not asked for, and says it did", async () => {
    const page = await buildElementsPage(sheet([feature(0)]), { include_geometry: false });
    expect(page.geometry_included).toBe(false);
    expect(page.elements[0]).not.toHaveProperty("rings");
    expect(page.elements[0]?.area).toBe(12.5);
    expect(notes(page)).toContain("include_geometry");
  });

  it("caps a geometry page and says it capped it", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => feature(i));
    const page = await buildElementsPage(sheet(rows), { limit: 400 });
    expect(page.returned).toBe(GEOMETRY_PAGE_MAX);
    expect(page.truncated).toBe(true);
    expect(notes(page)).toContain(String(GEOMETRY_PAGE_MAX));
  });

  it("lets a caller ask for more rows once the geometry is off", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => feature(i));
    const page = await buildElementsPage(sheet(rows), { limit: 400, include_geometry: false });
    expect(page.returned).toBe(400);
    expect(page.truncated).toBe(false);
  });
});

describe("list_elements measurements", () => {
  it("reports missing measurements rather than inventing them", async () => {
    // The route already nulls area and len when there is no scale; the geometry is still
    // there, and a model that measured the rings would report drawing units as metres.
    const rows = [feature(0, { area: null, len: null })];
    const page = await buildElementsPage(sheet(rows, { needs_scale: true, scale_label: null }), {});
    expect(page.needs_scale).toBe(true);
    expect(page.elements[0]?.area).toBeNull();
    expect(notes(page)).toMatch(/no scale/i);
    expect(notes(page)).toMatch(/do not estimate/i);
  });

  it("flags a measurement taken against an unconfirmed scale", async () => {
    const page = await buildElementsPage(sheet([feature(0)], { scale_unconfirmed: true }), {});
    expect(page.scale_unconfirmed).toBe(true);
    expect(notes(page)).toMatch(/provisional|not been confirmed/i);
  });

  it("says a blueprint that is not ready has no elements yet", async () => {
    const page = await buildElementsPage(
      sheet([], { state: "processing", total: 0, image: null }),
      {},
    );
    expect(page.state).toBe("processing");
    expect(page.returned).toBe(0);
    expect(notes(page)).toMatch(/still being processed/i);
  });
});

describe("the list_elements tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    const server = buildServer({ uid: "test", token: "test" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("is advertised to the model, not hidden behind the app", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "list_elements");
    expect(tool, "list_elements must be in tools/list").toBeDefined();
    expect(tool?._meta?.ui).toBeUndefined();
    expect(tool?.description).toContain("view_takeoff");
    expect(tool?.description).toMatch(/never show a raw id/i);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("returns structured content the output schema accepts", async () => {
    vi.stubGlobal("fetch", async (url: URL) => {
      expect(String(url)).toContain("/blueprints/bp1/geometry");
      return new Response(
        JSON.stringify({
          blueprint_id: "bp1",
          name: "Level 2",
          project_id: "pr1",
          project_name: "Tower",
          state: "ready",
          grid: 2000,
          image: null,
          features: [
            {
              i: 0,
              cls: "door",
              folder: "Apartment 5",
              name: "Front door",
              color: { r: 1, g: 2, b: 3, a: 4 },
              rings: null,
              lines: [[0, 0, 30, 0]],
              pts: null,
              area: null,
              len: 0.9,
            },
          ],
          total: 1,
          truncated: false,
          next_cursor: null,
          scale_label: "1:100",
          needs_scale: false,
          scale_unconfirmed: false,
          units: { area: "m²", length: "m" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_elements",
      arguments: { blueprint_id: "bp1", project_id: "pr1" },
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.project_name).toBe("Tower");
    expect(structured.returned).toBe(1);
    expect((structured.elements as Array<Record<string, unknown>>)[0]?.lines).toEqual([
      [0, 0, 30, 0],
    ]);
  });

  it("surfaces a Kamai refusal as its own sentence", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ code: "not_ready" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = await connect();
    const result = await client.callTool({
      name: "list_elements",
      arguments: { blueprint_id: "bp1", project_id: "pr1" },
    });
    expect(JSON.stringify(result.content)).toContain("still being processed");
  });

  it("sends the filter to Kamai and passes its fix message through", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ code: "invalid_request", detail: "That cursor was made by a listing with different cls/folder/name filters." }),
        { status: 400, headers: { "content-type": "application/problem+json" } },
      );
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_elements",
      arguments: { blueprint_id: "bp1", project_id: "pr1", cls: "door", name: "front", cursor: "mabc:2" },
    });
    const url = new URL(seen.at(-1)!);
    expect(url.searchParams.get("cls")).toBe("door");
    expect(url.searchParams.get("name")).toBe("front");
    expect(url.searchParams.get("folder")).toBeNull();
    expect(url.searchParams.get("cursor")).toBe("mabc:2");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("different cls/folder/name filters");
  });

  // The size that matters is the one the host measures, and that is not the page: text()
  // sends the payload twice, JSON-escaped in content[0].text and again as
  // structuredContent, so the tool result is about twice what the page weighs. Sizing the
  // page alone is how a 150-row cap came to sit ~37% over the ceiling it cited — past
  // which the result goes to the sandbox filesystem and never reaches the model at all.
  function stubGeometry(count: number, points: number) {
    const ring: number[] = [];
    for (let p = 0; p < points; p += 1) ring.push(1000 + (p % 999), 1500 + (p % 997));
    const features = Array.from({ length: count }, (_, i) => ({
      i,
      cls: "wall",
      folder: `Apartment ${(i % 12) + 1}`,
      name: `Interior wall ${i + 1}`,
      color: { r: 12, g: 34, b: 56, a: 255 },
      rings: [ring],
      lines: null,
      pts: null,
      area: 1234.56,
      len: null,
    }));
    vi.stubGlobal("fetch", async (url: URL) => {
      const query = new URL(String(url)).searchParams;
      const offset = Number(query.get("cursor") ?? 0);
      const window = features.slice(offset, offset + Number(query.get("limit") ?? 400));
      const end = offset + window.length;
      return new Response(
        JSON.stringify({
          blueprint_id: "bp1",
          name: "Ground floor",
          project_id: "pr1",
          project_name: "Tower",
          state: "ready",
          grid: 2000,
          image: null,
          features: window,
          total: features.length,
          truncated: end < features.length,
          next_cursor: end < features.length ? String(end) : null,
          scale_label: "1:100",
          needs_scale: false,
          scale_unconfirmed: false,
          units: { area: "m²", length: "m" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
  }

  it("keeps the whole tool result under the ceiling at its own page cap", async () => {
    stubGeometry(150, 60);
    const client = await connect();
    const result = await client.callTool({
      name: "list_elements",
      arguments: { blueprint_id: "bp1", project_id: "pr1", limit: 400 },
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.returned as number).toBeLessThanOrEqual(GEOMETRY_PAGE_MAX);
    expect(JSON.stringify(result).length).toBeLessThan(RESULT_BUDGET);
  });

  it("keeps it under the ceiling when the outlines are the big ones", async () => {
    // A wall feature is one connected component of the whole wall network, traced round
    // both faces, so hundreds to thousands of points is the normal case, not the
    // pathological one. A row count cannot see that; the budget can.
    stubGeometry(60, 3000);
    const client = await connect();
    const result = await client.callTool({
      name: "list_elements",
      arguments: { blueprint_id: "bp1", project_id: "pr1", limit: 50 },
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.returned as number).toBeLessThan(50);
    expect(structured.truncated).toBe(true);
    expect(structured.next_cursor).not.toBeNull();
    expect(JSON.stringify(result).length).toBeLessThan(RESULT_BUDGET);
  });
});

// A traced wall or room outline, quantised but never simplified, so ring length is
// whatever tracing produced.
function heavy(i: number, points: number, over: Partial<GeometryFeature> = {}): GeometryFeature {
  const ring: number[] = [];
  for (let p = 0; p < points; p += 1) ring.push(1000 + (p % 999), 1500 + (p % 997));
  return feature(i, { rings: [ring], ...over });
}

describe("list_elements holds the whole tool result under the host's ceiling", () => {
  it("stops filling an unfiltered page when the rows stop fitting, and resumes there", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => heavy(i, 2000));
    const fetcher = sheet(rows);
    const page = await buildElementsPage(fetcher, { limit: 10 });
    expect(fetcher.calls.length).toBe(1);
    expect(page.returned).toBeGreaterThan(0);
    expect(page.returned).toBeLessThan(10);
    expect(page.truncated).toBe(true);
    expect(notes(page)).toMatch(/left out of it|result-size/i);
    // The dropped rows must be the next page's, not nobody's.
    expect(page.next_cursor).toBe(String(page.elements.at(-1)!.i + 1));
    const next = await buildElementsPage(sheet(rows), { limit: 10, cursor: page.next_cursor! });
    expect(next.elements[0]?.i).toBe(page.elements.at(-1)!.i + 1);
  });

  it("asks the route for a smaller page when it cannot mint the resume cursor itself", async () => {
    // A route paging by an opaque token rather than a row offset: there is no cursor this
    // tool could derive, so it must not invent one.
    const rows = Array.from({ length: 20 }, (_, i) => heavy(i, 2000));
    const calls: number[] = [];
    const opaque: FetchGeometry = async (limit, cursor) => {
      calls.push(limit);
      const offset = cursor ? Number(cursor.replace("tok", "")) : 0;
      const page = await sheet(rows)(limit, String(offset));
      return {
        ...page,
        next_cursor: page.next_cursor === null ? null : `tok${page.next_cursor}`,
      };
    };
    const page = await buildElementsPage(opaque, { limit: 10 });
    expect(calls.length).toBe(2);
    expect(calls[1]).toBe(page.returned);
    expect(page.truncated).toBe(true);
    expect(page.next_cursor).toBe(`tok${page.returned}`);
  });

  it("trims a filtered page the same way and pages the rest", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => heavy(i, 2000, { cls: "wall" }));
    const first = await buildElementsPage(sheet(rows), { cls: "wall", limit: 12 });
    expect(first.matched).toBe(12);
    expect(first.returned).toBeLessThan(12);
    expect(first.truncated).toBe(true);
    expect(first.next_cursor).toMatch(new RegExp(`:${first.returned}$`));
    const second = await buildElementsPage(sheet(rows), {
      cls: "wall",
      limit: 12,
      cursor: first.next_cursor!,
    });
    expect(second.elements[0]?.i).toBe(first.elements.at(-1)!.i + 1);
  });

  it("says so when one element's outline is bigger than the whole budget", async () => {
    const page = await buildElementsPage(sheet([heavy(0, 40_000)]), { limit: 1 });
    expect(page.returned).toBe(1);
    expect(notes(page)).toMatch(/larger than the result-size budget/i);
  });
});
