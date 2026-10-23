import { afterEach, describe, expect, it, vi } from "vitest";

import { hostProbeEnabled } from "./config.ts";
import { MAX_REPORT_CHARS, shapeProbeReport } from "./host-probe.ts";
import { connect, structured } from "./testing/harness.ts";
import { WIDGET_VERSION, widgetUri } from "./widgets/index.ts";

type Tool = { name: string; annotations?: Record<string, unknown>; _meta?: { ui?: { visibility?: string[]; resourceUri?: string } } };

afterEach(() => vi.restoreAllMocks());

function captureLog() {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return () =>
    lines
      .map((l) => JSON.parse(l) as { event_name?: string; event_data?: Record<string, unknown> })
      .filter((e) => e.event_name === "widget_probe")
      .map((e) => e.event_data!);
}

describe("KAMAI_HOST_PROBE", () => {
  it("is off in prod and anywhere unnamed, on in dev and debug", () => {
    expect(hostProbeEnabled({})).toBe(false);
    expect(hostProbeEnabled({ K_SERVICE: "prod-mcp" })).toBe(false);
    expect(hostProbeEnabled({ K_SERVICE: "kamai-mcp" })).toBe(false);
    expect(hostProbeEnabled({ K_SERVICE: "dev-mcp" })).toBe(true);
    expect(hostProbeEnabled({ K_SERVICE: "debug-mcp" })).toBe(true);
  });

  it("is settable either way, over the service name", () => {
    expect(hostProbeEnabled({ KAMAI_HOST_PROBE: "on", K_SERVICE: "prod-mcp" })).toBe(true);
    expect(hostProbeEnabled({ KAMAI_HOST_PROBE: " ON " })).toBe(true);
    expect(hostProbeEnabled({ KAMAI_HOST_PROBE: "off", K_SERVICE: "dev-mcp" })).toBe(false);
    // Anything else is not a decision: the service name still decides.
    expect(hostProbeEnabled({ KAMAI_HOST_PROBE: "1", K_SERVICE: "prod-mcp" })).toBe(false);
  });
});

describe("probe tools", () => {
  it("off: neither tool nor the probe resource is listed", async () => {
    const client = await connect({ hostProbe: false });
    const names = ((await client.listTools()).tools as Tool[]).map((t) => t.name);
    expect(names).not.toContain("probe_host");
    expect(names).not.toContain("report_host_probe");
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris.some((uri) => uri.includes("/probe@"))).toBe(false);
  });

  it("off: the probe widget is not served at any version", async () => {
    const client = await connect({ hostProbe: false });
    await expect(client.readResource({ uri: widgetUri("probe") })).rejects.toThrow(/Unknown Kamai widget/);
    await expect(client.readResource({ uri: "ui://kamai/probe@v10.html" })).rejects.toThrow(/Unknown Kamai widget/);
    const other = await client.readResource({ uri: widgetUri("blueprint") });
    expect(other.contents).toHaveLength(1);
  });

  it("on: probe_host renders the probe widget, report_host_probe is app-only", async () => {
    const client = await connect({ hostProbe: true });
    const tools = (await client.listTools()).tools as Tool[];
    const probe = tools.find((t) => t.name === "probe_host");
    const report = tools.find((t) => t.name === "report_host_probe");
    expect(probe?._meta?.ui?.resourceUri).toBe(widgetUri("probe"));
    expect(probe?._meta?.ui?.visibility).toEqual(["model", "app"]);
    expect(report?._meta?.ui?.visibility).toEqual(["app"]);
    for (const tool of [probe, report]) expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toContain(widgetUri("probe"));
  });

  it("probe_host hands the widget its version and the WebGPU switch, in both result halves", async () => {
    const client = await connect({ hostProbe: true });
    const result = await client.callTool({ name: "probe_host", arguments: { webgpu: "skip" } });
    expect(structured(result)).toEqual({ widget_version: WIDGET_VERSION, webgpu: "skip" });
    const block = (result.content as Array<{ text: string }>)[0]!;
    expect(JSON.parse(block.text)).toMatchObject({ widget_version: WIDGET_VERSION, webgpu: "skip" });
    const fallback = await client.callTool({ name: "probe_host", arguments: {} });
    expect(structured(fallback).webgpu).toBe("auto");
  });

  it("the probe resource allows the tile host for fetch and for images", async () => {
    const client = await connect({ hostProbe: true });
    const result = await client.readResource({ uri: widgetUri("probe") });
    const meta = result.contents[0]?._meta as {
      ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } };
      "openai/widgetCSP"?: { connect_domains?: string[] };
    };
    expect(meta.ui?.csp?.connectDomains).toEqual(["https://storage.googleapis.com"]);
    expect(meta.ui?.csp?.resourceDomains).toEqual(["https://storage.googleapis.com"]);
    expect(meta["openai/widgetCSP"]?.connect_domains).toEqual(["https://storage.googleapis.com"]);
  });

  it("report_host_probe logs one widget_probe line and answers with its run id", async () => {
    const events = captureLog();
    const client = await connect({ hostProbe: true });
    const result = await client.callTool({
      name: "report_host_probe",
      arguments: {
        report: {
          schema: 1,
          run_id: "r-1",
          phase: "pre_gpu",
          webgl2: { status: "ok", max_texture_size: 16384 },
          webgpu: { status: "pending", api: true },
          timings: { webgl2: 12 },
        },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toEqual({ logged: true, run_id: "r-1", phase: "pre_gpu" });
    const logged = events();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      run_id: "r-1",
      phase: "pre_gpu",
      webgl2: { status: "ok", max_texture_size: 16384 },
      server_widget_version: WIDGET_VERSION,
    });
  });

  it("records which MCP client relayed the report", async () => {
    const events = captureLog();
    const client = await connect({ hostProbe: true }, { userAgent: "Claude-User" });
    await client.callTool({ name: "report_host_probe", arguments: { report: { run_id: "r-2" } } });
    expect(events()[0]!.mcp_client).toBe("Claude-User");
  });

  it("refuses a report that is not an object", async () => {
    const client = await connect({ hostProbe: true });
    const result = (await client.callTool({ name: "report_host_probe", arguments: { report: "x" } })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe("shapeProbeReport", () => {
  it("keeps only the known sections", () => {
    const shaped = shapeProbeReport({ run_id: "r", webgl2: { status: "ok" }, token: "secret", project_id: "p1" });
    expect(shaped).toEqual({ run_id: "r", webgl2: { status: "ok" } });
  });

  it("bounds strings, arrays and depth, and nulls non-finite numbers", () => {
    const shaped = shapeProbeReport({
      host: {
        user_agent: "u".repeat(1000),
        list: Array.from({ length: 200 }, (_, i) => i),
        deep: { a: { b: { c: { d: { e: "too deep" } } } } },
        nan: Number.NaN,
        fn: () => 1,
      },
    });
    const host = shaped.host as Record<string, unknown>;
    expect((host.user_agent as string).length).toBeLessThanOrEqual(301);
    expect(host.list).toHaveLength(64);
    expect(JSON.stringify(host.deep)).not.toContain("too deep");
    expect(host.nan).toBeNull();
    expect(host).not.toHaveProperty("fn");
  });

  it("drops the largest sections until the line fits, and says which", () => {
    const wide = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, "x".repeat(300)]));
    const shaped = shapeProbeReport({ run_id: "r", phase: "final", host: wide, webgpu: wide, webgl2: { status: "ok" } });
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
    expect(shaped.run_id).toBe("r");
    expect(shaped.webgl2).toEqual({ status: "ok" });
    expect(shaped.dropped_sections).toEqual(expect.arrayContaining(["host"]));
  });

  it("treats a non-object as empty", () => {
    expect(shapeProbeReport(null)).toEqual({});
    expect(shapeProbeReport([1, 2])).toEqual({});
  });
});
