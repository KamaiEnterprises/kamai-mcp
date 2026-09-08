import { z } from "zod";

import { API_BASE_URL } from "./config.ts";
import type { Principal } from "./auth.ts";

// The API layer's response models are the contract, and these mirror them field for
// field. Types are inferred from the schemas rather than declared alongside them: a
// hand-written twin is exactly how ingest_blueprint_from_chat's file_id drifted from
// ChatGPTFileRef and failed the app scan.
//
// Every optional field there is nullish() here. Today the API serialises those as
// null; nullish() also tolerates the key being dropped if that ever changes. Fields
// carrying a default are always present and stay required.

const blueprintState = z.enum(["ready", "processing", "failed"]);
const units = z.object({ area: z.string(), length: z.string() });

export const rgbaSchema = z.object({
  r: z.number(),
  g: z.number(),
  b: z.number(),
  a: z.number(),
});

export const blueprintSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  ready: z.boolean(),
});

export const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  last_modified: z.number().nullish(),
  // Only populated when the request asks for include=blueprints.
  blueprints: z.array(blueprintSummarySchema).nullish(),
});

export const projectPageSchema = z.object({
  items: z.array(projectSummarySchema),
  next_cursor: z.string().nullish(),
});

export const jobSummarySchema = z.object({
  id: z.string(),
  blueprint_id: z.string(),
  status: z.string(),
  state: z.string().nullish(),
  filename: z.string(),
  progress: z.number(),
  error_message: z.string().nullish(),
  error_code: z.string().nullish(),
});

export const projectDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  blueprints: z.array(blueprintSummarySchema),
  jobs: z.array(jobSummarySchema),
});

export const geometryFeatureSchema = z.object({
  i: z.number(),
  cls: z.string(),
  name: z.string(),
  // The feature's parent group in the drawing's hierarchy — how the user organises the
  // sheet ("Group 1", "Apartment 5"); null for anything outside the tree. The API layer
  // already sent it; this mirror is what never declared it.
  //
  // Nothing is stripped by declaring it — callApi casts the response with `as T` and never
  // parses it, so the field was reaching view_blueprint's widget all along. What changes is
  // the DECLARED outputSchema: a plain z.object() converts to JSON Schema with
  // "additionalProperties": false, so a client that validates structuredContent against the
  // advertised schema was rejecting every real geometry page. Declaring it is the fix.
  folder: z.string().nullish(),
  color: rgbaSchema,
  rings: z.array(z.array(z.number())).nullish(),
  lines: z.array(z.array(z.number())).nullish(),
  pts: z.array(z.number()).nullish(),
  area: z.number().nullish(),
  len: z.number().nullish(),
});

export const geometryPageSchema = z.object({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  project_id: z.string(),
  project_name: z.string(),
  state: blueprintState,
  grid: z.number(),
  image: z.object({ url: z.string(), w: z.number(), h: z.number() }).nullish(),
  features: z.array(geometryFeatureSchema),
  total: z.number(),
  truncated: z.boolean(),
  next_cursor: z.string().nullish(),
  scale_label: z.string().nullish(),
  needs_scale: z.boolean(),
  scale_unconfirmed: z.boolean(),
  units,
});

export const uploadTicketSchema = z.object({
  file_uuid: z.string(),
  project_id: z.string(),
  project_name: z.string().nullish(),
  signed_url: z.string(),
  method: z.string(),
  expires_in: z.number(),
  required_headers: z.record(z.string(), z.string()),
});

export const uploadResultSchema = z.object({
  job_id: z.string().nullish(),
  blueprint_id: z.string().nullish(),
  project_id: z.string(),
  project_name: z.string().nullish(),
  filename: z.string().nullish(),
  status: z.string().nullish(),
});

export const blueprintLocationSchema = z.object({
  project_id: z.string(),
  project_name: z.string(),
  blueprint_id: z.string(),
  name: z.string().nullish(),
});

export const takeoffRowSchema = z.object({
  group: z.string(),
  cls: z.string(),
  count: z.number(),
  area: z.number(),
  len: z.number(),
  color: rgbaSchema,
});

export const takeoffPageSchema = z.object({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  project_id: z.string(),
  project_name: z.string(),
  state: blueprintState,
  rows: z.array(takeoffRowSchema),
  totals: z.object({ count: z.number(), area: z.number(), len: z.number() }),
  shapes: z.number(),
  scale_label: z.string().nullish(),
  needs_scale: z.boolean(),
  scale_unconfirmed: z.boolean(),
  units,
});

export const blueprintDetailSchema = z.object({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  project_id: z.string(),
  project_name: z.string(),
  state: blueprintState,
  progress: z.number(),
  failed: z.boolean(),
  error_message: z.string().nullish(),
  error_code: z.string().nullish(),
});

export type Rgba = z.infer<typeof rgbaSchema>;
export type BlueprintSummary = z.infer<typeof blueprintSummarySchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ProjectPage = z.infer<typeof projectPageSchema>;
export type JobSummary = z.infer<typeof jobSummarySchema>;
export type ProjectDetail = z.infer<typeof projectDetailSchema>;
export type GeometryFeature = z.infer<typeof geometryFeatureSchema>;
export type GeometryPage = z.infer<typeof geometryPageSchema>;
export type UploadTicket = z.infer<typeof uploadTicketSchema>;
export type UploadResult = z.infer<typeof uploadResultSchema>;
export type BlueprintLocation = z.infer<typeof blueprintLocationSchema>;
export type TakeoffRow = z.infer<typeof takeoffRowSchema>;
export type TakeoffPage = z.infer<typeof takeoffPageSchema>;
export type BlueprintDetail = z.infer<typeof blueprintDetailSchema>;

const looseBlueprintSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().nullish().catch(null),
    ready: z.boolean().catch(false),
  })
  .passthrough();

const looseProjectSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().nullish().catch(null),
    description: z.string().nullish().catch(null),
    last_modified: z.number().nullish().catch(null),
    blueprints: z.unknown().optional(),
  })
  .passthrough();

const looseProjectPageSchema = z
  .object({
    items: z.unknown(),
    next_cursor: z.string().nullish().catch(null),
  })
  .passthrough();

function recordCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(([id, item]) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" ? record : { ...record, id };
  });
}

function parseBlueprintSummaries(value: unknown): BlueprintSummary[] | null {
  if (value == null) return null;
  return recordCandidates(value).flatMap((candidate) => {
    const parsed = looseBlueprintSummarySchema.safeParse(candidate);
    if (!parsed.success) return [];
    return [{ id: parsed.data.id, name: parsed.data.name, ready: parsed.data.ready }];
  });
}

export function parseProjectPage(value: unknown): ProjectPage {
  const page = looseProjectPageSchema.parse(value);
  const items = recordCandidates(page.items).flatMap((candidate) => {
    const parsed = looseProjectSummarySchema.safeParse(candidate);
    if (!parsed.success) return [];
    return [
      {
        id: parsed.data.id,
        name: parsed.data.name ?? "Untitled project",
        description: parsed.data.description ?? "",
        last_modified: parsed.data.last_modified,
        blueprints: parseBlueprintSummaries(parsed.data.blueprints),
      },
    ];
  });
  return { items, next_cursor: page.next_cursor };
}

// Prose the model may see. Keyed off the frozen `code` vocabulary, never off the
// upstream detail string, which can carry internal hostnames and paths.
const MESSAGES: Record<string, string> = {
  unauthenticated: "You are not signed in to Kamai.",
  // Not "your session expired": this fires for ANY downstream 401, including an audience
  // misconfiguration, where reconnecting never helps.
  invalid_token: "Kamai rejected the access token. If this persists, reconnect the connector.",
  forbidden: "You do not have access to that.",
  not_found: "Not found.",
  not_ready: "That blueprint is still being processed.",
  invalid_request: "That request was not valid.",
  upstream_unavailable: "Kamai is temporarily unavailable. Try again shortly.",
  internal: "Something went wrong on the Kamai side.",
  subscription_pending: "This Kamai account has no active plan yet, so blueprints cannot be uploaded.",
  subscription_expired: "The Kamai subscription has expired, so blueprints cannot be uploaded.",
  quota_exceeded: "This Kamai account has used its whole plan allowance.",
  org_quota_exceeded: "This account has reached the limit its organization set.",
  entitlement_unavailable: "Kamai could not verify the plan just now. Try again shortly.",
};

// RFC 9457 extension members the API layer attaches to an entitlement refusal. Every one
// is optional: a refusal that arrives without them still produces the static sentence
// above rather than a half-built one.
const problemDetailsSchema = z.object({
  plan: z.string().nullish(),
  quota_type: z.string().nullish(),
  limit: z.number().nullish(),
  current: z.number().nullish(),
  action_required: z.string().nullish(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;

// The remedy, not the diagnosis. A refusal the model cannot act on costs the user a
// round trip: it reads as a Kamai fault rather than as something they can fix.
const REMEDY: Record<string, string> = {
  subscription_pending: "Use the `open_kamai` tool to open Kamai, where a plan can be chosen.",
  subscription_expired: "Use the `open_kamai` tool to open Kamai, where the plan can be renewed.",
  quota_exceeded: "Use the `open_kamai` tool to open Kamai, where the plan can be changed.",
  org_quota_exceeded: "An administrator of the organization has to raise the limit.",
};

function messageFor(code: string, details: ProblemDetails): string {
  const base = MESSAGES[code] ?? MESSAGES.internal!;
  const parts = [base];

  if (code === "quota_exceeded" && details.limit != null) {
    const unit = details.quota_type ?? "uploads";
    const used = details.current ?? details.limit;
    parts[0] = details.plan
      ? `This Kamai account is on the ${details.plan} plan and has used ${used} of its ${details.limit} ${unit}.`
      : `This Kamai account has used ${used} of its ${details.limit} ${unit}.`;
  } else if (code === "org_quota_exceeded" && details.limit != null) {
    const used = details.current ?? details.limit;
    parts[0] = `This account has used ${used} of the ${details.limit} pages its organization allows.`;
  } else if (code === "subscription_expired" && details.plan && details.plan !== "expired") {
    parts[0] = `The Kamai ${details.plan} subscription has expired, so blueprints cannot be uploaded.`;
  }

  const remedy = REMEDY[code];
  if (remedy) parts.push(remedy);
  return parts.join(" ");
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: ProblemDetails = {},
  ) {
    super(messageFor(code, details));
  }
}

async function callApi<T>(
  principal: Principal,
  path: string,
  query?: Record<string, string | number | undefined>,
  init?: { method: "POST" | "PATCH"; body?: unknown },
  decode?: (value: unknown) => T,
): Promise<T> {
  const url = new URL(API_BASE_URL + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${principal.token}`,
    accept: "application/json",
  };
  if (init?.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? "GET",
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("upstream_unavailable", 503);
  }

  if (!response.ok) {
    let code = "internal";
    let details: ProblemDetails = {};
    try {
      const body = (await response.json()) as { code?: string };
      if (typeof body.code === "string") code = body.code;
      // Parsed leniently: an unparseable extension member must not turn a precise
      // refusal into a generic one.
      const parsed = problemDetailsSchema.safeParse(body);
      if (parsed.success) details = parsed.data;
    } catch {
      /* non-problem body: keep the generic code */
    }
    throw new ApiError(code, response.status, details);
  }

  const body = await response.json();
  return decode ? decode(body) : (body as T);
}

export const api = {
  // `include` is a comma-separated extras list; today the only value is "blueprints", which
  // embeds each project's blueprint summaries. The records already carry them, so asking for
  // them costs the API layer nothing — and NOT asking costs one extra request per project.
  listProjects: (p: Principal, limit = 50, cursor?: string, include?: string) =>
    callApi<ProjectPage>(p, "/v1/projects", { limit, cursor, include }, undefined, parseProjectPage),

  getProject: (p: Principal, projectId: string) =>
    callApi<ProjectDetail>(p, `/v1/projects/${encodeURIComponent(projectId)}`),

  getBlueprint: (p: Principal, projectId: string, blueprintId: string) =>
    callApi<BlueprintDetail>(
      p,
      `/v1/projects/${encodeURIComponent(projectId)}/blueprints/${encodeURIComponent(blueprintId)}`,
    ),

  getGeometry: (
    p: Principal,
    projectId: string,
    blueprintId: string,
    limit = 400,
    cursor?: string,
  ) =>
    callApi<GeometryPage>(
      p,
      `/v1/projects/${encodeURIComponent(projectId)}/blueprints/${encodeURIComponent(blueprintId)}/geometry`,
      { limit, cursor },
    ),

  getTakeoff: (p: Principal, projectId: string, blueprintId: string) =>
    callApi<TakeoffPage>(
      p,
      `/v1/projects/${encodeURIComponent(projectId)}/blueprints/${encodeURIComponent(blueprintId)}/takeoff`,
    ),

  createProject: (p: Principal, name: string, description: string) =>
    callApi<ProjectSummary>(p, "/v1/projects", undefined, {
      method: "POST",
      body: { name, description },
    }),

  updateProject: (p: Principal, projectId: string, patch: { name?: string; description?: string }) =>
    callApi<ProjectSummary>(p, `/v1/projects/${encodeURIComponent(projectId)}`, undefined, {
      method: "PATCH",
      body: patch,
    }),

  listJobs: (p: Principal, projectId: string) =>
    callApi<JobSummary[]>(p, `/v1/projects/${encodeURIComponent(projectId)}/jobs`),

  getJob: (p: Principal, projectId: string, jobId: string) =>
    callApi<JobSummary>(
      p,
      `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`,
    ),

  cancelJob: (p: Principal, projectId: string, jobId: string) =>
    callApi<JobSummary>(
      p,
      `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/cancel`,
      undefined,
      { method: "POST" },
    ),

  createUpload: (
    p: Principal,
    body: { filename?: string; project_id?: string; mime_type?: string },
  ) => callApi<UploadTicket>(p, "/v1/uploads", undefined, { method: "POST", body }),

  completeUpload: (p: Principal, fileUuid: string) =>
    callApi<UploadResult>(p, `/v1/uploads/${encodeURIComponent(fileUuid)}/complete`, undefined, {
      method: "POST",
    }),

  importChatAttachment: (
    p: Principal,
    body: {
      download_url: string;
      file_name?: string;
      mime_type?: string;
      project_id?: string;
    },
  ) => callApi<UploadResult>(p, "/v1/imports/chat-attachment", undefined, { method: "POST", body }),
};

// The API layer scopes blueprints under their project, so a tool holding only a
// blueprint id needs its project first. The resolve endpoint does that lookup
// server-side in one round trip rather than walking every project from here.
export async function resolveProject(
  principal: Principal,
  blueprintId: string,
  projectId?: string,
): Promise<string> {
  if (projectId) return projectId;
  const found = await callApi<BlueprintLocation>(
    principal,
    `/v1/blueprints/${encodeURIComponent(blueprintId)}`,
  );
  return found.project_id;
}
