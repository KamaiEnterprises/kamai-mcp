import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, stubApi, structured } from "./testing/harness.ts";

const page = {
  blueprint_id: "bp1",
  name: "Ground MEP",
  project_id: "p1",
  project_name: "Tower",
  state: "ready",
  grid: 2000,
  image: null,
  features: [{ i: 4, id: "e1", cls: "duct", name: "Duct", folder: "MEP", color: { r: 1, g: 2, b: 3, a: 4 }, rings: null, lines: [[0, 0, 10, 10]], pts: null, area: null, len: 1.2 }],
  total: 1,
  truncated: false,
  next_cursor: null,
  scale_label: "1:50",
  needs_scale: false,
  scale_unconfirmed: false,
  units: { area: "m²", length: "m" },
  classes: [{ cls: "duct", count: 1 }],
  duplicates_hidden: null,
};

// The cross-sheet room marks were removed from the backend, which ignores hide_duplicates and
// answers 0. The flag and its note are gone from here; nothing is left out of a sheet.
describe("geometry calls carry no duplicate policy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never asks the route to hide rooms, for list_elements or view_blueprint", async () => {
    const calls = stubApi({ "GET /v1/projects/p1/blueprints/bp1/geometry": { body: page } });
    const client = await connect();
    await client.callTool({ name: "list_elements", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    await client.callTool({ name: "view_blueprint", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    const geometry = calls.filter((c) => c.path.endsWith("/geometry"));
    expect(geometry).toHaveLength(2);
    for (const call of geometry) expect(call.query).not.toHaveProperty("hide_duplicates");
  });

  it("adds no duplicates key or note to list_elements", async () => {
    stubApi({ "GET /v1/projects/p1/blueprints/bp1/geometry": { body: { ...page, duplicates_hidden: 3 } } });
    const client = await connect();
    const result = structured<{ notes: string[] }>(
      await client.callTool({ name: "list_elements", arguments: { blueprint_id: "bp1", project_id: "p1" } }),
    );
    expect(result).not.toHaveProperty("duplicates_hidden");
    expect(result.notes.join(" ")).not.toMatch(/left out/);
  });
});
