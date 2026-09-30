import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApiError, api } from "../api.ts";
import { BadArgument } from "../elements.ts";
import { looseOutput } from "../loose.ts";
import { READONLY, text } from "../tool-kit.ts";
import { fitResult, resultCost, RESULT_BUDGET } from "./budget.ts";
import type { ToolContext } from "./context.ts";
import {
  INCLUDE_INVENTORY_GUIDE,
  LIST_CURSOR_GUIDE,
  LIST_PROJECT_ID_GUIDE,
  listBlueprintsDescription,
} from "./descriptions.ts";

const PAGE = 50;

const blueprintRow = z.object({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  ready: z.boolean(),
  inventory: z.record(z.string(), z.unknown()).optional(),
});

export const listBlueprintsOutput = z.object({
  projects: z.array(
    z.object({
      project_id: z.string(),
      project_name: z.string().nullish(),
      blueprints: z.array(blueprintRow),
    }),
  ),
  language_sample: z.string().optional(),
  count: z.number(),
  next_cursor: z.string().nullable(),
  notes: z.array(z.string()),
  truncated: z.boolean().optional(),
});

type BlueprintRow = z.infer<typeof blueprintRow>;
type Output = z.infer<typeof listBlueprintsOutput>;

/** How many entries of `list` fit the result budget, measured on a copy. */
function entriesThatFit(result: Output, pick: (copy: Output) => unknown[]): number {
  const copy = structuredClone(result);
  const list = pick(copy);
  fitResult(copy as unknown as Record<string, unknown>, list, () => "");
  return list.length;
}

export function registerListBlueprints(server: McpServer, ctx: ToolContext): void {
  const inputShape = {
    // An empty project_id means "no project": models send "" when they mean to list every
    // project, and refusing it cost a round trip in live runs.
    project_id: z.string().max(200).optional().describe(LIST_PROJECT_ID_GUIDE),
    cursor: z.string().min(1).optional().describe(LIST_CURSOR_GUIDE),
    ...(ctx.queryTools ? { include_inventory: z.boolean().optional().describe(INCLUDE_INVENTORY_GUIDE) } : {}),
  };

  server.registerTool(
    "list_blueprints",
    {
      title: "List blueprints",
      description: listBlueprintsDescription(ctx.queryTools),
      inputSchema: z.strictObject(inputShape),
      outputSchema: looseOutput(listBlueprintsOutput),
      annotations: READONLY,
    },
    async (input) => {
      try {
        const args = input as { project_id?: string; cursor?: string; include_inventory?: boolean };
        const project_id = args.project_id?.trim() || undefined;
        const { cursor } = args;
        const includeInventory = args.include_inventory === true;
        if (includeInventory && !project_id) throw new BadArgument("include_inventory needs project_id.");
        if (project_id && cursor) {
          throw new BadArgument("cursor pages the list of every project; leave it out when you pass project_id.");
        }
        return text(project_id ? await oneProject(ctx, project_id, includeInventory) : await allProjects(ctx, cursor));
      } catch (err) {
        ctx.fail(err, "list_blueprints");
      }
    },
  );
}

async function oneProject(ctx: ToolContext, projectId: string, includeInventory: boolean): Promise<Output> {
  let inventoryMissing = false;
  const [detail, inventory] = await Promise.all([
    api.getProject(ctx.principal, projectId),
    includeInventory
      ? api.getInventory(ctx.principal, projectId).catch((err: unknown) => {
          // The inventory is an add-on to the list. An API layer without the route still
          // answers the list; anything else fails the call as usual.
          if (err instanceof ApiError && err.code === "route_missing") {
            inventoryMissing = true;
            return undefined;
          }
          throw err;
        })
      : Promise.resolve(undefined),
  ]);
  const byId = new Map((inventory?.blueprints ?? []).map((entry) => [entry.blueprint_id, entry]));
  const blueprints: BlueprintRow[] = detail.blueprints.map((b) => {
    const row: BlueprintRow = { blueprint_id: b.id, name: b.name ?? null, ready: b.ready };
    const entry = byId.get(b.id);
    if (entry) {
      const { blueprint_id: _id, name: _name, ...rest } = entry;
      row.inventory = rest;
    }
    return row;
  });
  const notes: string[] = [];
  const result: Output = {
    projects: [{ project_id: detail.id, project_name: detail.name, blueprints }],
    count: blueprints.length,
    next_cursor: null,
    notes,
  };
  if (inventoryMissing) {
    notes.push("This Kamai server cannot list what the blueprints contain yet, so there is no inventory here.");
  }
  if (!inventory) return result;

  result.language_sample = inventory.language_sample;
  const without = blueprints.filter((b) => !b.inventory);
  if (without.length) {
    notes.push(
      `${without.length} blueprint(s) have no inventory in this result: it covers the ${byId.size} oldest ` +
        "blueprints of the project. What they contain is unknown here, not absent; count_elements with " +
        "their blueprint_ids answers the same questions.",
    );
  }
  // Inventory is the bulky part. Past the budget it is taken off the newest blueprints
  // first, so every blueprint still appears with its name and id.
  let stripped = 0;
  for (let i = blueprints.length - 1; i >= 0 && resultCost(result) > RESULT_BUDGET - 1_500; i -= 1) {
    if (blueprints[i]!.inventory) {
      delete blueprints[i]!.inventory;
      stripped += 1;
    }
  }
  if (stripped) {
    result.truncated = true;
    notes.push(
      `Inventory was left out for the last ${stripped} blueprint(s) listed, to keep this result within ` +
        "what a host delivers. Their contents are unknown here, not absent: count_elements with their " +
        "blueprint_ids and group_by ['class','sub_class'] or ['folder'] answers the same questions.",
    );
  }
  return result;
}

async function allProjects(ctx: ToolContext, cursor: string | undefined): Promise<Output> {
  const build = async (limit: number): Promise<Output> => {
    const page = await api.listProjects(ctx.principal, limit, cursor, "blueprints");
    const projects = page.items.map((p) => ({
      project_id: p.id,
      project_name: p.name,
      blueprints: (p.blueprints ?? []).map((b) => ({ blueprint_id: b.id, name: b.name ?? null, ready: b.ready })),
    }));
    return {
      projects,
      count: projects.reduce((sum, p) => sum + p.blueprints.length, 0),
      next_cursor: page.next_cursor ?? null,
      notes: [],
    };
  };

  let result = await build(PAGE);
  // Too many projects for one result: ask the API for a page that fits, so next_cursor is
  // its own and resumes exactly after the last project shown. Trimming here would leave a
  // cursor that skips the projects dropped.
  const fit = entriesThatFit(result, (copy) => copy.projects);
  if (fit < result.projects.length) {
    result = await build(fit);
    result.notes.push(
      `This page holds ${result.projects.length} project(s), fewer than usual, to stay within what a host ` +
        "delivers; next_cursor continues the list.",
    );
  }
  // One project whose blueprint list alone is over the budget.
  const only = result.projects[result.projects.length - 1];
  if (only && resultCost(result) > RESULT_BUDGET) {
    fitResult(
      result as unknown as Record<string, unknown>,
      only.blueprints,
      (dropped) =>
        `${dropped} blueprint(s) of ${only.project_name ?? "the last project"} are not listed here; ` +
        "call list_blueprints with that project_id to list them.",
    );
    result.count = result.projects.reduce((sum, p) => sum + p.blueprints.length, 0);
  }
  return result;
}
