import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "./server.ts";

describe("legend-edit tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function connect() {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    const server = buildServer({ uid: "test", token: "test" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("advertises list_folders, update_elements, create_folder and move_elements", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_folders");
    expect(names).toContain("update_elements");
    expect(names).toContain("create_folder");
    expect(names).toContain("move_elements");
    const tools = (await client.listTools()).tools;
    const listFolders = tools.find((t) => t.name === "list_folders");
    const update = tools.find((t) => t.name === "update_elements");
    const create = tools.find((t) => t.name === "create_folder");
    const move = tools.find((t) => t.name === "move_elements");
    expect(listFolders?.annotations?.readOnlyHint).toBe(true);
    expect(update?.annotations?.readOnlyHint).toBe(false);
    expect(create?.annotations?.readOnlyHint).toBe(false);
    expect(move?.annotations?.readOnlyHint).toBe(false);
    expect(listFolders?._meta?.ui).toBeUndefined();
  });

  it("list_folders hits the folders endpoint", async () => {
    vi.stubGlobal("fetch", async (url: URL) => {
      expect(String(url)).toContain("/blueprints/bp1/folders");
      expect(String(url)).not.toContain("method");
      return new Response(
        JSON.stringify({
          blueprint_id: "bp1",
          project_id: "pr1",
          project_name: "Tower",
          folders: [
            {
              id: "root",
              name: "Root",
              parent_id: null,
              is_root: true,
              color: null,
              position: 0,
            },
          ],
          count: 1,
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const client = await connect();
    const result = await client.callTool({
      name: "list_folders",
      arguments: { blueprint_id: "bp1", project_id: "pr1" },
    });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.project_name).toBe("Tower");
    expect(structured.count).toBe(1);
  });

  it("rejects an ids-only update_elements before calling the API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    const result = await client.callTool({
      name: "update_elements",
      arguments: { blueprint_id: "bp1", project_id: "pr1", ids: ["door-1"] },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/name or color/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
