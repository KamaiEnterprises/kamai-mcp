import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { vi } from "vitest";

import { buildServer, type HostHints, type ServerOptions } from "../server.ts";

// Test plumbing shared by the tool tests. Everything drives the registered tools over an
// in-memory MCP transport, so what runs is what a host calls; `fetch` at the HTTP
// boundary is the only stub.

export async function connect(opts: ServerOptions = {}, host: HostHints = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const server = buildServer({ uid: "test", token: "test" }, host, opts);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export type ApiCall = { method: string; path: string; query: Record<string, string>; body: unknown };
export type ApiReply = { status?: number; body: unknown } | ((call: ApiCall) => { status?: number; body: unknown });

/** Stub the API layer. `routes` maps "METHOD /path" (exact path, no query string) to a
 * reply; a path segment written `*` matches anything. Unmatched requests answer the
 * framework's 404 an unknown route gets, so a test that forgets a route sees route_missing
 * rather than a silent pass. */
export function stubApi(routes: Record<string, ApiReply>): ApiCall[] {
  const calls: ApiCall[] = [];
  const table = Object.entries(routes).map(([key, reply]) => {
    const [method, path] = key.split(" ") as [string, string];
    const pattern = new RegExp(`^${path.split("/").map((seg) => (seg === "*" ? "[^/]+" : escape(seg))).join("/")}$`);
    return { method, pattern, reply };
  });
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: ApiCall = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams.entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const hit = table.find((row) => row.method === call.method && row.pattern.test(url.pathname));
    const reply = hit ? (typeof hit.reply === "function" ? hit.reply(call) : hit.reply) : { status: 404, body: { detail: "Not Found" } };
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

function escape(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text a failed call puts in front of the model. */
export function errorText(result: unknown): string {
  const content = (result as { content?: unknown }).content as Array<{ text?: string }> | undefined;
  return content?.map((block) => block.text ?? "").join(" ") ?? "";
}

export function structured<T = Record<string, unknown>>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}
