import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  FileText,
  FolderOpen,
  LoaderCircle,
  X,
  type LucideIcon,
} from "lucide-react";

import { TERMINAL_BAD } from "./format";
import type { JobSummary } from "./types";

declare const __KAMAI_LOGO__: string;

export function BrandHeader({
  title,
  subtitle,
  actions,
  onBack,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {onBack && (
          <button className="btn btn-ghost btn-sm btn-circle" onClick={onBack} aria-label="Back">
            <span aria-hidden>←</span>
          </button>
        )}
        <div className="flex shrink-0 items-center rounded-full bg-[#001a47] px-3 py-1.5 shadow-lg">
          <img src={__KAMAI_LOGO__} alt="Kamai" className="h-[18px] w-auto" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-medium leading-tight text-base-content">{title}</h1>
          {subtitle && <p className="truncate text-xs text-base-content/55">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

const buttonVariants = {
  primary: "btn-primary",
  outline: "btn-outline btn-primary",
  ghost: "btn-ghost",
  error: "btn-error",
} as const;

export function Button({
  variant = "primary",
  size = "sm",
  loading,
  icon: Icon,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: "xs" | "sm" | "md";
  loading?: boolean;
  icon?: LucideIcon;
}) {
  const sizeClass = size === "xs" ? "btn-xs" : size === "sm" ? "btn-sm" : "";
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`btn ${buttonVariants[variant]} ${sizeClass} gap-1.5 rounded-full ${className}`}
    >
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`kamai-card overflow-hidden ${className}`}>{children}</section>;
}

export function StatusBadge({ job, ready }: { job?: JobSummary; ready?: boolean }) {
  const status = job?.status.toUpperCase();
  if (status === "SUCCEEDED" || ready) {
    return (
      <span className="badge badge-success badge-sm gap-1 font-semibold">
        <Check className="h-3 w-3" /> Ready
      </span>
    );
  }
  if (status && TERMINAL_BAD.includes(status as (typeof TERMINAL_BAD)[number])) {
    return (
      <span className="badge badge-error badge-sm gap-1 font-semibold">
        <X className="h-3 w-3" /> Failed
      </span>
    );
  }
  return (
    <span className="badge badge-primary badge-outline badge-sm gap-1 font-semibold">
      <LoaderCircle className="h-3 w-3 animate-spin" /> Processing{job?.progress ? ` ${job.progress}%` : ""}
    </span>
  );
}

export function EmptyState({
  icon: Icon = FolderOpen,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="px-5 py-10 text-center">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Icon className="h-6 w-6 text-primary" />
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-base-content/55">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}

export function LoadingState({ label = "Loading from Kamai…" }: { label?: string }) {
  return (
    <Card className="flex min-h-40 items-center justify-center gap-3 p-6 text-sm text-base-content/60">
      <LoaderCircle className="h-5 w-5 animate-spin text-primary" />
      {label}
    </Card>
  );
}

export function ProcessingState({
  failed,
  progress,
  message,
}: {
  failed?: boolean;
  progress?: number;
  message?: string | null;
}) {
  return (
    <Card className="flex min-h-44 flex-col items-center justify-center p-8 text-center">
      <div className={`mb-3 flex h-12 w-12 items-center justify-center rounded-full ${failed ? "bg-error/10" : "bg-primary/10"}`}>
        {failed ? (
          <AlertTriangle className="h-6 w-6 text-error" />
        ) : (
          <LoaderCircle className="h-6 w-6 animate-spin text-primary" />
        )}
      </div>
      <h2 className="font-semibold">{failed ? "Processing failed" : "Processing blueprint"}</h2>
      <p className="mt-1 max-w-md text-sm text-base-content/55">
        {message || (failed ? "This blueprint is not available yet." : "Kamai is preparing the plan and takeoff.")}
      </p>
      {!failed && progress != null && progress > 0 && progress < 100 && (
        <span className="mt-3 rounded-full bg-primary/10 px-3 py-1 text-sm font-semibold text-primary">{progress}%</span>
      )}
    </Card>
  );
}

export function PlanCardArtwork({ count }: { count: number }) {
  return (
    <div className="plan-grid relative flex h-36 items-center justify-center overflow-hidden bg-base-200">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-secondary/10" />
      <div className="relative h-24 w-32 rotate-[-2deg] rounded-md border border-base-300 bg-base-100 p-3 shadow-md">
        <div className="mb-2 flex items-center gap-2">
          <FileText className="h-4 w-4 text-primary" />
          <div className="h-1.5 w-14 rounded bg-base-300" />
        </div>
        <div className="grid h-14 grid-cols-3 gap-1">
          <div className="col-span-2 rounded border border-primary/20" />
          <div className="rounded border border-primary/20" />
          <div className="rounded border border-primary/20" />
          <div className="col-span-2 rounded border border-primary/20" />
        </div>
      </div>
      <span className="badge badge-sm absolute left-3 top-3 bg-white text-black shadow-sm">
        {count === 1 ? "1 file" : `${count} files`}
      </span>
    </div>
  );
}
