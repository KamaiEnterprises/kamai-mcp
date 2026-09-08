export interface Rgba {
  r?: number;
  g?: number;
  b?: number;
  a?: number;
}

export interface BlueprintSummary {
  id: string;
  name?: string | null;
  ready?: boolean | Record<string, boolean>;
}

export interface JobSummary {
  id: string;
  blueprint_id: string;
  status: string;
  state?: string | null;
  filename?: string;
  progress?: number;
  error_message?: string | null;
  error_code?: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  last_modified?: number | null;
  blueprint_count?: number;
  blueprints?: BlueprintSummary[] | Record<string, BlueprintSummary> | null;
}

export interface ProjectDetail {
  id: string;
  name: string;
  description?: string;
  blueprints?: BlueprintSummary[] | Record<string, BlueprintSummary>;
  blueprint_records?: BlueprintSummary[] | Record<string, BlueprintSummary>;
  jobs?: JobSummary[] | Record<string, JobSummary>;
}

export interface ProjectsData {
  projects: ProjectSummary[];
  count?: number;
}

export type BlueprintState = "ready" | "processing" | "failed";

export interface GeometryFeature {
  i: number;
  cls: string;
  name: string;
  color?: Rgba;
  rings?: number[][] | null;
  lines?: number[][] | null;
  pts?: number[] | null;
  area?: number | null;
  len?: number | null;
}

export interface PageImage {
  url: string;
  w: number;
  h: number;
}

export interface Units {
  area: string;
  length: string;
}

export interface BlueprintData {
  blueprint_id: string;
  name?: string | null;
  project_id: string;
  project_name: string;
  state: BlueprintState;
  progress?: number;
  failed?: boolean;
  error_message?: string | null;
  error_code?: string | null;
  grid?: number;
  image?: PageImage | null;
  features?: GeometryFeature[];
  total?: number;
  truncated?: boolean;
  scale_label?: string | null;
  needs_scale?: boolean;
  scale_unconfirmed?: boolean;
  units?: Units;
}

export interface TakeoffRow {
  group: string;
  cls: string;
  count: number;
  area: number;
  len: number;
  color?: Rgba;
}

export interface TakeoffData {
  blueprint_id: string;
  name?: string | null;
  project_id: string;
  project_name: string;
  state: BlueprintState;
  progress?: number;
  error_message?: string | null;
  rows?: TakeoffRow[];
  totals?: { count: number; area: number; len: number };
  shapes?: number;
  scale_label?: string | null;
  needs_scale?: boolean;
  scale_unconfirmed?: boolean;
  units?: Units;
}

export interface UploadData {
  projects?: Array<{ id: string; name: string }>;
  project_id?: string | null;
  project_name?: string | null;
  state?: string;
  jobs?: JobSummary[] | Record<string, JobSummary>;
  blueprints?: BlueprintSummary[] | Record<string, BlueprintSummary>;
}

export interface UploadTicket {
  file_uuid: string;
  project_id: string;
  project_name?: string | null;
  signed_url: string;
  required_headers?: Record<string, string>;
}

export interface UploadResult {
  job_id?: string | null;
  blueprint_id?: string | null;
  project_id: string;
  project_name?: string | null;
  filename?: string | null;
  status?: string | null;
}
