import { useEffect, useMemo, useState } from "react";
import { FileText, FolderOpen, LoaderCircle, RefreshCw, Upload } from "lucide-react";
import { useDropzone } from "react-dropzone";

import { callTool, updateModelContext } from "./bridge";
import {
  asArray,
  blueprintName,
  isBlueprintReady,
  projectBlueprints,
  projectJobs,
  TERMINAL_BAD,
} from "./format";
import { BlueprintPanel } from "./BlueprintWidget";
import { BrandHeader, Button, Card, LoadingState, StatusBadge } from "./shared";
import type {
  BlueprintData,
  BlueprintSummary,
  JobSummary,
  ProjectDetail,
  UploadData,
  UploadResult,
  UploadTicket,
} from "./types";
import { useWidgetData } from "./useWidgetData";

const MAX_TRACK_MS = 20 * 60 * 1000;

function putFile(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (value: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url, true);
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() !== "content-length" && key.toLowerCase() !== "host") {
        request.setRequestHeader(key, value);
      }
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 96) + 2);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${request.status}). ${request.responseText || ""}`.trim()));
    };
    request.onerror = () => reject(new Error("The browser blocked the upload. Check the storage CORS configuration."));
    request.send(file);
  });
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function belongsToUpload(job: JobSummary, jobId: string | null, filename: string | null): boolean {
  if (job.id === jobId) return true;
  if (!filename) return false;
  return new RegExp(`^\\(\\d+\\) ${escapedPattern(filename)}$`).test(job.filename || "");
}

function failureReason(job: JobSummary): string {
  if (job.error_code === "page_quota_exceeded") {
    return "Your plan has no pages left. Upgrade in Kamai to process this blueprint.";
  }
  return job.error_message || "Processing failed. Try uploading this blueprint again.";
}

function JobRow({
  job,
  blueprint,
  jobs,
  onOpen,
}: {
  job: JobSummary;
  blueprint?: BlueprintSummary;
  jobs: JobSummary[];
  onOpen: (blueprint: BlueprintSummary) => void;
}) {
  const status = job.status.toUpperCase();
  const ready = !!blueprint && status === "SUCCEEDED" && isBlueprintReady(blueprint, jobs);
  const failed = TERMINAL_BAD.includes(status as (typeof TERMINAL_BAD)[number]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 px-3 py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-primary" />
          <span className="truncate text-sm font-medium">{blueprint ? blueprintName(blueprint) : job.filename || job.blueprint_id}</span>
        </div>
        {failed && <p className="mt-1 pl-6 text-xs text-error">{failureReason(job)}</p>}
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge job={job} ready={ready} />
        {ready && blueprint && <Button variant="outline" size="xs" onClick={() => onOpen(blueprint)}>View</Button>}
      </div>
    </div>
  );
}

export function UploadWidget() {
  const data = useWidgetData<UploadData>();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("Drop a PDF here");
  const [phaseDetail, setPhaseDetail] = useState("or click to choose a file");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [blueprints, setBlueprints] = useState<BlueprintSummary[]>([]);
  const [tracked, setTracked] = useState<{ jobId: string | null; filename: string | null } | null>(null);
  const [trackingKey, setTrackingKey] = useState(0);
  const [trackingPaused, setTrackingPaused] = useState(false);
  const [opened, setOpened] = useState<BlueprintData | null>(null);
  const projects = data?.projects ?? [];

  useEffect(() => {
    if (!data) return;
    if (data.project_id) setProjectId(data.project_id);
    const selectedProject = data.project_id
      ? (data.projects ?? []).find((project) => project.id === data.project_id)
      : undefined;
    setProjectName(data.project_name ?? selectedProject?.name ?? null);
    setJobs(asArray(data.jobs));
    setBlueprints(asArray(data.blueprints));
  }, [data]);

  useEffect(() => {
    if (!tracked || !projectId) return;
    let active = true;
    let timer = 0;
    let tick = 0;
    let seen = false;
    let failures = 0;
    const started = Date.now();

    const poll = async () => {
      if (!active || Date.now() - started > MAX_TRACK_MS) return;
      try {
        const project = await callTool<ProjectDetail>("get_project", { project_id: projectId });
        failures = 0;
        const nextJobs = projectJobs(project);
        const nextBlueprints = projectBlueprints(project);
        setJobs(nextJobs);
        setBlueprints(nextBlueprints);
        setProjectName(project.name);
        const mine = nextJobs.filter((job) => belongsToUpload(job, tracked.jobId, tracked.filename));
        if (mine.length) seen = true;
        if (seen && mine.length && mine.every((job) => job.status.toUpperCase() === "SUCCEEDED" || TERMINAL_BAD.includes(job.status.toUpperCase() as (typeof TERMINAL_BAD)[number]))) {
          const ready = mine.filter((job) => {
            const blueprint = nextBlueprints.find((item) => item.id === job.blueprint_id);
            return job.status.toUpperCase() === "SUCCEEDED" && blueprint && isBlueprintReady(blueprint, nextJobs);
          });
          void updateModelContext(
            ready.length
              ? `Blueprint processing finished in ${project.name}. ${ready.length} blueprint(s) are ready.`
              : `Blueprint processing failed in ${project.name}.`,
          );
          return;
        }
      } catch {
        failures += 1;
        if (failures >= 2) {
          setTrackingPaused(true);
          return;
        }
      }
      const delay = tick < 20 ? 3000 : tick < 80 ? 5000 : 10000;
      tick += 1;
      timer = window.setTimeout(poll, delay);
    };

    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [projectId, tracked, trackingKey]);

  const upload = async (file: File) => {
    setError(null);
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setError("Only PDF blueprints are supported.");
      return;
    }
    setBusy(true);
    setPhase("Preparing upload…");
    setPhaseDetail(file.name);
    setUploadProgress(2);
    try {
      const ticket = await callTool<UploadTicket>("request_blueprint_upload", {
        filename: file.name,
        project_id: projectId || undefined,
        mime_type: "application/pdf",
      });
      setProjectId(ticket.project_id || projectId);
      setProjectName(ticket.project_name || projectName);
      setPhase("Uploading…");
      await putFile(ticket.signed_url, ticket.required_headers ?? {}, file, setUploadProgress);
      setUploadProgress(null);
      setPhase("Starting processing…");
      const result = await callTool<UploadResult>("finalize_blueprint_upload", { file_uuid: ticket.file_uuid });
      setProjectId(result.project_id || ticket.project_id);
      setProjectName(result.project_name || ticket.project_name || projectName);
      setTrackingPaused(false);
      setTracked({ jobId: result.job_id ?? null, filename: file.name });
      setJobs([{
        id: result.job_id || `queued-${Date.now()}`,
        blueprint_id: result.blueprint_id || "",
        status: "PENDING",
        filename: file.name,
        progress: 0,
      }]);
      setPhase("Drop another PDF here");
      setPhaseDetail(result.project_name ? `uploads to “${result.project_name}”` : "or click to choose a file");
    } catch (reason) {
      setUploadProgress(null);
      setPhase("Drop a PDF here");
      setPhaseDetail("or click to choose a file");
      setError(reason instanceof Error ? reason.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { "application/pdf": [".pdf"] },
    multiple: false,
    disabled: busy,
    onDrop: (accepted) => {
      const file = accepted[0];
      if (file) void upload(file);
    },
  });

  const visibleJobs = useMemo(() => {
    if (!tracked) return jobs;
    const mine = jobs.filter((job) => belongsToUpload(job, tracked.jobId, tracked.filename));
    return mine.length ? mine : jobs;
  }, [jobs, tracked]);

  const openBlueprint = async (blueprint: BlueprintSummary) => {
    if (!projectId) return;
    setError(null);
    try {
      setOpened(await callTool<BlueprintData>("view_blueprint", {
        blueprint_id: blueprint.id,
        project_id: projectId,
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this blueprint.");
    }
  };

  if (!data) return <LoadingState label="Preparing upload…" />;
  if (opened) return <BlueprintPanel initialData={opened} onBack={() => setOpened(null)} />;

  return (
    <>
      <BrandHeader title="Upload a blueprint" subtitle={projectName ? `to ${projectName}` : "PDF floor plans"} />

      <Card className="p-4">
        <div className="mb-4 flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-primary" />
          <label className="text-xs font-semibold text-base-content/60" htmlFor="project">Project</label>
          <select
            id="project"
            value={projectId ?? ""}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value || null;
              setProjectId(value);
              setProjectName(projects.find((project) => project.id === value)?.name ?? null);
            }}
            className="select select-sm ml-auto max-w-56 rounded-full bg-base-200"
          >
            <option value="">Default project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>

        <div
          {...getRootProps()}
          className={`group flex min-h-60 cursor-pointer flex-col items-center justify-center rounded-2xl border-[3px] border-dashed p-8 text-center transition ${
            isDragActive ? "scale-[1.01] border-primary bg-primary/5" : "border-base-300 hover:border-primary hover:bg-base-200/50"
          } ${busy ? "cursor-wait opacity-80" : ""}`}
        >
          <input {...getInputProps()} />
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 transition group-hover:bg-primary/20">
            {busy ? <LoaderCircle className="h-10 w-10 animate-spin text-primary" /> : <Upload className="h-10 w-10 text-primary" />}
          </div>
          <h2 className="text-base font-medium">{isDragActive ? "Drop the PDF to upload" : phase}</h2>
          <p className="mt-1 max-w-sm truncate text-sm text-base-content/50">{phaseDetail}</p>
          {uploadProgress != null && uploadProgress > 0 && uploadProgress < 100 && (
            <div className="mt-5 w-full max-w-xs">
              <progress className="progress progress-primary w-full" value={uploadProgress} max={100} />
              <div className="mt-1 text-xs font-semibold text-primary">{uploadProgress}%</div>
            </div>
          )}
        </div>
      </Card>

      {error && <div className="alert alert-error mt-3 py-2 text-sm">{error}</div>}

      {visibleJobs.length > 0 && (
        <Card className="mt-4">
          <div className="border-b border-base-300 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-base-content/50">Processing</div>
          {visibleJobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              jobs={jobs}
              blueprint={blueprints.find((blueprint) => blueprint.id === job.blueprint_id)}
              onOpen={openBlueprint}
            />
          ))}
        </Card>
      )}

      {trackingPaused && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-base-300 bg-base-100 p-3 text-xs text-base-content/60">
          Progress tracking paused after Kamai stopped responding.
          <Button
            variant="outline"
            size="xs"
            icon={RefreshCw}
            onClick={() => {
              setTrackingPaused(false);
              setTrackingKey((value) => value + 1);
            }}
          >
            Resume
          </Button>
        </div>
      )}
    </>
  );
}
