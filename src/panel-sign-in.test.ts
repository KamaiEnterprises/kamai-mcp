import { afterEach, describe, expect, it, vi } from "vitest";

import { connect, structured } from "./testing/harness.ts";

type Tool = { name: string; _meta?: { ui?: { visibility?: string[] } } };

afterEach(() => vi.unstubAllGlobals());

describe("open_kamai panel sign-in", () => {
  it("off by default: no session tool, open_kamai unchanged", async () => {
    const client = await connect();
    const names = ((await client.listTools()).tools as Tool[]).map((t) => t.name);
    expect(names).not.toContain("open_kamai_session");
    const result = structured(await client.callTool({ name: "open_kamai", arguments: {} }));
    expect(result).not.toHaveProperty("panel_sign_in");
  });

  it("on: open_kamai tells the panel to sign in, and the session tool is app-only", async () => {
    const client = await connect({ panelSignIn: true });
    const tools = (await client.listTools()).tools as Tool[];
    const session = tools.find((t) => t.name === "open_kamai_session");
    expect(session?._meta?.ui?.visibility).toEqual(["app"]);
    const result = structured(await client.callTool({ name: "open_kamai", arguments: {} }));
    expect(result.panel_sign_in).toBe(true);
  });

  it("mints with the caller's own token at the authorization server", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ panel_code: "c0de".repeat(10), expires_in: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = await connect({ panelSignIn: true });
    const result = structured<{ panel_code: string; expires_in: number }>(
      await client.callTool({ name: "open_kamai_session", arguments: {} }),
    );
    expect(result.panel_code).toBe("c0de".repeat(10));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/authorize\/panel-code$/);
    expect(seen[0]!.auth).toBe("Bearer test");
  });

  it("a refusal from the authorization server is a tool error, never a code", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    const client = await connect({ panelSignIn: true });
    const result = (await client.callTool({ name: "open_kamai_session", arguments: {} })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
