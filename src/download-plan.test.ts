import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, errorText, stubApi, structured } from "./testing/harness.ts";
import { handOver } from "./tool-kit.ts";
import { downloadPrompt } from "./widgets/app/format.ts";

const exported = {
  blueprint_id: "bp1",
  name: "Ground Floor",
  project_id: "p1",
  project_name: "Tower",
  url: "https://storage.googleapis.com/b/signed_url_uploads/exports/x.pdf?X-Goog-Signature=s",
  file_name: "Ground Floor - marked.pdf",
  format: "pdf",
  expires_in: 900,
  bytes: 12345,
  elements: 8,
  legend: [{ label: "single swing door", count: 3, color: { r: 1, g: 2, b: 3, a: 4 } }],
  unmatched_highlight: [],
  missing_ids: [],
};

describe("download_plan", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function call(args: Record<string, unknown>) {
    const client = await connect();
    return client.callTool({ name: "download_plan", arguments: args });
  }

  it("posts the highlight to the export route and returns the link", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: exported } });
    const result = await call({ blueprint_id: "bp1", project_id: "p1", highlight: ["doors", "windows"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ highlight: ["doors", "windows"] });
    expect(structured(result)).toMatchObject({ url: exported.url, file_name: exported.file_name, elements: 8 });
  });

  // A user's own spelling: download_plan(plan_id, highlighted_areas: "doors, windows").
  it("splits one comma-separated highlight into terms", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: exported } });
    await call({ blueprint_id: "bp1", project_id: "p1", highlight: ["doors, windows ", " "] });
    expect(calls[0]!.body).toEqual({ highlight: ["doors", "windows"] });
  });

  it("sends selected ids, and nothing for everything", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: exported } });
    await call({ blueprint_id: "bp1", project_id: "p1", element_ids: ["d1", "kitchen"] });
    await call({ blueprint_id: "bp1", project_id: "p1" });
    expect(calls.map((c) => c.body)).toEqual([{ element_ids: ["d1", "kitchen"] }, {}]);
  });

  // A plan comes without a legend unless asked, as export does.
  it("adds the legend page only when asked", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: exported } });
    await call({ blueprint_id: "bp1", project_id: "p1", highlight: ["doors"], legend: true });
    await call({ blueprint_id: "bp1", project_id: "p1", highlight: ["doors"], legend: false });
    expect(calls.map((c) => c.body)).toEqual([{ highlight: ["doors"], legend: true }, { highlight: ["doors"] }]);
  });

  it("resolves the project when only the blueprint is given", async () => {
    const calls = stubApi({
      "GET /v1/blueprints/bp1": { body: { project_id: "p1", project_name: "Tower", blueprint_id: "bp1", name: "Ground Floor" } },
      "POST /v1/projects/p1/blueprints/bp1/export": { body: exported },
    });
    await call({ blueprint_id: "bp1", highlight: ["rooms"] });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/blueprints/bp1",
      "POST /v1/projects/p1/blueprints/bp1/export",
    ]);
  });

  it("says a still-processing blueprint is not ready, without the upstream detail", async () => {
    stubApi({
      "POST /v1/projects/p1/blueprints/bp1/export": {
        status: 409,
        body: { code: "not_ready", title: "Not ready", status: 409, detail: "internal-host-123" },
      },
    });
    const result = await call({ blueprint_id: "bp1", project_id: "p1", highlight: ["doors"] });
    expect(result.isError).toBe(true);
    expect(errorText(result)).not.toContain("internal-host-123");
  });
});

describe("the widget's download request for hosts that cannot call tools", () => {
  it("names the classes and the exact ids", () => {
    const text = downloadPrompt("Ground Floor", ["d1", "w2"], ["room"]);
    expect(text).toContain('"Ground Floor"');
    expect(text).toContain('highlight: ["room"]');
    expect(text).toContain('element_ids: ["d1","w2"]');
  });

  it("asks for every element when nothing is picked", () => {
    expect(downloadPrompt("Ground Floor", [], [])).toContain("every element");
  });
});

describe("file link hand-over", () => {
  it("download_plan returns the JSON and a note carrying the ready markdown link", async () => {
    stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: exported } });
    const client = await connect();
    const result = await client.callTool({ name: "download_plan", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    const content = result.content as Array<Record<string, unknown>>;
    expect(JSON.parse(content[0]!.text as string)).toEqual(exported);
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: "text", text: handOver(exported.file_name, exported.url, 900) });
    expect(content[1]!.text).toContain(`[Ground Floor - marked.pdf](${exported.url})`);
    expect(content[1]!.text).toContain("15 min");
    expect(structured(result)).toEqual(exported);
  });

  it("export does the same for a table file", async () => {
    const file = { format: "xlsx", url: "https://storage.googleapis.com/b/x.xlsx?s=1", file_name: "Doors.xlsx", bytes: 9, expires_in: 900 };
    stubApi({ "POST /v1/projects/p1/export": { body: file } });
    const client = await connect({ queryTools: true });
    const result = await client.callTool({
      name: "export",
      arguments: { project_id: "p1", format: "xlsx", table: { columns: [{ key: "a", label: "A" }], rows: [] } },
    });
    const content = result.content as Array<Record<string, unknown>>;
    expect(content.map((c) => c.type)).toEqual(["text", "text"]);
    expect(content[1]!.text).toContain(`[Doors.xlsx](${file.url})`);
  });

  it("never rewrites the signed url, and keeps an expiry of zero", () => {
    const note = handOver("Plan [v2].pdf", "https://s/x.pdf?a=(1)", 0);
    expect(note).toContain("[Plan v2.pdf](https://s/x.pdf?a=(1))");
    expect(note).toContain("1 min");
  });

  it("tells the model in both descriptions not to fetch the link itself", async () => {
    const client = await connect({ queryTools: true });
    const { tools } = await client.listTools();
    for (const name of ["download_plan", "export"]) {
      expect(tools.find((t) => t.name === name)!.description).toContain("never download or open it yourself");
    }
  });
});
