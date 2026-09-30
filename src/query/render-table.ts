import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { api, resolveProject } from "../api.ts";
import { BadArgument } from "../elements.ts";
import { looseOutput } from "../loose.ts";
import { APP_ONLY, READONLY, text } from "../tool-kit.ts";
import { toolMeta, widgetUri } from "../widgets/index.ts";
import { IDS_PER_RESULT, capIds, fitResult } from "./budget.ts";
import type { ToolContext } from "./context.ts";
import type { IdMap } from "./contract.ts";
import {
  GET_ELEMENT_OUTLINES_DESCRIPTION,
  GET_TABLE_ROW_ELEMENTS_DESCRIPTION,
  RENDER_TABLE_DESCRIPTION,
} from "./descriptions.ts";
import { selectionSchema } from "./filters.ts";
import { elementOutlinesOutput, renderTableOutput, rowElementsOutput } from "./outputs.ts";

// Model-visible ids per row; the panel fetches complete sets itself.
const IDS_PER_ROW = 25;
// The panel's own fetch: one row at a time, up to this many ids.
const PANEL_IDS = 1500;
// Outlines per get_element_outlines call; the panel asks in chunks of this size.
export const OUTLINES_PER_CALL = 400;

const cellValue = z.union([z.string().max(300), z.number().finite(), z.null()]);
// A row key names at most every group_by field of a count (group_by takes 4) or {ref}.
// Bounded like the API's, so a body cannot carry thousands of keys.
const MAX_ROW_KEYS = 4;
const rowKey = z
  .record(z.string().max(64), z.union([z.string().max(300), z.null()]))
  .refine((key) => Object.keys(key).length <= MAX_ROW_KEYS, { message: `at most ${MAX_ROW_KEYS} keys` });
const fromSchema = z.strictObject({
  s: z.number().int().min(0).max(4).describe("Index into `selections`."),
  group: rowKey
    .optional()
    .describe("The group this row is: every group_by field of a count, or {ref} for a find or wall-surface row. Omit on a total row."),
});

const renderInput = z.strictObject({
  project_id: z.string().min(1).describe("The project the table's elements are in."),
  title: z.string().min(1).max(200).describe("The table's heading, in the language you are writing in."),
  language: z.string().regex(/^[a-z]{2}$/).optional().describe("Two-letter code of the language you are writing in."),
  from_result: selectionSchema
    .optional()
    .describe("The `selection` of a count_elements, find_elements or calculate_wall_surface_area result."),
  selections: z
    .array(selectionSchema)
    .min(1)
    .max(5)
    .optional()
    .describe("With rows only: the selections your rows point into with from.s."),
  columns: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
        label: z.string().min(1).max(80),
        type: z.enum(["text", "number", "area", "length", "count"]).optional(),
        unit: z.string().max(16).optional(),
        align: z.enum(["left", "right", "center"]).optional(),
      }),
    )
    .min(1)
    .max(12)
    .optional()
    .describe("With rows, for a table Kamai cannot build."),
  rows: z
    .array(
      z.strictObject({
        cells: z.record(z.string(), cellValue).describe("Column key to value; numbers as numbers."),
        kind: z.enum(["total", "note"]).optional(),
        element_ids: z
          .record(z.string(), z.array(z.string().min(1)).max(200))
          .optional()
          .describe("{blueprint_id: [ids]} of a few specific elements."),
        from: fromSchema.optional(),
      }),
    )
    .min(1)
    .max(200)
    .optional()
    .describe("With columns: one entry per table row."),
});

type RenderArgs = z.infer<typeof renderInput>;
type OutRow = {
  index?: number;
  cells: Record<string, string | number | null>;
  kind: string;
  element_count: number;
  element_ids: IdMap;
  element_ids_truncated?: boolean;
  from?: { s: number; group?: Record<string, string | null> };
};

const countIds = (map: IdMap) => Object.values(map).reduce((sum, ids) => sum + ids.length, 0);

function mergeIds(a: IdMap, b: IdMap): IdMap {
  const out: IdMap = {};
  for (const map of [a, b]) {
    for (const [blueprintId, ids] of Object.entries(map)) {
      out[blueprintId] = [...new Set([...(out[blueprintId] ?? []), ...ids])];
    }
  }
  return out;
}

/** The checks the schema cannot state. Each message says how to fix the call. */
function checkAuthored(args: RenderArgs): void {
  const authored = args.columns !== undefined || args.rows !== undefined;
  if (args.from_result && authored) {
    throw new BadArgument("Pass from_result, or columns and rows, not both.");
  }
  if (!args.from_result && !authored) {
    throw new BadArgument("Pass from_result (the selection of a count, find or wall-surface result), or columns and rows.");
  }
  if (args.selections && !args.rows) {
    throw new BadArgument("selections goes with rows; with from_result, leave it out.");
  }
  if (!args.from_result && (!args.columns || !args.rows)) {
    throw new BadArgument("columns and rows go together: pass both.");
  }
  if (!args.columns || !args.rows) return;
  const keys = new Set<string>();
  for (const column of args.columns) {
    if (keys.has(column.key)) throw new BadArgument(`Column key '${column.key}' appears twice.`);
    keys.add(column.key);
  }
  const selections = args.selections?.length ?? 0;
  args.rows.forEach((row, i) => {
    for (const key of Object.keys(row.cells)) {
      if (!keys.has(key)) throw new BadArgument(`Row ${i}: cell '${key}' is not a column key.`);
    }
    if (row.from && row.from.s >= selections) {
      throw new BadArgument(
        selections
          ? `Row ${i}: from.s is ${row.from.s}, but selections holds ${selections}.`
          : `Row ${i} has from, so pass the selections it points into.`,
      );
    }
  });
}

// registerAppTool adds this legacy twin of ui.resourceUri to every widget tool; spelled
// out here because render_table registers with a full input object, which its typings
// do not take.
const TABLE_META = { ...toolMeta("table"), "ui/resourceUri": widgetUri("table") };

export function registerRenderTable(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "render_table",
    {
      title: "Show a table",
      description: RENDER_TABLE_DESCRIPTION,
      inputSchema: renderInput,
      outputSchema: looseOutput(renderTableOutput),
      annotations: READONLY,
      _meta: TABLE_META,
    },
    async (args: RenderArgs) => {
      try {
        checkAuthored(args);
        const out = args.from_result ? await fromResult(ctx, args) : await authored(ctx, args);
        const rows = out.rows as Array<Record<string, unknown>>;
        capIds(rows, IDS_PER_RESULT);
        // A problem names a row; one for a row cut below goes with it, so a table of 200
        // failing rows cannot carry its problems past the budget either.
        const problems = out.problems as Array<{ row: number }>;
        const dropped = fitResult(
          out,
          rows,
          (n) => `${n} row(s) were left out of this table to keep it within what a host delivers.`,
        );
        if (dropped) out.problems = problems.filter((p) => p.row < rows.length);
        return { ...text(out), _meta: toolMeta("table") };
      } catch (err) {
        ctx.fail(err, "render_table");
      }
    },
  );

  registerTableHelpers(server, ctx);
}

async function fromResult(ctx: ToolContext, args: RenderArgs): Promise<Record<string, unknown>> {
  const table = await api.queryTable(ctx.principal, args.project_id, {
    selection: args.from_result!,
    ...(args.language ? { language: args.language } : {}),
    ids_per_row: IDS_PER_ROW,
    max_ids: IDS_PER_RESULT,
  });
  return { ...table, title: args.title, built_by: "kamai", selection: args.from_result };
}

async function authored(ctx: ToolContext, args: RenderArgs): Promise<Record<string, unknown>> {
  const columns = args.columns!;
  const rows = args.rows!;
  const detail = await api.getProject(ctx.principal, args.project_id);
  const inProject = new Set(detail.blueprints.map((b) => b.id));
  const problems: Array<{ row: number; reason: string }> = [];

  const out: OutRow[] = rows.map((row, i) => {
    const entry: OutRow = { cells: row.cells, kind: row.kind ?? "item", element_count: 0, element_ids: {} };
    if (row.from) entry.from = row.from;
    if (row.element_ids) {
      // An id map is only as trustworthy as the model that typed it. A blueprint outside
      // this project is refused here; the panel resolves only what is left, and every
      // outline it draws is read through the caller's own scope.
      if (Object.keys(row.element_ids).some((blueprintId) => !inProject.has(blueprintId))) {
        problems.push({ row: i, reason: "element_ids names a blueprint outside this project" });
      } else {
        entry.element_ids = mergeIds(row.element_ids, {});
        entry.element_count = countIds(entry.element_ids);
      }
    }
    return entry;
  });

  const pointed = rows.flatMap((row, i) => (row.from ? [{ i, from: row.from }] : []));
  if (pointed.length) {
    const resolved = await api.queryResolve(ctx.principal, args.project_id, {
      selections: args.selections!,
      rows: pointed.map((p) => p.from),
      ids_per_row: IDS_PER_ROW,
      max_ids: IDS_PER_RESULT,
    });
    if (resolved.rows.length !== pointed.length) throw new Error("resolve answered for a different number of rows");
    pointed.forEach(({ i }, j) => {
      const hit = resolved.rows[j]!;
      const row = out[i]!;
      // An id the row names that its group also holds is one element, not two.
      const own = row.element_ids;
      row.element_ids = mergeIds(own, hit.element_ids);
      const shared = countIds(own) + countIds(hit.element_ids) - countIds(row.element_ids);
      row.element_count += hit.element_count - shared;
      if (hit.element_ids_truncated) row.element_ids_truncated = true;
      if (hit.problem) problems.push({ row: i, reason: hit.problem });
    });
  }

  return {
    project_id: detail.id,
    project_name: detail.name,
    title: args.title,
    built_by: "model",
    language: args.language ?? "en",
    blueprints: detail.blueprints.map((b) => ({ blueprint_id: b.id, name: b.name ?? null })),
    columns,
    rows: out,
    ...(args.selections ? { selections: args.selections } : {}),
    notes: [],
    problems,
  };
}

// ── app-only: what the table panel calls ─────────────────────────────────────────────

const rowElementsInput = z.strictObject({
  project_id: z.string().min(1),
  table: selectionSchema.optional(),
  // A Kamai-built row is found by its key in the table rebuilt now, never by position: a
  // group deleted since the table was shown shifts every row after it. `row` is the index
  // the panel showed, kept only to name the row in a problem.
  row: z.number().int().min(0).optional(),
  row_key: rowKey.optional(),
  selections: z.array(selectionSchema).min(1).max(5).optional(),
  from: fromSchema.optional(),
});

const sameKey = (a: Record<string, string | null> | null | undefined, b: Record<string, string | null>): boolean => {
  if (!a) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && a[k] === b[k]);
};

const outlinesInput = z.strictObject({
  project_id: z.string().min(1),
  blueprint_id: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1).max(OUTLINES_PER_CALL),
});

function registerTableHelpers(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_table_row_elements",
    {
      title: "Table row elements",
      description: GET_TABLE_ROW_ELEMENTS_DESCRIPTION,
      inputSchema: rowElementsInput,
      outputSchema: looseOutput(rowElementsOutput),
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async (args) => {
      try {
        const byTable = args.table !== undefined || args.row !== undefined || args.row_key !== undefined;
        const bySelections = args.selections !== undefined || args.from !== undefined;
        if (byTable === bySelections || (byTable && (args.table === undefined || args.row_key === undefined))
          || (bySelections && (!args.selections || !args.from))) {
          throw new BadArgument("Pass table and row_key, or selections and from.");
        }
        if (args.from && args.selections && args.from.s >= args.selections.length) {
          throw new BadArgument(`from.s is ${args.from.s}, but selections holds ${args.selections.length}.`);
        }
        if (byTable) {
          const table = await api.queryTable(ctx.principal, args.project_id, {
            selection: args.table!,
            ...(args.row !== undefined ? { row: args.row } : {}),
            row_key: args.row_key!,
            ids_per_row: PANEL_IDS,
            max_ids: PANEL_IDS,
          });
          const hit = table.rows.find((row) => row.kind !== "note" && sameKey(row.key, args.row_key!));
          if (!hit) {
            return text({ element_ids: {}, element_count: 0, element_ids_truncated: false, problem: "That row is not in the table now." });
          }
          return text({
            element_ids: hit.element_ids,
            element_count: hit.element_count,
            element_ids_truncated: hit.element_ids_truncated,
          });
        }
        const resolved = await api.queryResolve(ctx.principal, args.project_id, {
          selections: args.selections!,
          rows: [args.from!],
          ids_per_row: PANEL_IDS,
          max_ids: PANEL_IDS,
        });
        const hit = resolved.rows[0];
        if (!hit) throw new Error("resolve answered no row");
        return text({
          element_ids: hit.element_ids,
          element_count: hit.element_count,
          element_ids_truncated: hit.element_ids_truncated,
          ...(hit.problem ? { problem: hit.problem } : {}),
        });
      } catch (err) {
        ctx.fail(err, "get_table_row_elements");
      }
    },
  );

  server.registerTool(
    "get_element_outlines",
    {
      title: "Element outlines",
      description: GET_ELEMENT_OUTLINES_DESCRIPTION,
      inputSchema: outlinesInput,
      outputSchema: looseOutput(elementOutlinesOutput),
      annotations: READONLY,
      _meta: APP_ONLY,
    },
    async ({ project_id, blueprint_id, ids }) => {
      try {
        const projectId = await resolveProject(ctx.principal, blueprint_id, project_id);
        const page = (await api.geometrySelect(ctx.principal, projectId, blueprint_id, ids)) as Record<string, unknown>;
        // One traced wall can carry thousands of points. Outlines past the budget are
        // named in `omitted` so the panel asks for them in the next call; they are not
        // `missing`, which means the element is not on the blueprint.
        const features = page.features as Array<{ id?: string | null }>;
        const before = features.map((f) => f.id);
        const dropped = fitResult(page, features, (n) => `${n} outline(s) omitted for size; ask again for them.`);
        if (dropped) page.omitted = before.slice(features.length).filter((id): id is string => !!id);
        return text(page);
      } catch (err) {
        ctx.fail(err, "get_element_outlines");
      }
    },
  );
}
