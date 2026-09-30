import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildServer } from "../server.ts";

const SIGNED = "https://storage.googleapis.com/b/p.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abc";
const ring = Array.from({ length: 48 }, (_, j) => 100 + j * 1.25);
const page = {
  blueprint_id: "bp1",
  name: "Haus F",
  project_id: "p1",
  project_name: "Default Project",
  state: "ready",
  grid: 1,
  image: { url: SIGNED, w: 4000, h: 3000 },
  features: [
    ...Array.from({ length: 300 }, (_, i) => ({ i, id: `r${i}`, cls: "room", name: `Room ${i}`, color: { r: 1, g: 2, b: 3, a: 1 }, rings: [ring], area: 12.5 })),
    ...Array.from({ length: 100 }, (_, i) => ({ i: 300 + i, id: `d${i}`, cls: "door", name: `Door ${i}`, color: { r: 1, g: 2, b: 3, a: 1 }, pts: [1, 2] })),
  ],
  total: 400,
  truncated: false,
  next_cursor: null,
  scale_label: "1:50",
  needs_scale: false,
  scale_unconfirmed: false,
  units: { area: "m²", length: "m" },
};

afterEach(() => vi.unstubAllGlobals());

async function viewBlueprint() {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } }));
  const server = buildServer({ uid: "test", token: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client.callTool({ name: "view_blueprint", arguments: { blueprint_id: "bp1", project_id: "p1" } });
}

describe("view_blueprint model text", () => {
  // content is what the model reads and what Open WebUI's bridge forwards. The widget
  // still renders from structuredContent, which keeps the full page.
  it("keeps the signed image URL and the outlines out of content", async () => {
    const result = await viewBlueprint();
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).not.toContain("X-Goog-Signature");
    expect(text.length).toBeLessThan(2_000);
    expect(JSON.parse(text)).toMatchObject({
      name: "Haus F",
      project_name: "Default Project",
      total: 400,
      features_shown: 400,
      classes: [{ cls: "room", count: 300 }, { cls: "door", count: 100 }],
    });
    const structured = result.structuredContent as { image: { url: string }; features: unknown[] };
    expect(structured.image.url).toBe(SIGNED);
    expect(structured.features).toHaveLength(400);
  });
});

describe("blueprint widget on a host that forwards only content", () => {
  // The widget picks the summary card when it receives the model summary (classes, no
  // features); if the two shapes drift, Open WebUI shows an empty canvas again.
  it("receives a payload the widget recognises as a summary", async () => {
    const result = await viewBlueprint();
    const summary = JSON.parse((result.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    expect(summary.features).toBeUndefined();
    expect(Array.isArray(summary.classes)).toBe(true);
    expect(typeof summary.project_id).toBe("string");
  });
});

