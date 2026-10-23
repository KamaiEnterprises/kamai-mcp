import { describe, expect, it } from "vitest";

import {
  ADD_WASM,
  adapterInfoOf,
  featureList,
  gpuOutcome,
  guessHost,
  hostContextSummary,
  isLogged,
  keyNames,
  originOf,
  pickLimits,
  sendSummary,
  step,
  verdicts,
  webgpuSkipReason,
  withTimeout,
} from "./probe-report";

describe("step and withTimeout", () => {
  it("times a step and folds its fields in", async () => {
    const result = await step(() => ({ width: 4 }));
    expect(result).toMatchObject({ status: "ok", width: 4 });
    expect(typeof result.ms).toBe("number");
  });

  it("reports a throw as failed, with the error text, and never rethrows", async () => {
    const result = await step(async () => {
      throw new TypeError("no adapter");
    });
    expect(result).toMatchObject({ status: "failed", error: "TypeError: no adapter" });
  });

  it("reports a hang as a timeout", async () => {
    const result = await step(() => withTimeout(new Promise(() => undefined), 10, "requestAdapter"));
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("requestAdapter");
  });

  it("passes a settled value through", async () => {
    await expect(withTimeout(Promise.resolve(3), 50, "x")).resolves.toBe(3);
  });
});

describe("WebGPU shaping", () => {
  it("reads limits by name, since they are prototype getters", () => {
    class Limits {
      get maxTextureDimension2D() {
        return 8192;
      }
      get maxBufferSize() {
        return 268435456;
      }
    }
    expect(Object.keys(new Limits())).toEqual([]);
    expect(pickLimits(new Limits())).toEqual({ maxTextureDimension2D: 8192, maxBufferSize: 268435456 });
    expect(pickLimits(null)).toEqual({});
  });

  it("takes adapter info from info, or the legacy fallback flag from the adapter", () => {
    expect(adapterInfoOf({ vendor: "apple", architecture: "metal-3", device: "", isFallbackAdapter: false })).toEqual({
      vendor: "apple",
      architecture: "metal-3",
      is_fallback: false,
    });
    expect(adapterInfoOf(undefined, { isFallbackAdapter: true })).toEqual({ is_fallback: true });
  });

  it("lists features sorted and bounded", () => {
    expect(featureList(new Set(["timestamp-query", "float32-filterable"]))).toEqual(["float32-filterable", "timestamp-query"]);
    expect(featureList(undefined)).toEqual([]);
  });
});

describe("WebGPU overall status", () => {
  it("is ok only when a device opened and drew", () => {
    expect(gpuOutcome({ status: "ok" }, { status: "ok" })).toEqual({ status: "ok" });
  });

  it("carries a failed or hung step up, never a pass", () => {
    expect(gpuOutcome({ status: "timeout", error: "StepTimeout: requestDevice did not settle" }, undefined)).toEqual({
      status: "timeout",
      error: "requestDevice: StepTimeout: requestDevice did not settle",
    });
    expect(gpuOutcome({ status: "ok" }, { status: "failed", error: "Error: no webgpu context" })).toEqual({
      status: "failed",
      error: "present: Error: no webgpu context",
    });
    expect(gpuOutcome({ status: "ok" }, undefined).status).toBe("failed");
  });
});

describe("when WebGPU is left alone", () => {
  it("runs by default on every surface but Windows desktop apps", () => {
    for (const surface of ["web", "desktop-mac", "ios", "android"]) expect(webgpuSkipReason(undefined, surface, false), surface).toBeNull();
    expect(webgpuSkipReason("auto", "desktop-windows", false)).toContain("claude-code#89112");
  });

  it("stays skipped after an attempt that never came back, until run is asked for", () => {
    expect(webgpuSkipReason("auto", "web", true)).toContain("never came back");
    expect(webgpuSkipReason("run", "web", true)).toBeNull();
    expect(webgpuSkipReason("run", "desktop-windows", true)).toBeNull();
  });

  it("never runs with skip", () => {
    expect(webgpuSkipReason("skip", "web", false)).toContain("webgpu=skip");
  });
});

describe("report send", () => {
  it("summarises delivery, counting a pre-GPU report on its own", () => {
    expect(sendSummary({ run_id: "abcdef123", phase: "pre_gpu" })).toBe("Running checks…");
    expect(sendSummary({ run_id: "abcdef123", phase: "final", report_send: { pre_gpu: { status: "ok" }, final: { status: "ok" } } })).toBe(
      "Reported to Kamai (run abcdef12).",
    );
    expect(
      sendSummary({ run_id: "abcdef123", phase: "final", report_send: { pre_gpu: { status: "ok" }, final: { status: "timeout", error: "slow" } } }),
    ).toContain("before the WebGPU test");
    expect(sendSummary({ run_id: "r", phase: "final", report_send: { pre_gpu: { status: "unavailable", error: "this host cannot call tools" } } })).toBe(
      "Not reported: this host cannot call tools.",
    );
  });

  it("counts only an answer that says it logged", () => {
    expect(isLogged({ logged: true, run_id: "r" })).toBe(true);
    expect(isLogged({ isError: true, content: [{ type: "text", text: "Invalid arguments" }] })).toBe(false);
    expect(isLogged(undefined)).toBe(false);
  });
});

describe("host identification", () => {
  it("names Claude from its sandbox origin", () => {
    expect(guessHost({ origin: "https://0123abcd.claudemcpcontent.com", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140" })).toEqual({
      family: "claude",
      surface: "web",
    });
  });

  it("names Claude Desktop on Windows from the Electron user agent", () => {
    expect(
      guessHost({ hostInfoName: "Claude Desktop", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Claude/1.2 Chrome/138 Electron/37" }),
    ).toEqual({ family: "claude", surface: "desktop-windows" });
  });

  it("names ChatGPT on iOS from the openai bridge", () => {
    expect(guessHost({ openai: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" })).toEqual({
      family: "chatgpt",
      surface: "ios",
    });
  });

  it("names Open WebUI from its injected result, and falls back to the host's own name", () => {
    expect(guessHost({ injectedResult: true }).family).toBe("open-webui");
    expect(guessHost({ hostInfoName: "Goose" }).family).toBe("goose");
    expect(guessHost({}).family).toBe("unknown");
  });
});

describe("privacy of the host section", () => {
  it("keeps host and device fields of the host context, never locale or time zone", () => {
    const summary = hostContextSummary({
      platform: "desktop",
      theme: "dark",
      locale: "he-IL",
      timeZone: "Asia/Jerusalem",
      toolInfo: { tool: { name: "probe_host" } },
      deviceCapabilities: { touch: false, hover: true },
    });
    expect(summary).toEqual({ platform: "desktop", theme: "dark", deviceCapabilities: { touch: false, hover: true } });
  });

  it("lists only the names of a host object's keys", () => {
    expect(keyNames({ toolOutput: { secret: 1 }, callTool: () => 1 })).toEqual(["callTool", "toolOutput"]);
    expect(keyNames(undefined)).toEqual([]);
  });

  it("reduces a blocked URL to its origin, so no signed query string is logged", () => {
    expect(originOf("https://storage.googleapis.com/b/o.png?X-Goog-Signature=abc")).toBe("https://storage.googleapis.com");
    expect(originOf("blob:https://x.example/123")).toBe("blob");
    expect(originOf("inline")).toBe("inline");
    expect(originOf("")).toBe("");
  });
});

describe("the WebAssembly test module", () => {
  it("validates and adds", async () => {
    const bytes = new Uint8Array(ADD_WASM);
    expect(WebAssembly.validate(bytes)).toBe(true);
    const { instance } = await WebAssembly.instantiate(bytes);
    expect((instance.exports.add as unknown as (a: number, b: number) => number)(2, 3)).toBe(5);
  });
});

describe("verdicts", () => {
  it("shows pending rows before anything has run", () => {
    expect(verdicts({}).map((v) => v.status)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
  });

  it("summarises a WebGPU success with its adapter and texture limit", () => {
    const [gpu] = verdicts({
      webgpu: {
        status: "ok",
        api: true,
        adapter: { vendor: "apple", architecture: "metal-3" },
        limits: { maxTextureDimension2D: 16384 },
        device: { status: "ok" },
      },
    });
    expect(gpu).toEqual({ label: "WebGPU", status: "ok", detail: "apple · metal-3 · max texture 16384 · device ok" });
  });

  it("says why WebGPU is missing", () => {
    expect(verdicts({ webgpu: { status: "unavailable", api: false } })[0]!.detail).toBe("navigator.gpu is absent");
  });

  it("marks the tile host failed when the fetch fails, whatever the decode says", () => {
    const tile = verdicts({ tile_host: { fetch: { status: "failed", error: "TypeError: Failed to fetch" }, decode: { status: "skipped" } } })[4]!;
    expect(tile).toMatchObject({ status: "failed", detail: "TypeError: Failed to fetch" });
  });
});
