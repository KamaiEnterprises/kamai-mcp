const trim = (value: string | undefined, fallback: string): string =>
  (value ?? fallback).trim().replace(/\/+$/, "");

export const PORT = Number(process.env.PORT ?? 8006);

export const PUBLIC_URL = trim(process.env.MCP_PUBLIC_URL, "http://localhost:8006");
export const AUTH_ISSUER = trim(process.env.MCP_AUTH_ISSUER, "http://localhost:8003");
export const AUTH_JWKS_URI =
  (process.env.MCP_AUTH_JWKS_URI ?? "").trim() || `${AUTH_ISSUER}/jwks.json`;

export const API_BASE_URL = trim(process.env.MCP_API_BASE_URL, "http://127.0.0.1:8005");

export const MCP_PATH = "/mcp";

// FastMCP derived the canonical resource by appending the endpoint path to the
// public root, and the transport is served at both /mcp and bare root, so all
// three forms are live audiences. Changing this set invalidates issued tokens.
export const RESOURCE_URL = `${PUBLIC_URL}${MCP_PATH}`;
export const ACCEPTED_AUDIENCES = [RESOURCE_URL, `${PUBLIC_URL}/`, PUBLIC_URL];

export const CLOCK_SKEW_SECONDS = 60;

// OpenAI re-fetches this when a plugin version is submitted, and its verifier only
// looks at the host root, so it cannot sit behind /mcp. Public by design: the old
// Python server served the same value unauthenticated.
export const OPENAI_APPS_CHALLENGE_TOKEN = "vez7x9V4rxWJFEU0dnlIqTHRk-i_H0Bkkdj2lemfEc4";
