import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response } from "express";

import {
  MCP_PATH,
  OPENAI_APPS_CHALLENGE_TOKEN,
  PORT,
  PUBLIC_URL,
  RESOURCE_URL,
} from "./config.ts";
import { protectedResourceMetadata, requireBearer } from "./auth.ts";
import { buildServer } from "./server.ts";

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/_health", (_req, res) => {
  res.json({ status: "ok" });
});

// Plain text and exactly one token: OpenAI rejects JSON, a list, or several tokens
// served from one URL. The Python server owned this route before the TS cutover.
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  res.type("text/plain").send(OPENAI_APPS_CHALLENGE_TOKEN);
});

// Both live resource forms get their own document: the transport answers at /mcp
// and at bare root, and a client discovers metadata for the resource it is using.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json(protectedResourceMetadata(`${PUBLIC_URL}/`));
});
app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json(protectedResourceMetadata(RESOURCE_URL));
});

// Stateless, one transport per request. An in-process session map survives neither
// scale-to-zero nor a scale-out, and on a miss the SDK answers 400 "Server not
// initialized" instead of the spec's 404 — fatal to a client rather than a cue to
// re-initialise. ChatGPT also sends tools/call before initialize, which only a
// session-less server can answer. Building per request binds the server to this
// request's principal rather than to whoever opened the session.
async function handleMcp(req: Request, res: Response): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
  });
  const server = buildServer(req.principal!);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

// Without sessions there is no stream to open and none to terminate, and the spec
// reserves 405 for exactly that. Nothing here pushes server to client, so the
// standalone GET stream only ever idled until Cloud Run timed it out at 300s.
function notOffered(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed" },
    id: null,
  });
}

for (const path of [MCP_PATH, "/"]) {
  app.post(path, requireBearer, handleMcp);
  app.get(path, requireBearer, notOffered);
  app.delete(path, requireBearer, notOffered);
}

app.listen(PORT, () => {
  console.log(`kamai-mcp listening on :${PORT}`);
  console.log(`  public url   ${PUBLIC_URL}`);
  console.log(`  resource     ${RESOURCE_URL}`);
});
