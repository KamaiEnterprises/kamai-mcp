import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import {
  ApiError,
  api,
  blueprintDetailSchema,
  blueprintSummarySchema,
  geometryPageSchema,
  projectDetailSchema,
  projectSummarySchema,
  jobSummarySchema,
  resolveProject,
  takeoffPageSchema,
  uploadResultSchema,
  uploadTicketSchema,
} from "./api.ts";
import type { Principal } from "./auth.ts";
import { BadArgument, MAX_LIMIT, buildElementsPage, listElementsOutput } from "./elements.ts";
import {
  FRAME_ORIGINS,
  UI_MIME,
  WIDGET_NAMES,
  isAllowedFrameTarget,
  isWidgetName,
  resourceMeta,
  toolMeta,
  widgetHtml,
  widgetUri,
  type WidgetName,
} from "./widgets/index.ts";

const UI_SCHEME_PREFIX = "ui://kamai/";

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
const READONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

// Superseded by a view_* tool. Still callable by id, just not advertised — every
// advertised tool costs the user another approval prompt. The snake-dialect twin
// keeps them callable from widgets on ChatGPT surfaces that gate on it.
const APP_ONLY = { ui: { visibility: ["app"] }, "openai/widgetAccessible": true };

// Both halves are load-bearing. FastMCP derived an output schema from the Python
// tools' `-> dict` annotation and so emitted content AND structuredContent; the
// widgets read the latter, so dropping it silently hands them undefined.
const text = (value: unknown) => {
  const content = [{ type: "text" as const, text: JSON.stringify(value) }];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { content, structuredContent: value as Record<string, unknown> }
    : { content };
};

function fail(err: unknown): never {
  if (err instanceof ApiError) throw new Error(err.message);
  throw new Error("Something went wrong on the Kamai side.");
}

// Declared where they are built. These four shapes are assembled in this file rather
// than returned by the API layer, so unlike the rest they have no API-side twin.
const listProjectsOutput = z.object({
  projects: z.array(projectSummarySchema),
  count: z.number(),
});

const listJobsOutput = z.object({
  jobs: z.array(jobSummarySchema),
  count: z.number(),
});

const projectsWidgetOutput = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      blueprints: z.array(blueprintSummarySchema),
    }),
  ),
  count: z.number(),
});

// view_blueprint pages the geometry itself and drops the cursor before handing the
// page to the widget, so its output is the page minus that one field.
const blueprintWidgetOutput = geometryPageSchema.omit({ next_cursor: true });

const kamaiAppOutput = z.object({
  url: z.string(),
  open_in: z.string().nullable(),
  expand_button: z.boolean(),
  // Legacy fields, always emitted. Conversations pinned to a probe-era descriptor
  // advertise them as required with additionalProperties: false, and the stateless
  // server cannot push tools/list_changed to update anyone — dropping them fails
  // schema validation on strict clients for as long as those conversations live.
  // chrome: false also keeps a host's still-cached pre-v25 bundle on its product
  // branch instead of the diagnostic it used to fall through to.
  chrome: z.boolean().optional(),
  declared_frame_domains: z.array(z.string()).optional(),
});

const uploadWidgetOutput = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  project_id: z.string().nullable(),
  state: z.string(),
});

function widgetResult(name: WidgetName, structured: object) {
  return {
    content: [],
    structuredContent: { ...structured } as Record<string, unknown>,
    _meta: toolMeta(name),
  };
}

export function buildServer(principal: Principal): McpServer {
  const server = new McpServer(
    { name: "Kamai MCP Server", version: "0.1.0" },
    {
      instructions:
        "Tools for managing Kamai construction-blueprint projects, blueprints, and takeoffs.",
      capabilities: { tools: {}, resources: {} },
    },
  );

  // The id is load-bearing — it is in every cached ui:// URI — but the label is what a
  // host shows in a resource list, so it should read like the product, not the module.
  const RESOURCE_LABEL: Record<WidgetName, string> = {
    projects: "Kamai projects",
    blueprint: "Kamai blueprint",
    takeoff: "Kamai takeoff",
    upload: "Kamai upload",
    iframetest: "Kamai app",
  };

  for (const name of WIDGET_NAMES) {
    registerAppResource(
      server,
      RESOURCE_LABEL[name],
      widgetUri(name),
      { mimeType: UI_MIME, _meta: resourceMeta(name) },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: UI_MIME,
            text: widgetHtml(name),
            _meta: resourceMeta(name),
          },
        ],
      }),
    );
  }

  // Every version, not just the current one. A host caches the tool descriptor — which
  // carries the versioned resourceUri — and keeps serving it to existing connectors and
  // conversations long after a deploy. Registering only the current URI means a
  // WIDGET_VERSION bump 404s every widget for everyone who connected before it, which is
  // exactly what happened going from v10 to v24. The version still busts the host's
  // content cache for anyone who picks up the new descriptor; it just no longer strands
  // anyone holding an old one. Not listed — resources/list advertises the current URIs.
  server.registerResource(
    "Kamai widget (any version)",
    new ResourceTemplate(`${UI_SCHEME_PREFIX}{name}@{version}.html`, { list: undefined }),
    { mimeType: UI_MIME },
    async (uri, variables) => {
      const name = String(variables.name);
      // -32002 is the spec's resource-not-found; a bare throw surfaces as a generic
      // -32603 InternalError, which reads as a server bug rather than a bad URI.
      if (!isWidgetName(name)) throw new McpError(-32002, `Unknown Kamai widget: ${name}`);
      return {
        contents: [
          { uri: uri.href, mimeType: UI_MIME, text: widgetHtml(name), _meta: resourceMeta(name) },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "list_projects",
    {
      title: "List projects",
      description:
        "List the authenticated user's Kamai projects (most-recently-modified first).",
      outputSchema: listProjectsOutput.shape,
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async () => {
      try {
        const page = await api.listProjects(principal);
        return text({ projects: page.items, count: page.items.length });
      } catch (err) {
        fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "view_projects",
    {
      title: "View projects",
      description:
        "Show the user's Kamai projects and their blueprints as an interactive panel. " +
        "Use this whenever the user wants to see, browse or pick a project or blueprint.",
      outputSchema: projectsWidgetOutput.shape,
      annotations: READONLY,
      _meta: toolMeta("projects"),
    },
    async () => {
      try {
        // One request, not 1 + N. The API layer's own parameter doc says this exists so a
        // caller needing blueprints does not have to fetch every project individually — which
        // is exactly what this handler used to do, once per project, on every panel open.
        const page = await api.listProjects(principal, 50, undefined, "blueprints");
        const projects = page.items.map((p) => ({
          id: p.id,
          name: p.name,
          blueprints: (p.blueprints ?? []).map((b) => ({
            id: b.id,
            name: b.name,
            ready: b.ready,
          })),
        }));
        return widgetResult("projects", { projects, count: projects.length });
      } catch (err) {
        fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "get_project",
    {
      title: "Project details",
      description:
        "Get one project's details, including its blueprints and processing jobs.\n\n" +
        "Refer to projects and blueprints by name in your replies. Never show a raw id " +
        "unless the user asks for one.",
      inputSchema: { project_id: z.string() },
      outputSchema: projectDetailSchema.shape,
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async ({ project_id }) => {
      try {
        return text(await api.getProject(principal, project_id));
      } catch (err) {
        fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "get_blueprint",
    {
      title: "Blueprint details",
      description: "Get a blueprint's processing state and readiness.",
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
      },
      outputSchema: blueprintDetailSchema.shape,
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        return text(await api.getBlueprint(principal, projectId, blueprint_id));
      } catch (err) {
        fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "view_blueprint",
    {
      title: "View blueprint",
      description:
        "Display a blueprint page with its take-off shapes drawn on top, as an interactive " +
        "panel. Use this whenever the user wants to see or look at a blueprint, its rooms, " +
        "walls or measured areas.\n\nRefer to the blueprint and project by name in your " +
        "replies. Never show a raw id unless the user asks for one.",
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
      },
      outputSchema: blueprintWidgetOutput.shape,
      annotations: READONLY,
      _meta: toolMeta("blueprint"),
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        const page = await api.getGeometry(principal, projectId, blueprint_id);
        const { next_cursor, ...widgetPayload } = page;
        return widgetResult("blueprint", widgetPayload);
      } catch (err) {
        fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "view_takeoff",
    {
      title: "Takeoff quantities",
      description:
        "Show measured take-off quantities for a blueprint as a sortable table, grouped " +
        "by Areas / Lines / Objects with per-class counts, areas and lengths. Use this " +
        "when the user asks about quantities, measurements, areas, how much of something " +
        "there is, or wants a take-off summary.\n\nRefer to the blueprint and project by " +
        "name in your replies. Never show a raw id unless the user asks for one.",
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
      },
      outputSchema: takeoffPageSchema.shape,
      annotations: READONLY,
      _meta: toolMeta("takeoff"),
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        return widgetResult(
          "takeoff",
          await api.getTakeoff(principal, projectId, blueprint_id),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

  // Not a widget. view_blueprint already fetches this exact geometry and hands it to a
  // canvas, which is why the gap was easy to miss: the shapes were on screen but never in
  // the model's hands, so the only per-element answer anyone could give was to read them
  // off the picture. Structured output, no _meta.ui — this one is for the model.
  server.registerTool(
    "list_elements",
    {
      title: "List blueprint elements",
      description:
        "List a blueprint's individual take-off elements: one row per room, wall, door, " +
        "window or object, with its class, the folder it sits in on the drawing, its " +
        "measured area or length, and its outline. This is the per-element counterpart to " +
        "`view_takeoff`, which returns only per-class totals — use view_takeoff for " +
        "quantities, and this when the user asks about particular elements, their sizes, " +
        "where they are, or what is inside one folder.\n\n" +
        "Narrow it with `cls`, `folder` and `name` (case-insensitive substring match). " +
        "Kamai's geometry endpoint has no filter of its own, so this tool reads the " +
        "blueprint and filters here: `matched`, `filter_scanned` and `filter_complete` say " +
        "what the filter actually saw, and `filter_complete` false means elements exist " +
        "that were never checked.\n\n" +
        "`rings`, `lines` and `pts` are flat [x0,y0,x1,y1,...] integer paths in the " +
        "blueprint's own drawing space, where the page is `grid` units wide. They give " +
        "shape and position, not size: quote `area` and `len` in `units` for measurements, " +
        "and never compute a measurement from the coordinates. Both are null when " +
        "`needs_scale` is true, and provisional when `scale_unconfirmed` is true.\n\n" +
        "Outlines are bulky, so pages are small: `limit` defaults to 50 and is held to 100 " +
        "while `include_geometry` is true. A page is also held to a size budget, so " +
        "`returned` can be smaller than `limit` — a single traced wall can carry thousands " +
        "of points. Pass include_geometry false for a cheaper index of up to 400 elements " +
        "with names, classes and measurements only. Always check `truncated` and read " +
        "`notes` before telling the user what a blueprint contains — a truncated page is " +
        "not the blueprint.\n\n" +
        "Refer to the blueprint and project by name in your replies. Never show a raw id " +
        "unless the user asks for one.",
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
        cls: z
          .string()
          .min(1)
          .optional()
          .describe("Keep only elements whose class contains this text, case-insensitively (door, room, wall, window, ...)."),
        folder: z
          .string()
          .min(1)
          .optional()
          .describe("Keep only elements whose drawing folder contains this text, case-insensitively. This is the grouping view_takeoff summarises."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("Keep only elements whose name contains this text, case-insensitively."),
        include_geometry: z
          .boolean()
          .optional()
          .describe("Return rings, lines and pts for each element. Default true — that geometry is the point of this tool. Set false for a longer, cheaper list of names and measurements."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe("Elements per page. Default 50; reduced to 100 when include_geometry is true, and reduced further if the outlines on the page are large. Either reduction is reported in `notes`."),
        cursor: z
          .string()
          .optional()
          .describe("`next_cursor` from a previous call, passed back exactly as it was given. A filtered cursor is an offset into one filter's matches, so it is bound to the exact cls, folder and name that produced it and is refused with any others; an unfiltered cursor counts rows and is refused if you add a filter. Change a filter and you start a new listing, without a cursor."),
      },
      outputSchema: listElementsOutput.shape,
      annotations: READONLY,
    },
    async ({ blueprint_id, project_id, ...args }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        return text(
          await buildElementsPage(
            (limit, cursor) => api.getGeometry(principal, projectId, blueprint_id, limit, cursor),
            args,
            // Scope for the filtered-scan cache. The token is in the key as well as the
            // uid: the scan holds one principal's view of one blueprint, so anything that
            // could change what this caller is allowed to see must change the key.
            `${principal.uid}\u0000${principal.token}\u0000${projectId}\u0000${blueprint_id}`,
          ),
        );
      } catch (err) {
        // A bad cursor is the caller's mistake and its message is already the fix, so it
        // goes through as written; fail() would flatten it into "something went wrong on
        // the Kamai side", which sends the model hunting an outage instead of fixing the
        // call. Only this module's own BadArgument gets that pass — anything else still
        // goes through fail(), which never leaks an upstream detail string.
        if (err instanceof BadArgument) throw new Error(err.message);
        fail(err);
      }
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description: "Create a new Kamai project to hold blueprints.",
      inputSchema: { name: z.string().min(1), description: z.string().optional() },
      outputSchema: projectSummarySchema.shape,
      annotations: WRITE,
    },
    async ({ name, description }) => {
      try {
        return text(await api.createProject(principal, name, description ?? ""));
      } catch (err) {
        fail(err);
      }
    },
  );

  server.registerTool(
    "update_project",
    {
      title: "Rename a project",
      description: "Change a project's name or description.",
      inputSchema: {
        project_id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
      },
      outputSchema: projectSummarySchema.shape,
      annotations: DESTRUCTIVE,
    },
    async ({ project_id, name, description }) => {
      try {
        return text(await api.updateProject(principal, project_id, { name, description }));
      } catch (err) {
        fail(err);
      }
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "Upload jobs of a project",
      description:
        "List a project's processing jobs, newest first — one per uploaded page, with " +
        "status, progress and any error. Use it to see what is still running or why " +
        "something failed. Refer to jobs by their filename, not by id.",
      inputSchema: { project_id: z.string() },
      outputSchema: listJobsOutput.shape,
      annotations: READONLY,
    },
    async ({ project_id }) => {
      try {
        const jobs = await api.listJobs(principal, project_id);
        return text({ jobs, count: jobs.length });
      } catch (err) {
        fail(err);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "One upload job",
      description: "Get one processing job's status, progress and error, if any.",
      inputSchema: { project_id: z.string(), job_id: z.string() },
      outputSchema: jobSummarySchema.shape,
      annotations: READONLY,
    },
    async ({ project_id, job_id }) => {
      try {
        return text(await api.getJob(principal, project_id, job_id));
      } catch (err) {
        fail(err);
      }
    },
  );

  server.registerTool(
    "cancel_job",
    {
      title: "Cancel an upload job",
      description:
        "Cancel a processing job that is still pending or running. A job that already " +
        "finished or failed cannot be cancelled and is reported as such. Cancelling marks " +
        "the job; work already in progress on the Kamai side may still run to completion.",
      inputSchema: { project_id: z.string(), job_id: z.string() },
      outputSchema: jobSummarySchema.shape,
      annotations: DESTRUCTIVE,
    },
    async ({ project_id, job_id }) => {
      try {
        return text(await api.cancelJob(principal, project_id, job_id));
      } catch (err) {
        fail(err);
      }
    },
  );

  server.registerTool(
    "request_blueprint_upload",
    {
      title: "Start a blueprint upload",
      description:
        "Step 1 of 2: request a pre-signed URL to upload a blueprint PDF.\n\n" +
        "Returns `file_uuid`, `signed_url`, and `required_headers`. Send an HTTP PUT of the " +
        "raw file bytes to `signed_url` with exactly the headers in `required_headers`, then " +
        "call `finalize_blueprint_upload(file_uuid)` to validate the upload and start " +
        "processing. Uses the user's Default Project when `project_id` is omitted.\n\n" +
        "When telling the user which project the blueprint went to, say `project_name`. " +
        "Never show a raw project id unless the user asks for it.\n\n" +
        "Called by the upload panel, which PUTs from the widget sandbox.",
      inputSchema: {
        filename: z.string().optional(),
        project_id: z.string().optional(),
        mime_type: z.string().optional(),
      },
      outputSchema: uploadTicketSchema.shape,
      annotations: WRITE,
      // App-only. The ticket contains a GCS V4 signed URL, which is a bearer
      // credential — model-visible output puts it in the transcript. The widget is
      // also the better client for it: UploadWidget already calls this and
      // finalize_blueprint_upload directly, PUTs from the sandbox with real progress,
      // and needs no allowlist changes in the user's MCP client.
      _meta: APP_ONLY,
    },
    async ({ filename, project_id, mime_type }) => {
      try {
        return text(await api.createUpload(principal, { filename, project_id, mime_type }));
      } catch (err) {
        fail(err);
      }
    },
  );

  server.registerTool(
    "finalize_blueprint_upload",
    {
      title: "Finish a blueprint upload",
      description:
        "Step 2 of 2: finalize a blueprint upload started with `request_blueprint_upload`.\n\n" +
        "Call this after PUTting the file to the signed URL. Validates the uploaded file, " +
        "files it under the project, and starts the processing pipeline. Returns the job_id, " +
        "the project_id and the project_name.\n\n" +
        "When telling the user where the blueprint landed, use `project_name`, not the id.",
      inputSchema: { file_uuid: z.string() },
      outputSchema: uploadResultSchema.shape,
      annotations: WRITE,
      // App-only: the other half of a flow the widget drives end to end.
      _meta: APP_ONLY,
    },
    async ({ file_uuid }) => {
      try {
        return text(await api.completeUpload(principal, file_uuid));
      } catch (err) {
        fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "view_upload",
    {
      title: "Upload a blueprint",
      description:
        "Open an upload panel where the user can pick a blueprint PDF and watch it process. " +
        "Use this whenever the user wants to upload, add or import a blueprint.",
      inputSchema: { project_id: z.string().optional() },
      outputSchema: uploadWidgetOutput.shape,
      annotations: WRITE,
      _meta: toolMeta("upload"),
    },
    async ({ project_id }) => {
      try {
        const page = await api.listProjects(principal, 100);
        return widgetResult("upload", {
          projects: page.items.map((p) => ({ id: p.id, name: p.name })),
          project_id: project_id ?? null,
          state: "idle",
        });
      } catch (err) {
        fail(err);
      }
    },
  );

  server.registerTool(
    "ingest_blueprint_from_chat",
    {
      title: "Import an attached blueprint",
      description:
        "Ingest a blueprint PDF the user attached in this ChatGPT message and start processing.\n\n" +
        "Attach the blueprint PDF to your message, then call this tool. Returns the job_id and " +
        "project_id; uses the user's Default Project when project_id is omitted. ChatGPT web only.",
      inputSchema: {
        // App submission is validated against ChatGPT's fixed file schema and is
        // rejected if this diverges: download_url and file_id required, mime_type
        // and file_name optional. Widening any of it fails the tool scan.
        blueprint_file: z.object({
          download_url: z.string(),
          file_id: z.string(),
          mime_type: z.string().optional(),
          file_name: z.string().optional(),
        }),
        project_id: z.string().optional(),
      },
      outputSchema: uploadResultSchema.shape,
      // The only tool that reaches a host Kamai does not control.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { "openai/fileParams": ["blueprint_file"] },
    },
    async ({ blueprint_file, project_id }) => {
      if (!blueprint_file.download_url?.startsWith("https://")) {
        throw new Error(
          "The attachment reference has no usable download_url. Re-attach the PDF on ChatGPT web, " +
            "or use view_upload to pick the file directly.",
        );
      }
      try {
        return text(
          await api.importChatAttachment(principal, {
            download_url: blueprint_file.download_url,
            file_name: blueprint_file.file_name,
            mime_type: blueprint_file.mime_type,
            project_id,
          }),
        );
      } catch (err) {
        fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "open_kamai",
    {
      title: "Open Kamai",
      description:
        "Open the Kamai app in a panel: browse projects and blueprints, view a plan with its " +
        "detected rooms, walls and objects, and read the takeoff quantities. Use this when the " +
        "user wants to see, open or work in Kamai.",
      inputSchema: {
        mode: z
          .enum(["inline", "fullscreen", "pip"])
          .optional()
          .describe("Panel size to open in. Defaults to fullscreen; ChatGPT web does not honour pip."),
        expand_button: z
          .boolean()
          .optional()
          .describe("Show the fallback Expand button overlaid on the app. Default true."),
        url: z
          .string()
          .optional()
          .describe(
            `Which Kamai to open. One of: ${FRAME_ORIGINS.join(", ")}. ` +
              "Defaults to the first, so a tunnelled dev build can be made the default " +
              "via KAMAI_APP_ORIGINS without changing the call.",
          ),
      },
      outputSchema: kamaiAppOutput.shape,
      annotations: READONLY,
      _meta: toolMeta("iframetest"),
    },
    async ({ mode, expand_button, url }) => {
      const target = url ?? FRAME_ORIGINS[0]!;
      if (!isAllowedFrameTarget(target)) {
        throw new Error(
          `${target} is not in the framing allowlist (${FRAME_ORIGINS.join(", ")}). ` +
            "Add it to KAMAI_APP_ORIGINS and restart.",
        );
      }
      return widgetResult("iframetest", {
        url: target,
        // One setting. pip is documented but ChatGPT web coerces it away, so offering
        // it as a default just produces an unpredictable panel.
        open_in: mode ?? "fullscreen",
        // Ours is a fallback. Set false once Kamai renders its own control and posts
        // requestDisplayMode up to the widget.
        expand_button: expand_button ?? true,
        chrome: false,
        declared_frame_domains: [...FRAME_ORIGINS],
      });
    },
  );

  return server;
}
