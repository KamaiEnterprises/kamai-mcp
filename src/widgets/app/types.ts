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
  id?: string | null;
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
  // Present only on the model-facing summary a host without structuredContent forwards.
  classes?: { cls: string; count: number }[];
  features_shown?: number;
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

export type IdMap = Record<string, string[]>;

export interface TableColumn {
  key: string;
  label: string;
  type?: string | null;
  unit?: string | null;
  align?: string | null;
}

export interface TableRow {
  index?: number;
  cells: Record<string, string | number | null>;
  kind?: string;
  element_count: number;
  element_ids?: IdMap;
  element_ids_truncated?: boolean;
  from?: { s: number; group?: Record<string, string | null> };
  /** A Kamai-built row's identity (group_by values or {ref}); absent on a note row. */
  key?: Record<string, string | null> | null;
}

export interface TableData {
  project_id: string;
  project_name?: string | null;
  title: string;
  built_by?: string;
  language?: string;
  blueprints?: Array<{ blueprint_id: string; name?: string | null }>;
  columns: TableColumn[];
  rows: TableRow[];
  selection?: string;
  selections?: string[];
  notes?: string[];
  problems?: Array<{ row: number; reason: string }>;
}

export interface RowElements {
  element_ids: IdMap;
  element_count: number;
  element_ids_truncated: boolean;
  problem?: string;
}

export interface OutlinesPage {
  blueprint_id: string;
  grid: number;
  features: GeometryFeature[];
  missing: string[];
  omitted?: string[];
}

/** Elements a table row lights up on the plan: their ids, and outlines fetched for them
 * (the plan's own page may not hold them all). */
export interface Highlight {
  ids: ReadonlySet<string>;
  outlines: GeometryFeature[];
  grid: number;
}
