import type { BlueprintSummary, JobSummary, ProjectDetail, Rgba, TakeoffData } from "./types";

export const TERMINAL_BAD = ["FAILED", "CANCELLED", "ABANDONED"] as const;

export function asArray<T extends { id?: string }>(value: T[] | Record<string, T> | null | undefined): T[] {
  return Array.isArray(value) ? value : Object.values(value ?? {});
}

export function blueprintName(blueprint: BlueprintSummary): string {
  return blueprint.name || blueprint.id;
}

export function projectBlueprints(project: ProjectDetail): BlueprintSummary[] {
  return asArray(project.blueprints ?? project.blueprint_records);
}

export function projectJobs(project: ProjectDetail): JobSummary[] {
  return asArray(project.jobs);
}

export function isBlueprintReady(blueprint: BlueprintSummary, jobs: JobSummary[] = []): boolean {
  if (typeof blueprint.ready === "boolean") return blueprint.ready;
  const ready = blueprint.ready;
  if (!ready || !(ready.geojson && (ready.all_tiles || ready.main_tile))) return false;
  return !jobs.some(
    (job) => job.blueprint_id === blueprint.id && job.status.toUpperCase() !== "SUCCEEDED",
  );
}

export function rgba(color: Rgba = {}, alpha?: number): string {
  const r = Math.max(0, Math.min(255, Number(color.r) || 0));
  const g = Math.max(0, Math.min(255, Number(color.g) || 0));
  const b = Math.max(0, Math.min(255, Number(color.b) || 0));
  const a = alpha ?? (color.a == null ? 1 : Math.max(0, Math.min(255, Number(color.a))) / 255);
  return `rgba(${r},${g},${b},${a})`;
}

export function formatNumber(value: number | null | undefined): string {
  if (!value) return "—";
  return Math.abs(value) >= 100
    ? Math.round(value).toLocaleString()
    : value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function scaleWarning(data: TakeoffData): string {
  if (data.needs_scale) {
    return "This blueprint has no usable scale. Counts are accurate; set the scale in Kamai for areas and lengths.";
  }
  if (data.scale_unconfirmed) {
    const label = data.scale_label ? ` (${data.scale_label})` : "";
    return `The scale${label} is not confirmed, so areas and lengths may change.`;
  }
  if (!(data.totals?.area || data.totals?.len)) {
    return "No areas or lengths could be measured for these shapes. Counts are still available.";
  }
  return "";
}

export function relativeTime(timestamp?: number | null): string {
  if (!timestamp) return "";
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  const days = Math.floor(seconds / 86400);
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString();
}
