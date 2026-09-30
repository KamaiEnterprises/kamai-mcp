import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../server.ts";

// A client that validates structuredContent against the advertised outputSchema, as the
// Python SDK behind Open WebUI's MCP App Bridge does, rejected every real geometry page
// and takeoff: the API sends fields (text*, row folder) the declared schema forbids.
const geometry = {
  blueprint_id: "bp1",
  name: "Haus F",
  project_id: "p1",
  project_name: "Default Project",
  state: "ready",
  grid: 1,
  image: null,
  features: [{ i: 0, id: "r0", cls: "room", name: "Room 0", folder: null, color: { r: 1, g: 2, b: 3, a: 1 }, area: 12.5 }],
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
  name: "Haus F",
  project_id: "p1",
  project_name: "Default Project",
  state: "ready",
  rows: [{ group: "Areas", cls: "room", folder: "Group 1", count: 1, area: 12.5, len: 0, color: { r: 1, g: 2, b: 3, a: 1 } }],
  totals: { count: 1, area: 12.5, len: 0 },
  shapes: 1,
  scale_label: "1:50",
  needs_scale: false,
  scale_unconfirmed: false,
  units: { area: "m²", length: "m" },
};

afterEach(() => vi.unstubAllGlobals());

async function strictClient(body: unknown) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  const server = buildServer({ uid: "test", token: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "strict", version: "0" });
  await client.connect(b);
  await client.listTools();
  return client;
}

describe("widget results on a client that validates outputSchema", () => {
  it("view_blueprint passes with the API's text fields present", async () => {
    const client = await strictClient(geometry);
    const result = await client.callTool({ name: "view_blueprint", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty("text_total");
    expect((result.structuredContent as { features: unknown[] }).features).toHaveLength(1);
  });

  it("view_takeoff passes with a row folder present", async () => {
    const client = await strictClient(takeoff);
    const result = await client.callTool({ name: "view_takeoff", arguments: { blueprint_id: "bp1", project_id: "p1" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { rows: object[] }).rows[0]).not.toHaveProperty("folder");
  });
});
