import { afterEach, describe, expect, it, vi } from "vitest";

import { blueprintDetailSchema, geometryPageSchema, jobSummarySchema } from "./api.ts";
import { rotationResultSchema } from "./query/contract.ts";
import { RESULT_LINK } from "./query/descriptions.ts";
import { connect, errorText, stubApi, structured, type ApiReply } from "./testing/harness.ts";

// set_rotation passes one absolute turn through to the API layer, and the
// sheet's rotation reaches view_blueprint's widget.

afterEach(() => vi.unstubAllGlobals());

const P = "p1";
const ROUTE = `PUT /v1/projects/${P}/blueprints/bp1/rotation`;
const turned = {
  blueprint_id: "bp1",
  name: "Ground",
  previous: 0,
  rotation: 90,
  auto_rotation: 270,
  project_id: P,
  app_url: "https://app.kamai.io/projects/p1/blueprints/bp1",
  reference_ids: { project_id: P, blueprint_id: "bp1" },
};

async function call(args: Record<string, unknown>, routes: Record<string, ApiReply>, rotation = true) {
  const calls = stubApi(routes);
  const client = await connect({ queryTools: true, rotation });
  const result = await client.callTool({ name: "set_rotation", arguments: args });
  return { result, calls };
}

describe("set_rotation", () => {
  it("PUTs the absolute rotation once and passes the result through", async () => {
    const { result, calls } = await call({ project_id: P, blueprint_id: "bp1", rotation: 90 }, { [ROUTE]: { body: turned } });
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls).toEqual([{ method: "PUT", path: `/v1/projects/${P}/blueprints/bp1/rotation`, query: {}, body: { rotation: 90 } }]);
    expect(structured(result)).toEqual(turned);
  });

  it("looks the project up when it is not given", async () => {
    const { result, calls } = await call(
      { blueprint_id: "bp1", rotation: 0 },
      {
        "GET /v1/blueprints/bp1": { body: { project_id: P, project_name: "Tower", blueprint_id: "bp1", name: "Ground" } },
        [ROUTE]: { body: { ...turned, previous: 90, rotation: 0 } },
      },
    );
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/blueprints/bp1", `PUT /v1/projects/${P}/blueprints/bp1/rotation`]);
  });

  it("reports a turn it made when the API layer sends no auto_rotation", async () => {
    const { auto_rotation: _auto, ...older } = turned;
    const { result } = await call({ project_id: P, blueprint_id: "bp1", rotation: 180 }, { [ROUTE]: { body: { ...older, rotation: 180 } } });
    expect(result.isError, errorText(result)).toBeFalsy();
    expect(structured(result)).toMatchObject({ rotation: 180, previous: 0 });
  });

  it("refuses anything but a quarter turn without calling Kamai", async () => {
    for (const rotation of [45, -90, 360, "90"]) {
      const { result, calls } = await call({ project_id: P, blueprint_id: "bp1", rotation }, { [ROUTE]: { body: turned } });
      expect(result.isError, String(rotation)).toBe(true);
      expect(calls, String(rotation)).toHaveLength(0);
    }
  });

  it("says route_missing on an API layer without the route", async () => {
    const { result } = await call({ project_id: P, blueprint_id: "bp1", rotation: 90 }, {});
    expect(result.isError).toBe(true);
  });
});

describe("set_rotation in the tool list", () => {
  const listTools = async (opts: { queryTools: boolean; rotation?: boolean }) =>
    (await (await connect(opts)).listTools()).tools;

  it("comes with the query tools unless KAMAI_ROTATION=off", async () => {
    expect((await listTools({ queryTools: true })).map((t) => t.name)).toContain("set_rotation");
    expect((await listTools({ queryTools: true, rotation: false })).map((t) => t.name)).not.toContain("set_rotation");
    expect((await listTools({ queryTools: false, rotation: true })).map((t) => t.name)).not.toContain("set_rotation");
  });

  it("is a write that destroys nothing, and the same turn twice ends the same", async () => {
    const tool = (await listTools({ queryTools: true, rotation: true })).find((t) => t.name === "set_rotation")!;
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool.title).toBeTruthy();
  });

  it("says it is display only, absolute and clockwise, and ends with the result link", async () => {
    const tool = (await listTools({ queryTools: true, rotation: true })).find((t) => t.name === "set_rotation")!;
    expect(tool.description).toMatch(/clockwise/);
    expect(tool.description).toMatch(/not a step added to the current one/);
    expect(tool.description).toMatch(/no measurement, element, scale or position changes, nothing is processed again/);
    expect(tool.description).toMatch(/auto_rotation/);
    expect(tool.description!.endsWith(RESULT_LINK)).toBe(true);
    const props = (tool.inputSchema as { properties: Record<string, unknown>; required?: string[] });
    expect(Object.keys(props.properties).sort()).toEqual(["blueprint_id", "project_id", "rotation"]);
    expect(props.required?.sort()).toEqual(["blueprint_id", "rotation"]);
    expect(JSON.stringify(tool.outputSchema)).not.toContain('"additionalProperties":false');
  });
});

describe("rotation on sheet responses", () => {
  const geometry = {
    blueprint_id: "bp1",
    name: "Ground",
    project_id: P,
    project_name: "Tower",
    state: "ready",
    grid: 2000,
    image: { url: "https://storage.googleapis.com/x/preview.webp", w: 8192, h: 5792 },
    features: [],
    total: 0,
    truncated: false,
    next_cursor: null,
    scale_label: "1:50",
    needs_scale: false,
    scale_unconfirmed: false,
    units: { area: "m²", length: "m" },
    classes: [],
  };
  const detail = {
    blueprint_id: "bp1",
    name: "Ground",
    project_id: P,
    project_name: "Tower",
    state: "ready",
    progress: 100,
    failed: false,
  };
  const job = { id: "j1", blueprint_id: "bp1", status: "SUCCEEDED", filename: "a.pdf", progress: 100 };

  it("validates with and without the rotation fields", () => {
    for (const [schema, body] of [[geometryPageSchema, geometry], [blueprintDetailSchema, detail]] as const) {
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.parse({ ...body, rotation: 270, auto_rotation: 90 })).toMatchObject({ rotation: 270, auto_rotation: 90 });
      expect(schema.safeParse({ ...body, rotation: null, auto_rotation: null }).success).toBe(true);
    }
    expect(jobSummarySchema.safeParse(job).success).toBe(true);
    expect(jobSummarySchema.parse({ ...job, page_index: 3, auto_rotation: 90 })).toMatchObject({ page_index: 3, auto_rotation: 90 });
    expect(rotationResultSchema.safeParse(turned).success).toBe(true);
    expect(rotationResultSchema.safeParse({ blueprint_id: "bp1", rotation: 0 }).success).toBe(true);
  });

  it("hands the widget the sheet's rotation, and adds no key when the API layer sends none", async () => {
    stubApi({ [`GET /v1/projects/${P}/blueprints/bp1/geometry`]: { body: { ...geometry, rotation: 90, auto_rotation: 0 } } });
    let client = await connect({ queryTools: false });
    let result = await client.callTool({ name: "view_blueprint", arguments: { blueprint_id: "bp1", project_id: P } });
    expect(structured(result)).toMatchObject({ rotation: 90, auto_rotation: 0 });

    stubApi({ [`GET /v1/projects/${P}/blueprints/bp1/geometry`]: { body: geometry } });
    client = await connect({ queryTools: false });
    result = await client.callTool({ name: "view_blueprint", arguments: { blueprint_id: "bp1", project_id: P } });
    expect(structured(result)).not.toHaveProperty("rotation");
    expect(structured(result)).not.toHaveProperty("auto_rotation");
  });
});
