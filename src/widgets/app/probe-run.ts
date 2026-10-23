// The capability probe's browser half. Every step is guarded and timed, and the report
// is sent once BEFORE WebGPU is touched: Claude Desktop on Windows has crashed inside
// requestAdapter() (claude-code#89112/#89226), and a crash there must not take the rest
// of the results with it.

import { callTool, getHostHandshake, hostCanCallTools, isReady } from "./bridge";
import {
  ADD_WASM,
  TILE_HOST_TEST_URL,
  adapterInfoOf,
  clip,
  errorText,
  featureList,
  gpuOutcome,
  guessHost,
  hostContextSummary,
  isLogged,
  keyNames,
  originOf,
  pickLimits,
  step,
  withTimeout,
  webgpuSkipReason,
  type Phase,
  type ProbeReport,
  type WebgpuMode,
} from "./probe-report";

type JsonRecord = Record<string, unknown>;

const STEP_MS = 8000;
const WORKER_MS = 4000;
const SEND_MS = 10000;
const READY_MS = 8000;

// Set before requestAdapter and cleared only when that promise itself settles. Found on
// a later mount, it means an attempt never came back (renderer crash or hang), and it
// stays set: every later run skips WebGPU until one is asked for with webgpu=run.
const GPU_MARKER = "kamai_probe_gpu_inflight";
// One automatic run per tool call: hosts remount old widgets when a conversation is
// reopened, and each remount would otherwise log again (and request an adapter again).
const DONE_PREFIX = "kamai_probe_done:";

// Minimal WebGPU shapes: the DOM lib in this TypeScript has no WebGPU types.
interface GpuDevice {
  queue: { submit(buffers: unknown[]): void; onSubmittedWorkDone(): Promise<void> };
  createCommandEncoder(): {
    beginRenderPass(desc: unknown): { end(): void };
    finish(): unknown;
  };
  destroy?(): void;
}
interface GpuAdapter {
  info?: unknown;
  limits?: unknown;
  features?: unknown;
  isFallbackAdapter?: boolean;
  requestAdapterInfo?(): Promise<unknown>;
  requestDevice(desc?: unknown): Promise<GpuDevice>;
}
interface GpuCanvasContext {
  configure(desc: unknown): void;
  getCurrentTexture(): { createView(): unknown };
}
interface Gpu {
  requestAdapter(options?: unknown): Promise<GpuAdapter | null>;
  getPreferredCanvasFormat?(): string;
  wgslLanguageFeatures?: unknown;
}

const now = () => performance.now();

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The JSON-RPC id of the tools/call that rendered this widget, when the host says. */
export function toolCallId(): string | null {
  const info = getHostHandshake().hostContext.toolInfo as { id?: unknown } | undefined;
  return typeof info?.id === "string" || typeof info?.id === "number" ? String(info.id) : null;
}

/** run_id of an earlier completed run for this same tool call, if any. */
export function earlierRun(): string | null {
  const id = toolCallId();
  return id ? storageGet(DONE_PREFIX + id) : null;
}

function frameDepth(): number | null {
  try {
    let depth = 0;
    let w: Window = window;
    while (w !== w.parent && depth < 10) {
      w = w.parent;
      depth++;
    }
    return depth;
  } catch {
    return null;
  }
}

function hostSection(): JsonRecord {
  const handshake = getHostHandshake();
  const init = handshake.initialize ?? {};
  const hostInfo = (init.hostInfo ?? {}) as JsonRecord;
  const capabilities = (init.hostCapabilities ?? {}) as JsonRecord;
  const sandbox = (capabilities.sandbox ?? {}) as JsonRecord;
  const nav = navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }>; mobile?: boolean; platform?: string };
    deviceMemory?: number;
  };
  let ancestorOrigins: string[] = [];
  try {
    const list = window.location.ancestorOrigins;
    if (list) ancestorOrigins = Array.from({ length: list.length }, (_, i) => originOf(list.item(i)));
  } catch {
    undefined;
  }
  const openai = window.openai as unknown;
  const signals = {
    hostInfoName: typeof hostInfo.name === "string" ? hostInfo.name : undefined,
    origin: window.origin,
    ancestorOrigins,
    openai: Boolean(openai),
    injectedResult: window.__MCP_TOOL_RESULT__ !== undefined,
    userAgent: navigator.userAgent,
  };
  return {
    guess: guessHost(signals),
    host_info: { name: clip(hostInfo.name, 80), version: clip(hostInfo.version, 40) },
    protocol_version: clip(init.protocolVersion, 40),
    host_capabilities: keyNames(capabilities),
    sandbox_csp: sandbox.csp ?? null,
    host_context: hostContextSummary(handshake.hostContext),
    silent_host: handshake.silentHost,
    bridge_ready: isReady(),
    tool_call_id: toolCallId(),
    can_call_tools: hostCanCallTools(),
    openai_bridge: Boolean(openai),
    openai_keys: keyNames(openai),
    injected_result: signals.injectedResult,
    user_agent: clip(navigator.userAgent, 300),
    ua_data: nav.userAgentData
      ? {
          brands: (nav.userAgentData.brands ?? []).map((b) => `${b.brand} ${b.version}`).slice(0, 6),
          mobile: nav.userAgentData.mobile,
          platform: nav.userAgentData.platform,
        }
      : null,
    platform: clip(navigator.platform, 40),
    origin: originOf(window.origin) || window.origin,
    ancestor_origins: ancestorOrigins,
    referrer_origin: originOf(document.referrer),
    frame_depth: frameDepth(),
    secure_context: window.isSecureContext,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    device_memory: nav.deviceMemory ?? null,
    device_pixel_ratio: window.devicePixelRatio,
    screen: { width: window.screen?.width, height: window.screen?.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

async function probeWebgl2(): Promise<JsonRecord> {
  return step(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 4;
    canvas.height = 4;
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      const gl1 = document.createElement("canvas").getContext("webgl");
      throw new Error(`getContext("webgl2") returned null; webgl1 ${gl1 ? "available" : "unavailable"}`);
    }
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    gl.clearColor(0, 1, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const out = {
      renderer: clip(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), 160),
      vendor: clip(debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), 80),
      unmasked: Boolean(debug),
      version: clip(gl.getParameter(gl.VERSION), 80),
      max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      max_renderbuffer_size: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number,
      max_3d_texture_size: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,
      draws: pixel[1] === 255 && pixel[0] === 0,
      offscreen_canvas: typeof OffscreenCanvas !== "undefined",
      create_image_bitmap: typeof createImageBitmap === "function",
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return out;
  });
}

const WORKER_SOURCE = `
self.onmessage = async () => {
  let wasm = false;
  try {
    const m = await WebAssembly.instantiate(new Uint8Array(${JSON.stringify(ADD_WASM)}));
    wasm = m.instance.exports.add(2, 3) === 5;
  } catch (e) {}
  self.postMessage({ ok: true, wasm, offscreen: typeof OffscreenCanvas !== "undefined", gpu: typeof navigator !== "undefined" && "gpu" in navigator });
};`;

async function startWorker(url: string, options?: WorkerOptions): Promise<JsonRecord> {
  return step(async () => {
    const worker = new Worker(url, options);
    try {
      const reply = await withTimeout(
        new Promise<JsonRecord>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<JsonRecord>) => resolve(event.data);
          worker.onerror = (event: ErrorEvent) => reject(new Error(event.message || "worker error event"));
          worker.postMessage("go");
        }),
        WORKER_MS,
        "worker reply",
      );
      return { wasm_in_worker: reply.wasm === true, offscreen_in_worker: reply.offscreen === true, gpu_in_worker: reply.gpu === true };
    } finally {
      worker.terminate();
    }
  });
}

async function probeWorkers(): Promise<JsonRecord> {
  if (typeof Worker === "undefined") return { blob: { status: "unavailable" } };
  let blobUrl = "";
  try {
    blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  } catch (error) {
    return { blob: { status: "failed", error: `createObjectURL: ${errorText(error)}` } };
  }
  try {
    const blob = await startWorker(blobUrl);
    const blobModule = await startWorker(blobUrl, { type: "module" });
    const data = await startWorker(`data:text/javascript;base64,${btoa(WORKER_SOURCE)}`);
    return {
      blob,
      blob_module: blobModule,
      data,
      wasm_in_worker: blob.wasm_in_worker ?? null,
      // The widget document is written into its frame (srcdoc or document.write), so it
      // has no URL of its own to load a same-origin worker script from.
      same_origin_script: "not applicable: the widget has no fetchable URL of its own",
    };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function probeWasm(): Promise<JsonRecord> {
  if (typeof WebAssembly === "undefined") return { status: "unavailable" };
  return step(async () => {
    const bytes = new Uint8Array(ADD_WASM);
    const valid = WebAssembly.validate(bytes);
    const { instance } = await withTimeout(WebAssembly.instantiate(bytes), STEP_MS, "WebAssembly.instantiate");
    const add = instance.exports.add as unknown as (a: number, b: number) => number;
    if (add(2, 3) !== 5) throw new Error("add(2, 3) did not return 5");
    return { valid, streaming: typeof WebAssembly.instantiateStreaming === "function" };
  });
}

function probeSharedMemory(): JsonRecord {
  return {
    shared_array_buffer: typeof SharedArrayBuffer !== "undefined",
    cross_origin_isolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : null,
  };
}

function probeStorage(): JsonRecord {
  const test = (get: () => Storage) => {
    try {
      const s = get();
      s.setItem("kamai_probe", "1");
      s.removeItem("kamai_probe");
      return true;
    } catch {
      return false;
    }
  };
  let indexedDb = false;
  try {
    indexedDb = typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    indexedDb = false;
  }
  let cacheApi = false;
  try {
    cacheApi = typeof caches !== "undefined";
  } catch {
    cacheApi = false;
  }
  return {
    local_storage: test(() => window.localStorage),
    session_storage: test(() => window.sessionStorage),
    indexed_db: indexedDb,
    cache_api: cacheApi,
  };
}

async function probeTileHost(): Promise<JsonRecord> {
  let blob: Blob | null = null;
  const fetchStep = await step(async () => {
    const response = await withTimeout(fetch(TILE_HOST_TEST_URL, { mode: "cors", cache: "no-store", credentials: "omit" }), STEP_MS, "fetch");
    blob = await withTimeout(response.blob(), STEP_MS, "body");
    return {
      http_status: response.status,
      content_type: clip(response.headers.get("content-type"), 60),
      bytes: blob.size,
      acao: clip(response.headers.get("access-control-allow-origin"), 60),
    };
  });
  const fetched = blob as Blob | null;
  const decode =
    fetched && fetchStep.status === "ok"
      ? await step(async () => {
          const bitmap = await withTimeout(createImageBitmap(fetched), STEP_MS, "createImageBitmap");
          const out = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          return out;
        })
      : { status: "skipped" };
  // An <img> is governed by img-src (resourceDomains), fetch() by connect-src
  // (connectDomains). The shipping widgets only declare the former.
  const image = await step(
    () =>
      withTimeout(
        new Promise<JsonRecord>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error("img onerror"));
          img.src = `${TILE_HOST_TEST_URL}?img=1`;
        }),
        STEP_MS,
        "img load",
      ),
  );
  return { url: TILE_HOST_TEST_URL, fetch: fetchStep, decode, img: image };
}

async function probeWebgpu(skipReason: string | null): Promise<JsonRecord> {
  const gpu = (navigator as unknown as { gpu?: Gpu }).gpu;
  const out: JsonRecord = { api: Boolean(gpu) };
  if (!gpu) return { ...out, status: "unavailable" };
  try {
    out.preferred_format = gpu.getPreferredCanvasFormat?.() ?? null;
  } catch (error) {
    out.preferred_format_error = errorText(error);
  }
  out.wgsl_features = featureList(gpu.wgslLanguageFeatures, 32);
  if (skipReason) return { ...out, status: "skipped", error: skipReason };

  let adapter: GpuAdapter | null = null;
  // Without a writable marker a crash here cannot be remembered, so the report says so.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  out.marker_writable = storageSet(GPU_MARKER, token);
  const request = await step(async () => {
    const pending = gpu.requestAdapter();
    // Cleared when the request itself settles, not when the timeout gives up on it: a
    // request that crashes the GPU process after the timeout must still be remembered.
    // Only by its own request, so an older one settling late cannot erase a newer mark.
    const clear = () => {
      if (storageGet(GPU_MARKER) === token) storageSet(GPU_MARKER, null);
    };
    pending.then(clear, clear);
    adapter = await withTimeout(pending, STEP_MS, "requestAdapter");
    if (!adapter) throw new Error("requestAdapter() resolved null");
    return {};
  });
  out.request_adapter_ms = request.ms;
  const found = adapter as GpuAdapter | null;
  if (request.status !== "ok" || !found) return { ...out, status: request.status, error: request.error };

  let info = found.info;
  if (!info && typeof found.requestAdapterInfo === "function") {
    try {
      info = await withTimeout(found.requestAdapterInfo(), STEP_MS, "requestAdapterInfo");
    } catch (error) {
      out.adapter_info_error = errorText(error);
    }
  }
  out.adapter = adapterInfoOf(info, found);
  out.limits = pickLimits(found.limits);
  out.features = featureList(found.features);

  let device: GpuDevice | null = null;
  out.device = await step(async () => {
    device = await withTimeout(found.requestDevice(), STEP_MS, "requestDevice");
    return {};
  });
  const opened = device as GpuDevice | null;
  if (opened) {
    // Presenting is a separate permission from computing on some hosts: configure a
    // canvas and clear it once, so "WebGPU works" means it can draw to the page.
    out.present = await step(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const ctx = (canvas as unknown as { getContext(id: "webgpu"): GpuCanvasContext | null }).getContext("webgpu");
      if (!ctx) throw new Error('getContext("webgpu") returned null');
      ctx.configure({ device: opened, format: gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm", alphaMode: "opaque" });
      const encoder = opened.createCommandEncoder();
      encoder
        .beginRenderPass({
          colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: [0, 1, 0, 1], loadOp: "clear", storeOp: "store" }],
        })
        .end();
      opened.queue.submit([encoder.finish()]);
      await withTimeout(opened.queue.onSubmittedWorkDone(), STEP_MS, "onSubmittedWorkDone");
      return {};
    });
    try {
      opened.destroy?.();
    } catch {
      undefined;
    }
  }
  return { ...out, ...gpuOutcome(out.device, out.present) };
}

async function waitForBridge(): Promise<void> {
  const start = now();
  while (!isReady() && now() - start < READY_MS) await new Promise((r) => setTimeout(r, 100));
}

export interface ProbeOptions {
  onUpdate: (report: Partial<ProbeReport>) => void;
  /** probe_host's webgpu argument. Read just before WebGPU runs, by then the tool result
   * has almost always arrived even on a host that delivered it late. */
  webgpuMode: () => WebgpuMode | undefined;
}

/** Run the whole probe. Resolves with the final report; every step reports through
 * onUpdate as it lands, so the panel fills in progressively. */
export async function runProbe(widgetVersion: string | undefined, { onUpdate, webgpuMode }: ProbeOptions): Promise<Partial<ProbeReport>> {
  const t0 = now();
  const runId = randomId();
  const timings: JsonRecord = {};
  const csp: Array<{ directive: string; blocked: string }> = [];
  const onViolation = (event: SecurityPolicyViolationEvent) => {
    if (csp.length < 20) csp.push({ directive: clip(event.effectiveDirective || event.violatedDirective, 40)!, blocked: originOf(event.blockedURI) });
  };
  document.addEventListener("securitypolicyviolation", onViolation);

  const crashed = storageGet(GPU_MARKER) !== null;

  const report: Partial<ProbeReport> = {
    schema: 1,
    run_id: runId,
    attempt: crashed ? "after_gpu_crash" : "first",
    widget_version: widgetVersion,
    csp_violations: csp,
    timings,
  };
  const update = (patch: Partial<ProbeReport>) => {
    Object.assign(report, patch);
    onUpdate({ ...report });
  };

  const timed = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    const start = now();
    const value = await work();
    timings[name] = Math.round(now() - start);
    return value;
  };

  const send = async (phase: Phase): Promise<JsonRecord> => {
      if (!hostCanCallTools()) return { status: "unavailable", error: "this host cannot call tools" };
      return step(async () => {
        const answer = await withTimeout(
          callTool<unknown>("report_host_probe", { report: { ...report, phase, csp_violations: [...csp] } }),
          SEND_MS,
          "report_host_probe",
        );
        // A tool error comes back as a resolved envelope, not a rejection.
        if (!isLogged(answer)) throw new Error(`report_host_probe did not log: ${clip(JSON.stringify(answer), 200)}`);
        return {};
      });
  };

  // Sections that are not already a step() run through this, so one throwing cannot
  // stop the rest of the probe or the report.
  const guarded = async (work: () => Promise<JsonRecord> | JsonRecord): Promise<JsonRecord> => {
    try {
      return await work();
    } catch (error) {
      return { status: "failed", error: errorText(error) };
    }
  };

  try {
    await timed("bridge_ready", waitForBridge);
    update({ host: await guarded(hostSection) });
    update({ webgl2: await timed("webgl2", () => guarded(probeWebgl2)) });
    update({ wasm: await timed("wasm", () => guarded(probeWasm)) });
    update({ worker: await timed("worker", () => guarded(probeWorkers)) });
    update({ shared_memory: await guarded(probeSharedMemory), storage: await guarded(probeStorage) });
    update({ tile_host: await timed("tile_host", () => guarded(probeTileHost)) });
    update({ webgpu: { status: "pending", api: "gpu" in navigator } });

    // Out the door before WebGPU: if requestAdapter takes the renderer down, this is
    // the report that survives.
    timings.pre_gpu_total = Math.round(now() - t0);
    const preSend = await timed("send_pre_gpu", () => send("pre_gpu"));
    update({ report_send: { pre_gpu: preSend } });

    const surface = String(((report.host as JsonRecord | undefined)?.guess as JsonRecord | undefined)?.surface ?? "");
    const skip = webgpuSkipReason(webgpuMode(), surface, crashed);
    update({ webgpu: await timed("webgpu", () => guarded(() => probeWebgpu(skip))) });
    timings.total = Math.round(now() - t0);
    const finalSend = await send("final");
    update({ phase: "final", report_send: { pre_gpu: preSend, final: finalSend } });
  } catch (error) {
    // Something outside every guard threw; still try to get what there is out.
    const finalSend = await send("final").catch((e: unknown) => ({ status: "failed", error: errorText(e) }));
    update({ phase: "final", report_send: { ...(report.report_send ?? {}), final: finalSend, error: errorText(error) } });
  } finally {
    document.removeEventListener("securitypolicyviolation", onViolation);
    // Only a delivered report ends this tool call's automatic runs; an undelivered one
    // runs again on the next mount.
    const sends = (report.report_send ?? {}) as Record<string, JsonRecord | undefined>;
    const id = toolCallId();
    if (id && (sends.pre_gpu?.status === "ok" || sends.final?.status === "ok")) storageSet(DONE_PREFIX + id, runId);
  }
  return report;
}
