import { afterEach, describe, expect, it, vi } from "vitest";

import baseline from "./__fixtures__/tools-v27.json" with { type: "json" };
import { connect, stubApi, structured } from "./testing/harness.ts";

// Deploy safety. With KAMAI_QUERY_TOOLS unset this server must advertise exactly today's
// tools plus list_blueprints, and no existing tool's structuredContent may gain or lose a
// field: hosts pin descriptors, and ChatGPT's directory freezes them.

const TODAY = [
  "list_projects",
  "view_projects",
  "get_project",
  "get_blueprint",
  "view_blueprint",
  "view_takeoff",
  "list_elements",
  "list_folders",
  "update_elements",
  "create_folder",
  "move_elements",
  "set_opening_height",
  "create_project",
  "update_project",
  "list_jobs",
  "get_job",
  "cancel_job",
  "request_blueprint_upload",
  "finalize_blueprint_upload",
  "view_upload",
  "open_kamai",
];

const APP_ONLY_TODAY = [
  "list_projects",
  "get_project",
  "get_blueprint",
  "request_blueprint_upload",
  "finalize_blueprint_upload",
];

type Tool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
  outputSchema?: unknown;
  inputSchema?: unknown;
  _meta?: { ui?: { visibility?: string[] } };
};

const isAppOnly = (tool: Tool) => {
  const visibility = tool._meta?.ui?.visibility;
  return Array.isArray(visibility) && visibility.length === 1 && visibility[0] === "app";
};

async function listTools(queryTools: boolean, chatgpt = false): Promise<Tool[]> {
  const client = await connect({ queryTools }, { chatgpt });
  return (await client.listTools()).tools as Tool[];
}

/** Every `description` string anywhere in a tool descriptor: the tool's own and every
 * parameter's and output field's describe(). */
function descriptions(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) descriptions(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "description" && typeof item === "string") out.push(item);
      else descriptions(item, out);
    }
  }
  return out;
}

// A dimension written into prose is a dimension a model copies onto a real drawing.
const DIGIT_UNIT = /\d\s*(?:mm|cm|m|ft|in|%|")(?![A-Za-z])/;
const FORBIDDEN_FIGURES = ["80/210", "2.7", "2.1", "1.2"];
// set_scale must show how a scale is written; nothing else may carry a figure.
const EXEMPT = [`1'-0"`, "1:N"];

function assertNoFigures(tools: Tool[]) {
  for (const tool of tools) {
    for (const text of descriptions(tool)) {
      const stripped = EXEMPT.reduce((acc, literal) => acc.split(literal).join(""), text);
      expect(stripped, `${tool.name}: ${text.slice(0, 80)}`).not.toMatch(DIGIT_UNIT);
      for (const figure of FORBIDDEN_FIGURES) {
        expect(text.includes(figure), `${tool.name} carries ${figure}`).toBe(false);
      }
    }
  }
}

function assertHintsAndTitles(tools: Tool[]) {
  for (const tool of tools) {
    expect(tool.title, tool.name).toBeTruthy();
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe("boolean");
    }
  }
}

// A grader that cannot fail proves nothing: feed it the figures it exists to catch.
describe("the figure check itself", () => {
  it("catches a dimension in prose", () => {
    for (const bad of ["Ceilings are 2.7 m.", "a 90cm door", "8 ft walls", "36\" wide", "waste 10%", "12 in"]) {
      expect(() => assertNoFigures([{ name: "bad", description: bad }]), bad).toThrow();
    }
    expect(() => assertNoFigures([{ name: "bad", description: "size tag 80/210" }])).toThrow();
    // "25 in" reads as inches to the check, so prose must not put a count before "in".
    expect(() => assertNoFigures([{ name: "count", description: "at most 25 in blueprint_ids" }])).toThrow();
    expect(() => assertNoFigures([{ name: "ok", description: "up to 25 blueprints, 4 keys, a ratio written 1:N" }])).not.toThrow();
  });
});

describe("tool list, query tools off", () => {
  it("is today's list plus list_blueprints", async () => {
    const names = (await listTools(false)).map((t) => t.name);
    expect(names.sort()).toEqual([...TODAY, "list_blueprints"].sort());
  });

  it("adds only ingest_blueprint_from_chat for ChatGPT", async () => {
    const names = (await listTools(false, true)).map((t) => t.name);
    expect(names.sort()).toEqual([...TODAY, "list_blueprints", "ingest_blueprint_from_chat"].sort());
  });

  it("keeps the same app-only set, 17 visible", async () => {
    const tools = await listTools(false);
    expect(tools.filter(isAppOnly).map((t) => t.name).sort()).toEqual([...APP_ONLY_TODAY].sort());
    expect(tools.filter((t) => !isAppOnly(t))).toHaveLength(17);
  });

  it("gives every tool a title and all four hints", async () => {
    assertHintsAndTitles(await listTools(false, true));
  });

  it("advertises no closed output schema", async () => {
    for (const tool of await listTools(false, true)) {
      expect(JSON.stringify(tool.outputSchema ?? {}), tool.name).not.toContain('"additionalProperties":false');
    }
  });

  it("puts no dimension in any description", async () => {
    assertNoFigures(await listTools(false, true));
  });

  it("marks the annotation fixes", async () => {
    const tools = await listTools(false);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(byName.update_project).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.update_elements).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.move_elements).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(byName.view_upload).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(byName.cancel_job).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.create_folder).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(byName.list_blueprints).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  // Recorded from the v27 tool list, before list_blueprints and the query tools, with
  // {chatgpt: true}. Only set_opening_height changes its words and inputs (the height
  // quote); the widget URIs carry the version.
  it("leaves every other tool's words, inputs and widget binding as they were", async () => {
    const now = Object.fromEntries((await listTools(false, true)).map((t) => [t.name, t]));
    const unversioned = (meta: unknown) => JSON.stringify(meta ?? null).replace(/@v\d+/g, "@v*");
    for (const [name, before] of Object.entries(baseline as unknown as Record<string, Tool>)) {
      const after = now[name]!;
      expect(after, name).toBeDefined();
      expect(after.title, name).toBe(before.title);
      expect(unversioned(after._meta), name).toBe(unversioned(before._meta));
      if (name === "set_opening_height") continue;
      expect(after.description, name).toBe(before.description);
      expect(after.inputSchema, name).toEqual(before.inputSchema);
    }
  });

  it("does not offer include_inventory without the query tools", async () => {
    const tool = (await listTools(false)).find((t) => t.name === "list_blueprints")!;
    expect(JSON.stringify(tool.inputSchema)).not.toContain("include_inventory");
    expect(tool.description).not.toContain("include_inventory");
  });
});

// ── structuredContent keys, per existing tool, with the query tools off ────────────────
// Recorded against the v27 tool list (the same calls, the same fixtures). A key
// appearing or disappearing here is a change strict clients see.

const color = { r: 1, g: 2, b: 3, a: 4 };
const geometry = {
  blueprint_id: "bp1",
  name: "Ground",
  project_id: "p1",
  project_name: "Tower",
  state: "ready",
  grid: 2000,
  image: null,
  features: [{ i: 0, id: "r0", cls: "room", name: "Room", folder: "G1", color, rings: [[0, 0, 1, 1]], area: 12.5, len: null }],
  total: 1,
  truncated: false,
  next_cursor: null,
  scale_label: "1:50",
  needs_scale: false,
  scale_unconfirmed: false,
  units: { area: "m²", length: "m" },
  text: null,
  text_total: null,
  text_next_cursor: null,
};
const takeoff = {
  blueprint_id: "bp1",
  name: "Ground",
  project_id: "p1",
  project_name: "Tower",
  state: "ready",
  rows: [{ group: "Areas", cls: "room", folder: "G1", count: 1, area: 12.5, len: 0, color }],
  totals: { count: 1, area: 12.5, len: 0 },
  shapes: 1,
  scale_label: "1:50",
  needs_scale: false,
  scale_unconfirmed: false,
  units: { area: "m²", length: "m" },
};
const job = { id: "j1", blueprint_id: "bp1", status: "RUNNING", state: null, filename: "a.pdf", progress: 5, error_message: null, error_code: null };
const project = { id: "p1", name: "Tower", description: "", last_modified: 1, blueprints: [{ id: "bp1", name: "Ground", ready: true }] };

const EXPECTED_KEYS: Record<string, { args: Record<string, unknown>; keys: string[] }> = {
  list_projects: { args: {}, keys: ["count", "projects"] },
  view_projects: { args: {}, keys: ["count", "projects"] },
  view_blueprint: {
    args: { blueprint_id: "bp1", project_id: "p1" },
    keys: ["blueprint_id", "features", "grid", "image", "name", "needs_scale", "project_id", "project_name", "scale_label", "scale_unconfirmed", "state", "total", "truncated", "units"],
  },
  view_takeoff: {
    args: { blueprint_id: "bp1", project_id: "p1" },
    keys: ["blueprint_id", "name", "needs_scale", "project_id", "project_name", "rows", "scale_label", "scale_unconfirmed", "shapes", "state", "totals", "units"],
  },
  list_elements: {
    args: { blueprint_id: "bp1", project_id: "p1" },
    keys: ["blueprint_id", "blueprint_name", "elements", "filter_complete", "filter_scanned", "filtered", "geometry_included", "grid", "matched", "needs_scale", "next_cursor", "notes", "project_id", "project_name", "returned", "scale_label", "scale_unconfirmed", "state", "total", "truncated", "units"],
  },
  list_jobs: { args: { project_id: "p1" }, keys: ["count", "jobs"] },
  view_upload: { args: {}, keys: ["project_id", "projects", "state"] },
  open_kamai: { args: {}, keys: ["chrome", "declared_frame_domains", "expand_button", "open_in", "url"] },
  set_opening_height: { args: { blueprint_id: "bp1", project_id: "p1", ids: ["op"], tag: "door" }, keys: ["applied", "changed", "fields", "refused", "written"] },
};

describe("structuredContent of existing tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has exactly the keys it had before", async () => {
    stubApi({
      "GET /v1/projects": { body: { items: [project], next_cursor: null } },
      "GET /v1/projects/p1/blueprints/bp1/geometry": { body: geometry },
      "GET /v1/projects/p1/blueprints/bp1/takeoff": { body: takeoff },
      "GET /v1/projects/p1/jobs": { body: [job] },
      "PATCH /v1/blueprints/bp1/features/op": {
        body: { id: "op", tag: "door", height_units: null, height_m: null, feature_class: "wall_surface_with_opening" },
      },
    });
    const client = await connect({ queryTools: false });
    for (const [name, { args, keys }] of Object.entries(EXPECTED_KEYS)) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${JSON.stringify(result.content).slice(0, 200)}`).toBeFalsy();
      expect(Object.keys(structured(result)).sort(), name).toEqual([...keys].sort());
    }
  });

  it("still strips fields the closed widget schemas do not declare", async () => {
    stubApi({ "GET /v1/projects/p1/blueprints/bp1/takeoff": { body: takeoff } });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({ name: "view_takeoff", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    expect(structured<{ rows: object[] }>(result).rows[0]).not.toHaveProperty("folder");
  });
});

// ── query tools on ───────────────────────────────────────────────────────────────────

const QUERY_VISIBLE = ["count_elements", "find_elements", "calculate_wall_surface_area", "render_table", "set_scale"];
const QUERY_APP_ONLY = ["get_table_row_elements", "get_element_outlines"];

describe("tool list, query tools on", () => {
  it("adds the query tools: 22 visible, 29 in all", async () => {
    const tools = await listTools(true);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...TODAY, "list_blueprints", ...QUERY_VISIBLE, ...QUERY_APP_ONLY].sort(),
    );
    expect(tools.filter((t) => !isAppOnly(t))).toHaveLength(22);
    expect(tools.filter(isAppOnly).map((t) => t.name).sort()).toEqual([...APP_ONLY_TODAY, ...QUERY_APP_ONLY].sort());
  });

  // Hosts degrade tool choice past roughly this many visible tools.
  it("stays at or under 25 visible tools, ChatGPT included", async () => {
    const tools = await listTools(true, true);
    expect(tools.filter((t) => !isAppOnly(t))).toHaveLength(23);
    expect(tools.filter((t) => !isAppOnly(t)).length).toBeLessThanOrEqual(25);
  });

  it("gives every tool a title and all four hints", async () => {
    assertHintsAndTitles(await listTools(true, true));
  });

  it("advertises no closed output schema", async () => {
    for (const tool of await listTools(true, true)) {
      expect(JSON.stringify(tool.outputSchema ?? {}), tool.name).not.toContain('"additionalProperties":false');
    }
  });

  it("puts no dimension in any description", async () => {
    assertNoFigures(await listTools(true, true));
  });

  // The domain rules. Claude.ai drops server instructions, so each one has to be in a
  // description the model reads.
  it("carries the domain rules in the descriptions", async () => {
    const tools = Object.fromEntries((await listTools(true)).map((t) => [t.name, t]));
    const words = ["count_elements", "find_elements", "calculate_wall_surface_area"]
      .map((name) => JSON.stringify([tools[name]!.description, tools[name]!.inputSchema]))
      .join(" ");
    for (const phrase of [
      "There is NO 'door' sub_class",
      "single swing door",
      "double swing door",
      "sliding door",
      "swing window",
      "safe room window",
      "leaves out",
      "PREFER THIS",
      "never add",
      "not detected",
      "related_to",
      "name_contains",
      "include_inventory",
    ]) {
      expect(words, phrase).toContain(phrase);
    }
    expect(words.toLowerCase()).toContain("quote");
    expect(tools.count_elements!.description).toContain("PREFER THIS");
    expect(tools.calculate_wall_surface_area!.description).toContain("room_height_quote");
  });

  // Each wording below cost a wrong filter or a wasted round trip in live model runs.
  it("words the wall tool's filters for rooms, and says when blueprint_ids is required", async () => {
    const tools = Object.fromEntries((await listTools(true)).map((t) => [t.name, t]));
    type Props = Record<string, { description?: string }>;
    const wallProps = (tools.calculate_wall_surface_area!.inputSchema as { properties: Props }).properties;
    expect(wallProps.name_contains!.description).toMatch(/ROOM's name: this picks rooms, never walls/);
    expect(wallProps.name_contains!.description).not.toMatch(/Exterior wall|Shared wall/);
    expect(wallProps.in_folder!.description).toMatch(/holds ROOMS/);
    expect(wallProps.in_folder!.description).not.toMatch(/WALL TYPE|keep a category/);
    expect(wallProps.blueprint_ids!.description).toMatch(/REQUIRED when you choose no rooms/);
    expect(wallProps.blueprint_ids!.description).not.toMatch(/Omit to cover/);
    expect(tools.calculate_wall_surface_area!.description).toMatch(/cannot choose walls by type/);
    // the shared filters on count and find still teach walls by type and by name
    const countProps = (tools.count_elements!.inputSchema as { properties: Props }).properties;
    expect(countProps.in_folder!.description).toMatch(/WALL TYPE is a folder name/);
    // feet and inches: one height, in both tools that take a height
    expect(wallProps.room_height_unit!.description).toMatch(/Feet and inches written together[^.]*ONE height/);
    const openingProps = (tools.set_opening_height!.inputSchema as { properties: Props }).properties;
    expect(openingProps.height_unit!.description).toMatch(/Feet and inches written together[^.]*ONE height/);
    // a project's id, never its name
    const listProps = (tools.list_blueprints!.inputSchema as { properties: Props }).properties;
    expect(listProps.project_id!.description).toMatch(/never its name/);
    expect(countProps.project_id!.description).toMatch(/never its name/);
  });

  it("marks set_scale destructive, so hosts ask before it rewrites a sheet", async () => {
    const tool = (await listTools(true)).find((t) => t.name === "set_scale")!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it("steers the older tools toward the exact ones", async () => {
    const tools = Object.fromEntries((await listTools(true)).map((t) => [t.name, t]));
    expect(tools.list_elements!.description).toMatch(/^Outlines and positions of a blueprint's elements/);
    expect(tools.view_takeoff!.description).toMatch(/^Show one blueprint's take-off summary panel/);
    expect(tools.view_takeoff!.description).toMatch(/Never show a raw id unless the user asks for one\.$/);
    for (const name of ["update_elements", "move_elements"]) {
      expect(tools[name]!.description).toContain("Pass ids from find_elements (id), count_elements (element_ids)");
      expect(JSON.stringify(tools[name]!.inputSchema)).toContain("Local ids from find_elements (id)");
    }
    expect(tools.view_blueprint!.description).toMatch(/show them with render_table and open the plan from a row\.$/);
    expect(tools.list_blueprints!.description).toContain("include_inventory");
  });
});

describe("server instructions", () => {
  const instructionsOf = async (opts: { queryTools: boolean; instructions?: boolean }) => {
    const client = await connect(opts);
    return client.getInstructions();
  };

  it("keeps today's text with the query tools off", async () => {
    expect(await instructionsOf({ queryTools: false })).toBe(
      "Tools for managing Kamai construction-blueprint projects, blueprints, and takeoffs.",
    );
  });

  it("teaches the query tools when they are on", async () => {
    const text = await instructionsOf({ queryTools: true });
    expect(text).toMatch(/^Kamai reads construction blueprints \(sheets\) inside projects\./);
    expect(text).toContain("list_blueprints with project_id and include_inventory");
  });

  it("can be left out, as claude.ai does", async () => {
    expect(await instructionsOf({ queryTools: true, instructions: false })).toBeUndefined();
  });
});
