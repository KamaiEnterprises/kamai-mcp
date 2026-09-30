import { describe, expect, it } from "vitest";

import { parseToolResultParams } from "./tool-result";

describe("parseToolResultParams", () => {
  it("prefers structuredContent when present", () => {
    expect(
      parseToolResultParams({
        structuredContent: { url: "https://app.kamai.io" },
        content: [{ type: "text", text: '{"url":"https://other.example"}' }],
      }),
    ).toEqual({ url: "https://app.kamai.io" });
  });

  // Open WebUI's MCP App Bridge shim often ships only content text, then
  // reconstructs structuredContent by JSON-parsing it — or fails to, leaving
  // content alone. Hosts that drop structuredContent (ext-apps#696) look the same.
  it("falls back to parsing content[0].text", () => {
    expect(
      parseToolResultParams({
        content: [{ type: "text", text: '{"url":"https://app.kamai.io","open_in":"fullscreen"}' }],
      }),
    ).toEqual({ url: "https://app.kamai.io", open_in: "fullscreen" });
  });

  // render_table's payload reaches the table widget the same two ways.
  it("reads a table payload from either half", () => {
    const table = {
      project_id: "p1",
      title: "Door schedule",
      built_by: "kamai",
      columns: [{ key: "count", label: "Count", type: "count" }],
      rows: [{ index: 0, cells: { count: 3 }, kind: "item", element_count: 3, element_ids: { bp1: ["a", "b", "c"] } }],
      selection: "q1.abc",
      notes: [],
      problems: [],
    };
    expect(parseToolResultParams({ structuredContent: table })).toEqual(table);
    expect(parseToolResultParams({ content: [{ type: "text", text: JSON.stringify(table) }] })).toEqual(table);
  });

  it("returns undefined when neither half carries a payload", () => {
    expect(parseToolResultParams({ content: [] })).toBeUndefined();
    expect(parseToolResultParams(undefined)).toBeUndefined();
  });
});
