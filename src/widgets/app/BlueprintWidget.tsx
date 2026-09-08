import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Maximize2 } from "lucide-react";

import { callTool, reportSize, requestDisplayMode } from "./bridge";
import { rgba } from "./format";
import { BrandHeader, Button, Card, LoadingState, ProcessingState } from "./shared";
import { TakeoffPanel } from "./TakeoffPanel";
import type { BlueprintData, GeometryFeature, TakeoffData } from "./types";
import { useWidgetData } from "./useWidgetData";

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
): void {
  const color = feature.color ?? { r: 120, g: 120, b: 120, a: 160 };
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
    context.lineWidth = selected ? 2.5 : 1;
    context.strokeStyle = selected ? accent : rgba(color, 0.95);
    context.stroke();
  }

  if (feature.lines?.length) {
    context.beginPath();
    for (const line of feature.lines) trace(context, line, scale);
    context.lineWidth = selected ? 3.5 : 2;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.strokeStyle = selected ? accent : rgba(color, 0.95);
    context.stroke();
  }

  if (feature.pts?.length) {
    context.fillStyle = rgba(color, 0.95);
    context.strokeStyle = selected ? accent : rgba(color, 0.95);
    context.lineWidth = selected ? 2 : 1;
    for (let index = 0; index < feature.pts.length; index += 2) {
      context.beginPath();
      context.arc(
        (feature.pts[index] ?? 0) * scale,
        (feature.pts[index + 1] ?? 0) * scale,
        selected ? 5 : 3.5,
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

function BlueprintCanvas({ data }: { data: BlueprintData }) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ width: 0, height: 0, scale: 1 });
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imagePending, setImagePending] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<GeometryFeature | null>(null);
  const features = data.features ?? [];
  const grid = data.grid ?? DEFAULT_GRID;

  const groups = useMemo(() => {
    const values = new Map<string, { count: number; color: GeometryFeature["color"] }>();
    for (const feature of features) {
      const group = values.get(feature.cls) ?? { count: 0, color: feature.color };
      group.count += 1;
      values.set(feature.cls, group);
    }
    return [...values.entries()];
  }, [features]);

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
    const height = Math.max(180, Math.round(width * ratio));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.current.width = Math.round(width * dpr);
    canvas.current.height = Math.round(height * dpr);
    canvas.current.style.height = `${height}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (image?.complete && image.naturalWidth) context.drawImage(image, 0, 0, width, height);
    const scale = width / grid;
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim() || "#004fb5";
    for (const feature of features) {
      if (!hidden.has(feature.cls)) drawFeature(context, feature, scale, selected?.i === feature.i, accent);
    }
    view.current = { width, height, scale };
  }, [data.image?.h, data.image?.w, features, grid, hidden, image, selected?.i]);

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

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / view.current.scale;
    const y = (event.clientY - bounds.top) / view.current.scale;
    const tolerance = 6 / view.current.scale;
    let hit: GeometryFeature | null = null;
    for (let index = features.length - 1; index >= 0; index -= 1) {
      const feature = features[index]!;
      if (hidden.has(feature.cls)) continue;
      if (inRings(feature, x, y) || nearPath(feature, x, y, tolerance)) {
        hit = feature;
        break;
      }
    }
    setSelected(hit);
  };

  const toggleGroup = (name: string) => {
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
          <canvas ref={canvas} onClick={onCanvasClick} className="cursor-crosshair" />
          {imagePending && <div className="skeleton absolute inset-0" />}
        </div>
      </Card>
      {imageFailed && <p className="mt-2 text-xs text-warning">Preview image is unavailable; showing takeoff geometry.</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {groups.map(([name, group]) => {
          const off = hidden.has(name);
          return (
            <button
              key={name}
              onClick={() => toggleGroup(name)}
              className={`badge h-auto gap-1.5 rounded-full border border-base-300 px-2.5 py-1 text-xs ${off ? "opacity-40" : "bg-base-100"}`}
            >
              {off ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
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
          <span className="text-base-content/55">Click a shape to inspect it.</span>
        )}
      </Card>
    </>
  );
}

export function BlueprintPanel({ initialData, onBack }: { initialData: BlueprintData; onBack?: () => void }) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<"plan" | "takeoff">("plan");
  const [takeoff, setTakeoff] = useState<TakeoffData | null>(null);
  const [takeoffLoading, setTakeoffLoading] = useState(false);
  const [takeoffError, setTakeoffError] = useState<string | null>(null);

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
      } catch {
        undefined;
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
      setTakeoffError(reason instanceof Error ? reason.message : "Could not load takeoff quantities.");
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
          </>
        }
      />

      {tab === "plan" ? (
        <>
          <BlueprintCanvas data={data} />
          {!data.image?.url && <p className="mt-2 text-xs text-base-content/50">No preview image is available; showing takeoff geometry.</p>}
        </>
      ) : takeoffLoading ? (
        <LoadingState label="Loading takeoff…" />
      ) : takeoffError ? (
        <div className="alert alert-error py-2 text-sm">{takeoffError}</div>
      ) : takeoff ? (
        <TakeoffPanel data={takeoff} compact />
      ) : (
        <Card className="p-5 text-sm text-base-content/60">Takeoff quantities are unavailable.</Card>
      )}
    </>
  );
}

export function BlueprintWidget() {
  const data = useWidgetData<BlueprintData>();
  if (!data) return <LoadingState label="Loading blueprint…" />;
  return <BlueprintPanel initialData={data} />;
}
