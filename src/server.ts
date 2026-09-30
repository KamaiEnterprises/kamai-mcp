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
  projectDetailSchema,
  projectSummarySchema,
  jobSummarySchema,
  resolveProject,
  rgbaSchema,
  takeoffPageSchema,
  uploadResultSchema,
  uploadTicketSchema,
} from "./api.ts";
import type { GeometryPage, OpeningPieceAttributes } from "./api.ts";
import type { Principal } from "./auth.ts";
import { NO_INSTRUCTIONS, QUERY_TOOLS } from "./config.ts";
import { BadArgument, MAX_LIMIT, buildElementsPage, invalidateScanCache, listElementsOutput } from "./elements.ts";
import { toolErrorText } from "./errors.ts";
import { looseOutput } from "./loose.ts";
import {
  APP_ONLY,
  DESTRUCTIVE_IDEMPOTENT,
  READONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  text,
} from "./tool-kit.ts";
import { registerListBlueprints } from "./query/list-blueprints.ts";
import { registerQueryTools } from "./query/tools.ts";
import {
  EDIT_IDS_GUIDE,
  EDIT_IDS_SENTENCE,
  LIST_ELEMENTS_PREFIX,
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

// The API route is per feature, so a selection is N requests, not one. Four at
// a time: enough that a normal selection finishes inside a turn, few enough
// that a large one cannot arrive as a burst the API layer sheds. A shed
// request is an element the user believes was written.
const WRITE_CONCURRENCY = 4;

// And a ceiling on the fan-out itself. At one request per element a selection
// of thousands is not a slow call, it is a call that never returns inside a
// turn, and the caller is better told to split it than left waiting.
const MAX_WRITE_IDS = 200;

/** Run `work` over `items`, at most `limit` in flight, results in input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Where the ids of opening pieces come from, in the words the tool list at hand can
 * honour: find_elements exists only with the query tools. */
const openingPieceIds = (queryTools: boolean): string =>
  queryTools
    ? `Get the ids from find_elements with category opening_pieces (or list_elements with cls ${OPENING_PIECE_CLASS}).`
    : `Get the ids from list_elements with cls set to ${OPENING_PIECE_CLASS}.`;

/** Refusals that are the same for every element of a set_opening_height call, because
 * every element gets the same body: once one arrives, the rest are not sent. */
const STOPS_FAN_OUT = new Set(["needs_scale", "invalid_request", "route_missing"]);

/** Why one opening piece was turned away, phrased so the model can fix it in this turn.
 *
 * The wrong-class refusal is checked first, by status: it is per element (a wall in a
 * selection of opening pieces), and the API layer sends it as invalid_request with 409,
 * so keying on the code alone would stop the whole fan-out over one wrong id. Then the
 * `code`; the status-only branches are for an API layer that answers with a bare
 * `detail` string. The status itself never reaches the prose. */
function refusalFor(err: ApiError, queryTools: boolean): string {
  if (err.status === 409) {
    return (
      "That element is not a wall-surface opening piece, so no height and no door/window tag " +
      `can be stored on it. Only elements of class ${OPENING_PIECE_CLASS} carry those two ` +
      `fields. ${openingPieceIds(queryTools)} Write to the ids that returns. An opening itself ` +
      "is not one of them, and its tag is the mark printed on the sheet, which is never rewritten."
    );
  }
  if (err.code === "needs_scale") {
    return toolErrorText(err, "set_opening_height", { queryTools });
  }
  if (err.code === "invalid_request" && err.detail) return err.detail;
  if (err.code === "route_missing") return err.message;
  if (err.status === 400) {
    return (
      "This sheet has no usable scale, so a height cannot be converted into the drawing's " +
      "units. The sheet's scale has to be set first, then the height can be written."
    );
  }
  if (err.status === 404) {
    return "No element with that id is on this sheet. Read the ids again with list_elements.";
  }
  return toolErrorText(err, "set_opening_height", { queryTools });
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
// is on it by class. Rendering data (outlines, image) stays in structuredContent.
function blueprintSummary(page: Omit<GeometryPage, "next_cursor">) {
  const { image: _image, features, ...rest } = page;
  const classes = new Map<string, number>();
  for (const feature of features) classes.set(feature.cls, (classes.get(feature.cls) ?? 0) + 1);
  return {
    ...rest,
    features_shown: features.length,
    classes: [...classes.entries()].map(([cls, count]) => ({ cls, count })),
  };
}

export interface HostHints {
  // Only ChatGPT fills ingest_blueprint_from_chat's file parameter. Advertised anywhere else it
  // is the tool a model reaches for first on "upload this PDF", and it can only fail.
  chatgpt?: boolean;
}

export interface ServerOptions {
  /** Register the query tools (KAMAI_QUERY_TOOLS=on). Settable so tests can flip it. */
  queryTools?: boolean;
  /** Send the server `instructions`. Off emulates hosts that drop them (claude.ai). */
  instructions?: boolean;
}

const BASE_INSTRUCTIONS = "Tools for managing Kamai construction-blueprint projects, blueprints, and takeoffs.";

export function buildServer(
  principal: Principal,
  host: HostHints = {},
  opts: ServerOptions = {},
): McpServer {
  const queryTools = opts.queryTools ?? QUERY_TOOLS;
  const withInstructions = opts.instructions ?? !NO_INSTRUCTIONS;
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

  const scanKey = (projectId: string, blueprintId: string) =>
    `${principal.uid}\u0000${principal.token}\u0000${projectId}\u0000${blueprintId}`;

  const ctx: ToolContext = { principal, queryTools, fail, scanKey };

  // The id is load-bearing — it is in every cached ui:// URI — but the label is what a
  // host shows in a resource list, so it should read like the product, not the module.
  const RESOURCE_LABEL: Record<WidgetName, string> = {
    projects: "Kamai projects",
    blueprint: "Kamai blueprint",
    takeoff: "Kamai takeoff",
    upload: "Kamai upload",
    iframetest: "Kamai app",
    table: "Kamai table",
  };

  // The table widget is listed only with the query tools, so resources/list with the flag
  // off is what it was. The any-version template below still serves it either way.
  for (const name of WIDGET_NAMES.filter((n) => queryTools || n !== "table")) {
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
      outputSchema: looseOutput(listProjectsOutput),
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async () => {
      try {
        const page = await api.listProjects(principal);
        return text({ projects: page.items, count: page.items.length });
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
          blueprints: (p.blueprints ?? []).map((b) => ({
            id: b.id,
            name: b.name,
            ready: b.ready,
          })),
        }));
        return widgetResult("projects", projectsWidgetOutput, { projects, count: projects.length });
      } catch (err) {
        fail(err, "view_projects");
      }
    },
  );

  registerListBlueprints(server, ctx);
  // Behind KAMAI_QUERY_TOOLS: every one of these needs an API route an older API layer
  // does not serve.
  if (queryTools) registerQueryTools(server, ctx);

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
        const page = await api.getGeometry(principal, projectId, blueprint_id);
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
        "Kamai's geometry endpoint has no filter of its own, so this tool reads the " +
        "blueprint and filters here: `matched`, `filter_scanned` and `filter_complete` say " +
        "what the filter actually saw, and `filter_complete` false means elements exist " +
        "that were never checked.\n\n" +
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
            (limit, cursor) => api.getGeometry(principal, projectId, blueprint_id, limit, cursor),
            args,
            // Scope for the filtered-scan cache. The token is in the key as well as the
            // uid: the scan holds one principal's view of one blueprint, so anything that
            // could change what this caller is allowed to see must change the key.
            scanKey(projectId, blueprint_id),
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
        " Use dry_run to preview. Refer to the blueprint by name, not by id.",
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
      annotations: WRITE_IDEMPOTENT,
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
        if (!dry_run) invalidateScanCache(scanKey(projectId, blueprint_id));
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
        "missing or non-folder parent is refused, not guessed. Refer to the blueprint by name.",
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
        if (!dry_run) invalidateScanCache(scanKey(projectId, blueprint_id));
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
        " Refer to the blueprint by name.",
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
      annotations: WRITE_IDEMPOTENT,
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
        if (!dry_run) invalidateScanCache(scanKey(projectId, blueprint_id));
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
        "One request per element, so pass the selection you mean. Refer to the blueprint by name.",
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
      annotations: WRITE_IDEMPOTENT,
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
            `This writes one element per request, so it takes at most ${MAX_WRITE_IDS} ids at a time. Split the selection and call again.`,
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

        // A refusal that every element would give (no scale, a height the words do not
        // state, a route the API does not have) stops the rest from being sent: N identical
        // failures is N pointless round trips.
        let sharedRefusal: string | undefined;
        const outcomes = await mapBounded(ids, WRITE_CONCURRENCY, async (id) => {
          if (sharedRefusal) return { id, reason: sharedRefusal };
          try {
            return await api.setOpeningPieceAttributes(principal, projectId, blueprint_id, id, body);
          } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            const reason = refusalFor(err, queryTools);
            const perElement = err.status === 409 || (err.status === 404 && err.code !== "route_missing");
            if (!perElement && (STOPS_FAN_OUT.has(err.code) || err.status === 400)) sharedRefusal = reason;
            return { id, reason };
          }
        });

        // Split on the one key only a stored row carries. The negation, rather
        // than a second test for `reason`, so a row and a refusal can never
        // both match and an element be counted twice.
        const written = outcomes.filter((row): row is OpeningPieceAttributes => "feature_class" in row);
        const refused = outcomes.filter(
          (row): row is { id: string; reason: string } => !("feature_class" in row),
        );
        // Nothing written is not a partial success, it is a failed call, and
        // it goes back as an error so the model treats it as one. The reason
        // is the only one there is when every element gave the same answer,
        // which is the common case: one wrong selection, or one unscaled sheet.
        if (written.length === 0) {
          const reasons = [...new Set(refused.map((row) => row.reason))];
          throw new BadArgument(
            reasons.length === 1
              ? `Nothing was written. ${reasons[0]}`
              : `Nothing was written. ${refused.map((row) => `${row.id}: ${row.reason}`).join(" ")}`,
          );
        }
        invalidateScanCache(scanKey(projectId, blueprint_id));
        return text({
          applied: true,
          changed: written.length,
          fields: [
            ...(height === undefined ? [] : ["height"]),
            ...(tag === undefined ? [] : ["tag"]),
          ],
          written,
          refused,
        });
      } catch (err) {
        fail(err, "set_opening_height");
      }
    },
  );

  server.registerTool(
    "create_project",
    {
      title: "Create a project",
      description: "Create a new Kamai project to hold blueprints.",
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
      description: "Change a project's name or description.",
      inputSchema: {
        project_id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
      },
      outputSchema: looseOutput(projectSummarySchema),
      annotations: WRITE_IDEMPOTENT,
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
        "something failed. Refer to jobs by their filename, not by id.",
      inputSchema: { project_id: z.string() },
      outputSchema: looseOutput(listJobsOutput),
      annotations: READONLY,
    },
    async ({ project_id }) => {
      try {
        const jobs = await api.listJobs(principal, project_id);
        return text({ jobs, count: jobs.length });
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
        "the job; work already in progress on the Kamai side may still run to completion.",
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
        "When telling the user where the blueprint landed, use `project_name`, not the id.",
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
        return widgetResult("upload", uploadWidgetOutput, {
          projects: page.items.map((p) => ({ id: p.id, name: p.name })),
          project_id: project_id ?? null,
          state: "idle",
        });
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
