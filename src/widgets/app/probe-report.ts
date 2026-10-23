// Pure shaping for the capability probe (widget_probe). Everything here runs in node
// under vitest; the browser calls live in probe-run.ts.

export type StepStatus = "ok" | "failed" | "unavailable" | "skipped" | "timeout" | "pending";

export interface Step {
  status: StepStatus;
  ms?: number;
  error?: string;
}

type JsonRecord = Record<string, unknown>;

const MAX_TEXT = 300;

export function clip(value: unknown, max = MAX_TEXT): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return clip(`${error.name}: ${error.message}`)!;
  return clip(error) ?? "unknown error";
}

export class StepTimeout extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not settle within ${ms} ms`);
    this.name = "StepTimeout";
  }
}

/** Reject after `ms`. The underlying work is not cancelled: a hung requestAdapter keeps
 * hanging, but the probe moves on and reports it. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeout(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Run one step: never throws, always timed, a timeout reported as such. */
export type StepResult<T> = Step & Partial<T> & Record<string, unknown>;

export async function step<T extends object>(work: () => Promise<T> | T): Promise<StepResult<T>> {
  const start = now();
  try {
    const value = await work();
    return { status: "ok", ...value, ms: Math.round(now() - start) };
  } catch (error) {
    return {
      status: error instanceof StepTimeout ? "timeout" : "failed",
      error: errorText(error),
      ms: Math.round(now() - start),
    } as StepResult<T>;
  }
}

// The limits that decide what a tile renderer can do. GPUSupportedLimits exposes them as
// prototype getters, so they are read by name: Object.keys sees none of them.
export const GPU_LIMIT_KEYS = [
  "maxTextureDimension2D",
  "maxTextureArrayLayers",
  "maxBufferSize",
  "maxStorageBufferBindingSize",
  "maxUniformBufferBindingSize",
  "maxBindGroups",
  "maxSampledTexturesPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
] as const;

export function pickLimits(limits: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!limits || typeof limits !== "object") return out;
  for (const key of GPU_LIMIT_KEYS) {
    const value = (limits as JsonRecord)[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export interface AdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  is_fallback?: boolean;
}

export function adapterInfoOf(info: unknown, adapter?: unknown): AdapterInfo {
  const out: AdapterInfo = {};
  if (info && typeof info === "object") {
    const record = info as JsonRecord;
    for (const key of ["vendor", "architecture", "device", "description"] as const) {
      const value = clip(record[key], 120);
      if (value) out[key] = value;
    }
    if (typeof record.isFallbackAdapter === "boolean") out.is_fallback = record.isFallbackAdapter;
  }
  // Older Chromium put isFallbackAdapter on the adapter, not on its info.
  const legacy = adapter && typeof adapter === "object" ? (adapter as JsonRecord).isFallbackAdapter : undefined;
  if (out.is_fallback === undefined && typeof legacy === "boolean") out.is_fallback = legacy;
  return out;
}

export function featureList(features: unknown, max = 64): string[] {
  if (!features || typeof (features as Iterable<unknown>)[Symbol.iterator] !== "function") return [];
  return [...(features as Iterable<unknown>)].map((f) => String(f)).sort().slice(0, max);
}

export type WebgpuMode = "auto" | "run" | "skip";

/** Why WebGPU is left alone this run, or null to run it.
 *
 * auto (the default) skips on Windows desktop apps: in Claude Desktop on Windows any
 * requestAdapter() has made Windows flag the install as tampered and close the app,
 * needing a repair or reinstall (claude-code#89112, #89226). It also skips after an
 * earlier attempt on this origin never came back. Only an explicit run overrides either. */
export function webgpuSkipReason(mode: WebgpuMode | undefined, surface: string, crashed: boolean): string | null {
  if (mode === "skip") return "skipped: probe_host was called with webgpu=skip";
  if (mode === "run") return null;
  if (surface === "desktop-windows") {
    return "skipped: Windows desktop app, where requestAdapter() can close the app (claude-code#89112); call probe_host with webgpu=run to test it";
  }
  if (crashed) {
    return "skipped: an earlier probe on this origin started requestAdapter() and never came back (crash or hang); call probe_host with webgpu=run to retry";
  }
  return null;
}

/** WebGPU's overall status: ok only if it can open a device and draw with it. A failed
 * device or present step carries its status and error up, so the panel and the log
 * never show a pass for a path that failed. */
export function gpuOutcome(device: unknown, present: unknown): { status: StepStatus; error?: string } {
  for (const [name, part] of [["requestDevice", device], ["present", present]] as const) {
    const s = part as Step | undefined;
    if (!s) return { status: "failed", error: `${name} did not run` };
    if (s.status !== "ok") return { status: s.status, error: `${name}: ${s.error ?? s.status}` };
  }
  return { status: "ok" };
}

/** Whether report_host_probe's answer says it logged. */
export function isLogged(answer: unknown): boolean {
  return Boolean(answer && typeof answer === "object" && (answer as Record<string, unknown>).logged === true);
}

export interface HostSignals {
  hostInfoName?: string;
  origin?: string;
  ancestorOrigins?: string[];
  openai?: boolean;
  injectedResult?: boolean;
  userAgent?: string;
}

/** Which chat this is, as far as the frame can tell. A guess, reported next to the raw
 * signals it came from so a wrong guess can be corrected from the log. */
export function guessHost(s: HostSignals): { family: string; surface: string } {
  const ua = s.userAgent ?? "";
  const origin = s.origin ?? "";
  const ancestors = s.ancestorOrigins ?? [];
  const name = (s.hostInfoName ?? "").toLowerCase();
  const seen = (pattern: RegExp) => pattern.test(origin) || ancestors.some((a) => pattern.test(a));

  let family = "unknown";
  if (name.includes("claude") || seen(/claudemcpcontent\.com|claude\.ai|claudeusercontent\.com/)) family = "claude";
  else if (s.openai || name.includes("chatgpt") || name.includes("openai") || seen(/oaiusercontent\.com|chatgpt\.com/)) {
    family = "chatgpt";
  } else if (s.injectedResult) family = "open-webui";
  else if (name) family = name.slice(0, 40);

  let surface = "web";
  if (/iPhone|iPad|iPod/.test(ua)) surface = "ios";
  else if (/Android/.test(ua)) surface = "android";
  else if (/Electron|\bClaude\/|\bChatGPT\//.test(ua)) surface = /Windows/.test(ua) ? "desktop-windows" : /Mac OS X|Macintosh/.test(ua) ? "desktop-mac" : "desktop";
  return { family, surface };
}

/** Only the names of a host-provided object's keys: enough to see what an API offers,
 * never its values (a host object can carry the user's locale, ids or state). */
export function keyNames(value: unknown, max = 40): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).sort().slice(0, max);
}

// Fields of the MCP Apps host context that describe the host and device, not the user.
// locale and timeZone are left out on purpose.
const HOST_CONTEXT_FIELDS = ["platform", "userAgent", "theme", "displayMode", "availableDisplayModes", "deviceCapabilities", "containerDimensions"] as const;

export function hostContextSummary(context: unknown): JsonRecord {
  const out: JsonRecord = {};
  if (!context || typeof context !== "object") return out;
  const record = context as JsonRecord;
  for (const key of HOST_CONTEXT_FIELDS) {
    const value = record[key];
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? clip(value, 200) : value;
  }
  return out;
}

/** Origins only: a blocked URL can carry a signed query string. */
export function originOf(url: unknown): string {
  const text = String(url ?? "");
  if (!text) return "";
  if (/^(blob|data|inline|eval|wasm-eval|self)\b/.test(text)) return text.split(":")[0]!;
  try {
    return new URL(text).origin;
  } catch {
    return clip(text, 60)!;
  }
}

// A tiny module exporting add(i32, i32) -> i32. The smallest thing that proves a host's
// CSP lets WebAssembly compile ('wasm-unsafe-eval') and run.
export const ADD_WASM = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x03, 0x02,
  0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20,
  0x01, 0x6a, 0x0b,
];

// A public, CORS-open sample image on the tile host (Google's TensorFlow examples
// bucket). It answers whether the host's CSP lets a widget fetch and draw from
// storage.googleapis.com at all; it says nothing about Kamai's own bucket CORS, which
// a signed tile URL would also need.
export const TILE_HOST_TEST_URL = "https://storage.googleapis.com/download.tensorflow.org/example_images/grace_hopper.jpg";

export type Phase = "pre_gpu" | "final";

export interface ProbeReport {
  schema: 1;
  run_id: string;
  attempt: string;
  phase: Phase;
  widget_version?: string;
  host: JsonRecord;
  webgl2: JsonRecord;
  worker: JsonRecord;
  wasm: JsonRecord;
  shared_memory: JsonRecord;
  storage: JsonRecord;
  tile_host: JsonRecord;
  csp_violations: Array<{ directive: string; blocked: string }>;
  webgpu: JsonRecord;
  report_send?: JsonRecord;
  timings: JsonRecord;
}

/** The panel's line about whether the report reached Kamai. A report counts as
 * delivered if either send landed: the pre-GPU one alone is a usable report. */
export function sendSummary(report: Partial<ProbeReport>): string {
  if (report.phase !== "final") return "Running checks…";
  const sends = (report.report_send ?? {}) as Record<string, Step | undefined>;
  const pre = sends.pre_gpu;
  const final = sends.final;
  const run = report.run_id?.slice(0, 8);
  if (final?.status === "ok") return `Reported to Kamai (run ${run}).`;
  if (pre?.status === "ok") return `Reported to Kamai before the WebGPU test (run ${run}); the final report failed: ${final?.error ?? final?.status ?? "not sent"}.`;
  const why = final?.error ?? pre?.error ?? final?.status ?? pre?.status ?? "not sent";
  return `Not reported: ${why}.`;
}

/** One-line verdict per capability, for the panel. */
export function verdicts(report: Partial<ProbeReport>): Array<{ label: string; status: StepStatus; detail: string }> {
  const s = (value: unknown): StepStatus => {
    const status = (value as Step | undefined)?.status;
    return status ?? "pending";
  };
  const gpu = report.webgpu ?? {};
  const gl = report.webgl2 ?? {};
  const worker = report.worker ?? {};
  const tile = report.tile_host ?? {};
  const adapter = (gpu.adapter ?? {}) as AdapterInfo;
  const limits = (gpu.limits ?? {}) as Record<string, number>;
  const gpuDetail =
    gpu.status === "ok"
      ? [adapter.vendor, adapter.architecture, adapter.description].filter(Boolean).join(" · ") +
        (limits.maxTextureDimension2D ? ` · max texture ${limits.maxTextureDimension2D}` : "") +
        ` · device ${s(gpu.device)}`
      : String(gpu.error ?? (gpu.api === false ? "navigator.gpu is absent" : ""));
  return [
    { label: "WebGPU", status: s(gpu), detail: gpuDetail },
    {
      label: "WebGL2",
      status: s(gl),
      detail: gl.status === "ok" ? `${gl.renderer ?? "renderer hidden"} · max texture ${gl.max_texture_size}` : String(gl.error ?? ""),
    },
    {
      label: "Worker (blob:)",
      status: s(worker.blob),
      detail:
        (worker.blob as Step | undefined)?.error ??
        (worker.wasm_in_worker === true ? "WebAssembly runs inside it" : worker.wasm_in_worker === false ? "no WebAssembly inside it" : ""),
    },
    { label: "WebAssembly", status: s(report.wasm), detail: String(report.wasm?.error ?? "") },
    {
      label: "Tile host fetch + decode",
      status: s(tile.decode) === "ok" ? "ok" : s(tile.fetch) === "ok" ? s(tile.decode) : s(tile.fetch),
      detail: String((tile.fetch as Step | undefined)?.error ?? (tile.decode as Step | undefined)?.error ?? "storage.googleapis.com"),
    },
  ];
}
