import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, stubApi, structured } from "./testing/harness.ts";
import { uploadReference } from "./widgets/app/format.ts";
import { RESULT_LINK } from "./query/descriptions.ts";

// Microsoft's Copilot certification: every action reply carries a link to the result in Kamai and the ids
// to check it by. The API layer builds `app_url`; this server passes it on as plain data. No sentence that tells
// the model what to write: Microsoft 365 Copilot refused every action reply that carried one (2026-10-12 22:4xZ).
const SHEET = "https://app.kamai.io/projects/p1/bp1";
const ROW = { id: "op", tag: "door", height_units: null, height_m: null, feature_class: "wall_surface_with_opening" };

const content = (result: unknown) => (result as { content: Array<{ text: string }> }).content;

describe("action replies carry the link in Kamai as data", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("cancel_job passes app_url and the ids, in one JSON block", async () => {
    const job = { id: "j1", blueprint_id: "bp1", status: "CANCELLED", state: "PREPARING_TILES", filename: "a.pdf",
      progress: 31, upload_id: "u1", project_id: "p1", app_url: SHEET };
    stubApi({ "POST /v1/projects/p1/jobs/j1/cancel": { body: job } });
    const result = await (await connect()).callTool({ name: "cancel_job", arguments: { project_id: "p1", job_id: "j1" } });
    expect(content(result)).toHaveLength(1);
    expect(JSON.parse(content(result)[0]!.text)).toMatchObject({ id: "j1", upload_id: "u1", project_id: "p1", app_url: SHEET });
    expect(structured(result)).toMatchObject({ app_url: SHEET });
  });

  it("set_opening_height keeps app_url and the ids through its reshaped reply", async () => {
    stubApi({ "POST /v1/projects/p1/blueprints/bp1/opening-pieces": { body: {
      applied: true, changed: 1, fields: ["tag"], written: [ROW], refused: [], project_id: "p1", blueprint_id: "bp1", app_url: SHEET } } });
    const result = await (await connect()).callTool({
      name: "set_opening_height", arguments: { blueprint_id: "bp1", project_id: "p1", ids: ["op"], tag: "door" } });
    expect(structured(result)).toMatchObject({ applied: true, app_url: SHEET, blueprint_id: "bp1", project_id: "p1" });
    expect(content(result)).toHaveLength(1);
  });

  it("set_opening_height keeps the ids even without a link", async () => {
    stubApi({ "POST /v1/projects/p1/blueprints/bp1/opening-pieces": { body: {
      applied: true, changed: 1, fields: ["tag"], written: [ROW], refused: [], project_id: "p1", blueprint_id: "bp1" } } });
    const result = await (await connect()).callTool({
      name: "set_opening_height", arguments: { blueprint_id: "bp1", project_id: "p1", ids: ["op"], tag: "door" } });
    expect(structured(result)).toMatchObject({ project_id: "p1", blueprint_id: "bp1" });
    expect(structured(result)).not.toHaveProperty("app_url");
  });

  it("download_plan keeps app_url past its closed decoder; only the file hand-over note follows", async () => {
    stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: {
      blueprint_id: "bp1", name: "G", project_id: "p1", project_name: "T", url: "https://storage.googleapis.com/x.pdf",
      file_name: "G - marked.pdf", format: "pdf", expires_in: 900, bytes: 1, elements: 1, legend: [],
      unmatched_highlight: [], missing_ids: [], app_url: SHEET } } });
    const result = await (await connect()).callTool({ name: "download_plan", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    expect(structured(result)).toMatchObject({ app_url: SHEET });
    expect(content(result)).toHaveLength(2);
    expect(content(result)[1]!.text).not.toContain("Open in Kamai");
  });

  it("view_upload carries the chosen project's link and nothing else", async () => {
    stubApi({ "GET /v1/projects": { body: { items: [
      { id: "p1", name: "Tower", description: "", app_url: "https://app.kamai.io/projects/p1" }], next_cursor: null } } });
    const result = await (await connect()).callTool({ name: "view_upload", arguments: { project_id: "p1" } });
    expect(structured(result)).toMatchObject({ project_id: "p1", app_url: "https://app.kamai.io/projects/p1" });
    expect(content(result)).toHaveLength(1);
  });

  it("view_projects keeps each project's link", async () => {
    stubApi({ "GET /v1/projects": { body: { items: [
      { id: "p1", name: "Tower", description: "", app_url: "https://app.kamai.io/projects/p1", blueprints: [] }], next_cursor: null } } });
    const result = await (await connect()).callTool({ name: "view_projects", arguments: {} });
    expect((structured(result) as { projects: unknown[] }).projects[0]).toMatchObject({ app_url: "https://app.kamai.io/projects/p1" });
  });

  it("the upload panel's outcome names the link and the ids as data, with no instruction", () => {
    expect(uploadReference("https://app.kamai.io/projects/p1", { jobId: "j1", uploadId: "u1" }))
      .toBe(" Kamai link: https://app.kamai.io/projects/p1; upload id: u1; job id: j1.");
    expect(uploadReference(null, null)).toBe("");
    expect(uploadReference("https://app.kamai.io/projects/p1", null)).not.toMatch(/reply|exactly|write/i);
  });
});

describe("reference_ids pass through", () => {
  afterEach(() => vi.unstubAllGlobals());
  const REF = { project_id: "p1", blueprint_id: "bp1" };

  it("set_opening_height keeps reference_ids", async () => {
    stubApi({ "POST /v1/projects/p1/blueprints/bp1/opening-pieces": { body: {
      applied: true, changed: 1, fields: ["tag"], written: [ROW], refused: [], ...REF, app_url: SHEET, reference_ids: REF } } });
    const result = await (await connect()).callTool({
      name: "set_opening_height", arguments: { blueprint_id: "bp1", project_id: "p1", ids: ["op"], tag: "door" } });
    expect(structured(result)).toMatchObject({ reference_ids: REF });
  });

  it("download_plan and export keep reference_ids past their closed decoders", async () => {
    const ref = { ...REF, file_name: "G - marked.pdf" };
    stubApi({
      "POST /v1/projects/p1/blueprints/bp1/export": { body: {
        blueprint_id: "bp1", name: "G", project_id: "p1", project_name: "T", url: "https://storage.googleapis.com/x.pdf",
        file_name: "G - marked.pdf", format: "pdf", expires_in: 900, bytes: 1, elements: 1, legend: [],
        unmatched_highlight: [], missing_ids: [], app_url: SHEET, reference_ids: ref } },
      "POST /v1/projects/p1/export": { body: {
        format: "xlsx", url: "https://storage.googleapis.com/x.xlsx", file_name: "T.xlsx", bytes: 1, expires_in: 900,
        ...REF, app_url: SHEET, reference_ids: { ...REF, file_name: "T.xlsx" } } },
    });
    const client = await connect({ queryTools: true });
    const plan = await client.callTool({ name: "download_plan", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    expect(structured(plan)).toMatchObject({ reference_ids: ref });
    const file = await client.callTool({ name: "export", arguments: { project_id: "p1", format: "xlsx", blueprint_id: "bp1",
      table: { columns: [{ key: "k", label: "K" }], rows: [{ cells: { k: 1 } }] } } });
    expect(structured(file)).toMatchObject({ reference_ids: { ...REF, file_name: "T.xlsx" } });
  });

  it("create_folder passes folder_id and reference_ids", async () => {
    const body = { applied: true, id: "f1", folder_id: "f1", name: "N", parent_id: null, ...REF, app_url: SHEET,
      reference_ids: { folder_id: "f1", ...REF } };
    stubApi({ "POST /v1/projects/p1/blueprints/bp1/folders": { body } });
    const result = await (await connect()).callTool({ name: "create_folder", arguments: { blueprint_id: "bp1", project_id: "p1", name: "N" } });
    expect(JSON.parse(content(result)[0]!.text)).toMatchObject({ folder_id: "f1", reference_ids: { folder_id: "f1", ...REF } });
  });
});


describe("the result-link rule lives in descriptions only", () => {
  const ACTIONS = ["update_elements", "create_folder", "move_elements", "set_opening_height", "set_scale", "create_project",
    "update_project", "cancel_job", "finalize_blueprint_upload", "download_plan", "export"];

  it("every action tool's description names app_url as the \"Open in Kamai\" link", async () => {
    const tools = (await (await connect({ queryTools: true })).listTools()).tools;
    for (const name of ACTIONS) {
      expect(tools.find((t) => t.name === name)?.description, name).toContain(RESULT_LINK);
    }
    // Ids stay out of chat replies; nothing asks the model to show them.
    expect(RESULT_LINK).not.toMatch(/list the reference ids|show (them|the ids)/);
    expect(RESULT_LINK).toMatch(/never show a raw id unless the user asks/);
  });
});


describe("list_jobs pages", () => {
  afterEach(() => vi.unstubAllGlobals());
  const jobs = Array.from({ length: 40 }, (_, i) => ({ id: `j${i}`, blueprint_id: "bp1", status: "SUCCEEDED", filename: `(${i}) a.pdf`, progress: 100 }));

  it("asks Kamai for one more than the page and names the next offset", async () => {
    const calls = stubApi({ "GET /v1/projects/p1/jobs": (call) => ({
      body: jobs.slice(Number(call.query.offset ?? 0), Number(call.query.offset ?? 0) + Number(call.query.limit)) }) });
    const client = await connect();
    const first = JSON.parse(content(await client.callTool({ name: "list_jobs", arguments: { project_id: "p1" } }))[0]!.text);
    expect(calls.find((c) => c.path.endsWith("/jobs"))!.query).toEqual({ limit: "26" });
    expect(first.jobs).toHaveLength(25);
    expect(first.next_offset).toBe(25);
    const last = JSON.parse(content(await client.callTool({ name: "list_jobs", arguments: { project_id: "p1", offset: 25 } }))[0]!.text);
    expect(last.jobs.map((j: { id: string }) => j.id)).toEqual(jobs.slice(25).map((j) => j.id));
    expect(last).not.toHaveProperty("next_offset");
  });

  // An older Kamai with exactly limit + 1 jobs must not repeat the first page on the second.
  it("pages an older Kamai's list itself, at the limit + 1 boundary too", async () => {
    stubApi({ "GET /v1/projects/p1/jobs": { body: jobs.slice(0, 26) } });
    const client = await connect();
    const call = async (offset: number) =>
      JSON.parse(content(await client.callTool({ name: "list_jobs", arguments: { project_id: "p1", offset } }))[0]!.text);
    const [one, two] = [await call(0), await call(25)];
    expect(one.jobs).toHaveLength(25);
    expect(one.next_offset).toBe(25);
    expect(two.jobs.map((j: { id: string }) => j.id)).toEqual(["j25"]);
    expect(two).not.toHaveProperty("next_offset");
  });

  it("never offers a next_offset past the last one it accepts", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ ...jobs[0]!, id: `j${i}` }));
    stubApi({ "GET /v1/projects/p1/jobs": (call) => ({ body: many.slice(0, Number(call.query.limit)) }) });
    const client = await connect();
    const page = async (offset: number) =>
      JSON.parse(content(await client.callTool({ name: "list_jobs", arguments: { project_id: "p1", offset, limit: 100 } }))[0]!.text);
    expect((await page(799)).next_offset).toBe(899);
    const last = await page(899);
    expect(last.jobs).toHaveLength(100);
    expect(last).not.toHaveProperty("next_offset");
    expect(last.older_not_listed).toBe(true);
  });

  it("pages an older Kamai's full list itself", async () => {
    stubApi({ "GET /v1/projects/p1/jobs": { body: jobs } });
    const page = JSON.parse(content(await (await connect()).callTool({ name: "list_jobs", arguments: { project_id: "p1", limit: 10, offset: 10 } }))[0]!.text);
    expect(page.jobs.map((j: { id: string }) => j.id)).toEqual(jobs.slice(10, 20).map((j) => j.id));
    expect(page.next_offset).toBe(20);
  });
});


describe("list_jobs leads with the newest upload", () => {
  afterEach(() => vi.unstubAllGlobals());
  const job = { id: "j1", blueprint_id: "bp1", status: "RUNNING", filename: "(1) a.pdf", progress: 3, upload_id: "u1" };

  it("puts latest_upload first when Kamai names one", async () => {
    const latest = { upload_id: "u1", filename: "a.pdf", created_at: "2026-10-13T03:38:00", status: "RUNNING", pages: 24, open_pages: 23 };
    stubApi({ "GET /v1/projects/p1/jobs": { body: [job] }, "GET /v1/projects/p1/uploads/latest": { body: latest } });
    const result = await (await connect()).callTool({ name: "list_jobs", arguments: { project_id: "p1" } });
    const body = JSON.parse(content(result)[0]!.text);
    expect(Object.keys(body)[0]).toBe("latest_upload");
    expect(body.latest_upload).toEqual(latest);
  });

  it("an older Kamai without the route gets the jobs as before", async () => {
    stubApi({ "GET /v1/projects/p1/jobs": { body: [job] } });
    const result = await (await connect()).callTool({ name: "list_jobs", arguments: { project_id: "p1" } });
    expect(Object.keys(JSON.parse(content(result)[0]!.text))).toEqual(["jobs", "count"]);
  });
});
