import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { NextFunction, Request, Response } from "express";

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

// JSON media type only, matched by parsed type rather than substring: the SDK accepts any
// content type containing "application/json" and reads the body itself when nothing was
// parsed here, which would let "application/json-patch+json" skip the size limit.
// Read from the header, not req.is(): that helper answers null when a request carries no
// Content-Length or Transfer-Encoding, which would turn an empty JSON-typed POST into a
// 415 instead of the parse error the SDK gives it.
function requireJson(req: Request, res: Response, next: NextFunction): void {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    res.status(415).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unsupported Media Type: Content-Type must be application/json" },
      id: null,
    });
    return;
  }
  next();
}

// Attached per MCP route after the bearer check, so an anonymous caller cannot make the
// server buffer, inflate or parse anything. No inflate: MCP clients do not compress.
const parseJson = express.json({ limit: "1mb", inflate: false });

// One message per request. The SDK dispatches every element of a JSON-RPC array and
// rescans its response map per element, which is quadratic CPU plus one upstream call
// per element from a single request; no client of this server batches.
function rejectBatch(req: Request, res: Response, next: NextFunction): void {
  // body-parser hands an empty body to the route as {}; the SDK refuses the same
  // request as a parse error, so it is refused here with the same answer.
  if (req.body === undefined || (typeof req.body === "object" && req.body !== null && Object.keys(req.body).length === 0 && !Array.isArray(req.body))) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON-RPC message" },
      id: null,
    });
    return;
  }
  if (Array.isArray(req.body)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32600, message: "Batch requests are not supported" },
      id: null,
    });
    return;
  }
  next();
}

// The widget ResourceTemplate compiles to two greedy captures around "@", which
// backtrack quadratically on a long run of "@" (32k characters measured at ~1s of CPU),
// and the SDK matches the template before any callback of ours runs. Longest real
// widget URI is under 50 characters.
const MAX_RESOURCE_URI_LENGTH = 256;

// JSON-RPC allows a string or an integer id; anything else is echoed as null rather
// than reflected back as an invalid id.
function rpcId(value: unknown): string | number | null {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value)) ? value : null;
}

function boundResourceUri(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as { method?: unknown; params?: { uri?: unknown }; id?: unknown } | undefined;
  if (body?.method === "resources/read") {
    const uri = body.params?.uri;
    if (typeof uri !== "string" || uri.length > MAX_RESOURCE_URI_LENGTH) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32602, message: "Invalid params: resource uri missing or too long" },
        id: rpcId(body.id),
      });
      return;
    }
  }
  next();
}

// body-parser reports its failures as errors with an HTTP status and a type; without a
// handler Express renders them as HTML pages. MCP clients expect a JSON-RPC error body
// (the SDK itself answers a parse failure with 400 and -32700).
// Keyed by body-parser's error type, not by status: a 400 is also what it raises for an
// aborted request or a Content-Length that disagrees with the body, and neither is a
// JSON problem. A scalar body ("42") fails the strict parser here; the SDK answers the
// same body with -32700 "Invalid JSON-RPC message", so the wording follows it.
const PARSER_ERRORS: Record<string, { code: number; message: string }> = {
  "entity.too.large": { code: -32000, message: "Payload Too Large" },
  "encoding.unsupported": { code: -32000, message: "Unsupported Media Type: compressed bodies are not accepted" },
  "charset.unsupported": { code: -32000, message: "Unsupported Media Type: charset must be UTF-8" },
  "request.aborted": { code: -32000, message: "Request aborted before the body was received" },
  "request.size.invalid": { code: -32000, message: "Content-Length does not match the body" },
  "entity.parse.failed": { code: -32700, message: "Parse error: Invalid JSON-RPC message" },
};

function parserError(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const e = err as { status?: number; type?: string };
  if (typeof e?.status !== "number" || typeof e.type !== "string") {
    next(err);
    return;
  }
  const known = PARSER_ERRORS[e.type];
  if (!known) {
    next(err);
    return;
  }
  res.status(e.status).json({ jsonrpc: "2.0", error: known, id: null });
}

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

export const mcpGuards = [requireJson, parseJson, parserError, rejectBatch, boundResourceUri] as const;

for (const path of [MCP_PATH, "/"]) {
  app.post(path, requireBearer, ...mcpGuards, handleMcp);
  app.get(path, requireBearer, notOffered);
  app.delete(path, requireBearer, notOffered);
}

// The guard chain is imported by its test; only the entrypoint listens. vitest sets
// VITEST=true, so nothing short of that exact value suppresses the listener.
if (process.env.VITEST !== "true") {
  app.listen(PORT, () => {
    console.log(`kamai-mcp listening on :${PORT}`);
    console.log(`  public url   ${PUBLIC_URL}`);
    console.log(`  resource     ${RESOURCE_URL}`);
  });
}
