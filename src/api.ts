import { z } from "zod";

import { API_BASE_URL } from "./config.ts";
import type { Principal } from "./auth.ts";
import {
  aggregateResultSchema,
  geometrySelectResultSchema,
  inventoryResultSchema,
  resolveResultSchema,
  scaleResultSchema,
  selectResultSchema,
  tableResultSchema,
  vocabularySchema,
  wallSurfaceResultSchema,
  type AggregateResult,
  type GeometrySelectResult,
  type HeightStatement,
  type InventoryResult,
  type ResolveResult,
  type ScaleResult,
  type SelectResult,
  type TableResult,
  type Vocabulary,
  type WallSurfaceResult,
} from "./query/contract.ts";

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
  // Blueprint-local id. Pass this to update_elements / move_elements. Nullish so a
  // page assembled before the field existed still validates.
  id: z.string().nullish(),
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

export const legendFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parent_id: z.string().nullish(),
  is_root: z.boolean(),
  color: rgbaSchema.nullish(),
  position: z.number(),
});

export const legendPageSchema = z.object({
  blueprint_id: z.string(),
  project_id: z.string(),
  project_name: z.string(),
  folders: z.array(legendFolderSchema),
  count: z.number(),
});

export const featurePatchResultSchema = z.object({
  applied: z.boolean(),
  changed: z.number(),
  ids: z.array(z.string()),
  fields: z.array(z.string()),
});

/** What one opening piece reports back after a tag/height write.
 *
 * Read back AFTER the write rather than echoed from the request: `height_units`
 * and `height_m` are the same stored length in the two units, so a caller that
 * sent metres can check the conversion the sheet's scale performed, and a
 * tag-only write still learns the height already on the row. Both are nullish
 * because a piece that has never been given a height has neither. */
export const openingPieceAttributesSchema = z.object({
  id: z.string(),
  tag: z.string().nullish(),
  height_units: z.number().nullish(),
  height_m: z.number().nullish(),
  feature_class: z.string(),
});

export const folderCreatedSchema = z.object({
  applied: z.boolean(),
  id: z.string().nullish(),
  name: z.string(),
  parent_id: z.string().nullish(),
});

export const featureMovedSchema = z.object({
  applied: z.boolean(),
  moved: z.number(),
  parent_id: z.string(),
  ids: z.array(z.string()),
  unknown: z.array(z.string()),
  refused: z.array(z.object({ id: z.string(), reason: z.string() })),
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
export type LegendFolder = z.infer<typeof legendFolderSchema>;
export type LegendPage = z.infer<typeof legendPageSchema>;
export type FeaturePatchResult = z.infer<typeof featurePatchResultSchema>;
export type FolderCreated = z.infer<typeof folderCreatedSchema>;
export type FeatureMoved = z.infer<typeof featureMovedSchema>;
export type OpeningPieceAttributes = z.infer<typeof openingPieceAttributesSchema>;

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

// Every route this client calls, spelled once. Each `api.*` call builds its path from
// here, and scripts/check-routes.ts asserts every entry against a live API's
// /openapi.json: a fetch-mocked tool test passes against a route that does not exist.
// Placeholders use the API layer's own parameter names.
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT";

export const API_ROUTES = {
  me: { method: "GET", template: "/v1/me" },
  listProjects: { method: "GET", template: "/v1/projects" },
  createProject: { method: "POST", template: "/v1/projects" },
  getProject: { method: "GET", template: "/v1/projects/{project_id}" },
  updateProject: { method: "PATCH", template: "/v1/projects/{project_id}" },
  listJobs: { method: "GET", template: "/v1/projects/{project_id}/jobs" },
  getJob: { method: "GET", template: "/v1/projects/{project_id}/jobs/{job_id}" },
  cancelJob: { method: "POST", template: "/v1/projects/{project_id}/jobs/{job_id}/cancel" },
  getBlueprint: { method: "GET", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}" },
  getGeometry: { method: "GET", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/geometry" },
  getTakeoff: { method: "GET", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/takeoff" },
  listFolders: { method: "GET", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/folders" },
  createFolder: { method: "POST", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/folders" },
  patchFeatures: { method: "POST", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/features" },
  moveFeatures: { method: "POST", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/move" },
  setOpeningPieceAttributes: { method: "PATCH", template: "/v1/blueprints/{blueprint_id}/features/{feature_id}" },
  locateBlueprint: { method: "GET", template: "/v1/blueprints/{blueprint_id}" },
  createUpload: { method: "POST", template: "/v1/uploads" },
  completeUpload: { method: "POST", template: "/v1/uploads/{file_uuid}/complete" },
  importChatAttachment: { method: "POST", template: "/v1/imports/chat-attachment" },
  getVocabulary: { method: "GET", template: "/v1/vocabulary" },
  querySelect: { method: "POST", template: "/v1/projects/{project_id}/query/select" },
  queryAggregate: { method: "POST", template: "/v1/projects/{project_id}/query/aggregate" },
  queryWallSurface: { method: "POST", template: "/v1/projects/{project_id}/query/wall-surface-area" },
  queryTable: { method: "POST", template: "/v1/projects/{project_id}/query/table" },
  queryResolve: { method: "POST", template: "/v1/projects/{project_id}/query/resolve" },
  getInventory: { method: "GET", template: "/v1/projects/{project_id}/inventory" },
  setScale: { method: "PUT", template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/scale" },
  geometrySelect: {
    method: "POST",
    template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/geometry/select",
  },
} as const satisfies Record<string, { method: HttpMethod; template: string }>;

export type RouteName = keyof typeof API_ROUTES;

/** A route's path with its placeholders filled, each value URL-encoded. A missing value is
 * a bug in this file, not a caller mistake, so it throws rather than sending `{id}`. */
export function routePath(route: RouteName, params: Record<string, string> = {}): string {
  return API_ROUTES[route].template.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`routePath(${route}): missing ${name}`);
    return encodeURIComponent(value);
  });
}

// Prose the model may see. Keyed off the frozen `code` vocabulary, never off the
// upstream detail string, which can carry internal hostnames and paths. The one
// exception is `invalid_request` on the query routes, whose detail is the backend's own
// fix message (see errors.ts).
//
// forbidden and not_found say the same thing: telling "exists but not yours" apart from
// "does not exist" is an oracle over other accounts' ids.
const NOTHING_WITH_THAT_ID =
  "Kamai has nothing with that id in this account. Check the id with view_projects, list_blueprints or list_jobs.";

// Not in the plan remedies below: the sentence that stops a model re-trying a refusal
// that cannot change until a person acts.
const DO_NOT_RETRY_PLAN =
  "Do not call this tool again until the user has changed the plan in Kamai; it will be refused the same way.";

export const MESSAGES: Record<string, string> = {
  unauthenticated: "You are not signed in to Kamai.",
  // Not "your session expired": this fires for ANY downstream 401, including an audience
  // misconfiguration, where reconnecting never helps.
  invalid_token: "Kamai rejected the access token. If this persists, reconnect the connector.",
  forbidden: NOTHING_WITH_THAT_ID,
  not_found: NOTHING_WITH_THAT_ID,
  not_ready: "That blueprint is still being processed.",
  invalid_request: "That request was not valid.",
  upstream_unavailable: "Kamai is temporarily unavailable. Try again shortly.",
  internal: "Something went wrong on the Kamai side.",
  // A 404 with no problem body is the framework's own "no such route": the API this server
  // talks to is older than the tool. Retrying cannot help within a conversation.
  route_missing:
    "This Kamai feature is not available on the server yet. Do not call it again in this conversation; tell the user it could not be done.",
  needs_scale:
    "This blueprint has no usable scale, so nothing on it can be measured. The scale has to be set in Kamai first.",
  busy: "Kamai is still running this account's other queries. Wait for them to finish, then ask once more.",
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
  subscription_pending: `Use the \`open_kamai\` tool to open Kamai, where a plan can be chosen. ${DO_NOT_RETRY_PLAN}`,
  subscription_expired: `Use the \`open_kamai\` tool to open Kamai, where the plan can be renewed. ${DO_NOT_RETRY_PLAN}`,
  quota_exceeded: `Use the \`open_kamai\` tool to open Kamai, where the plan can be changed. ${DO_NOT_RETRY_PLAN}`,
  org_quota_exceeded: `An administrator of the organization has to raise the limit. ${DO_NOT_RETRY_PLAN}`,
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

// The longest backend fix message worth carrying. The validation handler caps its own
// detail at this length; the cap here is so a misbehaving server cannot flood the model.
const MAX_DETAIL = 600;

export class ApiError extends Error {
  /** The problem document's `detail`, trimmed. Never shown by default: see errors.ts for
   * the routes whose detail is a fix message written for the caller. */
  readonly detail?: string;
  /** Which route refused, so the message can depend on it. */
  readonly route?: RouteName;

  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: ProblemDetails = {},
    extra: { detail?: string; route?: RouteName } = {},
  ) {
    super(messageFor(code, details));
    this.detail = extra.detail;
    this.route = extra.route;
  }
}

type CallOptions<T> = {
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  decode?: (value: unknown) => T;
};

async function callApi<T>(principal: Principal, route: RouteName, options: CallOptions<T> = {}): Promise<T> {
  const url = new URL(API_BASE_URL + routePath(route, options.params));
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${principal.token}`,
    accept: "application/json",
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method: API_ROUTES[route].method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError("upstream_unavailable", 503, {}, { route });
  }

  if (!response.ok) {
    let code: string | null = null;
    let detail: string | undefined;
    let details: ProblemDetails = {};
    try {
      const body = (await response.json()) as { code?: unknown; detail?: unknown };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.detail === "string" && body.detail.trim()) {
        detail = body.detail.trim().slice(0, MAX_DETAIL);
      }
      // Parsed leniently: an unparseable extension member must not turn a precise
      // refusal into a generic one.
      const parsed = problemDetailsSchema.safeParse(body);
      if (parsed.success) details = parsed.data;
    } catch {
      /* non-problem body: keep the generic code */
    }
    // Every refusal of the API layer's own carries a `code`. A 404 or 405 without one is
    // the framework saying the route itself is not there.
    if (code === null && (response.status === 404 || response.status === 405)) code = "route_missing";
    throw new ApiError(code ?? "internal", response.status, details, { detail, route });
  }

  const body = await response.json();
  return options.decode ? options.decode(body) : (body as T);
}

/** Decode a query-route response against its contract schema. A response that does not
 * match is treated as a server fault rather than passed on half-understood: a refusal is
 * recoverable, a wrong number stated confidently is not. */
function decodeWith<S extends z.ZodType>(schema: S, route: RouteName) {
  return (value: unknown): z.infer<S> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      // Paths and issue codes only, never values: a value is a customer's data. stderr,
      // because in local mode stdout is the MCP transport.
      console.error(
        JSON.stringify({
          severity: "WARNING",
          event_name: "api_contract_mismatch",
          event_data: {
            route,
            issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.code}`),
          },
        }),
      );
      throw new ApiError("internal", 502, {}, { route });
    }
    return parsed.data;
  };
}

const bp = (projectId: string, blueprintId: string) => ({ project_id: projectId, blueprint_id: blueprintId });

export const api = {
  // `include` is a comma-separated extras list; today the only value is "blueprints", which
  // embeds each project's blueprint summaries. The records already carry them, so asking for
  // them costs the API layer nothing — and NOT asking costs one extra request per project.
  listProjects: (p: Principal, limit = 50, cursor?: string, include?: string) =>
    callApi<ProjectPage>(p, "listProjects", { query: { limit, cursor, include }, decode: parseProjectPage }),

  getProject: (p: Principal, projectId: string) =>
    callApi<ProjectDetail>(p, "getProject", { params: { project_id: projectId } }),

  getBlueprint: (p: Principal, projectId: string, blueprintId: string) =>
    callApi<BlueprintDetail>(p, "getBlueprint", { params: bp(projectId, blueprintId) }),

  getGeometry: (
    p: Principal,
    projectId: string,
    blueprintId: string,
    limit = 400,
    cursor?: string,
  ) =>
    callApi<GeometryPage>(p, "getGeometry", { params: bp(projectId, blueprintId), query: { limit, cursor } }),

  getTakeoff: (p: Principal, projectId: string, blueprintId: string) =>
    callApi<TakeoffPage>(p, "getTakeoff", { params: bp(projectId, blueprintId) }),

  createProject: (p: Principal, name: string, description: string) =>
    callApi<ProjectSummary>(p, "createProject", { body: { name, description } }),

  updateProject: (p: Principal, projectId: string, patch: { name?: string; description?: string }) =>
    callApi<ProjectSummary>(p, "updateProject", { params: { project_id: projectId }, body: patch }),

  listJobs: (p: Principal, projectId: string) =>
    callApi<JobSummary[]>(p, "listJobs", { params: { project_id: projectId } }),

  getJob: (p: Principal, projectId: string, jobId: string) =>
    callApi<JobSummary>(p, "getJob", { params: { project_id: projectId, job_id: jobId } }),

  cancelJob: (p: Principal, projectId: string, jobId: string) =>
    callApi<JobSummary>(p, "cancelJob", { params: { project_id: projectId, job_id: jobId } }),

  createUpload: (
    p: Principal,
    body: { filename?: string; project_id?: string; mime_type?: string },
  ) => callApi<UploadTicket>(p, "createUpload", { body }),

  completeUpload: (p: Principal, fileUuid: string) =>
    callApi<UploadResult>(p, "completeUpload", { params: { file_uuid: fileUuid } }),

  listFolders: (p: Principal, projectId: string, blueprintId: string) =>
    callApi<LegendPage>(p, "listFolders", { params: bp(projectId, blueprintId) }),

  patchFeatures: (
    p: Principal,
    projectId: string,
    blueprintId: string,
    body: { ids: string[]; name?: string; color?: Rgba; dry_run?: boolean },
  ) => callApi<FeaturePatchResult>(p, "patchFeatures", { params: bp(projectId, blueprintId), body }),

  /** Set the door|window tag and/or the height of ONE opening piece.
   *
   * Field-level and single-feature by contract. The alternative on the API
   * side is a whole-collection PUT, which makes an editor echo back every
   * feature on the sheet to change one number and races anything else editing
   * that sheet. A caller holding a selection fans it out itself.
   *
   * The blueprint owns the path and the project rides in the query string,
   * which is how the API layer spells its blueprint-first routes; the
   * project-first spelling belongs to the batch `features` endpoint above.
   *
   * A height travels as the user stated it: the number, the unit and the user's own
   * words. The server checks the words contain that figure and unit (a height nobody
   * stated is refused), converts to metres, and converts again into the drawing's units
   * through the sheet's scale. None of that is done here.
   *
   * Refusals: 409 the feature is not a wall_surface_with_opening (per element), 404
   * not_found no such feature on this sheet (per element), needs_scale the sheet has no
   * usable scale, invalid_request the height's words do not state it (the same for
   * every element, since every element gets the same body). */
  setOpeningPieceAttributes: (
    p: Principal,
    projectId: string,
    blueprintId: string,
    featureId: string,
    body: { tag?: "door" | "window"; height?: HeightStatement },
  ) =>
    callApi<OpeningPieceAttributes>(p, "setOpeningPieceAttributes", {
      params: { blueprint_id: blueprintId, feature_id: featureId },
      query: { project_id: projectId },
      body,
    }),

  createFolder: (
    p: Principal,
    projectId: string,
    blueprintId: string,
    body: { name: string; parent_id?: string; color?: Rgba; dry_run?: boolean },
  ) => callApi<FolderCreated>(p, "createFolder", { params: bp(projectId, blueprintId), body }),

  moveFeatures: (
    p: Principal,
    projectId: string,
    blueprintId: string,
    body: { ids: string[]; parent_id: string; index?: number; dry_run?: boolean },
  ) => callApi<FeatureMoved>(p, "moveFeatures", { params: bp(projectId, blueprintId), body }),

  importChatAttachment: (
    p: Principal,
    body: {
      download_url: string;
      file_name?: string;
      mime_type?: string;
      project_id?: string;
    },
  ) => callApi<UploadResult>(p, "importChatAttachment", { body }),

  locateBlueprint: (p: Principal, blueprintId: string) =>
    callApi<BlueprintLocation>(p, "locateBlueprint", { params: { blueprint_id: blueprintId } }),

  // ── query routes (behind KAMAI_QUERY_TOOLS) ────────────────────────────────────────
  // Bodies are the route models' own field names. Responses are decoded against the
  // contract schemas in query/contract.ts.

  getVocabulary: (p: Principal) =>
    callApi<Vocabulary>(p, "getVocabulary", { decode: decodeWith(vocabularySchema, "getVocabulary") }),

  querySelect: (p: Principal, projectId: string, body: Record<string, unknown>) =>
    callApi<SelectResult>(p, "querySelect", {
      params: { project_id: projectId },
      body,
      decode: decodeWith(selectResultSchema, "querySelect"),
    }),

  queryAggregate: (p: Principal, projectId: string, body: Record<string, unknown>) =>
    callApi<AggregateResult>(p, "queryAggregate", {
      params: { project_id: projectId },
      body,
      decode: decodeWith(aggregateResultSchema, "queryAggregate"),
    }),

  queryWallSurface: (p: Principal, projectId: string, body: Record<string, unknown>) =>
    callApi<WallSurfaceResult>(p, "queryWallSurface", {
      params: { project_id: projectId },
      body,
      decode: decodeWith(wallSurfaceResultSchema, "queryWallSurface"),
    }),

  queryTable: (
    p: Principal,
    projectId: string,
    body: {
      selection: string;
      language?: string;
      ids_per_row?: number;
      max_ids?: number;
      row?: number;
      row_key?: Record<string, string | null>;
    },
  ) =>
    callApi<TableResult>(p, "queryTable", {
      params: { project_id: projectId },
      body,
      decode: decodeWith(tableResultSchema, "queryTable"),
    }),

  queryResolve: (
    p: Principal,
    projectId: string,
    body: {
      selections: string[];
      rows: Array<{ s: number; group?: Record<string, string | null> }>;
      ids_per_row?: number;
      max_ids?: number;
    },
  ) =>
    callApi<ResolveResult>(p, "queryResolve", {
      params: { project_id: projectId },
      body,
      decode: decodeWith(resolveResultSchema, "queryResolve"),
    }),

  getInventory: (p: Principal, projectId: string, blueprintIds?: readonly string[]) =>
    callApi<InventoryResult>(p, "getInventory", {
      params: { project_id: projectId },
      query: { blueprint_ids: blueprintIds?.length ? blueprintIds.join(",") : undefined },
      decode: decodeWith(inventoryResultSchema, "getInventory"),
    }),

  setScale: (p: Principal, projectId: string, blueprintId: string, label: string) =>
    callApi<ScaleResult>(p, "setScale", {
      params: bp(projectId, blueprintId),
      body: { label },
      decode: decodeWith(scaleResultSchema, "setScale"),
    }),

  geometrySelect: (p: Principal, projectId: string, blueprintId: string, ids: string[], grid?: number) =>
    callApi<GeometrySelectResult>(p, "geometrySelect", {
      params: bp(projectId, blueprintId),
      body: grid === undefined ? { ids } : { ids, grid },
      decode: decodeWith(geometrySelectResultSchema, "geometrySelect"),
    }),
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
  const found = await api.locateBlueprint(principal, blueprintId);
  return found.project_id;
}
