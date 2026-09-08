import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const WIDGET_DIR = join(DIR, "../../dist/widgets");

export const UI_MIME = "text/html;profile=mcp-app";
const UI_SCHEME = "ui://kamai";

// Hosts cache resource contents by URI for up to about an hour, so any breaking
// change to a widget needs a new version here.
export const WIDGET_VERSION = "v25";

export const WIDGET_NAMES = ["projects", "blueprint", "takeoff", "upload", "iframetest"] as const;

export type WidgetName = (typeof WIDGET_NAMES)[number];

export function isWidgetName(value: string): value is WidgetName {
  return (WIDGET_NAMES as readonly string[]).includes(value);
}

const GCS_ORIGIN = "https://storage.googleapis.com";

// Origins the panel may frame. Settable so a tunnelled local Kamai can be pointed at
// without editing code:
//
//   KAMAI_APP_ORIGINS=https://kamai-dev.example.com,https://app.kamai.io
//
// The first entry is the default target. A widget cannot reach http://localhost — the
// sandbox has no local-network access — so a dev build has to be tunnelled like
// everything else.
const DEFAULT_FRAME_ORIGINS = ["https://app.kamai.io"];

// Parsed, not string-munged. Trimming a trailing slash off "https://" leaves "https:",
// which CSP reads as a scheme-source: frame-src would silently widen to every https
// origin, and a prefix-based gate would then accept every URL. Refuse to boot instead —
// this value is documented as a pasted dev tunnel, which is exactly where a malformed
// entry comes from.
function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`KAMAI_APP_ORIGINS: ${value} is not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`KAMAI_APP_ORIGINS: ${value} must be https`);
  if (!url.hostname || url.hostname === "*") throw new Error(`KAMAI_APP_ORIGINS: ${value} has no host`);
  if (url.username || url.password) throw new Error(`KAMAI_APP_ORIGINS: ${value} carries credentials`);
  return url.origin;
}

export const FRAME_ORIGINS = (process.env.KAMAI_APP_ORIGINS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map(parseOrigin)
  .concat(DEFAULT_FRAME_ORIGINS)
  .filter((origin, index, all) => all.indexOf(origin) === index);

// An origin comparison, not a prefix test. `startsWith` accepted
// https://app.kamai.io.evil.tld and https://app.kamai.io@evil.tld — the latter's real
// origin being evil.tld — and `url` is a free-form string on model-visible tools, so it
// is reachable by prompt injection through any text the model has read.
export function isAllowedFrameTarget(target: string): boolean {
  try {
    const url = new URL(target);
    if (url.username || url.password) return false;
    return FRAME_ORIGINS.includes(url.origin);
  } catch {
    return false;
  }
}

export interface Csp {
  connectDomains: string[];
  resourceDomains: string[];
  // Maps to CSP frame-src. Omitted everywhere but the probe: the secure default is
  // frame-src 'none', and no shipping widget nests a frame.
  frameDomains?: string[];
}

export const CSP: Partial<Record<WidgetName, Csp>> = {
  projects: { connectDomains: [], resourceDomains: [GCS_ORIGIN] },
  blueprint: { connectDomains: [], resourceDomains: [GCS_ORIGIN] },
  takeoff: { connectDomains: [], resourceDomains: [GCS_ORIGIN] },
  // The upload widget PUTs the file straight from the sandbox iframe, so GCS has
  // to be reachable as a connect target, not just as a resource origin.
  upload: { connectDomains: [GCS_ORIGIN], resourceDomains: [GCS_ORIGIN] },
  // GCS as a resource origin because the frame-refusal fallback renders the full
  // projects → blueprint tree inside this bundle, and BlueprintPanel loads its page
  // image from a storage.googleapis.com signed URL like the standalone widgets do.
  iframetest: { connectDomains: [], resourceDomains: [GCS_ORIGIN], frameDomains: FRAME_ORIGINS },
};

const cache = new Map<string, string>();

const read = (name: string): string => {
  const hit = cache.get(name);
  if (hit) return hit;
  const text = readFileSync(join(WIDGET_DIR, name), "utf8");
  cache.set(name, text);
  return text;
};

export function widgetHtml(name: WidgetName): string {
  return read(`${name}.html`);
}

// frameDomains rides on the resource's _meta, and hosts cache a resource by URI for
// about an hour — so changing the allowlist without changing the URI serves the old
// allowlist and the new target frame silently stays blank. Folding a hash of the
// origins into the version makes that self-invalidating, which matters most for the
// one case where the origins actually move: a rotating dev tunnel.
const originsTag = createHash("sha256")
  .update(FRAME_ORIGINS.join(","))
  .digest("hex")
  .slice(0, 6);

export const widgetUri = (name: WidgetName): string =>
  name === "iframetest"
    ? `${UI_SCHEME}/${name}@${WIDGET_VERSION}-${originsTag}.html`
    : `${UI_SCHEME}/${name}@${WIDGET_VERSION}.html`;

// ChatGPT documents both dialects; frame_domains is the snake_case twin of
// frameDomains. Emitted only when declared, so no shipping widget starts asking
// for a permission it does not use.
const legacyCsp = (csp: Csp) => ({
  connect_domains: csp.connectDomains,
  resource_domains: csp.resourceDomains,
  ...(csp.frameDomains ? { frame_domains: csp.frameDomains } : {}),
});

// visibility defaults to model+app because most widget tools are meant to be chosen by
// the model. Pass ["app"] for anything a user should never see offered — hosts render
// raw tool names, so an internal name reaches the user verbatim.
export function toolMeta(
  name: WidgetName,
  visibility: readonly string[] = ["model", "app"],
): Record<string, unknown> {
  return {
    ui: { resourceUri: widgetUri(name), visibility: [...visibility] },
    "openai/outputTemplate": widgetUri(name),
    // The snake-dialect twin of visibility containing "app", same as outputTemplate
    // and widgetCSP have theirs: older ChatGPT surfaces gate widget-initiated
    // callTool on this flag alone, and the frame-refusal fallback depends on it.
    ...(visibility.includes("app") ? { "openai/widgetAccessible": true } : {}),
  };
}

export function resourceMeta(name: WidgetName): Record<string, unknown> {
  const csp = CSP[name];
  const ui: Record<string, unknown> = { prefersBorder: true };
  if (csp) ui.csp = csp;
  const meta: Record<string, unknown> = { ui };
  if (csp) meta["openai/widgetCSP"] = legacyCsp(csp);
  return meta;
}
