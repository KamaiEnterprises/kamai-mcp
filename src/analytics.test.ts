import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { API_BASE_URL } from "./config.ts";

type Captured = { event: string; distinct_id: string; properties: Record<string, unknown> };

// A stand-in for eu.i.posthog.com: whatever the real client sends to /batch/ lands here.
const received: Captured[] = [];
let slowIngest = false;
const ingest = createServer((req, res) => {
  if (slowIngest) return;
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const body = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString("utf8"));
    received.push(...(body.batch as Captured[]));
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});

let base = "";
let close = () => {};

beforeAll(async () => {
  await new Promise<void>((resolve) => ingest.listen(0, resolve));
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_test");
  vi.stubEnv("POSTHOG_HOST", `http://127.0.0.1:${(ingest.address() as AddressInfo).port}`);
  vi.resetModules();
  const { handleMcp, mcpGuards } = await import("./index.ts");
  const app = express();
  app.post("/mcp", (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.principal = { uid: "u1", token: "t" };
    next();
  }, ...mcpGuards, handleMcp);
  const server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(() => {
  close();
  ingest.close();
  vi.unstubAllEnvs();
});

// Returns as soon as the first JSON-RPC message is read and drops the connection, the way
// the Python MCP SDK behind Open WebUI does; nothing after that point is guaranteed CPU.
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "user-agent": "probe/1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    const line = text.split("\n").find((l) => l.startsWith("data:") && l.endsWith("}"));
    if (line || done) {
      const snapshot = [...received];
      await reader.cancel();
      return { body: JSON.parse(line ? line.slice(5) : text) as { result?: Record<string, unknown> }, snapshot };
    }
  }
}

// Only the API layer is stubbed: the probe's own request and the PostHog batch use the real fetch.
function stubProjects(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: URL | string, init?: RequestInit) =>
    String(input).startsWith(`${API_BASE_URL}/v1/projects`)
      ? Promise.resolve(new Response(JSON.stringify({ items: [{ id: "p1", name: "Secret Tower" }], next_cursor: null }), { headers: { "content-type": "application/json" } }))
      : realFetch(input, init));
}

describe("PostHog MCP analytics", () => {
  it("has sent $mcp_tool_call for the person by the time the answer is readable, without the tool result", async () => {
    stubProjects();
    received.length = 0;
    const { body, snapshot } = await rpc("tools/call", { name: "list_projects", arguments: {} });
    expect(JSON.stringify(body.result)).toContain("Secret Tower");

    const call = snapshot.find((e) => e.event === "$mcp_tool_call");
    expect(call, JSON.stringify(snapshot.map((e) => e.event))).toBeDefined();
    expect(call!.distinct_id).toBe("u1");
    expect(call!.properties).toMatchObject({
      $mcp_tool_name: "list_projects",
      $mcp_server_name: "Kamai MCP Server",
      $mcp_is_error: false,
    });
    expect(call!.properties.$mcp_response).toBeUndefined();
    expect(JSON.stringify(received)).not.toContain("Secret Tower");
    expect(received.map((e) => e.event)).not.toContain("$identify");
    vi.unstubAllGlobals();
  });

  it("holds only a tool call's answer for PostHog, not a listing", async () => {
    slowIngest = true;
    try {
      let started = Date.now();
      await rpc("tools/list");
      expect(Date.now() - started).toBeLessThan(1000);
      stubProjects();
      started = Date.now();
      await rpc("tools/call", { name: "list_projects", arguments: {} });
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    } finally {
      slowIngest = false;
      vi.unstubAllGlobals();
    }
  });

  it("leaves every tool's input schema without injected arguments", async () => {
    const { body } = await rpc("tools/list");
    for (const tool of body.result!.tools as { name: string; inputSchema: { properties?: Record<string, unknown> } }[]) {
      const keys = Object.keys(tool.inputSchema.properties ?? {});
      for (const injected of ["context", "llm_model", "conversation_id"]) expect(keys, tool.name).not.toContain(injected);
    }
  });
});
