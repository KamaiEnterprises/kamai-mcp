import { useEffect, useRef, useState } from "react";
import { ExternalLink, Maximize2 } from "lucide-react";

import {
  callTool,
  getBottomInset,
  openLink,
  relayDisplayModeRequests,
  reportSize,
  requestDisplayMode,
  setSizeReporting,
} from "./bridge";
import { ProjectsWidget } from "./ProjectsWidget";
import { Button, Card, LoadingState } from "./shared";
import { useDisplayMode } from "./useDisplayMode";
import { useWidgetData } from "./useWidgetData";

interface KamaiAppData {
  url: string;
  /** Mode to open in without waiting for a click. The host may grant another. */
  open_in?: string | null;
  /** Hosts that render their own expand control can turn ours off. */
  expand_button?: boolean;
}

const FALLBACK_URL = "https://app.kamai.io";

// Only consulted when the host raises no CSP violation report. Generous on purpose:
// the app boots React and a WebGPU pipeline at iframe depth three, and calling a slow
// load a refusal is far worse than showing the real app a few seconds late.
const GRACE_MS = 15000;

// A blocked frame and a frame that has not finished loading both read about:blank, so
// this alone cannot decide anything — a cross-origin document THROWS on access, which
// is the success case, and that is the part worth trusting.
function isCrossOrigin(frame: HTMLIFrameElement | null): boolean {
  if (!frame) return false;
  try {
    return frame.contentWindow?.location?.href !== "about:blank";
  } catch {
    return true;
  }
}

function ExpandButton({ mode }: { mode: string }) {
  // Collapsing is the host's job — it renders its own close control — so offering one
  // of ours would be a second, worse X.
  if (mode === "fullscreen") return null;
  return (
    <Button
      size="xs"
      icon={Maximize2}
      className="shadow-lg"
      onClick={() => void requestDisplayMode("fullscreen")}
    >
      Expand
    </Button>
  );
}

export function KamaiAppWidget() {
  const data = useWidgetData<KamaiAppData>();
  const mode = useDisplayMode();
  const frame = useRef<HTMLIFrameElement>(null);
  const url = data?.url ?? FALLBACK_URL;

  // Layout is keyed on the box we were actually given, not the mode we believe we are
  // in: exiting fullscreen via the host's own control does not reliably notify us, and
  // a stale mode leaves a 100vh layout inside a collapsed card.
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
    };
  }, []);

  const filling = mode === "fullscreen" && viewportH >= 400;

  // While filling a host-owned box, reporting a height feeds a loop: our layout sizes
  // from the viewport and the viewport sizes from what we report.
  useEffect(() => {
    setSizeReporting(!filling);
    if (!filling) reportSize();
  }, [filling, mode, viewportH]);

  // Let the app drive the panel size from its own toolbar.
  useEffect(() => {
    try {
      return relayDisplayModeRequests(new URL(url).origin);
    } catch {
      return undefined;
    }
  }, [url]);

  const openIn = data?.open_in ?? null;
  const asked = useRef(false);
  useEffect(() => {
    if (!openIn || asked.current) return;
    if (openIn !== "inline" && openIn !== "fullscreen" && openIn !== "pip") return;
    asked.current = true;
    void requestDisplayMode(openIn);
  }, [openIn]);

  // Hosts that refuse frame-src leave about:blank behind and fire no error, so without
  // this the panel is silently empty anywhere nested frames are not allowed.
  const [blocked, setBlocked] = useState(false);
  // Truthiness, matching the render gate below: a host can deliver a tool result
  // without structuredContent, which lands here as undefined — data !== null let
  // that arm the refusal timer while the render branch still showed the loader
  // with no iframe mounted at all.
  const hasData = Boolean(data);
  useEffect(() => {
    // No iframe exists until data arrives (the early return below), and in production
    // the delivered url equals FALLBACK_URL, so keying on url alone let the grace
    // clock burn down against a frame that was not even mounted yet.
    if (!hasData) return;
    // A block belongs to the url that suffered it. A follow-up tool result can point
    // at a different, framable origin — or the earlier block was the grace timer
    // misreading a slow boot — so a new url starts from a clean slate.
    setBlocked(false);
    setFallbackFailed(false);
    let settled = false;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (settled || !event.violatedDirective?.startsWith("frame-src")) return;
      settled = true;
      setBlocked(true);
    };
    document.addEventListener("securitypolicyviolation", onViolation);

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (settled) return;
      // A loaded frame can never become a refusal; stop watching, or a slow app gets
      // misread as blocked.
      if (isCrossOrigin(frame.current)) {
        settled = true;
        return;
      }
      if (Date.now() - startedAt >= GRACE_MS) {
        settled = true;
        setBlocked(true);
      }
    }, 1000);

    return () => {
      document.removeEventListener("securitypolicyviolation", onViolation);
      window.clearInterval(timer);
    };
  }, [url, hasData]);

  // Recover the native experience rather than leaving a dead end. The model cannot know
  // which hosts frame us, so the panel works it out for itself.
  const [fallbackData, setFallbackData] = useState<unknown>(null);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  useEffect(() => {
    if (!blocked || fallbackData || fallbackFailed) return;
    let cancelled = false;
    void callTool<unknown>("view_projects")
      .then((result) => !cancelled && setFallbackData(result))
      .catch(() => !cancelled && setFallbackFailed(true));
    return () => {
      cancelled = true;
    };
  }, [blocked, fallbackData, fallbackFailed]);

  if (!data) return <LoadingState label="Loading Kamai…" />;

  if (blocked) {
    if (fallbackData) {
      return (
        <>
          <ProjectsWidget data={fallbackData as never} />
          <div className="mt-3 flex justify-center">
            <Button variant="ghost" size="xs" icon={ExternalLink} onClick={() => void openLink(url)}>
              Open in Kamai
            </Button>
          </div>
        </>
      );
    }
    if (!fallbackFailed) return <LoadingState label="Loading Kamai…" />;
    return (
      <Card className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm text-base-content/70">This app does not allow Kamai to be embedded.</p>
        <Button icon={ExternalLink} onClick={() => void openLink(url)}>
          Open Kamai
        </Button>
      </Card>
    );
  }

  // Inline needs a definite height: the host sizes our frame from the height we report,
  // so filling "the viewport" would only mean staying as tall as we already are.
  return (
    <div
      className={`relative ${filling ? "fill-host" : ""}`}
      style={filling ? { paddingBottom: getBottomInset() } : undefined}
    >
      {mode !== "fullscreen" && data.expand_button !== false && (
        <div className="absolute bottom-3 start-3 z-10">
          <ExpandButton mode={mode} />
        </div>
      )}
      <iframe
        ref={frame}
        src={url}
        title="Kamai"
        className={`w-full border-0 bg-base-100 ${filling ? "fill-grow" : "h-[520px] rounded-lg"}`}
        allow="clipboard-write; fullscreen"
      />
    </div>
  );
}
