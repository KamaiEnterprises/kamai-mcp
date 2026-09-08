import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";

import { buildServer } from "../server.ts";
import { WIDGET_NAMES, widgetUri } from "./index.ts";

// Hosts cache the tool descriptor, which carries the versioned resourceUri, and keep
// asking for that exact URI long after a deploy. Bumping WIDGET_VERSION from v10 to v24
// once took every widget down for every already-connected user, because the server only
// registered the current URI and answered "Resource not found" for the old one. The
// symptom is a 404 inside the host with nothing in our logs.
// contents[] is a text|blob union, so narrow once here rather than casting at every
// assertion — and fail loudly if a widget ever comes back as a blob.
function textOf(result: { contents: Array<Record<string, unknown>> }): string {
  const first = result.contents[0];
  const text = first?.text;
  if (typeof text !== "string") throw new Error("expected a text resource, got " + JSON.stringify(first));
  return text;
}

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
  const server = buildServer({ uid: "test", token: "test" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("widget resource URIs", () => {
  it("serves every widget at a previously deployed version", async () => {
    const client = await connect();
    for (const name of WIDGET_NAMES) {
      const result = await client.readResource({ uri: `ui://kamai/${name}@v10.html` });
      expect(textOf(result), `${name}@v10 must still resolve`).toContain("<!doctype html>");
    }
  });

  it("serves every widget at its current version", async () => {
    const client = await connect();
    for (const name of WIDGET_NAMES) {
      const result = await client.readResource({ uri: widgetUri(name) });
      expect(textOf(result)).toContain("<!doctype html>");
    }
  });

  it("carries the CSP metadata on a legacy URI too", async () => {
    const client = await connect();
    const result = await client.readResource({ uri: "ui://kamai/blueprint@v10.html" });
    const meta = result.contents[0]?._meta as { ui?: { csp?: unknown } } | undefined;
    expect(meta?.ui?.csp).toBeDefined();
  });

  it("still refuses an unknown widget name", async () => {
    const client = await connect();
    await expect(client.readResource({ uri: "ui://kamai/bogus@v10.html" })).rejects.toThrow();
  });

  // The iframetest URI folds a hash of the frame origins into the version, so it is
  // the URI that churns most — every origin allowlist change strands a cached
  // descriptor pointing at a hash the server no longer emits.
  it("serves iframetest at a stale origins hash", async () => {
    const client = await connect();
    const result = await client.readResource({ uri: "ui://kamai/iframetest@v25-0ddba1.html" });
    expect(textOf(result)).toContain("<!doctype html>");
  });
});

describe("open_kamai output contract", () => {
  // Probe-era descriptors advertised {url, declared_frame_domains, open_in, chrome,
  // expand_button} — all required, additionalProperties: false — and a stateless
  // server cannot tell a pinned conversation the schema changed. Dropping any of the
  // five fails validation on strict clients for as long as those conversations live,
  // and a payload without chrome: false sends a still-cached pre-v25 bundle down its
  // diagnostic branch instead of the product.
  it("keeps every probe-era field in the payload", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "open_kamai", arguments: {} });
    const output = result.structuredContent as Record<string, unknown>;
    expect(output).toMatchObject({ chrome: false, expand_button: true });
    expect(typeof output.url).toBe("string");
    expect(typeof output.open_in).toBe("string");
    expect(Array.isArray(output.declared_frame_domains)).toBe(true);
  });
});
