import { afterEach, describe, expect, it, vi } from "vitest";

// bridge.ts reads window at call time; a minimal stand-in is enough to drive init() the way
// Open WebUI's MCP App Bridge does: a parent frame, an injected result, no ui/* replies.
function stubWindow(injected: unknown) {
  const posted: unknown[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  const opened: string[] = [];
  vi.stubGlobal("window", {
    parent,
    __MCP_TOOL_RESULT__: injected,
    addEventListener: () => undefined,
    setTimeout,
    open: (href: string) => {
      opened.push(href);
      return null;
    },
  });
  vi.stubGlobal("document", {
    documentElement: { scrollHeight: 100, setAttribute: () => undefined },
    body: { scrollHeight: 100, style: {} },
  });
  return { posted, opened };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("a host that injects the result and answers nothing", () => {
  it("fails a tool call at once instead of after the 20 s RPC timeout", async () => {
    const { posted } = stubWindow(JSON.stringify({ projects: [], count: 0 }));
    const bridge = await import("./bridge");
    let delivered: unknown;
    bridge.init((data) => {
      delivered = data;
    });
    expect(delivered).toEqual({ projects: [], count: 0 });
    expect(bridge.hostCanCallTools()).toBe(false);
    const started = Date.now();
    await expect(bridge.callTool("request_blueprint_upload")).rejects.toBeInstanceOf(bridge.HostCannotCallTools);
    expect(Date.now() - started).toBeLessThan(100);
    expect(posted.filter((m) => (m as { method?: string }).method === "tools/call")).toHaveLength(0);
  });

  it("opens Kamai in a new tab without asking the host", async () => {
    const { opened, posted } = stubWindow(JSON.stringify({ url: "https://app.kamai.io" }));
    const bridge = await import("./bridge");
    bridge.init(() => undefined);
    await bridge.openLink("https://app.kamai.io");
    expect(opened).toEqual(["https://app.kamai.io"]);
    expect(posted.filter((m) => (m as { method?: string }).method === "ui/open-link")).toHaveLength(0);
  });

  it("tells Open WebUI its height in the message Open WebUI reads", async () => {
    const { posted } = stubWindow(JSON.stringify({ projects: [], count: 0 }));
    const bridge = await import("./bridge");
    bridge.init(() => undefined);
    posted.length = 0;
    (document.documentElement as { scrollHeight: number }).scrollHeight = 521;
    bridge.reportSize();
    expect(posted).toContainEqual({ type: "iframe:height", height: 521 });
  });
});
