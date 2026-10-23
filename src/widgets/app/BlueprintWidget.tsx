import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Eye, EyeOff, Maximize2, MousePointerClick, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";

import { callTool, hostCanCallTools, HostCannotCallTools, openLink, reportSize, requestDisplayMode, sendPrompt } from "./bridge";
import { downloadPrompt, rgba } from "./format";
import { ActionError, BrandHeader, Button, Card, LoadingState, OpenKamai, ProcessingState, blueprintUrl } from "./shared";
import { TakeoffPanel } from "./TakeoffPanel";
import type { BlueprintData, GeometryFeature, Highlight, TakeoffData } from "./types";
import { useWidgetData } from "./useWidgetData";
import { IDENTITY, MAX_ZOOM, clampView, panBy, quarterTurn, sideways, toGrid, turnMatrix, unturn, zoomAt, type View } from "./zoom";

const DEFAULT_GRID = 2000;

function trace(context: CanvasRenderingContext2D, path: number[], scale: number): void {
  for (let index = 0; index < path.length; index += 2) {
    const x = (path[index] ?? 0) * scale;
    const y = (path[index + 1] ?? 0) * scale;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
}

function drawFeature(
  context: CanvasRenderingContext2D,
  feature: GeometryFeature,
  scale: number,
  selected: boolean,
  accent: string,
  zoom = 1,
): void {
  const color = feature.color ?? { r: 120, g: 120, b: 120, a: 160 };
  const px = 1 / zoom;
  context.save();

  if (feature.rings?.length) {
    context.beginPath();
    for (const ring of feature.rings) {
      trace(context, ring, scale);
      context.closePath();
    }
    const baseAlpha = color.a == null ? 0.4 : color.a / 255;
    context.fillStyle = rgba(color, baseAlpha * (selected ? 1 : 0.75));
    context.fill("evenodd");
    context.lineWidth = (selected ? 2.5 : 1) * px;
    context.strokeStyle = selected ? accent : rgba(color, 0.95);
    context.stroke();
  }

  if (feature.lines?.length) {
    context.beginPath();
    for (const line of feature.lines) trace(context, line, scale);
    context.lineWidth = (selected ? 3.5 : 2) * px;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.strokeStyle = selected ? accent : rgba(color, 0.95);
    context.stroke();
  }

  if (feature.pts?.length) {
    context.fillStyle = rgba(color, 0.95);
    context.strokeStyle = selected ? accent : rgba(color, 0.95);
    context.lineWidth = (selected ? 2 : 1) * px;
    for (let index = 0; index < feature.pts.length; index += 2) {
      context.beginPath();
      context.arc(
        (feature.pts[index] ?? 0) * scale,
        (feature.pts[index + 1] ?? 0) * scale,
        (selected ? 5 : 3.5) * px,
        0,
        Math.PI * 2,
      );
      context.fill();
      if (selected) context.stroke();
    }
  }

  context.restore();
}

function inRings(feature: GeometryFeature, x: number, y: number): boolean {
  let inside = false;
  for (const polygon of feature.rings ?? []) {
    for (let index = 0, previous = polygon.length - 2; index < polygon.length; previous = index, index += 2) {
      const xi = polygon[index] ?? 0;
      const yi = polygon[index + 1] ?? 0;
      const xj = polygon[previous] ?? 0;
      const yj = polygon[previous + 1] ?? 0;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

export function ringsArea(feature: Pick<GeometryFeature, "rings">): number {
  let total = 0;
  for (const ring of feature.rings ?? []) {
    let twice = 0;
    for (let index = 0, previous = ring.length - 2; index < ring.length; previous = index, index += 2) {
      twice += (ring[previous] ?? 0) * (ring[index + 1] ?? 0) - (ring[index] ?? 0) * (ring[previous + 1] ?? 0);
    }
    total += Math.abs(twice) / 2;
  }
  return total;
}

function nearPath(feature: GeometryFeature, x: number, y: number, tolerance: number): boolean {
  for (const line of feature.lines ?? []) {
    for (let index = 0; index + 3 < line.length; index += 2) {
      const x1 = line[index] ?? 0;
      const y1 = line[index + 1] ?? 0;
      const x2 = line[index + 2] ?? 0;
      const y2 = line[index + 3] ?? 0;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = dx * dx + dy * dy;
      const amount = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0;
      if (Math.hypot(x - (x1 + amount * dx), y - (y1 + amount * dy)) <= tolerance) return true;
    }
  }
  for (let index = 0; feature.pts && index < feature.pts.length; index += 2) {
    if (Math.hypot(x - (feature.pts[index] ?? 0), y - (feature.pts[index + 1] ?? 0)) <= tolerance * 1.5) {
      return true;
    }
  }
  return false;
}

function drawHighlight(context: CanvasRenderingContext2D, highlight: Highlight, width: number, accent: string, zoom = 1): void {
  const scale = width / (highlight.grid || DEFAULT_GRID);
  const color = { r: 0, g: 0, b: 0, a: 255 };
  for (const outline of highlight.outlines) {
    context.save();
    if (outline.rings?.length) {
      context.beginPath();
      for (const ring of outline.rings) {
        trace(context, ring, scale);
        context.closePath();
      }
      context.globalAlpha = 0.3;
      context.fillStyle = accent;
      context.fill("evenodd");
      context.globalAlpha = 1;
      context.lineWidth = 2.5 / zoom;
      context.strokeStyle = accent;
      context.stroke();
    }
    context.restore();
    // Lines and points take the selected style drawFeature already has.
    if (outline.lines?.length || outline.pts?.length) {
      drawFeature(context, { ...outline, rings: null, color: outline.color ?? color }, scale, true, accent, zoom);
    }
  }
}

export type PlanExportResult = {
  url: string;
  file_name: string;
  expires_in: number;
  elements: number;
  unmatched_highlight?: string[];
  missing_ids?: string[];
};

function DownloadBar({
  data,
  picked,
  pickedClasses,
  onClear,
}: {
  data: BlueprintData;
  picked: Set<string>;
  pickedClasses: Set<string>;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlanExportResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(false);
  const ids = [...picked];
  const classes = [...pickedClasses];
  const count = ids.length + classes.length;

  const download = async () => {
    setError(null);
    setResult(null);
    setAsked(false);
    if (!hostCanCallTools()) {
      await sendPrompt(downloadPrompt(data.name || "the blueprint", ids, classes));
      setAsked(true);
      return;
    }
    setBusy(true);
    try {
      const out = await callTool<PlanExportResult>("download_plan", {
        blueprint_id: data.blueprint_id,
        project_id: data.project_id || undefined,
        ...(ids.length ? { element_ids: ids } : {}),
        ...(classes.length ? { highlight: classes } : {}),
      });
      setResult(out);
      void openLink(out.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("Could not make the PDF."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-base-content/70">
          {count
            ? `Selected: ${[classes.length ? classes.join(", ") : "", ids.length ? `${ids.length} element${ids.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ")}`
            : "Nothing selected: the PDF will show every element."}
        </span>
        <div className="ml-auto flex gap-2">
          {count > 0 && (
            <Button variant="ghost" size="xs" onClick={onClear}>
              Clear
            </Button>
          )}
          <Button size="xs" icon={Download} loading={busy} onClick={() => void download()}>
            Download PDF
          </Button>
        </div>
      </div>
      {asked && <p className="mt-2 text-xs text-base-content/60">Sent to the chat. Confirm it there and the assistant replies with the download link.</p>}
      {result && (
        <p className="mt-2 text-xs">
          <a className="link link-primary" href={result.url} target="_blank" rel="noreferrer" download={result.file_name}>
            {result.file_name}
          </a>{" "}
          <span className="text-base-content/55">
            {result.elements} elements · link valid {Math.round(result.expires_in / 60)} min
          </span>
        </p>
      )}
      <ActionError error={error} className="mt-2" />
    </Card>
  );
}

function BlueprintCanvas({ data, highlight }: { data: BlueprintData; highlight?: Highlight }) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ width: 0, height: 0, box: 0, scale: 1, zoom: IDENTITY });
  const [zoom, setZoom] = useState<View>(IDENTITY);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imagePending, setImagePending] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<GeometryFeature | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedClasses, setPickedClasses] = useState<Set<string>>(new Set());
  const features = data.features ?? [];
  const grid = data.grid ?? DEFAULT_GRID;
  const turn = quarterTurn(data.rotation);

  const groups = useMemo(() => {
    const values = new Map<string, { count: number; color: GeometryFeature["color"] }>();
    for (const feature of features) {
      const group = values.get(feature.cls) ?? { count: 0, color: feature.color };
      group.count += 1;
      values.set(feature.cls, group);
    }
    return [...values.entries()];
  }, [features]);

  // A different sheet, or the same one turned, starts unzoomed.
  useEffect(() => setZoom(IDENTITY), [data.image?.url, data.blueprint_id, turn]);

  useEffect(() => {
    if (!data.image?.url) {
      setImage(null);
      setImagePending(false);
      setImageFailed(false);
      return;
    }
    let cancelled = false;
    const next = new Image();
    setImage(null);
    setImagePending(true);
    setImageFailed(false);
    next.crossOrigin = "anonymous";
    next.onload = () => {
      if (cancelled) return;
      setImage(next);
      setImagePending(false);
    };
    next.onerror = () => {
      if (cancelled) return;
      setImage(null);
      setImagePending(false);
      setImageFailed(true);
    };
    next.src = data.image.url;
    return () => {
      cancelled = true;
    };
  }, [data.image?.url]);

  const draw = useCallback(() => {
    if (!container.current || !canvas.current) return;
    const context = canvas.current.getContext("2d");
    if (!context) return;
    const width = Math.max(280, container.current.clientWidth);
    const ratio = data.image?.h && data.image.w ? data.image.h / data.image.w : 0.66;
    // The turned page keeps its own proportions; only the canvas below it has a minimum height.
    const box = Math.round(width * (sideways(turn) ? 1 / ratio : ratio));
    const height = Math.max(180, box);
    // The page as stored; `rotation` turns it into the box for display only.
    const pageWidth = sideways(turn) ? box : width;
    const pageHeight = sideways(turn) ? width : box;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.current.width = Math.round(width * dpr);
    canvas.current.height = Math.round(height * dpr);
    canvas.current.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    // The pan was clamped against the box it was made in; after a resize, clamp it again.
    const shown = clampView(zoom, width, height);
    context.setTransform(dpr * shown.k, 0, 0, dpr * shown.k, dpr * shown.x, dpr * shown.y);
    context.transform(...turnMatrix(turn, width, box));
    context.imageSmoothingQuality = "high";
    if (image?.complete && image.naturalWidth) context.drawImage(image, 0, 0, pageWidth, pageHeight);
    const scale = pageWidth / grid;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim() || "#004fb5";
    // With a highlight, everything else is dimmed and the row's elements are drawn from
    // their own outlines, which cover elements past the page this plan loaded.
    if (highlight) context.globalAlpha = 0.25;
    for (const feature of features) {
      if (hidden.has(feature.cls)) continue;
      if (highlight && feature.id && highlight.ids.has(feature.id)) continue;
      const chosen = selecting
        ? (!!feature.id && picked.has(feature.id)) || pickedClasses.has(feature.cls)
        : selected?.i === feature.i;
      const dimmed = selecting && !chosen && (picked.size > 0 || pickedClasses.size > 0);
      context.globalAlpha = highlight ? 0.25 : dimmed ? 0.35 : 1;
      drawFeature(context, feature, scale, chosen, accent, shown.k);
    }
    context.globalAlpha = 1;
    if (highlight) drawHighlight(context, highlight, pageWidth, accent, shown.k);
    view.current = { width, height, box, scale, zoom: shown };
  }, [data.image?.h, data.image?.w, features, grid, hidden, highlight, image, selected?.i, selecting, picked, pickedClasses, turn, zoom]);

  useEffect(() => {
    draw();
    if (!container.current) return;
    const observer = new ResizeObserver(() => {
      draw();
      reportSize();
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [draw]);

  // Wheel and pinch zoom about the pointer; a drag pans once zoomed in. React's onWheel is
  // passive, so preventDefault (keeping the chat from scrolling) needs a native listener.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey && zoom.k === 1 && event.deltaY > 0) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
      setZoom((current) =>
        zoomAt(current, factor, event.clientX - bounds.left, event.clientY - bounds.top, view.current.width, view.current.height),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoom.k]);

  const zoomBy = (factor: number) =>
    setZoom((current) => zoomAt(current, factor, view.current.width / 2, view.current.height / 2, view.current.width, view.current.height));

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      drag.current = null;
      return;
    }
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const { width, height } = view.current;
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const bounds = event.currentTarget.getBoundingClientRect();
      const cx = (a!.x + b!.x) / 2 - bounds.left;
      const cy = (a!.y + b!.y) / 2 - bounds.top;
      const factor = distance / pinch.current;
      pinch.current = distance;
      setZoom((current) => zoomAt(current, factor, cx, cy, width, height));
      return;
    }
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    if (!current.moved) event.currentTarget.setPointerCapture(event.pointerId);
    current.moved = true;
    current.x = event.clientX;
    current.y = event.clientY;
    setZoom((value) => panBy(value, dx, dy, width, height));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    // The click that ends a pan is not a pick.
    if (drag.current?.moved) {
      drag.current = null;
      return;
    }
    drag.current = null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const shown = view.current.zoom;
    const box = toGrid(shown, event.clientX - bounds.left, event.clientY - bounds.top, 1);
    const page = unturn(turn, box.x, box.y, view.current.width, view.current.box);
    const x = page.x / view.current.scale;
    const y = page.y / view.current.scale;
    const tolerance = 6 / (view.current.scale * shown.k);
    // The smallest shape under the pointer wins: a footprint or a room drawn over a door
    // would otherwise swallow every click inside it.
    let hit: GeometryFeature | null = null;
    let hitSize = Infinity;
    for (let index = features.length - 1; index >= 0; index -= 1) {
      const feature = features[index]!;
      if (hidden.has(feature.cls)) continue;
      const size = nearPath(feature, x, y, tolerance) ? 0 : inRings(feature, x, y) ? ringsArea(feature) : Infinity;
      if (size < hitSize) {
        hit = feature;
        hitSize = size;
      }
    }
    setSelected(hit);
    if (selecting && hit?.id) {
      const id = hit.id;
      setPicked((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
  };

  const toggleGroup = (name: string) => {
    if (selecting) {
      setPickedClasses((current) => {
        const next = new Set(current);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
      return;
    }
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const units = data.units ?? { area: "m²", length: "m" };

  return (
    <>
      <Card className="canvas-stage plan-grid relative">
        <div ref={container} className="relative overflow-hidden bg-base-200">
          <canvas
            ref={canvas}
            onClick={onCanvasClick}
            onDoubleClick={() => setZoom(IDENTITY)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`touch-none ${zoom.k > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`}
          />
          {imagePending && <div className="skeleton absolute inset-0" />}
          <div className="absolute end-2 top-2 flex flex-col gap-1">
            <button type="button" aria-label="Zoom in" disabled={zoom.k >= MAX_ZOOM} onClick={() => zoomBy(1.6)} className="btn btn-xs btn-square border-base-300 bg-base-100/90">
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button type="button" aria-label="Zoom out" disabled={zoom.k <= 1} onClick={() => zoomBy(1 / 1.6)} className="btn btn-xs btn-square border-base-300 bg-base-100/90">
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            {zoom.k > 1 && (
              <button type="button" aria-label="Reset zoom" onClick={() => setZoom(IDENTITY)} className="btn btn-xs btn-square border-base-300 bg-base-100/90">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </Card>
      {imageFailed && <p className="mt-2 text-xs text-warning">Preview image is unavailable; showing takeoff geometry.</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => setSelecting((on) => !on)}
          aria-pressed={selecting}
          className={`badge h-auto gap-1.5 rounded-full border px-2.5 py-1 text-xs ${selecting ? "badge-primary border-primary" : "border-base-300 bg-base-100"}`}
        >
          <MousePointerClick className="h-3 w-3" />
          {selecting ? "Selecting" : "Select"}
        </button>
        {groups.map(([name, group]) => {
          const off = hidden.has(name);
          const chosen = selecting && pickedClasses.has(name);
          return (
            <button
              key={name}
              onClick={() => toggleGroup(name)}
              aria-pressed={selecting ? chosen : undefined}
              className={`badge h-auto gap-1.5 rounded-full border px-2.5 py-1 text-xs ${chosen ? "border-primary bg-primary/10" : "border-base-300"} ${off ? "opacity-40" : "bg-base-100"}`}
            >
              {selecting ? null : off ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: rgba(group.color, 0.85) }} />
              {name} <span className="opacity-50">{group.count}</span>
            </button>
          );
        })}
      </div>

      <Card className="mt-3 p-3 text-sm">
        {selected ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <strong>{selected.name}</strong>
            <span className="text-base-content/55">{selected.cls}</span>
            {!!selected.area && <span>{selected.area} {units.area}</span>}
            {!!selected.len && <span>{selected.len} {units.length}</span>}
          </div>
        ) : (
          <span className="text-base-content/55">
            {selecting ? "Click shapes or a class to add them to the PDF." : "Click a shape to inspect it."}
          </span>
        )}
      </Card>
      <DownloadBar
        data={data}
        picked={picked}
        pickedClasses={pickedClasses}
        onClear={() => {
          setPicked(new Set());
          setPickedClasses(new Set());
        }}
      />
    </>
  );
}

export function BlueprintPanel({
  initialData,
  onBack,
  highlight,
  banner,
}: {
  initialData: BlueprintData;
  onBack?: () => void;
  /** Elements to light up, everything else dimmed (a table row's elements). */
  highlight?: Highlight;
  /** Shown above the plan, e.g. which table row is highlighted. */
  banner?: React.ReactNode;
}) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<"plan" | "takeoff">("plan");
  const [takeoff, setTakeoff] = useState<TakeoffData | null>(null);
  const [takeoffLoading, setTakeoffLoading] = useState(false);
  const [takeoffError, setTakeoffError] = useState<unknown>(null);
  const [pollError, setPollError] = useState<unknown>(null);

  useEffect(() => setData(initialData), [initialData]);

  useEffect(() => {
    if (data.state !== "processing") return;
    let cancelled = false;
    let ticks = 0;
    const timer = window.setInterval(async () => {
      if (++ticks > 240) {
        window.clearInterval(timer);
        return;
      }
      try {
        const next = await callTool<BlueprintData>("view_blueprint", {
          blueprint_id: data.blueprint_id,
          project_id: data.project_id || undefined,
        });
        if (!cancelled) setData(next);
        if (next.state !== "processing") window.clearInterval(timer);
      } catch (reason) {
        // A transient failure is retried on the next tick; a host that cannot run tools never
        // will, and the panel would otherwise sit on the progress bar with no way out.
        if (reason instanceof HostCannotCallTools) {
          window.clearInterval(timer);
          if (!cancelled) setPollError(reason);
        }
      }
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [data.blueprint_id, data.project_id, data.state]);

  const showTakeoff = async () => {
    setTab("takeoff");
    setTakeoffError(null);
    if (takeoff) return;
    setTakeoffLoading(true);
    try {
      setTakeoff(await callTool<TakeoffData>("view_takeoff", {
        blueprint_id: data.blueprint_id,
        project_id: data.project_id || undefined,
      }));
    } catch (reason) {
      setTakeoffError(reason instanceof Error ? reason : new Error("Could not load takeoff quantities."));
    } finally {
      setTakeoffLoading(false);
    }
  };

  const subtitle = [
    data.project_name ? `in ${data.project_name}` : "",
    data.features ? `${data.truncated ? `${data.features.length} of ${data.total}` : data.features.length} shapes` : "",
    data.scale_label || "",
  ].filter(Boolean).join(" · ");

  if (data.state === "processing" || data.state === "failed") {
    return (
      <>
        <BrandHeader title={data.name || "Blueprint"} subtitle={data.project_name ? `in ${data.project_name}` : undefined} onBack={onBack} />
        <ProcessingState failed={data.state === "failed"} progress={data.progress} message={data.error_message} />
        <ActionError error={pollError} className="mt-3" />
      </>
    );
  }

  return (
    <>
      <BrandHeader
        title={data.name || "Blueprint"}
        subtitle={subtitle}
        onBack={onBack}
        actions={
          <>
            <div className="join">
              <button className={`btn btn-xs join-item ${tab === "plan" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("plan")}>Plan</button>
              <button className={`btn btn-xs join-item ${tab === "takeoff" ? "btn-primary" : "btn-ghost"}`} onClick={showTakeoff}>Takeoff</button>
            </div>
            <Button variant="ghost" size="xs" icon={Maximize2} onClick={() => requestDisplayMode("fullscreen")}>
              Expand
            </Button>
            <OpenKamai href={blueprintUrl(data.project_id, data.blueprint_id)} label="Open in Kamai" variant="ghost" size="xs" />
          </>
        }
      />

      {banner}
      {tab === "plan" ? (
        <>
          <BlueprintCanvas data={data} highlight={highlight} />
          {!data.image?.url && <p className="mt-2 text-xs text-base-content/50">No preview image is available; showing takeoff geometry.</p>}
        </>
      ) : takeoffLoading ? (
        <LoadingState label="Loading takeoff…" />
      ) : takeoffError ? (
        <ActionError error={takeoffError} />
      ) : takeoff ? (
        <TakeoffPanel data={takeoff} compact />
      ) : (
        <Card className="p-5 text-sm text-base-content/60">Takeoff quantities are unavailable.</Card>
      )}
    </>
  );
}

// A host that forwards only content[0].text hands us the model summary: counts, no outlines
// and no image. Drawing it would be an empty canvas captioned "showing takeoff geometry".
function BlueprintSummary({ data }: { data: BlueprintData }) {
  const subtitle = [data.project_name ? `in ${data.project_name}` : null, data.scale_label].filter(Boolean).join(" · ");
  const [pickedClasses, setPickedClasses] = useState<Set<string>>(new Set());
  const toggle = (cls: string) =>
    setPickedClasses((current) => {
      const next = new Set(current);
      if (next.has(cls)) next.delete(cls);
      else next.add(cls);
      return next;
    });
  return (
    <>
      <BrandHeader title={data.name || "Blueprint"} subtitle={subtitle || undefined} />
      <Card className="p-4">
        <p className="text-sm text-base-content/70">
          {data.truncated ? `First ${data.features_shown ?? 0} take-off elements` : `${data.features_shown ?? 0} take-off elements`}.
          {" "}This chat cannot draw the plan; open it in Kamai to see it.
        </p>
        {data.classes && data.classes.length > 0 && (
          <ul className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-x-4 gap-y-1 text-sm">
            {data.classes.map((row) => {
              const on = pickedClasses.has(row.cls);
              return (
                <li key={row.cls}>
                  <button
                    onClick={() => toggle(row.cls)}
                    aria-pressed={on}
                    className={`flex w-full justify-between gap-3 rounded px-1.5 py-0.5 text-left ${on ? "bg-primary/10 font-medium text-primary" : "hover:bg-base-200"}`}
                  >
                    <span className="truncate">{on ? "✓ " : ""}{row.cls}</span>
                    <span className="tabular-nums text-base-content/60">{row.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4">
          <OpenKamai href={blueprintUrl(data.project_id, data.blueprint_id)} label="Open in Kamai" />
        </div>
      </Card>
      {data.classes && data.classes.length > 0 && (
        <DownloadBar data={data} picked={new Set()} pickedClasses={pickedClasses} onClear={() => setPickedClasses(new Set())} />
      )}
    </>
  );
}

export function BlueprintWidget() {
  const data = useWidgetData<BlueprintData>();
  if (!data) return <LoadingState label="Loading blueprint…" />;
  if (!data.features && data.classes) return <BlueprintSummary data={data} />;
  return <BlueprintPanel initialData={data} />;
}
