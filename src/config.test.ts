import { afterEach, describe, expect, it, vi } from "vitest";

// config.ts reads the environment at import time, so each case imports a fresh copy.
const load = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) vi.stubEnv(k, "");
    else vi.stubEnv(k, v);
  }
  return import("./config.ts");
};

afterEach(() => vi.unstubAllEnvs());

describe("accepted token audience", () => {
  it("is the API this server adapts, not the server's own address", async () => {
    const c = await load({
      MCP_PUBLIC_URL: "https://mcp.example.test",
      MCP_API_BASE_URL: "https://mcp-api.example.test/",
      MCP_ACCEPTED_AUDIENCES: undefined,
    });
    expect(c.ACCEPTED_AUDIENCES).toEqual(["https://mcp-api.example.test", "https://mcp-api.example.test/"]);
    expect(c.ACCEPTED_AUDIENCES).not.toContain(c.RESOURCE_URL);
  });

  it("takes an explicit list for a cutover window", async () => {
    const c = await load({
      MCP_PUBLIC_URL: "https://mcp.example.test",
      MCP_API_BASE_URL: "https://mcp-api.example.test",
      MCP_ACCEPTED_AUDIENCES: " https://mcp.example.test/mcp, https://mcp-api.example.test ,",
    });
    expect(c.ACCEPTED_AUDIENCES).toEqual(["https://mcp.example.test/mcp", "https://mcp-api.example.test"]);
  });

  it("still advertises its own URL as the resource hosts ask a token for", async () => {
    const c = await load({ MCP_PUBLIC_URL: "https://mcp.example.test/", MCP_API_BASE_URL: "https://mcp-api.example.test" });
    expect(c.RESOURCE_URL).toBe("https://mcp.example.test/mcp");
  });
});

describe("PostHog host", () => {
  it("is Kamai's own proxy when unset", async () => {
    vi.resetModules();
    vi.stubEnv("POSTHOG_HOST", undefined);
    expect((await import("./config.ts")).POSTHOG_HOST).toBe("https://t.kamai.io");
  });

  it("takes an explicit value", async () => {
    expect((await load({ POSTHOG_HOST: "https://eu.i.posthog.com/" })).POSTHOG_HOST).toBe("https://eu.i.posthog.com");
  });
});
