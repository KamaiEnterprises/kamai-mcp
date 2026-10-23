import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import {
  ApiError,
  api,
  blueprintDetailSchema,
  blueprintSummarySchema,
  featureMovedSchema,
  featurePatchResultSchema,
  folderCreatedSchema,
  geometryPageSchema,
  legendPageSchema,
  openingPieceAttributesSchema,
  planExportSchema,
  exportResultSchema,
  projectDetailSchema,
  projectSummarySchema,
  jobSummarySchema,
  latestUploadSchema,
  noticeOf,
  resolveProject,
  rgbaSchema,
  takeoffPageSchema,
  uploadResultSchema,
  uploadTicketSchema,
} from "./api.ts";
import type { GeometryPage, OpeningPiecesWritten } from "./api.ts";
import type { Principal } from "./auth.ts";
import { HOST_PROBE, MARKUPS, NO_INSTRUCTIONS, OPEN_KAMAI_LINK, PANEL_SIGN_IN, PRINTED_TABLES, QUERY_TOOLS, ROTATION, clientFamily } from "./config.ts";
import { registerHostProbe } from "./host-probe.ts";
import { mintPanelCode } from "./panel-code.ts";
import { BadArgument, MAX_LIMIT, buildElementsPage, listElementsOutput } from "./elements.ts";
import { toolErrorText } from "./errors.ts";
import { looseOutput } from "./loose.ts";
import {
  APP_ONLY,
  DESTRUCTIVE_IDEMPOTENT,
  READONLY,
  WRITE,
  fileLink,
  text,
} from "./tool-kit.ts";
import { registerListBlueprints } from "./query/list-blueprints.ts";
import { registerMarkupTools } from "./markups.ts";
import { selectionSchema } from "./query/filters.ts";
import { registerQueryTools } from "./query/tools.ts";
import { refreshVocabulary } from "./query/vocabulary.ts";
import {
  EDIT_IDS_GUIDE,
  EDIT_IDS_SENTENCE,
  LIST_ELEMENTS_PREFIX,
  RESULT_LINK,
  SERVER_INSTRUCTIONS,
  VIEW_BLUEPRINT_SUFFIX,
  VIEW_TAKEOFF_HEAD,
} from "./query/descriptions.ts";
import type { ToolContext } from "./query/context.ts";
import { HEIGHT_UNITS } from "./query/contract.ts";
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

// The one class the attributes route will write. Spelled once, and used in the
// tool's prose, in its refusals, and in the filter those refusals tell the
// caller to run, so the three cannot drift apart.
const OPENING_PIECE_CLASS = "wall_surface_with_opening";

// The API route's own ceiling on one selection; past it the caller is told to split.
const MAX_WRITE_IDS = 200;

/** Where the ids of opening pieces come from, in the words the tool list at hand can
 * honour: find_elements exists only with the query tools. */
const openingPieceIds = (queryTools: boolean): string =>
  queryTools
    ? `Get the ids from find_elements with category opening_pieces (or list_elements with cls ${OPENING_PIECE_CLASS}).`
    : `Get the ids from list_elements with cls set to ${OPENING_PIECE_CLASS}.`;

/** Why one opening piece was turned away (the API's per-element `code`), phrased so the
 * model can fix it in this turn. */
function elementRefusal(code: string, queryTools: boolean): string {
  if (code === "wrong_class") {
    return (
      "That element is not a wall-surface opening piece, so no height and no door/window tag " +
      `can be stored on it. Only elements of class ${OPENING_PIECE_CLASS} carry those two ` +
      `fields. ${openingPieceIds(queryTools)} Write to the ids that returns. An opening itself ` +
      "is not one of them, and its tag is the mark printed on the sheet, which is never rewritten."
    );
  }
  return "No element with that id is on this sheet. Read the ids again with list_elements.";
}

/** A refusal of the whole call, which Kamai gives before writing anything. */
function callRefusal(err: ApiError, queryTools: boolean): string | null {
  if (err.code === "needs_scale") return toolErrorText(err, "set_opening_height", { queryTools });
  if (err.code === "invalid_request" && err.detail) return err.detail;
  if (err.code === "route_missing") return err.message;
  return null;
}

// Declared where they are built. These four shapes are assembled in this file rather
// than returned by the API layer, so unlike the rest they have no API-side twin.
const listProjectsOutput = z.object({
  projects: z.array(projectSummarySchema),
  count: z.number(),
});

const listJobsOutput = z.object({
  latest_upload: latestUploadSchema.nullish(),
  jobs: z.array(jobSummarySchema),
  count: z.number(),
  next_offset: z.number().nullish(),
  older_not_listed: z.boolean().nullish(),
});

// One page of jobs: a project with over a hundred jobs listed them in more characters than claude.ai
// takes from one tool result.
const JOBS_PAGE = 25;
// Kamai is asked for the first offset + limit + 1 jobs and the page is cut here: right on a Kamai that ignores
// limit and offset too. The API layer takes up to 1000.
const JOBS_MAX_OFFSET = 899;

// One PATCH per element, one row per element in the answer. `written` carries
// what the sheet now stores for each element the write reached, and `refused`
// carries the rest with the reason each one gave: an id that was turned away
// must never be folded into a count that reads as a success over it. `applied`
// is a restatement of `changed > 0`, kept because the other write tools in
// this file all report one.
const setOpeningHeightOutput = z.object({
  applied: z.boolean(),
  changed: z.number(),
  fields: z.array(z.string()),
  written: z.array(openingPieceAttributesSchema),
  refused: z.array(z.object({ id: z.string(), reason: z.string() })),
});

const projectsWidgetOutput = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      app_url: z.string().nullish(),
      blueprints: z.array(blueprintSummarySchema),
    }),
  ),
  count: z.number(),
});

// view_blueprint pages the geometry itself and drops the cursor before handing the
// page to the widget, so its output is the page minus that one field.
const blueprintWidgetOutput = geometryPageSchema.omit({ next_cursor: true, classes: true });

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
  panel_sign_in: z.boolean().optional(),
});

// export's element_ids declares only the {blueprint_id: [ids]} map (Microsoft 365 Copilot never offered the tool
// while it was array-or-map); a bare array is still taken and handed to the API exactly as it came.
const BARE_IDS = "\u0000bare";
const bareIdsBack = <T extends { rows: Array<Record<string, unknown>> }>(table: T): T => ({
  ...table,
  rows: table.rows.map((row) => {
    const ids = row.element_ids as Record<string, string[]> | undefined;
    return ids && Object.keys(ids).length === 1 && BARE_IDS in ids ? { ...row, element_ids: ids[BARE_IDS] } : row;
  }),
});

const uploadWidgetOutput = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string(), app_url: z.string().nullish() })),
  project_id: z.string().nullable(),
  app_url: z.string().nullish(),
  state: z.string(),
});

// Both halves are load-bearing for widgets, same as `text()` above. Claude and
// ChatGPT read structuredContent over the MCP Apps channel; Open WebUI's MCP App
// Bridge (and hosts that drop structuredContent, ext-apps#696) only forward
// content[0].text into the widget shim. Empty content left open_kamai stuck on
// "Loading Kamai…" with the nested iframe never mounted.
//
// content is model-visible, so it carries `forModel` when given: a geometry page runs to
// hundreds of KB on a large sheet and its image.url is a signed GCS URL, which must stay
// out of the transcript for the same reason request_blueprint_upload is app-only.
//
// structuredContent goes through the tool's own outputSchema: the advertised JSON Schema is
// additionalProperties: false, and the API grows fields the mirror in api.ts does not know
// yet (geometry text/text_total/text_next_cursor, takeoff row folder). The SDK's own check
// strips them silently, a validating client (Open WebUI's bridge, mcp 1.27) rejects the call.
function widgetResult(
  name: WidgetName,
  schema: z.ZodObject,
  structured: object,
  forModel: object = structured,
) {
  const structuredContent = schema.parse(structured) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(forModel) }],
    structuredContent,
    _meta: toolMeta(name),
  };
}

// What the model needs to talk about a blueprint: its identity, state, scale and what
// is on it by class (Kamai's counts over the whole sheet). Rendering data (outlines, image)
// stays in structuredContent.
function blueprintSummary(page: Omit<GeometryPage, "next_cursor">) {
  const { image: _image, features, ...rest } = page;
  return { ...rest, features_shown: features.length, classes: page.classes ?? null };
}

export interface HostHints {
  // Only ChatGPT fills ingest_blueprint_from_chat's file parameter. Advertised anywhere else it
  // is the tool a model reaches for first on "upload this PDF", and it can only fail.
  chatgpt?: boolean;
  // The calling MCP client's User-Agent, for the host probe's log line: the frame cannot see
  // which backend relayed its call, and that is the most reliable host signal there is.
  userAgent?: string;
}

export interface ServerOptions {
  /** Register the query tools (KAMAI_QUERY_TOOLS=on). Settable so tests can flip it. */
  queryTools?: boolean;
  /** Register get_printed_tables with the query tools (KAMAI_PRINTED_TABLES=on). Settable so tests can flip it. */
  printedTables?: boolean;
  /** Register set_rotation with the query tools (on unless KAMAI_ROTATION=off). Settable so tests can flip it. */
  rotation?: boolean;
  /** The markup tools and download_plan's include_markups (KAMAI_MARKUPS=on). Settable so tests can flip it. */
  markups?: boolean;
  /** Send the server `instructions`. Off emulates hosts that drop them (claude.ai). */
  instructions?: boolean;
  /** Panel sign-in for open_kamai (KAMAI_PANEL_SIGN_IN=on). Settable so tests can flip it. */
  panelSignIn?: boolean;
  /** The host-capability probe (KAMAI_HOST_PROBE, default on in dev/debug only). Settable so tests can flip it. */
  hostProbe?: boolean;
  /** Client families that get open_kamai as a link card (KAMAI_OPEN_KAMAI_LINK). Settable so tests can flip it. */
  openKamaiLink?: Set<string>;
}

const BASE_INSTRUCTIONS =
  "Tools for managing Kamai construction-blueprint projects, blueprints, and takeoffs. After an action (create, " +
  "update, move, cancel, upload, download), give its `app_url` as a link named \"Open in Kamai\", never as a bare " +
  "URL; ids are for tool calls, never shown to the user unless they ask.";

export function buildServer(
  principal: Principal,
  host: HostHints = {},
  opts: ServerOptions = {},
): McpServer {
  const queryTools = opts.queryTools ?? QUERY_TOOLS;
  const withInstructions = opts.instructions ?? !NO_INSTRUCTIONS;
  const panelSignIn = opts.panelSignIn ?? PANEL_SIGN_IN;
  const hostProbe = opts.hostProbe ?? HOST_PROBE;
  const openAsLink = (opts.openKamaiLink ?? OPEN_KAMAI_LINK).has(clientFamily(host.userAgent));
  const server = new McpServer(
    { name: "Kamai MCP Server", version: "0.1.0" },
    {
      // Claude.ai drops instructions, so every rule here is also in a tool description.
      ...(withInstructions ? { instructions: queryTools ? SERVER_INSTRUCTIONS : BASE_INSTRUCTIONS } : {}),
      capabilities: { tools: {}, resources: {} },
    },
  );

  // What a failed call tells the model. Every call site names its tool, so the generic
  // branch can say which one failed.
  const fail: (err: unknown, tool: string) => never = (err, tool) => {
    throw new Error(toolErrorText(err, tool, { queryTools }));
  };

  const ctx: ToolContext = {
    principal,
    queryTools,
    printedTables: opts.printedTables ?? PRINTED_TABLES,
    rotation: opts.rotation ?? ROTATION,
    fail,
  };
  const markups = opts.markups ?? MARKUPS;

  // The id is load-bearing — it is in every cached ui:// URI — but the label is what a
  // host shows in a resource list, so it should read like the product, not the module.
  const RESOURCE_LABEL: Record<WidgetName, string> = {
    projects: "Kamai projects",
    blueprint: "Kamai blueprint",
    takeoff: "Kamai takeoff",
    upload: "Kamai upload",
    iframetest: "Kamai app",
    table: "Kamai table",
    probe: "Kamai host probe",
  };

  // The table widget is listed only with the query tools, and the probe only with its flag,
  // so resources/list with the flags off is what it was. The any-version template below
  // still serves them either way.
  for (const name of WIDGET_NAMES.filter((n) => (queryTools || n !== "table") && (hostProbe || n !== "probe"))) {
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
      // The probe resolves only where its tools are registered, so prod answers for it
      // as for any unknown name.
      if (!isWidgetName(name) || (name === "probe" && !hostProbe)) {
        throw new McpError(-32002, `Unknown Kamai widget: ${name}`);
      }
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
      outputSchema: looseOutput(listProjectsOutput),
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async () => {
      try {
        const page = await api.listProjects(principal);
        const notice = noticeOf(page);
        return text({ projects: page.items, count: page.items.length, ...(notice ? { notice } : {}) });
      } catch (err) {
        fail(err, "list_projects");
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
      outputSchema: looseOutput(projectsWidgetOutput),
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
          ...(p.app_url ? { app_url: p.app_url } : {}),
          blueprints: (p.blueprints ?? []).map((b) => ({
            id: b.id,
            name: b.name,
            ready: b.ready,
          })),
        }));
        const notice = noticeOf(page);
        // The notice goes to the model only: structuredContent keeps the closed schema hosts have pinned.
        return widgetResult("projects", projectsWidgetOutput, { projects, count: projects.length },
          { projects, count: projects.length, ...(notice ? { notice } : {}) });
      } catch (err) {
        fail(err, "view_projects");
      }
    },
  );

  registerListBlueprints(server, ctx);
  if (markups) registerMarkupTools(server, ctx);
  // Behind KAMAI_QUERY_TOOLS: every one of these needs an API route an older API layer
  // does not serve.
  if (queryTools) {
    // Builds this request's enums from the vocabulary as it is; a due re-read lands for later ones.
    void refreshVocabulary(() => api.getVocabulary(principal));
    registerQueryTools(server, ctx);
  }

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
      outputSchema: looseOutput(projectDetailSchema),
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async ({ project_id }) => {
      try {
        return text(await api.getProject(principal, project_id));
      } catch (err) {
        fail(err, "get_project");
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
      outputSchema: looseOutput(blueprintDetailSchema),
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        return text(await api.getBlueprint(principal, projectId, blueprint_id));
      } catch (err) {
        fail(err, "get_blueprint");
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
        "replies. Never show a raw id unless the user asks for one." +
        (queryTools ? VIEW_BLUEPRINT_SUFFIX : ""),
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
      },
      outputSchema: looseOutput(blueprintWidgetOutput),
      annotations: READONLY,
      _meta: toolMeta("blueprint"),
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        const page = await api.getGeometry(principal, projectId, blueprint_id, undefined, undefined, { include: "classes" });
        // A route without include=classes would leave the model no class counts at all.
        if (page.state === "ready" && !Array.isArray(page.classes)) {
          throw new Error("geometry route did not return the class counts");
        }
        const { next_cursor, ...widgetPayload } = page;
        return widgetResult("blueprint", blueprintWidgetOutput, widgetPayload, blueprintSummary(widgetPayload));
      } catch (err) {
        fail(err, "view_blueprint");
      }
    },
  );

  registerAppTool(
    server,
    "view_takeoff",
    {
      title: "Takeoff quantities",
      description:
        (queryTools
          ? VIEW_TAKEOFF_HEAD
          : "Show measured take-off quantities for a blueprint as a sortable table, grouped " +
            "by Areas / Lines / Objects with per-class counts, areas and lengths. Use this " +
            "when the user asks about quantities, measurements, areas, how much of something " +
            "there is, or wants a take-off summary.") +
        "\n\nRefer to the blueprint and project by " +
        "name in your replies. Never show a raw id unless the user asks for one.",
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
      },
      outputSchema: looseOutput(takeoffPageSchema),
      annotations: READONLY,
      _meta: toolMeta("takeoff"),
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        return widgetResult(
          "takeoff",
          takeoffPageSchema,
          await api.getTakeoff(principal, projectId, blueprint_id),
        );
      } catch (err) {
        fail(err, "view_takeoff");
      }
    },
  );

  server.registerTool(
    "download_plan",
    {
      title: "Download marked-up plan",
      description:
        (queryTools ? "Older name for `export` of a plan; prefer export. " : "") +
        "Make a PDF of a processed blueprint with its detected elements drawn on the original " +
        "drawing, and return a temporary download link. Use this when the user wants the plan " +
        "as a file, to download, print or send it, with some or all elements highlighted.\n\n" +
        "Choose what is drawn with `highlight` (what to show, in plain words: doors, windows, " +
        "rooms, walls, a class such as sink, or a folder name from the drawing) and/or " +
        "`element_ids` (exact elements, from list_elements or a selection in the plan view). " +
        "Both together draw the union; neither draws every element. `unmatched_highlight` and " +
        "`missing_ids` name what matched nothing: tell the user rather than ignore it.\n\n" +
        "Give the user `url` as a clickable link in your reply; never download or open it " +
        "yourself, a code sandbox cannot reach it. Name the link by `file_name` and say that it expires " +
        "after `expires_in` seconds; they can ask again for a fresh one. Set `legend: true` only when " +
        "the user asks for a legend: it adds a page naming each kind drawn, its colour and count.\n\n" +
        "Refer to the blueprint and project by name in your replies. " +
        RESULT_LINK,
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
        highlight: z
          .array(z.string().min(1).max(100))
          .max(25)
          .optional()
          .describe("What to draw, one entry per kind, e.g. [\"doors\", \"windows\"]. Categories, classes and folder names all work; plurals are fine."),
        element_ids: z
          .array(z.string().min(1))
          .max(5000)
          .optional()
          .describe("Exact element ids to draw, as list_elements or the plan view gives them."),
        legend: z.boolean().optional().describe("Add a legend page. Only when the user asks for one."),
        ...(markups
          ? {
              include_markups: z
                .boolean()
                .optional()
                .describe("Also draw the sheet's markups (revision clouds, highlights, notes). Off unless the user asks for them."),
            }
          : {}),
      },
      outputSchema: looseOutput(planExportSchema),
      annotations: READONLY,
      // The plan view's Download PDF button calls this; ChatGPT gates widget calls on the flag.
      _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
    },
    async ({ blueprint_id, project_id, highlight, element_ids, legend, include_markups }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        // A model writes "doors, windows" as one entry as often as two.
        const terms = (highlight ?? []).flatMap((h) => h.split(",")).map((h) => h.trim()).filter(Boolean);
        return fileLink(
          await api.exportPlan(principal, projectId, blueprint_id, {
            ...(terms.length ? { highlight: terms } : {}),
            ...(element_ids?.length ? { element_ids } : {}),
            ...(legend ? { legend: true } : {}),
            ...(markups && include_markups ? { include_markups: true } : {}),
          }),
        );
      } catch (err) {
        fail(err, "download_plan");
      }
    },
  );

  if (queryTools) {
    const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
    server.registerTool(
      "export",
      {
        title: "Export a plan or a table",
        description:
          "Make a file of Kamai data and return a temporary download link: a marked-up plan, or a table.\n\n" +
          "A plan: give `blueprint_id` and nothing of a table. The file is a PDF of the original drawing " +
          "with the detected elements drawn on it. Choose what is drawn with `highlight` (what to show, in " +
          "plain words: doors, windows, rooms, walls, a class such as sink, or a folder name from the drawing) " +
          "and/or `element_ids` (exact elements); both together draw the union, neither draws every element. " +
          "Set `legend: true` only when the user asks for a legend: it adds a page naming each kind drawn, its " +
          "colour and count. `unmatched_highlight` and `missing_ids` name what matched nothing: tell the user " +
          "rather than ignore it.\n\n" +
          "A table: give `project_id` and pass `selection`, the selection of a count_elements, find_elements, " +
          "calculate_wall_surface_area or render_table result: Kamai builds the table from it with " +
          "every element of every row, so each is numbered. Set `language` to the language you are " +
          "writing in and `name` to the file's title. Pass `table` (columns and rows as render_table " +
          "returned them) only for a table Kamai cannot build, or `saved_table_id` for a table saved in Kamai. " +
          "Formats: `xlsx` (Excel: the table, plus the plan picture with each row's elements numbered #N; " +
          "`include_plan: false` leaves the picture out), `pdf` (the table alone; `include_plan: true` puts " +
          "the plan with each row's elements numbered #N first, so plan and table are one PDF), `png` (only " +
          "the numbered plan picture), `csv_cf` (a CSV in the Contractor Foreman import layout). Give " +
          "`blueprint_id` for the sheet the plan is drawn on. When the rows come from several sheets, a pdf " +
          "with `include_plan` takes `blueprint_ids` instead: one drawing page per sheet in that order, the " +
          "elements numbered #N across all of them, then the table.\n\n" +
          "This is the way to make a file of Kamai data: never build a spreadsheet, PDF or CSV " +
          "yourself in a code sandbox, it would number nothing on the plan.\n\n" +
          "Give the user `url` as a clickable link in your reply; never download or open it " +
          "yourself, a code sandbox cannot reach it. Name the link by `file_name` and say that it expires " +
          "after `expires_in` seconds; they can ask again for a fresh one.\n\n" +
          "Refer to the blueprint and project by name in your replies. " +
          RESULT_LINK,
        inputSchema: {
          project_id: z.string().optional().describe("The project. Required for a table; a plan finds it from `blueprint_id`."),
          format: z.enum(["xlsx", "pdf", "png", "csv_cf"]).optional().describe("A table's file format; a plan is always a pdf."),
          blueprint_id: z.string().optional(),
          blueprint_ids: z.array(z.string().min(1)).min(1).max(100).optional(),
          saved_table_id: z.string().optional(),
          selection: selectionSchema
            .optional()
            .describe("The `selection` of a count_elements, find_elements, calculate_wall_surface_area or render_table result."),
          name: z.string().max(200).optional().describe("The table's title in the file."),
          language: z
            .string()
            .regex(/^[a-z]{2}$/)
            .optional()
            .describe("Two-letter code of the language you are writing in, for the column labels."),
          table: z
            .looseObject({
              name: z.string().max(200).optional(),
              title: z.string().max(200).nullish(),
              columns: z
                .array(z.looseObject({ key: z.string(), label: z.string(), type: z.string().nullish() }))
                .min(1)
                .max(100),
              rows: z
                .array(
                  z.looseObject({
                    id: z.string().optional(),
                    index: z.number().optional(),
                    cells: z.record(z.string(), cellValue),
                    // One form, the {blueprint_id: [ids]} map the table tools return: Microsoft 365 Copilot
                    // never offered this tool while it was array-or-map.
                    // A bare array (the older form) is still taken, under the sheet the export draws on;
                    // only the map is declared.
                    element_ids: z
                      .preprocess(
                        (value) => (Array.isArray(value) ? { [BARE_IDS]: value } : value),
                        z.record(z.string(), z.array(z.string()).max(5000)),
                      )
                      .optional()
                      .describe("{blueprint_id: [element ids]} of the row, as the table tools returned it."),
                  }),
                )
                .max(5000),
            })
            .optional()
            .describe("The table to export, as render_table, count_elements or find_elements returned it."),
          include_plan: z
            .boolean()
            .optional()
            .describe("A table only. pdf: put the numbered plan before the table (off unless asked). xlsx: false leaves the plan picture out."),
          highlight: z
            .array(z.string().min(1).max(100))
            .max(25)
            .optional()
            .describe("A plan only: what to draw, one entry per kind, e.g. [\"doors\", \"windows\"]. Categories, classes and folder names all work; plurals are fine."),
          element_ids: z
            .array(z.string().min(1))
            .max(5000)
            .optional()
            .describe("A plan only: exact element ids to draw, as list_elements or the plan view gives them."),
          legend: z.boolean().optional().describe("A plan only: add a legend page. Only when the user asks for one."),
        },
        outputSchema: looseOutput(exportResultSchema),
        annotations: READONLY,
        _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
      },
      async (args) => {
        const { project_id, format, blueprint_id, blueprint_ids, saved_table_id, selection, name, language, table } = args;
        try {
          const sources = [selection, table, saved_table_id].filter(Boolean).length;
          if (sources > 1) throw new BadArgument("Pass one of `selection`, `table` or `saved_table_id`.");
          if (sources === 0) {
            if (args.include_plan !== undefined || name !== undefined || language !== undefined) {
              throw new BadArgument(
                "`include_plan`, `name` and `language` belong to a table export; a plan export is the plan itself, named by its sheet.",
              );
            }
            const sheets = [...new Set([...(blueprint_id ? [blueprint_id] : []), ...(blueprint_ids ?? [])])];
            const sheet = sheets[0];
            if (!sheet) {
              throw new BadArgument("Pass one of `selection`, `table` or `saved_table_id` for a table, or `blueprint_id` for a plan.");
            }
            if (sheets.length > 1) throw new BadArgument("A plan export draws one sheet: give one `blueprint_id`, nothing else.");
            if (format && format !== "pdf") {
              throw new BadArgument(`A plan export is a pdf. For ${format}, pass the table: \`selection\`, \`table\` or \`saved_table_id\`.`);
            }
            const projectId = await resolveProject(principal, sheet, project_id);
            // A model writes "doors, windows" as one entry as often as two.
            const terms = (args.highlight ?? []).flatMap((h) => h.split(",")).map((h) => h.trim()).filter(Boolean);
            return fileLink(
              await api.exportPlan(principal, projectId, sheet, {
                ...(terms.length ? { highlight: terms } : {}),
                ...(args.element_ids?.length ? { element_ids: args.element_ids } : {}),
                ...(args.legend ? { legend: true } : {}),
              }),
            );
          }
          if (args.highlight?.length || args.element_ids?.length || args.legend !== undefined) {
            throw new BadArgument(
              "`highlight`, `element_ids` and `legend` belong to a plan export; a table numbers its own rows' elements.",
            );
          }
          if (!format) throw new BadArgument("A table export needs `format`: xlsx, pdf, png or csv_cf.");
          const asked = format === "png" || (args.include_plan === true && (format === "pdf" || format === "xlsx"));
          if (asked && !blueprint_id && !blueprint_ids && !saved_table_id) {
            throw new BadArgument(
              format === "png"
                ? "A png export needs `blueprint_id`, the sheet to draw on."
                : "An export with `include_plan` needs `blueprint_id`, the sheet to draw on.",
            );
          }
          // Only a drawing is tied to its sheets: a table alone keeps every sheet's elements.
          const drawn = format === "png" || (format === "pdf" ? args.include_plan === true : format === "xlsx" && args.include_plan !== false);
          if (drawn && blueprint_ids && new Set(blueprint_ids).size > 1 && format !== "pdf") {
            throw new BadArgument("Only a pdf draws several sheets; give one `blueprint_id` for a png or xlsx, or `include_plan: false`.");
          }
          const anySheet = blueprint_id ?? blueprint_ids?.[0];
          const projectId = project_id ?? (anySheet ? await resolveProject(principal, anySheet) : undefined);
          if (!projectId) throw new BadArgument("A table export needs `project_id`: the project the table's elements are in.");
          return fileLink(
            await api.exportTable(principal, projectId, {
              format,
              ...(args.include_plan !== undefined ? { include_plan: args.include_plan } : {}),
              ...(blueprint_id ? { blueprint_id } : {}),
              ...(blueprint_ids ? { blueprint_ids } : {}),
              ...(saved_table_id ? { saved_table_id } : {}),
              ...(selection ? { selection, ...(name ? { name } : {}), ...(language ? { language } : {}) } : {}),
              ...(table ? { table: bareIdsBack(table) } : {}),
            }),
          );
        } catch (err) {
          fail(err, "export");
        }
      },
    );
  }

  // Not a widget. view_blueprint already fetches this exact geometry and hands it to a
  // canvas, which is why the gap was easy to miss: the shapes were on screen but never in
  // the model's hands, so the only per-element answer anyone could give was to read them
  // off the picture. Structured output, no _meta.ui — this one is for the model.
  server.registerTool(
    "list_elements",
    {
      title: "List blueprint elements",
      description:
        (queryTools ? LIST_ELEMENTS_PREFIX : "") +
        "List a blueprint's individual take-off elements: one row per room, wall, door, " +
        "window or object, with its class, the folder it sits in on the drawing, its " +
        "measured area or length, and its outline. This is the per-element counterpart to " +
        "`view_takeoff`, which returns only per-class totals — use view_takeoff for " +
        "quantities, and this when the user asks about particular elements, their sizes, " +
        "where they are, or what is inside one folder.\n\n" +
        "Narrow it with `cls`, `folder` and `name` (case-insensitive substring match). " +
        "Kamai applies them to every element of the blueprint, and `matched` is how many " +
        "elements match.\n\n" +
        "`rings`, `lines` and `pts` are flat [x0,y0,x1,y1,...] integer paths in the " +
        "blueprint's own drawing space, where the page is `grid` units wide. They give " +
        "shape and position, not size: quote `area` and `len` in `units` for measurements, " +
        "and never compute a measurement from the coordinates. Both are null when " +
        "`needs_scale` is true, and provisional when `scale_unconfirmed` is true.\n\n" +
        "Each row's `id` is the stable local id for `update_elements` and `move_elements`. " +
        "Folders are not in this list (they have no shape) — use `list_folders` for those.\n\n" +
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
      outputSchema: looseOutput(listElementsOutput),
      annotations: READONLY,
    },
    async ({ blueprint_id, project_id, ...args }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        return text(
          await buildElementsPage(
            (limit, cursor, filter) => api.getGeometry(principal, projectId, blueprint_id, limit, cursor, filter),
            args,
          ),
        );
      } catch (err) {
        // A bad cursor is the caller's mistake and its message is already the fix, so it
        // goes through as written; fail() would flatten it into "something went wrong on
        // the Kamai side", which sends the model hunting an outage instead of fixing the
        // call. Only this module's own BadArgument gets that pass — anything else still
        // goes through fail(), which never leaks an upstream detail string.
        if (err instanceof BadArgument) throw new Error(err.message);
        fail(err, "list_elements");
      }
    },
  );

  server.registerTool(
    "list_folders",
    {
      title: "List blueprint folders",
      description:
        "List a blueprint's legend folders: id, name, parent, and colour. Geometry tools skip " +
        "folders because they have no shape, so call this when the user asks to create, rename, " +
        "recolour, or move items between folders. Pass a folder's `id` to create_folder " +
        "(as parent_id), update_elements, or move_elements. Do not show raw ids unless the " +
        "user asks for one. Refer to the blueprint and project by name.",
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
      },
      outputSchema: looseOutput(legendPageSchema),
      annotations: READONLY,
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        return text(await api.listFolders(principal, projectId, blueprint_id));
      } catch (err) {
        fail(err, "list_folders");
      }
    },
  );

  server.registerTool(
    "update_elements",
    {
      title: "Rename or recolour elements",
      description:
        "Rename or recolour specific elements or folders on a blueprint. Name and colour only — " +
        "geometry cannot be changed here. " +
        (queryTools ? EDIT_IDS_SENTENCE : "Pass `ids` from list_elements or list_folders.") +
        " Use dry_run to preview. Refer to the blueprint by name, not by id." + " " + RESULT_LINK,
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
        ids: z
          .array(z.string())
          .min(1)
          .describe(queryTools ? EDIT_IDS_GUIDE : "Local ids from list_elements or list_folders."),
        name: z.string().min(1).optional().describe("New label. Omit to leave names alone."),
        color: rgbaSchema.optional().describe("New colour, channels 0-255. Omit to leave colour alone."),
        dry_run: z.boolean().optional().describe("Report what would change without changing it."),
      },
      outputSchema: looseOutput(featurePatchResultSchema),
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ blueprint_id, project_id, ids, name, color, dry_run }) => {
      try {
        if (name === undefined && color === undefined) {
          throw new BadArgument(
            "Pass name or color. An ids-only call would change nothing.",
          );
        }
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        const result = await api.patchFeatures(principal, projectId, blueprint_id, {
          ids,
          name,
          color,
          dry_run,
        });
        return text(result);
      } catch (err) {
        if (err instanceof BadArgument) throw new Error(err.message);
        fail(err, "update_elements");
      }
    },
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create a legend folder",
      description:
        "Create a folder on a blueprint, under an existing folder or under the sheet's root. " +
        "parent_id must be a folder from list_folders; omit it to create under the root. A " +
        "missing or non-folder parent is refused, not guessed. Refer to the blueprint by name." + " " + RESULT_LINK,
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
        name: z.string().min(1).describe("The folder's label."),
        parent_id: z
          .string()
          .optional()
          .describe("Folder id from list_folders. Omit to create under the sheet's root."),
        color: rgbaSchema.optional().describe("Folder colour, channels 0-255."),
        dry_run: z.boolean().optional(),
      },
      outputSchema: looseOutput(folderCreatedSchema),
      annotations: WRITE,
    },
    async ({ blueprint_id, project_id, name, parent_id, color, dry_run }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        const result = await api.createFolder(principal, projectId, blueprint_id, {
          name,
          parent_id,
          color,
          dry_run,
        });
        return text(result);
      } catch (err) {
        fail(err, "create_folder");
      }
    },
  );

  server.registerTool(
    "move_elements",
    {
      title: "Move elements between folders",
      description:
        "Move elements or folders into a folder on the SAME blueprint. The sheet's root folder " +
        "cannot move. A folder cannot be dropped into its own subtree. Cross-sheet moves are " +
        "refused. Moved non-folders inherit the destination folder's colour; a moved folder " +
        "keeps its own. " +
        (queryTools ? EDIT_IDS_SENTENCE : "Pass ids from list_elements / list_folders.") +
        " Refer to the blueprint by name." + " " + RESULT_LINK,
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
        ids: z
          .array(z.string())
          .min(1)
          .describe(queryTools ? EDIT_IDS_GUIDE : "Local ids from list_elements or list_folders."),
        parent_id: z.string().describe("Destination folder id from list_folders."),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Insertion index among the destination's remaining children. Omit to append."),
        dry_run: z.boolean().optional(),
      },
      outputSchema: looseOutput(featureMovedSchema),
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ blueprint_id, project_id, ids, parent_id, index, dry_run }) => {
      try {
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        const result = await api.moveFeatures(principal, projectId, blueprint_id, {
          ids,
          parent_id,
          index,
          dry_run,
        });
        return text(result);
      } catch (err) {
        fail(err, "move_elements");
      }
    },
  );

  server.registerTool(
    "set_opening_height",
    {
      title: "Set an opening piece's height or door/window tag",
      description:
        "Store a height, or a door/window tag, on the wall-surface pieces drawn across an " +
        `opening. Class ${OPENING_PIECE_CLASS} is the ONLY class that carries these two ` +
        "fields: a plain wall, a room, or the opening itself is refused, for the height as " +
        `much as for the tag. ${openingPieceIds(queryTools)} ` +
        "A floor plan carries no vertical dimension, so these pieces arrive with no height and " +
        "every wall-surface figure computed from them falls back to a declared default. A " +
        "height written here STAYS on the drawing and is read back instead of that default. " +
        "The height is the USER's to give: pass the number, the unit they stated and " +
        "height_quote, their own words containing that number and unit; a height without a " +
        "matching quote is refused. Never pass a standard, typical or assumed height; if the " +
        "user has not said how tall these are, ask them. " +
        "An opening's own tag is the mark printed on the sheet and the server reads heights " +
        "out of it, so it is never rewritten from here: door and window are the only values " +
        "accepted, and only on wall-surface opening pieces. " +
        "Pass the whole selection in one call: it is written together, and an element that cannot " +
        "take the value comes back in refused while the rest are written. Refer to the blueprint by name." + " " + RESULT_LINK,
      inputSchema: {
        blueprint_id: z.string(),
        project_id: z.string().optional(),
        ids: z
          .array(z.string())
          .min(1)
          .describe(
            `Local ids of class ${OPENING_PIECE_CLASS} only. Any other class is refused.`,
          ),
        height: z
          .number()
          .positive()
          .finite()
          .optional()
          .describe(
            "The height the USER stated, counted in `height_unit`. Ask them for it rather than supplying a standard or assumed figure. Omit to leave heights alone.",
          ),
        height_unit: z
          .enum(HEIGHT_UNITS)
          .optional()
          .describe(
            "Unit of `height`. Mandatory with it, because a bare number is not a dimension. Feet and inches written together are ONE height: pass their total in inches with unit in, never either part alone.",
          ),
        height_quote: z
          .string()
          .min(1)
          .max(300)
          .optional()
          .describe(
            "The user's own words stating this height, copied exactly from their message, feet and inch marks included. Required with height.",
          ),
        tag: z
          .enum(["door", "window"])
          .optional()
          .describe(
            "What the user says these pieces cross. Never read off the opening's size, and never copied from the mark printed on the sheet.",
          ),
      },
      outputSchema: looseOutput(setOpeningHeightOutput),
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ blueprint_id, project_id, ids, height, height_unit, height_quote, tag }) => {
      try {
        if (height === undefined && tag === undefined) {
          throw new BadArgument(
            "Pass height (with height_unit and height_quote) or tag. An ids-only call would change nothing.",
          );
        }
        // The unit and the words are half the dimension, and they are checked here rather
        // than left to the server because the fix is the caller's: a height whose unit went
        // missing is a height nobody can read back, and one without the user's words is a
        // height the server will not believe. No worked figure in these messages on purpose:
        // a number offered here is a number that gets copied onto a real drawing.
        if (height !== undefined && height_unit === undefined) {
          throw new BadArgument(
            "Pass height_unit with height. A bare number is not a dimension, so state the unit the user used.",
          );
        }
        if (height !== undefined && height_quote === undefined) {
          throw new BadArgument(
            "Pass height_quote with height: the user's own words stating it, copied exactly from their message. If the user did not state a height, leave height out and ask them.",
          );
        }
        if (height === undefined && (height_unit !== undefined || height_quote !== undefined)) {
          throw new BadArgument("height_unit and height_quote were passed without a height.");
        }
        if (ids.length > MAX_WRITE_IDS) {
          throw new BadArgument(
            `This takes at most ${MAX_WRITE_IDS} ids at a time. Split the selection and call again.`,
          );
        }
        const projectId = await resolveProject(principal, blueprint_id, project_id);
        // The height travels as the user stated it. The server checks the words, converts
        // to metres and then into the drawing's units through the sheet's scale.
        const body = {
          tag,
          height:
            height === undefined
              ? undefined
              : { value: height, unit: height_unit!, quote: height_quote! },
        };

        // Kamai writes the whole selection in one call and decides what is written and what is
        // refused (the API layer's opening-pieces route); this relays its answer.
        let result: OpeningPiecesWritten;
        try {
          result = await api.setOpeningPieces(principal, projectId, blueprint_id, { ids, ...body });
        } catch (err) {
          const reason = err instanceof ApiError ? callRefusal(err, queryTools) : null;
          if (reason) throw new BadArgument(`Nothing was written. ${reason}`);
          throw err;
        }
        const refused = result.refused.map((row) => ({ id: row.id, reason: elementRefusal(row.code, queryTools) }));
        // Nothing written is a failed call, not a partial success: it goes back as an error.
        if (!result.applied) {
          const reasons = [...new Set(refused.map((row) => row.reason))];
          throw new BadArgument(
            reasons.length === 1
              ? `Nothing was written. ${reasons[0]}`
              : `Nothing was written. ${refused.map((row) => `${row.id}: ${row.reason}`).join(" ")}`,
          );
        }
        const links = Object.fromEntries(
          (["project_id", "blueprint_id", "app_url", "reference_ids"] as const).flatMap((key) => (result[key] ? [[key, result[key]]] : [])),
        );
        return text({ applied: true, changed: result.changed, fields: result.fields, written: result.written, refused, ...links });
      } catch (err) {
        fail(err, "set_opening_height");
      }
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description: "Create a new Kamai project to hold blueprints." + " " + RESULT_LINK,
      inputSchema: { name: z.string().min(1), description: z.string().optional() },
      outputSchema: looseOutput(projectSummarySchema),
      annotations: WRITE,
    },
    async ({ name, description }) => {
      try {
        return text(await api.createProject(principal, name, description ?? ""));
      } catch (err) {
        fail(err, "create_project");
      }
    },
  );

  server.registerTool(
    "update_project",
    {
      title: "Rename a project",
      description: "Change a project's name or description." + " " + RESULT_LINK,
      inputSchema: {
        project_id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
      },
      outputSchema: looseOutput(projectSummarySchema),
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ project_id, name, description }) => {
      try {
        return text(await api.updateProject(principal, project_id, { name, description }));
      } catch (err) {
        fail(err, "update_project");
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
        "something failed. Refer to jobs by their filename, not by id. `latest_upload` is the project's newest " +
        "upload: to stop the upload the user just started, pass its `upload_id` to cancel_job. " +
        `At most \`limit\` jobs (default ${JOBS_PAGE}) come back; \`next_offset\`, when present, is the \`offset\` ` +
        "of the next, older page; `older_not_listed` says there are older jobs past the last page offered.",
      inputSchema: {
        project_id: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(JOBS_MAX_OFFSET).optional(),
      },
      outputSchema: looseOutput(listJobsOutput),
      annotations: READONLY,
    },
    async ({ project_id, limit = JOBS_PAGE, offset = 0 }) => {
      try {
        const [listed, latest] = await Promise.all([
          // One more than the page, to know whether an older page follows.
          api.listJobs(principal, project_id, { limit: offset + limit + 1 }),
          // An older Kamai has no such route: the jobs alone, as before.
          api.latestUpload(principal, project_id).catch((err) => {
            if (err instanceof ApiError && err.code === "route_missing") return null;
            throw err;
          }),
        ]);
        const rest = listed.slice(offset);
        const jobs = rest.slice(0, limit);
        return text({
          ...(latest?.upload_id ? { latest_upload: latest } : {}),
          jobs,
          count: jobs.length,
          // Past the last reachable offset the older jobs are named, not offered as a page that would be refused.
          ...(rest.length > limit
            ? offset + limit <= JOBS_MAX_OFFSET ? { next_offset: offset + limit } : { older_not_listed: true }
            : {}),
        });
      } catch (err) {
        fail(err, "list_jobs");
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "One upload job",
      description: "Get one processing job's status, progress and error, if any.",
      inputSchema: { project_id: z.string(), job_id: z.string() },
      outputSchema: looseOutput(jobSummarySchema),
      annotations: READONLY,
    },
    async ({ project_id, job_id }) => {
      try {
        return text(await api.getJob(principal, project_id, job_id));
      } catch (err) {
        fail(err, "get_job");
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
        "the job; work already in progress on the Kamai side may still run to completion. " +
        "Cancelling a page job cancels every page of its upload that is still pending or running. " +
        "`job_id` may also be an `upload_id` (from finalize_blueprint_upload or list_jobs): that cancels the " +
        "whole upload, and works from its first seconds, so prefer it when the user wants to stop an upload." + " " + RESULT_LINK,
      inputSchema: { project_id: z.string(), job_id: z.string() },
      outputSchema: looseOutput(jobSummarySchema),
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ project_id, job_id }) => {
      try {
        return text(await api.cancelJob(principal, project_id, job_id));
      } catch (err) {
        fail(err, "cancel_job");
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
      outputSchema: looseOutput(uploadTicketSchema),
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
        fail(err, "request_blueprint_upload");
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
        "When telling the user where the blueprint landed, use `project_name`, not the id." + " " + RESULT_LINK,
      inputSchema: { file_uuid: z.string() },
      outputSchema: looseOutput(uploadResultSchema),
      annotations: WRITE,
      // App-only: the other half of a flow the widget drives end to end.
      _meta: APP_ONLY,
    },
    async ({ file_uuid }) => {
      try {
        return text(await api.completeUpload(principal, file_uuid));
      } catch (err) {
        fail(err, "finalize_blueprint_upload");
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
      outputSchema: looseOutput(uploadWidgetOutput),
      annotations: READONLY,
      _meta: toolMeta("upload"),
    },
    async ({ project_id }) => {
      try {
        const page = await api.listProjects(principal, 100);
        const appUrl = page.items.find((p) => p.id === project_id)?.app_url;
        const structured = {
          projects: page.items.map((p) => ({ id: p.id, name: p.name, ...(p.app_url ? { app_url: p.app_url } : {}) })),
          project_id: project_id ?? null,
          ...(appUrl ? { app_url: appUrl } : {}),
          state: "idle",
        };
        const notice = noticeOf(page);
        return widgetResult("upload", uploadWidgetOutput, structured, notice ? { ...structured, notice } : structured);
      } catch (err) {
        fail(err, "view_upload");
      }
    },
  );

  if (host.chatgpt) {
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
        outputSchema: looseOutput(uploadResultSchema),
        // The only tool that reaches a host Kamai does not control.
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
          fail(err, "ingest_blueprint_from_chat");
        }
      },
    );
  }

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
      outputSchema: looseOutput(kamaiAppOutput),
      annotations: READONLY,
      _meta: toolMeta("iframetest"),
    },
    async ({ mode, expand_button, url }) => {
      // A client whose store forbids selling must not be shown the plan picker the app opens
      // on for an account without a plan; the API layer says so, and what to say instead.
      // Fail closed: without the answer, opening could be exactly that.
      const me = await api.me(principal).catch(() => null);
      if (!me) throw new Error("Kamai could not be opened just now. Try again shortly.");
      if (me.app_links === false) {
        throw new Error(me.notice ?? "This Kamai account's current plan does not include opening the Kamai web app.");
      }
      const target = url ?? FRAME_ORIGINS[0]!;
      if (!isAllowedFrameTarget(target)) {
        throw new Error(
          `${target} is not in the framing allowlist (${FRAME_ORIGINS.join(", ")}). ` +
            "Add it to KAMAI_APP_ORIGINS and restart.",
        );
      }
      return widgetResult("iframetest", kamaiAppOutput, {
        url: target,
        // One setting. pip is documented but ChatGPT web coerces it away, so offering
        // it as a default just produces an unpredictable panel. "link" asks for the
        // Open-in-Kamai card instead of the frame: open_in is already a free string in every
        // descriptor a host may have pinned, where a new field would fail strict validation,
        // and an older cached bundle reads it as no mode and keeps its frame fallback.
        open_in: openAsLink ? "link" : (mode ?? "fullscreen"),
        // Ours is a fallback. Set false once Kamai renders its own control and posts
        // requestDisplayMode up to the widget.
        expand_button: expand_button ?? true,
        chrome: false,
        declared_frame_domains: [...FRAME_ORIGINS],
        // Hosts pin descriptors: with the flag off the result must not gain a field.
        ...(panelSignIn && !openAsLink ? { panel_sign_in: true } : {}),
      });
    },
  );

  if (panelSignIn) {
    registerAppTool(
      server,
      "open_kamai_session",
      {
        title: "Sign the Kamai panel in",
        description:
          "Called by the Kamai panel itself, never by the model: a one-time code, valid for one " +
          "minute, that signs the framed Kamai app in as the user this connector acts for.",
        outputSchema: looseOutput(z.object({ panel_code: z.string(), expires_in: z.number() })),
        annotations: READONLY,
        // App-only: model-visible output would keep this bearer code in the transcript.
        _meta: APP_ONLY,
      },
      async () => {
        try {
          return text(await mintPanelCode(principal));
        } catch (err) {
          fail(err, "open_kamai_session");
        }
      },
    );
  }

  if (hostProbe) registerHostProbe(server, host.userAgent);

  return server;
}
