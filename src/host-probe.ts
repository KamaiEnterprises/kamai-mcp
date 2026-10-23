import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import { logEvent } from "./log.ts";
import { looseOutput } from "./loose.ts";
import { APP_ONLY, READONLY, text } from "./tool-kit.ts";
import { WIDGET_VERSION, toolMeta } from "./widgets/index.ts";

// What a widget frame can actually do on each host
// (WebGPU, WebGL2, workers, WebAssembly, the GCS tile host), measured from inside the
// frame and logged here as one `widget_probe` line per report. Capability data only:
// the widget sends no project data and holds no token.

// The sections the widget sends. Anything else in a report is dropped, so a host or a
// hand-crafted call cannot use this tool to write arbitrary data into the log.
export const PROBE_SECTIONS = [
  "schema",
  "run_id",
  "attempt",
  "phase",
  "widget_version",
  "host",
  "webgl2",
  "worker",
  "wasm",
  "shared_memory",
  "storage",
  "tile_host",
  "csp_violations",
  "webgpu",
  "report_send",
  "timings",
] as const;

const MAX_STRING = 300;
const MAX_ARRAY = 64;
const MAX_KEYS = 64;
const MAX_DEPTH = 5;
// One Cloud Logging entry; a full report is around 4 KB.
export const MAX_REPORT_CHARS = 24_000;

function bound(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => bound(item, depth + 1)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      const item = bound((value as Record<string, unknown>)[key], depth + 1);
      if (item !== undefined) out[key.slice(0, 64)] = item;
    }
    return out;
  }
  return undefined;
}

/** The log line's payload: known sections only, every string, array and object bounded,
 * and the whole under MAX_REPORT_CHARS, the largest sections dropped first. */
export function shapeProbeReport(report: unknown): Record<string, unknown> {
  const input = report && typeof report === "object" && !Array.isArray(report) ? (report as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of PROBE_SECTIONS) {
    if (!(key in input)) continue;
    const value = bound(input[key], 1);
    if (value !== undefined) out[key] = value;
  }
  const dropped: string[] = [];
  let size = JSON.stringify(out).length;
  while (size > MAX_REPORT_CHARS) {
    const largest = Object.keys(out)
      .filter((key) => key !== "run_id" && key !== "phase")
      .sort((a, b) => JSON.stringify(out[b]).length - JSON.stringify(out[a]).length)[0];
    if (!largest) break;
    delete out[largest];
    dropped.push(largest);
    size = JSON.stringify(out).length;
  }
  if (dropped.length) out.dropped_sections = dropped;
  return out;
}

const WEBGPU_MODES = ["auto", "run", "skip"] as const;

const probeWidgetOutput = z.object({
  widget_version: z.string(),
  webgpu: z.enum(WEBGPU_MODES),
});

const reportOutput = z.object({
  logged: z.boolean(),
  run_id: z.string().nullable(),
  phase: z.string().nullable(),
});

export function registerHostProbe(server: McpServer, clientUserAgent?: string): void {
  registerAppTool(
    server,
    "probe_host",
    {
      title: "Probe widget capabilities",
      description:
        "Diagnostic for Kamai's developers: show a panel that tests what Kamai panels can use in this " +
        "chat (WebGPU, WebGL2, workers, WebAssembly, image loading from the tile host) and reports the " +
        "result to Kamai. Use only when the user explicitly asks to run the Kamai host probe.",
      inputSchema: {
        webgpu: z
          .enum(WEBGPU_MODES)
          .optional()
          .describe(
            "auto (default) tests WebGPU except in Windows desktop apps, where requesting a GPU adapter " +
              "can close the app and need a reinstall, and after an earlier attempt never came back. " +
              "run tests it anyway; skip never does.",
          ),
      },
      outputSchema: looseOutput(probeWidgetOutput),
      annotations: READONLY,
      _meta: toolMeta("probe"),
    },
    async ({ webgpu }) => {
      const structuredContent = probeWidgetOutput.parse({ widget_version: WIDGET_VERSION, webgpu: webgpu ?? "auto" });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ...structuredContent,
              note: "The panel runs the checks in the user's browser and reports them to Kamai itself; there is nothing to summarise.",
            }),
          },
        ],
        structuredContent,
        _meta: toolMeta("probe"),
      };
    },
  );

  registerAppTool(
    server,
    "report_host_probe",
    {
      title: "Record a widget probe",
      description: "Called by the probe panel itself, never by the model: records what this chat's widget frame supports.",
      inputSchema: { report: z.record(z.string(), z.unknown()) },
      outputSchema: looseOutput(reportOutput),
      // Hints describe the user's data, which is what hosts ask about before a call: this
      // writes nothing a user owns, only a log line, and a repeat is harmless (the run_id
      // dedupes it), so it is marked read-only and idempotent like the other app helpers.
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async ({ report }) => {
      const shaped = shapeProbeReport(report);
      logEvent("widget_probe", {
        ...shaped,
        server_widget_version: WIDGET_VERSION,
        mcp_client: (clientUserAgent ?? "").slice(0, 120) || null,
      });
      return text({
        logged: true,
        run_id: typeof shaped.run_id === "string" ? shaped.run_id : null,
        phase: typeof shaped.phase === "string" ? shaped.phase : null,
      });
    },
  );
}
