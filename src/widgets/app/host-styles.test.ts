import { afterEach, describe, expect, it, vi } from "vitest";

type Listener = (event: { source: unknown; data: unknown }) => void;

function stubWindow() {
  const listeners: Listener[] = [];
  const parent = { postMessage: () => undefined };
  const rootStyle = new Map<string, string>();
  const attributes = new Map<string, string>();
  const head: { id: string; textContent: string }[] = [];
  vi.stubGlobal("window", {
    parent,
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") listeners.push(listener);
    },
    setTimeout: () => 0,
  });
  vi.stubGlobal("document", {
    documentElement: {
      scrollHeight: 100,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      style: {
        setProperty: (name: string, value: string) => rootStyle.set(name, value),
        removeProperty: (name: string) => rootStyle.delete(name),
      },
    },
    body: { scrollHeight: 100, style: {} },
    head: { appendChild: (tag: { id: string; textContent: string }) => head.push(tag) },
    getElementById: (id: string) => head.find((tag) => tag.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "" }),
  });
  const push = (params: unknown) => {
    for (const listener of listeners) {
      listener({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params } });
    }
  };
  return { push, rootStyle, attributes, head };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("host styles", () => {
  it("puts styles.variables on the root element, where styles.css reads them", async () => {
    const { push, rootStyle, attributes } = stubWindow();
    await import("./bridge");
    push({
      theme: "dark",
      styles: { variables: { "--color-background-primary": "#212121", "--font-sans": "Söhne, sans-serif" } },
    });
    expect(attributes.get("data-theme")).toBe("dark");
    expect(rootStyle.get("--color-background-primary")).toBe("#212121");
    expect(rootStyle.get("--font-sans")).toBe("Söhne, sans-serif");
  });

  it("drops a variable the host stops sending a value for, so our fallback returns", async () => {
    const { push, rootStyle } = stubWindow();
    await import("./bridge");
    push({ styles: { variables: { "--color-background-primary": "#212121" } } });
    push({ styles: { variables: { "--color-background-primary": undefined } } });
    expect(rootStyle.has("--color-background-primary")).toBe(false);
  });

  it("ignores keys that are not custom properties", async () => {
    const { push, rootStyle } = stubWindow();
    await import("./bridge");
    push({ styles: { variables: { background: "red" } } });
    expect(rootStyle.size).toBe(0);
  });

  it("loads the host's font faces once", async () => {
    const { push, head } = stubWindow();
    await import("./bridge");
    const fonts = "@font-face { font-family: Söhne; src: url(https://example.com/s.woff2); }";
    push({ styles: { css: { fonts } } });
    push({ styles: { css: { fonts } } });
    expect(head).toHaveLength(1);
    expect(head[0]?.textContent).toBe(fonts);
  });
});
