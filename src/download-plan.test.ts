import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, errorText, stubApi, structured } from "./testing/harness.ts";
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

  it("sends selected ids, and nothing at all for everything", async () => {
    const calls = stubApi({ "POST /v1/projects/p1/blueprints/bp1/export": { body: exported } });
    await call({ blueprint_id: "bp1", project_id: "p1", element_ids: ["d1", "kitchen"] });
    await call({ blueprint_id: "bp1", project_id: "p1" });
    expect(calls.map((c) => c.body)).toEqual([{ element_ids: ["d1", "kitchen"] }, {}]);
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
