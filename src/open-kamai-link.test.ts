import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clientFamily, openKamaiLinkFamilies } from "./config.ts";
import { connect, structured, stubApi } from "./testing/harness.ts";

describe("open_kamai link or frame per host", () => {
  beforeEach(() => stubApi({ "GET /v1/me": { body: { uid: "test", app_links: true } } }));
  afterEach(() => vi.unstubAllGlobals());
  it("tells MCP clients apart by the User-Agent their backend sends", () => {
    expect(clientFamily("Claude-User")).toBe("claude");
    expect(clientFamily("openai-mcp/1.0.0")).toBe("chatgpt");
    expect(clientFamily("openai-mcp/1.0.0 (Codex)")).toBe("codex");
    expect(clientFamily("Cursor/1.7.0 (darwin arm64)")).toBe("cursor");
    expect(clientFamily("python-httpx/0.28.1")).toBe("other");
    expect(clientFamily(undefined)).toBe("other");
  });

  it("defaults to a link on Claude only; the setting is a list or none", () => {
    expect([...openKamaiLinkFamilies({})]).toEqual(["claude"]);
    expect([...openKamaiLinkFamilies({ KAMAI_OPEN_KAMAI_LINK: "Claude, ChatGPT" })]).toEqual(["claude", "chatgpt"]);
    expect(openKamaiLinkFamilies({ KAMAI_OPEN_KAMAI_LINK: "none" }).size).toBe(0);
  });

  it("Claude gets the link card, without the panel sign-in", async () => {
    const client = await connect({ panelSignIn: true, openKamaiLink: new Set(["claude"]) }, { userAgent: "Claude-User" });
    const result = structured(await client.callTool({ name: "open_kamai", arguments: {} }));
    expect(result.open_in).toBe("link");
    expect(result).not.toHaveProperty("panel_sign_in");
  });

  it("ChatGPT keeps the signed-in frame by default", async () => {
    const client = await connect({ panelSignIn: true, openKamaiLink: new Set(["claude"]) }, { userAgent: "openai-mcp/1.0.0", chatgpt: true });
    const result = structured(await client.callTool({ name: "open_kamai", arguments: {} }));
    expect(result.open_in).toBe("fullscreen");
    expect(result.panel_sign_in).toBe(true);
  });

  it("ChatGPT gets the link once it is listed", async () => {
    const client = await connect({ openKamaiLink: new Set(["claude", "chatgpt"]) }, { userAgent: "openai-mcp/1.0.0", chatgpt: true });
    expect(structured(await client.callTool({ name: "open_kamai", arguments: {} })).open_in).toBe("link");
  });

  it("an unknown client, Open WebUI included, keeps the frame", async () => {
    const client = await connect({ openKamaiLink: new Set(["claude"]) }, { userAgent: "python-httpx/0.28.1" });
    expect(structured(await client.callTool({ name: "open_kamai", arguments: {} })).open_in).toBe("fullscreen");
  });
});

describe("open_kamai link keeps old descriptors valid", () => {
  beforeEach(() => stubApi({ "GET /v1/me": { body: { uid: "test", app_links: true } } }));
  afterEach(() => vi.unstubAllGlobals());
  it("adds no field to the result: the link rides on open_in, a free string", async () => {
    const client = await connect({ openKamaiLink: new Set(["claude"]) }, { userAgent: "Claude-User" });
    const tools = (await client.listTools()).tools as Array<{ name: string; outputSchema?: { properties?: Record<string, unknown> } }>;
    const props = Object.keys(tools.find((t) => t.name === "open_kamai")?.outputSchema?.properties ?? {});
    expect(props).not.toContain("presentation");
    const result = structured(await client.callTool({ name: "open_kamai", arguments: {} }));
    expect(Object.keys(result).every((key) => props.includes(key))).toBe(true);
  });
});

describe("open_kamai for an account the client may not link to the app", () => {
  afterEach(() => vi.unstubAllGlobals());

  const me = (body: unknown) =>
    vi.stubGlobal("fetch", async (input: URL | string) => {
      expect(String(input)).toMatch(/\/v1\/me$/);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });

  it("answers with the API layer's notice and opens nothing", async () => {
    const notice = "This Kamai account's current plan does not include opening its projects in the Kamai web app.";
    me({ uid: "u", app_links: false, notice });
    const client = await connect({ panelSignIn: true }, { userAgent: "openai-mcp/1.0.0", chatgpt: true });
    const result = (await client.callTool({ name: "open_kamai", arguments: {} })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text ?? "").join(" ")).toContain(notice);
  });

  it("opens Kamai as before when the API layer allows it", async () => {
    me({ uid: "u", app_links: true });
    const client = await connect({ panelSignIn: true }, { userAgent: "openai-mcp/1.0.0", chatgpt: true });
    expect(structured(await client.callTool({ name: "open_kamai", arguments: {} })).open_in).toBe("fullscreen");
  });
});

describe("open_kamai fails closed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens nothing when the API layer cannot say whether it may", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 503 }));
    const client = await connect({ panelSignIn: true }, { userAgent: "openai-mcp/1.0.0", chatgpt: true });
    const result = (await client.callTool({ name: "open_kamai", arguments: {} })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text ?? "").join(" ")).toContain("could not be opened just now");
  });
});
