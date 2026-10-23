import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { api, resolveProject } from "../api.ts";
import { BadArgument } from "../elements.ts";
import { looseOutput } from "../loose.ts";
import { READONLY, text } from "../tool-kit.ts";
import { RESULT_BUDGET, resultCost } from "./budget.ts";
import type { ToolContext } from "./context.ts";
import {
  GET_PRINTED_TABLES_DESCRIPTION,
  GET_SHEET_TEXT_DESCRIPTION,
  SHEET_TEXT_TABLES_SENTENCE,
  PRINTED_TABLES_BLUEPRINTS_GUIDE,
  PRINTED_TABLES_CURSOR_GUIDE,
  PRINTED_TABLES_FORMAT_GUIDE,
  PRINTED_TABLES_ID_GUIDE,
  PRINTED_TABLES_LIMIT_GUIDE,
  PRINTED_TABLES_Q_GUIDE,
  SHEET_TEXT_BBOX_GUIDE,
  SHEET_TEXT_CURSOR_GUIDE,
  SHEET_TEXT_FIELDS_GUIDE,
  SHEET_TEXT_LIMIT_GUIDE,
  SHEET_TEXT_Q_GUIDE,
  SHEET_TEXT_ROOM_GUIDE,
  SHEET_TEXT_SOURCE_GUIDE,
} from "./descriptions.ts";
import { printedTablesOutput, sheetTextOutput } from "./outputs.ts";

// Pages sized to fit RESULT_BUDGET at a typical word / row. The API layer pages and
// filters; this module never drops an entry from a page, because the API's next_cursor
// points past every entry it sent and a dropped one could never be read again.
export const WORDS_PER_PAGE = 500;
export const ROWS_PER_PAGE = 200;
const MAX_FETCHES = 6;
const OVERSIZED_NOTE =
  "This page is still larger than a host delivers: ask for it again with a smaller limit, or narrow it with a filter.";

export function registerDrawingTextTools(server: McpServer, ctx: ToolContext): void {
  registerGetSheetText(server, ctx);
  if (ctx.printedTables) registerGetPrintedTables(server, ctx);
}

/** Fetch one page, and when it does not fit what a host delivers, fetch the same page again
 * with a smaller limit. `count` is how many entries the page holds. A page that still does
 * not fit (one entry too large, or the fetches ran out) is returned flagged `oversized`. */
async function fittedPage<T extends Record<string, unknown>>(
  limit: number,
  fetchPage: (limit: number) => Promise<T>,
  count: (page: T) => number,
): Promise<T> {
  let page = await fetchPage(limit);
  for (let fetches = 1; fetches < MAX_FETCHES; fetches++) {
    const cost = resultCost(page);
    const entries = count(page);
    if (cost <= RESULT_BUDGET || entries <= 1) break;
    limit = Math.max(1, Math.min(Math.floor(entries / 2), Math.floor((entries * RESULT_BUDGET * 0.9) / cost)));
    page = await fetchPage(limit);
  }
  if (resultCost(page) > RESULT_BUDGET) {
    const notes = Array.isArray(page.notes) ? (page.notes as unknown[]) : [];
    return { ...page, oversized: true, notes: [...notes, OVERSIZED_NOTE] };
  }
  return page;
}

// ── get_sheet_text ────────────────────────────────────────────────────────────────────

const unit = z.number().min(0).max(1);

const sheetTextInput = z.strictObject({
  blueprint_id: z.string().min(1),
  project_id: z.string().min(1).optional(),
  q: z.string().min(1).max(200).optional().describe(SHEET_TEXT_Q_GUIDE),
  room_id: z.string().min(1).optional().describe(SHEET_TEXT_ROOM_GUIDE),
  source: z.string().min(1).optional().describe(SHEET_TEXT_SOURCE_GUIDE),
  bbox: z.array(unit).length(4).optional().describe(SHEET_TEXT_BBOX_GUIDE),
  fields: z.array(z.string().min(1)).max(10).optional().describe(SHEET_TEXT_FIELDS_GUIDE),
  limit: z.number().int().min(1).max(5000).optional().describe(SHEET_TEXT_LIMIT_GUIDE),
  cursor: z.string().min(1).optional().describe(SHEET_TEXT_CURSOR_GUIDE),
});

// The API layer reads `fields` as the whole list, not extras: without these a word comes back with no text.
const WORD_FIELDS = ["text", "bbox", "source", "room"];

function registerGetSheetText(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_sheet_text",
    {
      title: "Read a sheet's text",
      description: GET_SHEET_TEXT_DESCRIPTION + (ctx.printedTables ? SHEET_TEXT_TABLES_SENTENCE : ""),
      inputSchema: sheetTextInput,
      outputSchema: looseOutput(sheetTextOutput),
      annotations: READONLY,
    },
    async (args) => {
      try {
        const projectId = await resolveProject(ctx.principal, args.blueprint_id, args.project_id);
        const query = {
          q: args.q,
          room_id: args.room_id,
          source: args.source,
          bbox: args.bbox?.join(","),
          fields: args.fields?.length ? [...new Set([...WORD_FIELDS, ...args.fields])].join(",") : undefined,
          cursor: args.cursor,
        };
        const page = await fittedPage(
          args.limit ?? WORDS_PER_PAGE,
          (limit) => api.getSheetText(ctx.principal, projectId, args.blueprint_id, { ...query, limit }),
          (result) => result.words.length,
        );
        return text(page);
      } catch (err) {
        ctx.fail(err, "get_sheet_text");
      }
    },
  );
}

// ── get_printed_tables ────────────────────────────────────────────────────────────────

const printedTablesInput = z.strictObject({
  project_id: z.string().min(1).optional(),
  blueprint_ids: z.array(z.string().min(1)).min(1).max(25).optional().describe(PRINTED_TABLES_BLUEPRINTS_GUIDE),
  table_id: z.string().min(1).optional().describe(PRINTED_TABLES_ID_GUIDE),
  q: z.string().min(1).max(200).optional().describe(PRINTED_TABLES_Q_GUIDE),
  format: z.enum(["rows", "markdown"]).optional().describe(PRINTED_TABLES_FORMAT_GUIDE),
  limit: z.number().int().min(1).max(5000).optional().describe(PRINTED_TABLES_LIMIT_GUIDE),
  cursor: z.string().min(1).optional().describe(PRINTED_TABLES_CURSOR_GUIDE),
});

const NEED_SCOPE = "Pass project_id (list_blueprints lists them) or blueprint_ids.";

function registerGetPrintedTables(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_printed_tables",
    {
      title: "Read printed tables",
      description: GET_PRINTED_TABLES_DESCRIPTION,
      inputSchema: printedTablesInput,
      outputSchema: looseOutput(printedTablesOutput),
      annotations: READONLY,
    },
    async (args) => {
      try {
        const first = args.blueprint_ids?.[0];
        if (!args.project_id && !first) throw new BadArgument(NEED_SCOPE);
        const projectId = args.project_id ?? (await resolveProject(ctx.principal, first!));
        const body: Record<string, unknown> = {};
        for (const key of ["blueprint_ids", "table_id", "q", "format", "cursor"] as const) {
          if (args[key] !== undefined) body[key] = args[key];
        }
        const page = await fittedPage(
          args.limit ?? ROWS_PER_PAGE,
          (limit) => api.queryPrintedTables(ctx.principal, projectId, { ...body, limit }),
          (result) => result.tables?.length ?? (result.table?.rows as unknown[] | undefined)?.length ?? 0,
        );
        return text(page);
      } catch (err) {
        ctx.fail(err, "get_printed_tables");
      }
    },
  );
}
