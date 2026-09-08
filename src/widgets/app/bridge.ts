type JsonRecord = Record<string, unknown>;
type Renderer = (data: unknown) => void;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: JsonRecord;
  result?: unknown;
  error?: { message?: string };
}

interface OpenAiBridge {
  toolOutput?: unknown;
  toolResponse?: unknown;
  callTool?: (name: string, args: JsonRecord) => Promise<unknown>;
  sendFollowUpMessage?: (value: { prompt: string }) => Promise<unknown>;
  setWidgetState?: (value: JsonRecord) => void;
  requestDisplayMode?: (value: { mode: string }) => Promise<unknown>;
  openExternal?: (value: { href: string }) => Promise<unknown>;
}

declare global {
  interface Window {
    openai?: OpenAiBridge;
    __KAMAI_BOOTSTRAP__?: unknown;
  }
}

const PROTOCOL_VERSION = "2026-01-26";

export type DisplayMode = "inline" | "fullscreen" | "pip";

// The spec closes this set at three. There is no split/side-panel/docked mode to ask
// for on any host, so "render beside the conversation" is not expressible — fullscreen
// is the largest surface a third-party app can occupy.
const ALL_DISPLAY_MODES: DisplayMode[] = ["inline", "fullscreen", "pip"];

// hostCapabilities.sandbox.csp is documented as "CSP domains approved by the host",
// which is the only way to tell a policy refusal from a frame that failed to load.
let initializeResult: JsonRecord | null = null;
// Merged, not replaced: host-context-changed carries PARTIAL updates and the spec says
// the view SHOULD merge received fields.
let hostContext: JsonRecord = {};
let displayMode: DisplayMode = "inline";
const modeListeners = new Set<(mode: DisplayMode) => void>();

function setDisplayMode(next: unknown): void {
  if (next !== "inline" && next !== "fullscreen" && next !== "pip") return;
  if (next === displayMode) return;
  displayMode = next;
  // Exposed on the root element so CSS can react without every component threading
  // the mode through props — fullscreen needs the document itself to stop growing
  // and start filling.
  document.documentElement.setAttribute("data-display-mode", displayMode);
  for (const listener of modeListeners) listener(displayMode);
}

let nextId = 1;
// A set, not a slot: the frame-refusal fallback nests ProjectsWidget inside
// KamaiAppWidget, and both call useWidgetData. With a single slot the inner mount
// silently stole every later delivery from the outer widget.
const renderers = new Set<Renderer>();
let latest: unknown;
let hasDelivered = false;
let started = false;
let ready = false;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function post(message: RpcMessage): void {
  window.parent.postMessage(message, "*");
}

function rpc(method: string, params: JsonRecord = {}): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ jsonrpc: "2.0", id, method, params });
    window.setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`timeout: ${method}`));
    }, 20000);
  });
}

function notify(method: string, params: JsonRecord = {}): void {
  post({ jsonrpc: "2.0", method, params });
}

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as JsonRecord;
  return Object.keys(record).length === 1 && "result" in record ? record.result : value;
}

function applyTheme(context: unknown): void {
  if (!context || typeof context !== "object") return;
  const hostContext = context as JsonRecord;
  const styles = (hostContext.styles && typeof hostContext.styles === "object"
    ? hostContext.styles
    : {}) as JsonRecord;
  const theme = hostContext.theme ?? styles.colorScheme ?? styles["color-scheme"];
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  }
  const font = styles.fontFamily ?? styles["font-family"];
  if (typeof font === "string" && font) document.body.style.fontFamily = font;
}

function deliver(structuredContent: unknown): void {
  latest = unwrap(structuredContent);
  hasDelivered = true;
  for (const render of renderers) render(latest);
  reportSize();
}

window.addEventListener("message", (event: MessageEvent<RpcMessage>) => {
  // Only the host speaks this protocol. Once a widget nests a third-party frame, that
  // frame can post too — and this handler resolves pending RPCs by a counter id and
  // pipes tool-result straight into the renderer, so an unchecked message can rewrite
  // the widget's data or forge a reply to an in-flight request.
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || typeof message !== "object") return;

  if (message.id && pending.has(message.id)) {
    const request = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "rpc error"));
    else request.resolve(message.result);
    return;
  }

  if (message.method === "ui/notifications/tool-result") {
    deliver(message.params?.structuredContent);
  }
  // params IS the partial host context — McpUiHostContextChangedNotification declares
  // `params: McpUiHostContext`, with no wrapper object. Reading params.hostContext
  // silently discarded every host push, including every display-mode change.
  if (message.method === "ui/notifications/host-context-changed") {
    const patch = message.params ?? {};
    hostContext = { ...hostContext, ...patch };
    applyTheme(hostContext);
    setDisplayMode(hostContext.displayMode);
  }
});

// When the widget fills a host-owned box, reporting a height is not just useless, it
// is actively harmful: the layout is sized from the viewport, the viewport is sized
// from what we report, and the two chase each other until a tall empty slab is left
// under the content. In that state the host owns the box and we say nothing.
let sizeReporting = true;

export function setSizeReporting(enabled: boolean): void {
  sizeReporting = enabled;
}

export function reportSize(): void {
  if (!sizeReporting) return;
  const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 1);
  notify("ui/notifications/size-changed", { width: 0, height });
}

export function init(render: Renderer): () => void {
  renderers.add(render);
  // A consumer mounting after the payload arrived still gets it — without re-notifying
  // everyone else, which would re-render them for nothing.
  if (hasDelivered) render(latest);
  else if (window.__KAMAI_BOOTSTRAP__ !== undefined) deliver(window.__KAMAI_BOOTSTRAP__);
  const unsubscribe = () => {
    renderers.delete(render);
  };
  if (started) return unsubscribe;
  started = true;

  // ChatGPT pushes state by mutating window.openai and firing this event rather than
  // sending ui/notifications/host-context-changed. Display mode arrives the same way,
  // so it has to be read here or the layout never reacts on ChatGPT.
  window.addEventListener("openai:set_globals", () => {
    setDisplayMode((window.openai as unknown as JsonRecord | undefined)?.displayMode);
    const openaiResult = window.openai?.toolOutput ?? window.openai?.toolResponse;
    if (openaiResult && typeof openaiResult === "object") {
      const record = openaiResult as JsonRecord;
      deliver(record.structuredContent ?? record);
    }
  });
  // The globals event only fires on changes. A widget loaded straight into
  // fullscreen or pip gets no event, so read what the host already wrote.
  setDisplayMode((window.openai as unknown as JsonRecord | undefined)?.displayMode);

  if (window.parent === window && !window.openai) {
    ready = true;
    reportSize();
    return unsubscribe;
  }

  void (async () => {
    try {
      const result = (await rpc("ui/initialize", {
        protocolVersion: PROTOCOL_VERSION,
        appInfo: { name: "kamai-widgets", version: "2.0.0" },
        // Binding, not advisory: the host MUST NOT switch to a mode absent from this
        // list. Declaring only inline+fullscreen actively forbade pip, the one
        // co-visible mode there is.
        appCapabilities: { availableDisplayModes: ALL_DISPLAY_MODES },
      })) as JsonRecord | undefined;
      initializeResult = result ?? null;
      ready = true;
      notify("ui/notifications/initialized");
      const initialContext = (result?.hostContext as JsonRecord | undefined) ?? {};
      hostContext = { ...hostContext, ...initialContext };
      applyTheme(hostContext);
      setDisplayMode(hostContext.displayMode);
      const toolResult = result?.toolResult as JsonRecord | undefined;
      if (toolResult) deliver(toolResult.structuredContent);
    } catch (error) {
      console.warn("[kamai-widget] ui/initialize failed", error);
    }

    const openaiResult = window.openai?.toolOutput ?? window.openai?.toolResponse;
    if (openaiResult && typeof openaiResult === "object") {
      const record = openaiResult as JsonRecord;
      deliver(record.structuredContent ?? record);
    }
  })();

  if (window.ResizeObserver) {
    new ResizeObserver(reportSize).observe(document.documentElement);
  }
  reportSize();
  return unsubscribe;
}

function toolPayload(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as JsonRecord;
  if (record.structuredContent) return unwrap(record.structuredContent);
  const block = Array.isArray(record.content) ? record.content[0] : null;
  if (block && typeof block === "object" && typeof (block as JsonRecord).text === "string") {
    try {
      return unwrap(JSON.parse((block as JsonRecord).text as string));
    } catch {
      return result;
    }
  }
  return unwrap(result);
}

export async function callTool<T>(name: string, args: JsonRecord = {}): Promise<T> {
  if (window.openai?.callTool) return toolPayload(await window.openai.callTool(name, args)) as T;
  return toolPayload(await rpc("tools/call", { name, arguments: args })) as T;
}

export function updateModelContext(text: string): Promise<unknown> {
  try {
    window.openai?.setWidgetState?.({ note: text });
  } catch {
    undefined;
  }
  return rpc("ui/update-model-context", { content: [{ type: "text", text }] }).catch(() => undefined);
}

// The host MAY grant a mode other than the one asked for — the spec says the result
// "may differ from the requested mode if not supported", and ChatGPT is reported to
// coerce pip to fullscreen on web. So the answer is authoritative and the request is
// only a suggestion; discarding the result left the widget unable to lay itself out.
export async function requestDisplayMode(mode: DisplayMode): Promise<DisplayMode> {
  try {
    const result = window.openai?.requestDisplayMode
      ? await window.openai.requestDisplayMode({ mode })
      : await rpc("ui/request-display-mode", { mode });
    // Only a mode the host actually names is a grant. Falling back to what we asked
    // for records a refusal as a success and leaves the layout keyed on a mode we are
    // not in.
    setDisplayMode((result as JsonRecord | undefined)?.mode);
  } catch {
    // A refusal is not an error state: we simply stay in whatever mode we were in.
  }
  return displayMode;
}

export function getDisplayMode(): DisplayMode {
  return displayMode;
}

// The embedded app cannot reach the host itself: ui/* travels to window.parent, and
// from inside app.kamai.io that is THIS widget, not ChatGPT. So Kamai posts its intent
// up one level and we make the call on its behalf. That lets the expand/pip control
// live in Kamai's own toolbar instead of as a foreign button floating over it.
//
// Contract, to implement on the Kamai side:
//   window.parent.postMessage(
//     { scope: "Kamai.IframeBridge", type: "requestDisplayMode", mode: "fullscreen" },
//     "*",
//   );
//
// Origin is checked here.
export function relayDisplayModeRequests(allowedOrigin: string): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== allowedOrigin) return;
    const data = event.data as JsonRecord | null;
    if (!data || typeof data !== "object") return;
    if (data.scope !== "Kamai.IframeBridge" || data.type !== "requestDisplayMode") return;
    const mode = data.mode;
    if (mode !== "inline" && mode !== "fullscreen" && mode !== "pip") return;
    void requestDisplayMode(mode);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

// Some hosts float the composer over the bottom of our surface without shrinking our
// box, so content at the bottom edge becomes unclickable. Others give us a column with
// the composer beside us, overlapping nothing. Those are indistinguishable from in
// here, and guessing is visible either way: too little inset hides a control, too much
// leaves a dead band under the app. So inset only on a safe area the host actually
// reports, and otherwise use every pixel we were given. A hardcoded fallback was wrong
// in precisely the case that matters — the split layout, where nothing overlaps us.


export function getBottomInset(): number {
  if (displayMode !== "fullscreen") return 0;
  const openai = window.openai as unknown as JsonRecord | undefined;
  const safeArea = (openai?.safeArea ?? hostContext.safeAreaInsets) as JsonRecord | undefined;
  const insets = (safeArea?.insets ?? safeArea) as JsonRecord | undefined;
  const bottom = insets?.bottom;
  return typeof bottom === "number" && bottom > 0 ? bottom : 0;
}

export function onDisplayModeChange(listener: (mode: DisplayMode) => void): () => void {
  modeListeners.add(listener);
  return () => modeListeners.delete(listener);
}

export function isReady(): boolean {
  return ready;
}

// The escape hatch for every host that will not frame us. Claude always shows a
// confirmation modal for custom connectors before following one, which is fine — this
// is a deliberate "take me to the app" action, not something we do on our own.
export function openLink(href: string): Promise<unknown> {
  if (window.openai?.openExternal) return window.openai.openExternal({ href });
  return rpc("ui/open-link", { url: href }).catch(() => window.open(href, "_blank"));
}

