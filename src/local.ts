import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Principal } from "./auth.ts";
import { API_BASE_URL } from "./config.ts";
import { buildServer } from "./server.ts";

// Local mode: the host spawns this process and talks JSON-RPC over stdin/stdout, so the
// credential comes from the environment (a personal Kamai API key), never from OAuth.
// Nothing here may write to stdout except the transport.
export async function resolvePrincipal(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Principal> {
  const res = await fetchImpl(`${API_BASE_URL}/v1/me`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${API_BASE_URL}/v1/me answered ${res.status}: the API key was not accepted`);
  }
  const me = (await res.json()) as { uid?: unknown; email?: unknown };
  if (typeof me.uid !== "string" || !me.uid) throw new Error("/v1/me returned no uid");
  return { uid: me.uid, email: typeof me.email === "string" ? me.email : undefined, token: apiKey };
}

async function main(): Promise<void> {
  const apiKey = (process.env.KAMAI_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("KAMAI_API_KEY is required: create one in Kamai under API Keys and pass it in the environment.");
    process.exit(2);
  }
  const widgets = join(dirname(fileURLToPath(import.meta.url)), "../dist/widgets");
  if (!existsSync(widgets)) {
    console.error("dist/widgets is missing: run `bun run build:widgets` once before `bun run local`.");
    process.exit(2);
  }
  let principal: Principal;
  try {
    principal = await resolvePrincipal(apiKey);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const server = buildServer(principal);
  await server.connect(new StdioServerTransport());
  console.error(`kamai-mcp local: ${principal.email ?? principal.uid} via ${API_BASE_URL}`);
}

if (process.env.VITEST !== "true") {
  await main();
}
