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

// get_printed_tables, on top of the query tools. Off unless set; needs the API layer's
// printed-table routes.
export const PRINTED_TABLES = (process.env.KAMAI_PRINTED_TABLES ?? "").trim() === "on";

// set_rotation, on top of the query tools. Needs the API layer's /rotation route;
// KAMAI_ROTATION=off drops it.
export const ROTATION = (process.env.KAMAI_ROTATION ?? "").trim() !== "off";

// The markup tools and download_plan's include_markups. Off unless set; needs the API
// layer's markup routes.
export const MARKUPS = (process.env.KAMAI_MARKUPS ?? "").trim() === "on";

// Claude.ai drops a server's `instructions`. Set this to test the tool descriptions on
// their own, the way that host reads them.
export const NO_INSTRUCTIONS = (process.env.KAMAI_MCP_NO_INSTRUCTIONS ?? "").trim() === "1";

// Needs KAMAI_AUTH_PANEL_CODE on in the same environment, or every open_kamai_session call fails.
export const PANEL_SIGN_IN = (process.env.KAMAI_PANEL_SIGN_IN ?? "").trim() === "on";

// PostHog MCP Analytics. No token, no client: nothing is captured or sent.
export const POSTHOG_PROJECT_TOKEN = (process.env.POSTHOG_PROJECT_TOKEN ?? "").trim();
export const POSTHOG_HOST = trim(process.env.POSTHOG_HOST, "https://t.kamai.io");

// The host-capability probe (probe_host, report_host_probe). KAMAI_HOST_PROBE=on|off sets
// it; unset, it follows the service name Cloud Run puts in K_SERVICE: on for a dev- or
// debug- service, off otherwise and anywhere unnamed.
export function hostProbeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = (env.KAMAI_HOST_PROBE ?? "").trim().toLowerCase();
  if (flag === "on") return true;
  if (flag === "off") return false;
  return /^(dev|debug)-/.test((env.K_SERVICE ?? "").trim());
}

export const HOST_PROBE = hostProbeEnabled();

// Which MCP clients get open_kamai as a link card instead of the framed app.
// KAMAI_OPEN_KAMAI_LINK is a comma list of client families (claude, chatgpt, codex, cursor,
// other) or "none"; unset = claude, the one host that refuses nested frames outright
// (claude-ai-mcp#40). ChatGPT keeps the signed-in frame unless listed here.
export function openKamaiLinkFamilies(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = (env.KAMAI_OPEN_KAMAI_LINK ?? "claude").trim().toLowerCase();
  if (!raw || raw === "none") return new Set();
  return new Set(raw.split(",").map((part) => part.trim()).filter(Boolean));
}

export const OPEN_KAMAI_LINK = openKamaiLinkFamilies();

/** The calling MCP client's family, from the User-Agent its backend sends. */
export function clientFamily(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/^Claude-User\b|\bclaude-ai\b/i.test(ua)) return "claude";
  if (/\bopenai-mcp\/.*\(Codex\)/i.test(ua)) return "codex";
  if (/\bopenai-mcp\//i.test(ua)) return "chatgpt";
  if (/^Cursor\//i.test(ua)) return "cursor";
  return "other";
}
