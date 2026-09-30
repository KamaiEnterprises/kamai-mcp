import { afterEach, describe, expect, it, vi } from "vitest";

import { RESULT_BUDGET, resultCost } from "./query/budget.ts";
import { connect, errorText, stubApi, structured } from "./testing/harness.ts";

afterEach(() => vi.unstubAllGlobals());

const project = (id: string, blueprints: number) => ({
  id,
  name: `Project ${id}`,
  description: "",
  last_modified: 1,
  blueprints: Array.from({ length: blueprints }, (_, i) => ({ id: `${id}-bp${i}`, name: `Sheet ${i}`, ready: i % 2 === 0 })),
});

const detail = {
  id: "p1",
  name: "Eval Tower",
  description: "",
  blueprints: [
    { id: "bpA", name: "Ground Floor", ready: true },
    { id: "bpB", name: "First Floor", ready: true },
  ],
  jobs: [],
};

const inventoryEntry = (id: string, name: string) => ({
  blueprint_id: id,
  name,
  state: "ready",
  status: "indexed",
  has_scale: true,
  scale_label: "1:50",
  scale_unconfirmed: false,
  units: "metric",
  discipline: "A",
  words: 120,
  classes: {
    opening: { count: 9, sub_classes: { "single swing door": 3, window: 6 }, folders: { Doors: 3, Windows: 6 } },
    wall: { count: 4, sub_classes: { "(none)": 4 }, folders: { "Type 1": 2, "Type 2": 2 } },
  },
  single_swing_doors: { total: 3, with_handing: 1 },
});

type Out = {
  projects: Array<{ project_id: string; project_name: string; blueprints: Array<Record<string, unknown>> }>;
  count: number;
  next_cursor: string | null;
  notes: string[];
  language_sample?: string;
  truncated?: boolean;
};

describe("list_blueprints", () => {
  it("lists every project's blueprints in one request, grouped by project", async () => {
    const calls = stubApi({ "GET /v1/projects": { body: { items: [project("p1", 2), project("p2", 1)], next_cursor: "c2" } } });
    const client = await connect({ queryTools: false });
    const result = await client.callTool({ name: "list_blueprints", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/v1/projects", query: { limit: "50", include: "blueprints" } });
    const out = structured<Out>(result);
    expect(out.projects.map((p) => p.project_id)).toEqual(["p1", "p2"]);
    expect(out.projects[0]!.blueprints[0]).toEqual({ blueprint_id: "p1-bp0", name: "Sheet 0", ready: true });
    expect(out.count).toBe(3);
    expect(out.next_cursor).toBe("c2");
  });

  it("reads an empty project_id as none, and lists every project", async () => {
    // Models sent {"project_id": ""} to mean "every project", and the refusal cost a
    // round trip.
    const calls = stubApi({ "GET /v1/projects": { body: { items: [project("p1", 1)], next_cursor: null } } });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "list_blueprints", arguments: { project_id: "" } });
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls.map((c) => c.path)).toEqual(["/v1/projects"]);
    expect(structured<Out>(result).projects.map((p) => p.project_id)).toEqual(["p1"]);
  });

  it("passes the cursor through", async () => {
    const calls = stubApi({ "GET /v1/projects": { body: { items: [], next_cursor: null } } });
    const client = await connect({ queryTools: false });
    await client.callTool({ name: "list_blueprints", arguments: { cursor: "c2" } });
    expect(calls[0]!.query.cursor).toBe("c2");
  });

  it("reads one project with one request", async () => {
    const calls = stubApi({ "GET /v1/projects/p1": { body: detail } });
    const client = await connect({ queryTools: false });
    const result = await client.callTool({ name: "list_blueprints", arguments: { project_id: "p1" } });
    const out = structured<Out>(result);
    expect(calls.map((c) => c.path)).toEqual(["/v1/projects/p1"]);
    expect(out.projects).toEqual([
      {
        project_id: "p1",
        project_name: "Eval Tower",
        blueprints: [
          { blueprint_id: "bpA", name: "Ground Floor", ready: true },
          { blueprint_id: "bpB", name: "First Floor", ready: true },
        ],
      },
    ]);
    expect(out.next_cursor).toBeNull();
  });

  it("refuses include_inventory as an unknown key when the query tools are off", async () => {
    const calls = stubApi({});
    const client = await connect({ queryTools: false });
    const result = await client.callTool({ name: "list_blueprints", arguments: { project_id: "p1", include_inventory: true } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toMatch(/Unrecognized key/);
    expect(calls).toHaveLength(0);
  });

  it("adds the inventory and the language sample when asked, in parallel", async () => {
    const calls = stubApi({
      "GET /v1/projects/p1": { body: detail },
      "GET /v1/projects/p1/inventory": {
        body: {
          project_id: "p1",
          project_name: "Eval Tower",
          language_sample: "מטבח KITCHEN CONCRETE",
          blueprints: [inventoryEntry("bpA", "Ground Floor")],
        },
      },
    });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "list_blueprints", arguments: { project_id: "p1", include_inventory: true } });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.path).sort()).toEqual(["/v1/projects/p1", "/v1/projects/p1/inventory"]);
    const out = structured<Out>(result);
    expect(out.language_sample).toContain("מטבח");
    const [a, b] = out.projects[0]!.blueprints;
    expect(a!.inventory).toMatchObject({ has_scale: true, units: "metric", single_swing_doors: { total: 3, with_handing: 1 } });
    expect(a!.inventory).not.toHaveProperty("blueprint_id");
    expect(b).not.toHaveProperty("inventory");
    // A blueprint the inventory did not cover is unknown, not empty.
    expect(out.notes.join(" ")).toMatch(/unknown here, not absent/);
  });

  it("passes a never-processed blueprint through as unknown, never as empty", async () => {
    // Roof came back `ready, classes: {}` and every model run called it empty.
    // inventory.json is the API's real answer for the Eval Tower fixture, whose Roof was
    // never processed.
    const fixture = (await import("./query/__fixtures__/inventory.json", { with: { type: "json" } })).default;
    const tower = {
      ...detail,
      id: fixture.project_id,
      blueprints: fixture.blueprints.map((b) => ({ id: b.blueprint_id, name: b.name, ready: true })),
    };
    stubApi({
      [`GET /v1/projects/${fixture.project_id}`]: { body: tower },
      [`GET /v1/projects/${fixture.project_id}/inventory`]: { body: fixture },
    });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({
      name: "list_blueprints",
      arguments: { project_id: fixture.project_id, include_inventory: true },
    });
    expect(result.isError, errorText(result)).toBeFalsy();
    const roof = structured<Out>(result).projects[0]!.blueprints.find((b) => b.name === "Roof")!;
    expect(roof.inventory).toMatchObject({ status: "not_indexed", state: "not_processed", classes: null, words: null });
    expect(String((roof.inventory as { note: string }).note)).toMatch(/unknown, not empty/);
    const tools = (await client.listTools()).tools;
    expect(tools.find((t) => t.name === "list_blueprints")!.description).toMatch(/not_indexed[^.]*UNKNOWN, never empty/);
  });

  it("refuses include_inventory without a project", async () => {
    const calls = stubApi({});
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "list_blueprints", arguments: { include_inventory: true } });
    expect(result.isError).toBe(true);
    expect(errorText(result)).toBe("include_inventory needs project_id.");
    expect(calls).toHaveLength(0);
  });

  it("asks the API for a smaller page rather than trimming one, so the cursor stays exact", async () => {
    const big = Array.from({ length: 50 }, (_, i) => project(`p${i}`, 40));
    const calls = stubApi({
      "GET /v1/projects": (call) => ({
        body: { items: big.slice(0, Number(call.query.limit)), next_cursor: `after-${call.query.limit}` },
      }),
    });
    const client = await connect({ queryTools: false });
    const result = await client.callTool({ name: "list_blueprints", arguments: {} });
    const out = structured<Out>(result);
    expect(calls).toHaveLength(2);
    const limit = Number(calls[1]!.query.limit);
    expect(limit).toBeLessThan(50);
    expect(out.projects).toHaveLength(limit);
    expect(out.next_cursor).toBe(`after-${limit}`);
    expect(resultCost(result.structuredContent)).toBeLessThanOrEqual(RESULT_BUDGET);
    expect(out.notes.join(" ")).toMatch(/next_cursor continues/);
  });

  it("takes inventory off the newest blueprints first when it does not fit", async () => {
    const blueprints = Array.from({ length: 25 }, (_, i) => ({ id: `bp${i}`, name: `Sheet ${i}`, ready: true }));
    const bulky = (id: string) => {
      const entry = inventoryEntry(id, id);
      (entry.classes.wall as { folders: Record<string, number> }).folders = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Wall type ${i} ${"x".repeat(300)}`, i]));
      return entry;
    };
    stubApi({
      "GET /v1/projects/p1": { body: { ...detail, blueprints } },
      "GET /v1/projects/p1/inventory": {
        body: { project_id: "p1", project_name: "Eval Tower", language_sample: "", blueprints: blueprints.map((b) => bulky(b.id)) },
      },
    });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "list_blueprints", arguments: { project_id: "p1", include_inventory: true } });
    const out = structured<Out>(result);
    const rows = out.projects[0]!.blueprints;
    expect(rows).toHaveLength(25);
    expect(rows[0]).toHaveProperty("inventory");
    expect(rows[24]).not.toHaveProperty("inventory");
    expect(out.truncated).toBe(true);
    expect(resultCost(result.structuredContent)).toBeLessThanOrEqual(RESULT_BUDGET);
  });
});

describe("list_blueprints on an API layer without the inventory route", () => {
  it("still lists the blueprints, and says the inventory is unavailable", async () => {
    stubApi({ "GET /v1/projects/p1": { body: detail } });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "list_blueprints", arguments: { project_id: "p1", include_inventory: true } });
    expect(result.isError).toBeFalsy();
    const out = structured<Out>(result);
    expect(out.projects[0]!.blueprints).toHaveLength(2);
    expect(out.notes.join(" ")).toMatch(/cannot list what the blueprints contain yet/);
  });
});
