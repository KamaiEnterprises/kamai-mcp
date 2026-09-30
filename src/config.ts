const trim = (value: string | undefined, fallback: string): string =>
  (value ?? fallback).trim().replace(/\/+$/, "");

export const PORT = Number(process.env.PORT ?? 8006);

export const PUBLIC_URL = trim(process.env.MCP_PUBLIC_URL, "http://localhost:8006");
export const AUTH_ISSUER = trim(process.env.MCP_AUTH_ISSUER, "http://localhost:8003");
export const AUTH_JWKS_URI =
  (process.env.MCP_AUTH_JWKS_URI ?? "").trim() || `${AUTH_ISSUER}/jwks.json`;

export const API_BASE_URL = trim(process.env.MCP_API_BASE_URL, "http://127.0.0.1:8005");

export const MCP_PATH = "/mcp";

// The canonical resource a host asks a token for (RFC 8707): the transport is served at
// both /mcp and bare root, so discovery advertises both forms.
export const RESOURCE_URL = `${PUBLIC_URL}${MCP_PATH}`;

// The audience a token must carry is the API this server adapts, not this server's own
// address: one resource, one audience, and the same token is valid at the API directly.
// MCP_ACCEPTED_AUDIENCES overrides the derived list, comma-separated, for a cutover.
const configuredAudiences = (process.env.MCP_ACCEPTED_AUDIENCES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const ACCEPTED_AUDIENCES = configuredAudiences.length
  ? configuredAudiences
  : [API_BASE_URL, `${API_BASE_URL}/`];

export const CLOCK_SKEW_SECONDS = 60;

// OpenAI re-fetches this when a plugin version is submitted, and its verifier only
// looks at the host root, so it cannot sit behind /mcp. Public by design: the old
// Python server served the same value unauthenticated.
export const OPENAI_APPS_CHALLENGE_TOKEN = "vez7x9V4rxWJFEU0dnlIqTHRk-i_H0Bkkdj2lemfEc4";

// The query tools (count_elements, find_elements, calculate_wall_surface_area,
// render_table, set_scale and their app-only helpers) call API routes an older API
// layer does not serve. Off by default; turn it on where the API serves /v1/vocabulary.
export const QUERY_TOOLS = (process.env.KAMAI_QUERY_TOOLS ?? "").trim() === "on";

// Claude.ai drops a server's `instructions`. Set this to test the tool descriptions on
// their own, the way that host reads them.
export const NO_INSTRUCTIONS = (process.env.KAMAI_MCP_NO_INSTRUCTIONS ?? "").trim() === "1";
