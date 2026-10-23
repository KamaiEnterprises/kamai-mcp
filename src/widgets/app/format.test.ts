import { describe, expect, it } from "vitest";

import { asArray, belongsToUpload, isBlueprintReady, rgba, scaleWarning } from "./format";

describe("widget view models", () => {
  it("normalizes keyed and array payloads", () => {
    expect(asArray([{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(asArray({ b: { id: "b" } })).toEqual([{ id: "b" }]);
  });

  it("does not mark a blueprint ready while a job is still running", () => {
    const blueprint = { id: "b", ready: { geojson: true, all_tiles: true } };
    expect(isBlueprintReady(blueprint, [{ id: "j", blueprint_id: "b", status: "RUNNING" }])).toBe(false);
    expect(isBlueprintReady(blueprint, [{ id: "j", blueprint_id: "b", status: "SUCCEEDED" }])).toBe(true);
  });

  it("picks an upload's page jobs by the upload they name, not by their file name", () => {
    const upload = { jobId: "j1", uploadId: "u1" };
    const job = (id: string, upload_id: string | null, filename: string) =>
      ({ id, blueprint_id: "b", status: "RUNNING", filename, upload_id });
    expect(belongsToUpload(job("j1", null, "plan.pdf"), upload)).toBe(true);
    expect(belongsToUpload(job("j2", "u1", "(2) plan.pdf"), upload)).toBe(true);
    expect(belongsToUpload(job("j3", "u0", "(2) plan.pdf"), upload)).toBe(false);
    expect(belongsToUpload(job("j4", null, "(2) plan.pdf"), { jobId: "j1", uploadId: null })).toBe(false);
  });

  it("bounds rgba values before they reach canvas styles", () => {
    expect(rgba({ r: 999, g: -4, b: 20, a: 128 })).toBe("rgba(255,0,20,0.5019607843137255)");
  });

  it("distinguishes missing and unconfirmed scale", () => {
    const base = {
      blueprint_id: "b",
      project_id: "p",
      project_name: "P",
      state: "ready" as const,
    };
    expect(scaleWarning({ ...base, needs_scale: true })).toContain("no usable scale");
    expect(scaleWarning({ ...base, scale_unconfirmed: true, scale_label: "1:100" })).toContain("not confirmed");
  });
});
