import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { api, markupChangeSchema, markupClipSchema, markupListSchema, resolveProject } from "./api.ts";
import { looseOutput } from "./loose.ts";
import type { ToolContext } from "./query/context.ts";
import { DESTRUCTIVE_IDEMPOTENT, READONLY, WRITE, text } from "./tool-kit.ts";

// Markups: revision clouds, highlights and notes on a sheet. Pass-through: the API
// layer converts positions, finds the room under a note's arrow and checks who may edit.

const unit = z.number().min(0).max(1);
const point = z.array(unit).length(2);
const box = z.array(unit).length(4);

const POSITIONS =
  "Positions are fractions of the page from its top-left corner, 0..1 on each axis, the same as " +
  "get_sheet_text's bbox: a box is [x0, y0, x1, y1], a point [x, y].";

const NAMING =
  "In replies, name a markup by what it is: its kind, a cloud's Δ number, a note's text and the room or element it points at. " +
  "Its id and version are for update_markup and delete_markup, not for the user.";

const STYLE = z
  .strictObject({
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    width: z.number().positive().optional(),
    opacity: z.number().min(0.05).max(1).optional(),
    font_size: z.number().min(4).max(72).optional(),
  })
  .optional()
  .describe("Optional look: color #rrggbb, line width in points, opacity, font_size (notes only).");

export function registerMarkupTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_markups",
    {
      title: "List a sheet's markups",
      description:
        "The markups drawn on a blueprint sheet: revision clouds (numbered Δ1, Δ2… per sheet), " +
        "highlights, and notes with an arrow. Everyone on the project sees them; `can_edit` says " +
        `whether this user may change one. ${POSITIONS} ${NAMING}`,
      inputSchema: { blueprint_id: z.string().min(1), project_id: z.string().min(1).optional() },
      outputSchema: looseOutput(markupListSchema),
      annotations: READONLY,
    },
    async ({ blueprint_id, project_id }) => {
      try {
        const projectId = await resolveProject(ctx.principal, blueprint_id, project_id);
        return text(await api.listMarkups(ctx.principal, projectId, blueprint_id));
      } catch (err) {
        ctx.fail(err, "list_markups");
      }
    },
  );

  server.registerTool(
    "add_markup",
    {
      title: "Add a markup",
      description:
        "Draw a markup on a blueprint sheet; it is saved and the whole project sees it in the app. " +
        "A cloud takes `box` (a revision cloud around that area, numbered Δ1, Δ2…) or `points` " +
        "(an outline). A highlight takes `points`, the line its see-through stroke follows. A note " +
        "takes `box` (where its text sits), `text`, and `pointer`, the spot its arrow points at; " +
        "the room under the pointer is recorded with it. " +
        `${POSITIONS} To place one next to something, read where it is first (get_sheet_text for ` +
        `printed words, the plan view for elements). ${NAMING}`,
      inputSchema: {
        blueprint_id: z.string().min(1),
        project_id: z.string().min(1).optional(),
        kind: z.enum(["cloud", "highlight", "note"]),
        box: box.optional(),
        points: z.array(point).min(2).max(2000).optional(),
        pointer: point.optional(),
        text: z.string().max(2000).optional(),
        style: STYLE,
        request_id: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Any unique value; repeat it on a retry and the first markup is returned instead of a second one."),
      },
      outputSchema: looseOutput(markupChangeSchema),
      annotations: WRITE,
    },
    async ({ blueprint_id, project_id, ...body }) => {
      try {
        const projectId = await resolveProject(ctx.principal, blueprint_id, project_id);
        return text(await api.createMarkup(ctx.principal, projectId, blueprint_id, defined(body)));
      } catch (err) {
        ctx.fail(err, "add_markup");
      }
    },
  );

  server.registerTool(
    "update_markup",
    {
      title: "Change a markup",
      description:
        "Move, reshape, restyle or retext a markup. Send its `version` from list_markups. When " +
        "someone changed it in between, the result's status is `conflict` with the markup as it " +
        "is now: apply the change to that version or tell the user. Only the markup's author or " +
        `the project owner can change it. ${POSITIONS} ${NAMING}`,
      inputSchema: {
        blueprint_id: z.string().min(1),
        project_id: z.string().min(1).optional(),
        markup_id: z.string().min(1),
        version: z.number().int().min(1),
        box: box.optional(),
        points: z.array(point).min(2).max(2000).optional(),
        pointer: point.optional(),
        text: z.string().max(2000).optional(),
        style: STYLE,
      },
      outputSchema: looseOutput(markupChangeSchema),
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ blueprint_id, project_id, markup_id, ...body }) => {
      try {
        const projectId = await resolveProject(ctx.principal, blueprint_id, project_id);
        return text(await api.updateMarkup(ctx.principal, projectId, blueprint_id, markup_id, defined(body)));
      } catch (err) {
        ctx.fail(err, "update_markup");
      }
    },
  );

  server.registerTool(
    "delete_markup",
    {
      title: "Delete a markup",
      description:
        "Remove a markup from the sheet for everyone on the project. Send its `version` from " +
        "list_markups; a status of `conflict` means it changed in between. A cloud's Δ number is " +
        `not reused. Only the markup's author or the project owner can delete it. ${NAMING}`,
      inputSchema: {
        blueprint_id: z.string().min(1),
        project_id: z.string().min(1).optional(),
        markup_id: z.string().min(1),
        version: z.number().int().min(1),
      },
      outputSchema: looseOutput(markupChangeSchema),
      annotations: DESTRUCTIVE_IDEMPOTENT,
    },
    async ({ blueprint_id, project_id, markup_id, version }) => {
      try {
        const projectId = await resolveProject(ctx.principal, blueprint_id, project_id);
        return text(await api.deleteMarkup(ctx.principal, projectId, blueprint_id, markup_id, version));
      } catch (err) {
        ctx.fail(err, "delete_markup");
      }
    },
  );

  server.registerTool(
    "clip_markups",
    {
      title: "Clip an area to a PDF",
      description:
        "Make a one-page PDF (A4 or Letter) of one area of a sheet with its markups, a title block, " +
        "a list of the notes and a small key plan, for sending to a subcontractor. Returns a " +
        "temporary download link: give the user `url` as a link named by `file_name`, say it " +
        "expires after `expires_in` seconds, and never download or open it yourself. The rest of " +
        `the sheet stays inside the file, cropped out of view. ${POSITIONS}`,
      inputSchema: {
        blueprint_id: z.string().min(1),
        project_id: z.string().min(1).optional(),
        box: box.describe("The area to clip, [x0, y0, x1, y1]."),
        page: z.enum(["A4", "Letter"]).optional(),
        notes: z.boolean().optional().describe("List the notes beside the drawing (default true)."),
        key_plan: z.boolean().optional().describe("Show a small plan of the whole sheet with the area marked (default true)."),
      },
      outputSchema: looseOutput(markupClipSchema),
      annotations: READONLY,
    },
    async ({ blueprint_id, project_id, ...body }) => {
      try {
        const projectId = await resolveProject(ctx.principal, blueprint_id, project_id);
        return text(await api.clipMarkups(ctx.principal, projectId, blueprint_id, defined(body)));
      } catch (err) {
        ctx.fail(err, "clip_markups");
      }
    },
  );
}

function defined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}
