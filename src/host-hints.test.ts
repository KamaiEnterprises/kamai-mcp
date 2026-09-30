import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMcp, mcpGuards } from "./index.ts";

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.post("/mcp", (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.principal = { uid: "u1", token: "t" };
    next();
  }, ...mcpGuards, handleMcp);
  const server = app.listen(0);
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

async function rpc(base: string, userAgent: string, method: string, params: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text) as { result?: Record<string, unknown> };
}

afterEach(() => vi.restoreAllMocks());

describe("ingest_blueprint_from_chat visibility", () => {
  // Only ChatGPT fills the file parameter; anywhere else the model picks the tool first on
  // "upload this PDF" and gets "Re-attach the PDF on ChatGPT web".
  it("is listed for ChatGPT's connector", () =>
    withServer(async (base) => {
      const r = await rpc(base, "openai-mcp/1.0.0", "tools/list");
      const names = (r.result!.tools as { name: string }[]).map((t) => t.name);
      expect(names).toContain("ingest_blueprint_from_chat");
    }));

  it("is not listed for other hosts", () =>
    withServer(async (base) => {
      for (const ua of ["python-httpx/0.28.1", "Claude-User", "Cursor/1.0.0"]) {
        const r = await rpc(base, ua, "tools/list");
        const names = (r.result!.tools as { name: string }[]).map((t) => t.name);
        expect(names, ua).not.toContain("ingest_blueprint_from_chat");
        expect(names, ua).toContain("view_upload");
      }
    }));
});

function capture() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return lines.map((l) => JSON.parse(l)).filter((e) => e.event_name === "mcp_request").map((e) => e.event_data);
  };
}

describe("mcp_request log line", () => {
  it("names the tool, the caller and the tool's own failure", () =>
    withServer(async (base) => {
      const events = capture();
      await rpc(base, "python-httpx/0.28.1", "tools/call", { name: "get_job", arguments: {} });
      const [event] = await events();
      expect(event).toMatchObject({
        method: "tools/call",
        target: "get_job",
        uid: "u1",
        user_agent: "python-httpx/0.28.1",
        status: 200,
        is_error: true,
      });
      expect(event.error).toMatch(/Invalid arguments/);
    }));

  it("reports a large successful result as a success", () =>
    withServer(async (base) => {
      const events = capture();
      await rpc(base, "python-httpx/0.28.1", "resources/read", { uri: "ui://kamai/upload@v26.html" });
      const [event] = await events();
      expect(event).toMatchObject({ method: "resources/read", status: 200, is_error: false, error: null });
    }));

  it("logs a resource read the guard refuses", () =>
    withServer(async (base) => {
      const events = capture();
      await rpc(base, "python-httpx/0.28.1", "resources/read", { uri: "x".repeat(5000) });
      const [event] = await events();
      expect(event).toMatchObject({ method: "resources/read", status: 400, is_error: true });
    }));
});
