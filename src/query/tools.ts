import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { api, resolveProject } from "../api.ts";
import { BadArgument, invalidateScanCache } from "../elements.ts";
import { looseOutput } from "../loose.ts";
import { DESTRUCTIVE_IDEMPOTENT, READONLY, text } from "../tool-kit.ts";
import { IDS_PER_RESULT, capIds, compact, fitResult, stripSi } from "./budget.ts";
import type { ToolContext } from "./context.ts";
import { HEIGHT_UNITS, type HeightStatement } from "./contract.ts";
import {
  COUNT_ELEMENTS_DESCRIPTION,
  DOOR_HEIGHT_GUIDE,
  FIND_ELEMENTS_DESCRIPTION,
  GROUP_BY_GUIDE,
  HEIGHT_QUOTE_GUIDE,
  HEIGHT_UNIT_GUIDE,
  IDS_PER_GROUP_GUIDE,
  LIMIT_GUIDE,
  OFFSET_GUIDE,
  ORDER_BY_GUIDE,
  ROOM_HEIGHT_GUIDE,
  ROOM_REFS_GUIDE,
  SCALE_GUIDE,
  SET_SCALE_DESCRIPTION,
  WALL_BLUEPRINT_IDS_GUIDE,
  WALL_IN_FOLDER_GUIDE,
  WALL_NAME_CONTAINS_GUIDE,
  WALL_SELECTION_GUIDE,
  WALL_SUB_CLASS_GUIDE,
  WALL_SURFACE_DESCRIPTION,
  WINDOW_HEIGHT_GUIDE,
} from "./descriptions.ts";
import { REF_RE, filterBody, filterShape, scopeShape, selectionSchema } from "./filters.ts";
import { registerRenderTable } from "./render-table.ts";
import { countElementsOutput, findElementsOutput, setScaleOutput, wallSurfaceOutput } from "./outputs.ts";
import { GROUP_KEYS, ORDER_FIELDS } from "./vocabulary.ts";


const NEED_SCOPE = "Pass project_id (list_blueprints lists them) or blueprint_ids.";

/** The project a call runs in: given, or looked up from its first blueprint. The API
 * layer then checks every blueprint_id belongs to that project. */
async function projectFor(ctx: ToolContext, projectId?: string, blueprintIds?: readonly string[]): Promise<string> {
  if (projectId) return projectId;
  const first = blueprintIds?.[0];
  if (first) return resolveProject(ctx.principal, first);
  throw new BadArgument(NEED_SCOPE);
}

const given = (value: unknown) => value !== undefined;

export function registerQueryTools(server: McpServer, ctx: ToolContext): void {
  registerCountElements(server, ctx);
  registerFindElements(server, ctx);
  registerWallSurface(server, ctx);
  registerRenderTable(server, ctx);
  registerSetScale(server, ctx);
}

// ── count_elements ────────────────────────────────────────────────────────────────────

const countInput = z.strictObject({
  ...scopeShape,
  ...filterShape,
  group_by: z.array(z.enum(GROUP_KEYS)).min(1).max(4).optional().describe(GROUP_BY_GUIDE),
  ids_per_group: z.number().int().min(0).max(200).optional().describe(IDS_PER_GROUP_GUIDE),
});

function registerCountElements(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "count_elements",
    {
      title: "Count elements",
      description: COUNT_ELEMENTS_DESCRIPTION,
      inputSchema: countInput,
      outputSchema: looseOutput(countElementsOutput),
      annotations: READONLY,
    },
    async (args) => {
      try {
        const projectId = await projectFor(ctx, args.project_id, args.blueprint_ids);
        const body: Record<string, unknown> = { ...filterBody(args) };
        if (args.blueprint_ids) body.blueprint_ids = args.blueprint_ids;
        if (args.group_by) body.group_by = args.group_by;
        if (args.ids_per_group !== undefined) body.ids_per_group = args.ids_per_group;

        const out = (await api.queryAggregate(ctx.principal, projectId, body)) as Record<string, unknown>;
        const groups = out.groups as Array<Record<string, unknown>>;
        stripSi(groups);
        stripSi([out.total as Record<string, unknown>]);
        capIds(groups, IDS_PER_RESULT);
        capIds(groups, IDS_PER_RESULT, "text_ids");
        compact(out, ["groups"]);
        const dropped = fitResult(
          out,
          groups,
          (n) =>
            `${n} group(s) were left out of this result to keep it within what a host delivers. ` +
            "`total` still covers every group; group by fewer keys for the rest, or show all of it " +
            "with render_table(from_result = selection).",
        );
        if (dropped) out.groups_truncated = true;
        return text(out);
      } catch (err) {
        ctx.fail(err, "count_elements");
      }
    },
  );
}

// ── find_elements ─────────────────────────────────────────────────────────────────────

const findInput = z.strictObject({
  ...scopeShape,
  ...filterShape,
  order_by: z
    .array(z.strictObject({ field: z.enum(ORDER_FIELDS), dir: z.enum(["asc", "desc"]).optional() }))
    .max(3)
    .optional()
    .describe(ORDER_BY_GUIDE),
  limit: z.number().int().min(1).max(200).optional().describe(LIMIT_GUIDE),
  offset: z.number().int().min(0).max(100_000).optional().describe(OFFSET_GUIDE),
});

function shapeFind(result: Record<string, unknown>): Record<string, unknown> {
  stripSi(result.rows as Array<Record<string, unknown>>);
  compact(result, ["rows"]);
  return result;
}

const smallerPageNote = (rows: number) =>
  `This page holds ${rows} row(s), fewer than asked, to stay within what a host delivers; ` +
  "next_offset continues from there.";

/** How many rows of a shaped page fit the budget, measured on a copy that already
 * carries the note a smaller page will get, so the page asked for next fits with it. */
function rowsThatFit(result: Record<string, unknown>): number {
  const copy = structuredClone(result);
  const rows = copy.rows as unknown[];
  (copy.notes as string[]).push(smallerPageNote(rows.length));
  fitResult(copy, rows, () => "");
  return rows.length;
}

function registerFindElements(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "find_elements",
    {
      title: "Find elements",
      description: FIND_ELEMENTS_DESCRIPTION,
      inputSchema: findInput,
      outputSchema: looseOutput(findElementsOutput),
      annotations: READONLY,
    },
    async (args) => {
      try {
        const projectId = await projectFor(ctx, args.project_id, args.blueprint_ids);
        const body: Record<string, unknown> = { ...filterBody(args) };
        if (args.blueprint_ids) body.blueprint_ids = args.blueprint_ids;
        if (args.order_by) body.order_by = args.order_by;
        if (args.limit !== undefined) body.limit = args.limit;
        if (args.offset !== undefined) body.offset = args.offset;

        let out = shapeFind((await api.querySelect(ctx.principal, projectId, body)) as Record<string, unknown>);
        // A page too large for the host is asked for again, smaller, rather than cut
        // here: the selection token encodes the page's limit, so a cut page would carry a
        // selection covering rows the model never saw, and next_offset would skip them.
        const shown = (out.rows as unknown[]).length;
        const fit = rowsThatFit(out);
        if (fit < shown) {
          out = shapeFind(
            (await api.querySelect(ctx.principal, projectId, { ...body, limit: fit })) as Record<string, unknown>,
          );
          (out.notes as string[]).push(smallerPageNote((out.rows as unknown[]).length));
        }
        // Only a page that grew between the two reads gets here. Cutting it makes its
        // selection cover rows not shown, so the selection is withdrawn and next_offset
        // is moved back to the first row not shown.
        const rows = out.rows as unknown[];
        const cut = fitResult(
          out,
          rows,
          (n) =>
            `${n} row(s) did not fit this result, so next_offset continues from the first of them and this ` +
            "page has no selection; call find_elements again with a smaller limit to get one.",
        );
        if (cut) {
          out.returned = rows.length;
          out.next_offset = (out.offset as number) + rows.length;
          out.selection = null;
        }
        return text(out);
      } catch (err) {
        ctx.fail(err, "find_elements");
      }
    },
  );
}

// ── calculate_wall_surface_area ───────────────────────────────────────────────────────

const heightFields = (kind: "room" | "door" | "window", guide: string) => ({
  [`${kind}_height`]: z.number().positive().finite().optional().describe(guide),
  [`${kind}_height_unit`]: z.enum(HEIGHT_UNITS).optional().describe(HEIGHT_UNIT_GUIDE),
  [`${kind}_height_quote`]: z.string().min(1).max(300).optional().describe(HEIGHT_QUOTE_GUIDE),
});

// This tool chooses ROOMS only, so its filters get guides of their own: the shared ones
// speak of walls ("Exterior wall", "a wall type = in_folder") and sent the model looking
// for walls here.
const wallInput = z.strictObject({
  project_id: scopeShape.project_id,
  blueprint_ids: scopeShape.blueprint_ids.describe(WALL_BLUEPRINT_IDS_GUIDE),
  selection: selectionSchema.optional().describe(WALL_SELECTION_GUIDE),
  room_refs: z.array(z.string().regex(REF_RE)).min(1).max(200).optional().describe(ROOM_REFS_GUIDE),
  name_contains: z.string().min(1).max(200).optional().describe(WALL_NAME_CONTAINS_GUIDE),
  sub_class: z.array(z.enum(["wet room"])).length(1).optional().describe(WALL_SUB_CLASS_GUIDE),
  in_folder: z.string().min(1).max(200).optional().describe(WALL_IN_FOLDER_GUIDE),
  ...heightFields("room", ROOM_HEIGHT_GUIDE),
  ...heightFields("door", DOOR_HEIGHT_GUIDE),
  ...heightFields("window", WINDOW_HEIGHT_GUIDE),
});

type WallArgs = z.infer<typeof wallInput> & Record<string, unknown>;

/** One height as the user stated it, or nothing. All three fields or none: a figure
 * without its unit is not a dimension, and one without the user's words is a height the
 * API layer will not believe. No figure in these messages on purpose. */
function statedHeight(args: WallArgs, kind: "room" | "door" | "window"): HeightStatement | undefined {
  const value = args[`${kind}_height`] as number | undefined;
  const unit = args[`${kind}_height_unit`] as HeightStatement["unit"] | undefined;
  const quote = args[`${kind}_height_quote`] as string | undefined;
  const present = [value, unit, quote].filter(given).length;
  if (present === 0) return undefined;
  if (present < 3) {
    throw new BadArgument(
      `Pass ${kind}_height with ${kind}_height_unit and ${kind}_height_quote, or none of them.`,
    );
  }
  return { value: value!, unit: unit!, quote: quote! };
}

function registerWallSurface(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "calculate_wall_surface_area",
    {
      title: "Wall surface area of rooms",
      description: WALL_SURFACE_DESCRIPTION,
      inputSchema: wallInput,
      outputSchema: looseOutput(wallSurfaceOutput),
      annotations: READONLY,
    },
    async (input) => {
      try {
        const args = input as WallArgs;
        const heights = {
          room_height: statedHeight(args, "room"),
          door_height: statedHeight(args, "door"),
          window_height: statedHeight(args, "window"),
        };
        const byFilter = given(args.name_contains) || given(args.sub_class) || given(args.in_folder);
        const ways = [given(args.selection), given(args.room_refs), byFilter].filter(Boolean).length;
        if (ways > 1) {
          throw new BadArgument(
            "Choose the rooms one way: selection, room_refs, or name_contains / sub_class / in_folder.",
          );
        }
        if (ways === 0 && !args.blueprint_ids) {
          throw new BadArgument(
            "Pass blueprint_ids to measure every room on those blueprints, or choose the rooms with selection, room_refs or name_contains.",
          );
        }
        const projectId = await projectFor(ctx, args.project_id, args.blueprint_ids);

        const body: Record<string, unknown> = {};
        if (args.blueprint_ids) body.blueprint_ids = args.blueprint_ids;
        if (args.selection) body.selection = args.selection;
        if (args.room_refs) body.room_refs = args.room_refs;
        if (byFilter) {
          body.rooms = Object.fromEntries(
            (["name_contains", "sub_class", "in_folder"] as const).filter((k) => given(args[k])).map((k) => [k, args[k]]),
          );
        }
        for (const [key, value] of Object.entries(heights)) if (value) body[key] = value;

        const out = (await api.queryWallSurface(ctx.principal, projectId, body)) as Record<string, unknown>;
        const rooms = out.rooms as Array<Record<string, unknown>>;
        stripSi(rooms);
        stripSi([out.total as Record<string, unknown>]);
        capIds(rooms, IDS_PER_RESULT, "element_ids");
        capIds(rooms, IDS_PER_RESULT, "opening_ids");
        fitResult(
          out,
          rooms,
          (n) =>
            `${n} room(s) were left out of this result to keep it within what a host delivers. ` +
            "`total` covers every room; render_table(from_result = selection) shows them all.",
        );
        return text(out);
      } catch (err) {
        ctx.fail(err, "calculate_wall_surface_area");
      }
    },
  );
}

// ── set_scale ─────────────────────────────────────────────────────────────────────────

const scaleInput = z.strictObject({
  blueprint_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  scale: z.string().min(3).max(64).describe(SCALE_GUIDE),
});

function registerSetScale(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "set_scale",
    {
      title: "Set a blueprint's scale",
      description: SET_SCALE_DESCRIPTION,
      inputSchema: scaleInput,
      outputSchema: looseOutput(setScaleOutput),
      // Rewrites every quantity on the sheet, so hosts should ask first. Setting the
      // same scale twice ends in the same state.
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ blueprint_id, project_id, scale }) => {
      try {
        const projectId = await resolveProject(ctx.principal, blueprint_id, project_id);
        const result = await api.setScale(ctx.principal, projectId, blueprint_id, scale);
        invalidateScanCache(ctx.scanKey(projectId, blueprint_id));
        return text(result);
      } catch (err) {
        ctx.fail(err, "set_scale");
      }
    },
  );
}
