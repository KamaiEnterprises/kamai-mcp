import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";

import { mcpGuards } from "./index.ts";

// The guard chain in front of the transport, driven over real HTTP so the body parser's
// own behaviour (limit, inflate, type matching) is what gets asserted, not a mock of it.
async function withApp(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.post("/mcp", ...mcpGuards, (req: express.Request, res: express.Response) => {
    res.json({ reached: true, method: (req.body as { method?: string }).method });
  });
  app.use((err: { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.type });
  });
  const server = app.listen(0);
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const post = (base: string, body: BodyInit, type = "application/json", extra: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": type, ...extra },
    body,
  });

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

describe("MCP route guards", () => {
  it("lets a single JSON-RPC message through", () =>
    withApp(async (base) => {
      const r = await post(base, JSON.stringify(ping));
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ reached: true, method: "ping" });
    }));

  it("rejects a JSON-RPC batch before the transport sees it", () =>
    withApp(async (base) => {
      const r = await post(base, JSON.stringify([ping, { ...ping, id: 2 }]));
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe(-32600);
    }));

  it("refuses a media type that merely contains application/json", () =>
    withApp(async (base) => {
      const r = await post(base, JSON.stringify(ping), "application/json-patch+json");
      expect(r.status).toBe(415);
    }));

  it("accepts application/json with a charset parameter", () =>
    withApp(async (base) => {
      const r = await post(base, JSON.stringify(ping), "application/json; charset=utf-8");
      expect(r.status).toBe(200);
    }));

  it("caps the body at the configured limit with a JSON-RPC error, not an HTML page", () =>
    withApp(async (base) => {
      const big = JSON.stringify({ ...ping, params: { pad: "x".repeat(2 * 1024 * 1024) } });
      const r = await post(base, big);
      expect(r.status).toBe(413);
      expect(r.headers.get("content-type")).toContain("application/json");
      expect(await r.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "Payload Too Large" }, id: null });
    }));

  it("does not inflate compressed bodies", () =>
    withApp(async (base) => {
      const { gzipSync } = await import("node:zlib");
      const r = await post(base, gzipSync(Buffer.from(JSON.stringify(ping))), "application/json", {
        "content-encoding": "gzip",
      });
      expect(r.status).toBe(415);
      expect((await r.json()).error.code).toBe(-32000);
    }));

  it("answers malformed JSON the way the SDK would", () =>
    withApp(async (base) => {
      const r = await post(base, "{not json");
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: Invalid JSON-RPC message" },
        id: null,
      });
    }));

  it("answers a scalar JSON body exactly as the SDK does for the same body", () =>
    withApp(async (base) => {
      // The SDK, handed 42 as a pre-parsed body, replies 400 -32700 "Invalid JSON-RPC message".
      const r = await post(base, "42");
      expect(r.status).toBe(400);
      expect((await r.json()).error).toEqual({ code: -32700, message: "Parse error: Invalid JSON-RPC message" });
    }));

  it("treats a JSON-typed POST with no body as a parse error, not a media-type error", () =>
    withApp(async (base) => {
      const { connect } = await import("node:net");
      const url = new URL(`${base}/mcp`);
      const raw = (head: string) =>
        new Promise<string>((resolve) => {
          const c = connect(Number(url.port), url.hostname);
          let out = "";
          c.on("data", (d) => (out += d));
          c.on("close", () => resolve(out));
          c.write(head);
          c.end();
        });
      // No Content-Length and no Transfer-Encoding: the case req.is() answers null for.
      const noFraming = await raw(
        "POST /mcp HTTP/1.1\r\nHost: x\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
      );
      expect(noFraming.split("\r\n")[0]).toContain("400");
      expect(JSON.parse(noFraming.split("\r\n\r\n")[1] ?? "{}").error.code).toBe(-32700);
      // Content-Length: 0 used to reach the handler as {}.
      const zero = await post(base, "");
      expect(zero.status).toBe(400);
      expect((await zero.json()).error.code).toBe(-32700);
    }));

  it("echoes only a valid JSON-RPC id on the early uri refusal", () =>
    withApp(async (base) => {
      const uri = "ui://kamai/" + "@".repeat(1_000) + ".html";
      for (const [id, expected] of [
        [7, 7],
        ["abc", "abc"],
        [{ nested: true }, null],
        [[1, 2], null],
        [1.5, null],
        [true, null],
      ] as const) {
        const r = await post(base, JSON.stringify({ jsonrpc: "2.0", id, method: "resources/read", params: { uri } }));
        expect(r.status).toBe(400);
        expect((await r.json()).id).toEqual(expected);
      }
    }));

  it("bounds the resources/read uri before the template matcher runs", () =>
    withApp(async (base) => {
      const uri = "ui://kamai/" + "@".repeat(32_000) + ".html";
      const started = performance.now();
      const r = await post(base, JSON.stringify({ ...ping, method: "resources/read", params: { uri } }));
      expect(r.status).toBe(400);
      expect((await r.json()).error.code).toBe(-32602);
      expect(performance.now() - started).toBeLessThan(200);
    }));

  it("passes a normal widget uri through", () =>
    withApp(async (base) => {
      const r = await post(
        base,
        JSON.stringify({ ...ping, method: "resources/read", params: { uri: "ui://kamai/projects@v25.html" } }),
      );
      expect(r.status).toBe(200);
    }));
});
