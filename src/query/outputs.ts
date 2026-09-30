import { z } from "zod";

// What the query tools ADVERTISE as their output. Every tool passes these through
// looseOutput(), so unknown fields are allowed at every depth, and row fields are
// optional because compact() moves a field every row shares into `rows_common` /
// `groups_common`. The decoders in contract.ts are the strict half.

const idMap = z.record(z.string(), z.array(z.string())).describe("{blueprint_id: [local ids]}");
const blueprints = z.array(
  z.object({
    blueprint_id: z.string(),
    name: z.string().nullish(),
    units: z.string().nullish(),
    has_scale: z.boolean().nullish(),
  }),
);
const excluded = z.array(z.object({ blueprint_id: z.string(), name: z.string().nullish(), reason: z.string() }));
const notes = z.array(z.string()).describe("Caveats about this exact result. Read them before answering.");
const selection = z
  .string()
  .nullable()
  .describe("Pass to render_table as from_result, or (rooms) to calculate_wall_surface_area.");

export const countElementsOutput = z.object({
  project_id: z.string(),
  project_name: z.string().nullish(),
  blueprints: blueprints.optional(),
  group_by: z.array(z.string()).optional(),
  groups: z.array(
    z.object({
      blueprint_name: z.string().nullish(),
      count: z.number().optional(),
      area: z.string().nullish(),
      perimeter: z.string().nullish(),
      length: z.string().nullish(),
      width_min: z.string().nullish(),
      width_max: z.string().nullish(),
      area_note: z.string().nullish(),
      units_conflict: z.string().nullish(),
      unmeasured_count: z.number().nullish(),
      element_count: z.number().optional(),
      element_ids: idMap.nullish(),
      element_ids_truncated: z.boolean().nullish(),
      text_ids: idMap.nullish().describe("Words only: word ids. Not element ids: no editing tool takes them."),
      text_ids_truncated: z.boolean().nullish(),
    }),
  ),
  groups_common: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Fields every group shares, stated once instead of on each group."),
  groups_total: z.number().optional(),
  groups_truncated: z.boolean().optional(),
  total: z
    .object({
      count: z.number(),
      area: z.string().nullish(),
      area_note: z.string().nullish(),
      count_is_partial: z.boolean().optional(),
      area_is_partial: z.boolean().nullish(),
      units_conflict: z.string().nullish(),
    })
    .optional(),
  excluded: excluded.optional(),
  total_is_partial: z.boolean().optional(),
  notes,
  selection: selection.optional(),
  truncated: z.boolean().optional(),
});

export const findElementsOutput = z.object({
  project_id: z.string(),
  project_name: z.string().nullish(),
  blueprints: blueprints.optional(),
  rows: z.array(
    z.object({
      ref: z.string().optional(),
      id: z.string().optional(),
      blueprint_id: z.string().optional(),
      kind: z.string().nullish(),
      class: z.string().nullish(),
      sub_class: z.string().nullish(),
      name: z.string().nullish(),
      tag: z.string().nullish(),
      handing: z.string().nullish(),
      folder: z.string().nullish(),
      folder_path: z.string().nullish(),
      blueprint_discipline: z.string().nullish(),
      is_user_drawn: z.boolean().nullish(),
      needs_scale: z.boolean().nullish(),
      area: z.string().nullish(),
      perimeter: z.string().nullish(),
      length: z.string().nullish(),
      width: z.string().nullish(),
    }),
  ),
  rows_common: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Fields every row shares, stated once instead of on each row."),
  total: z.number().optional(),
  returned: z.number().optional(),
  offset: z.number().optional(),
  next_offset: z.number().nullish(),
  excluded: excluded.optional(),
  total_is_partial: z.boolean().optional(),
  notes,
  selection: selection.optional(),
  truncated: z.boolean().optional(),
});

export const wallSurfaceOutput = z.object({
  project_id: z.string(),
  project_name: z.string().nullish(),
  method: z.string().nullish(),
  defaults: z.object({ room: z.string().nullish(), door: z.string().nullish(), window: z.string().nullish() }).nullish(),
  stated_heights: z.array(z.record(z.string(), z.unknown())).nullish(),
  rooms: z.array(
    z.object({
      ref: z.string().optional(),
      id: z.string().optional(),
      blueprint_id: z.string().optional(),
      blueprint_name: z.string().nullish(),
      name: z.string().nullish(),
      basis: z.string().nullish(),
      net_wall_area: z.string().nullish(),
      gross_wall_area: z.string().nullish(),
      opening_area: z.string().nullish(),
      wall_run: z.string().nullish(),
      perimeter: z.string().nullish(),
      coverage_ratio: z.number().nullish(),
      perimeter_net_wall_area: z.string().nullish(),
      room_height: z.string().nullish(),
      room_height_source: z.string().nullish(),
      defaulted_heights: z.array(z.string()).nullish(),
      openings_left_undeducted_count: z.number().nullish(),
      missing_opening_width_count: z.number().nullish(),
      assumed_window_count: z.number().nullish(),
      error: z.string().nullish(),
      note: z.string().nullish(),
      element_ids: idMap.optional(),
      element_count: z.number().optional(),
      element_ids_truncated: z.boolean().optional(),
      opening_ids: idMap.nullish(),
      opening_count: z.number().nullish(),
      opening_ids_truncated: z.boolean().nullish(),
    }),
  ),
  unknown_room_refs: z.array(z.string()).optional(),
  skipped_non_rooms: z.number().optional(),
  total: z
    .object({
      net_wall_area: z.string().nullish(),
      rooms_measured: z.number().optional(),
      rooms_failed: z.number().optional(),
      units_conflict: z.string().nullish(),
    })
    .optional(),
  notes,
  selection: selection.optional(),
  truncated: z.boolean().optional(),
});

const scaleInfo = z.object({ label: z.string().nullish(), type: z.string().nullish(), units: z.string().nullish() });

export const setScaleOutput = z.object({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  previous: scaleInfo.nullable().describe("The scale before this call; null when there was none."),
  scale: scaleInfo,
  stored_heights_reinterpreted: z
    .number()
    .describe("Opening heights stored in drawing units that now read differently. Restate them with set_opening_height."),
  needs_scale: z.boolean(),
  scale_unconfirmed: z.boolean(),
});

const cell = z.union([z.string(), z.number(), z.null()]);

export const renderTableOutput = z.object({
  project_id: z.string(),
  project_name: z.string().nullish(),
  title: z.string(),
  built_by: z.enum(["kamai", "model"]),
  source: z.string().optional(),
  language: z.string().optional(),
  blueprints: z.array(z.object({ blueprint_id: z.string(), name: z.string().nullish() })),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.string().nullish(),
      unit: z.string().nullish(),
      align: z.string().nullish(),
    }),
  ),
  rows: z.array(
    z.object({
      index: z.number().optional(),
      cells: z.record(z.string(), cell),
      kind: z.string().optional(),
      element_count: z.number(),
      element_ids: idMap.optional(),
      element_ids_truncated: z.boolean().optional(),
      from: z.object({ s: z.number(), group: z.record(z.string(), z.string().nullable()).optional() }).optional(),
      key: z.record(z.string(), z.string().nullable()).nullish(),
    }),
  ),
  selection: z.string().optional(),
  selections: z.array(z.string()).optional(),
  notes: z.array(z.string()),
  problems: z.array(z.object({ row: z.number(), reason: z.string() })),
  truncated: z.boolean().optional(),
});

export const rowElementsOutput = z.object({
  element_ids: idMap,
  element_count: z.number(),
  element_ids_truncated: z.boolean(),
  problem: z.string().optional(),
});

export const elementOutlinesOutput = z.object({
  blueprint_id: z.string(),
  grid: z.number(),
  features: z.array(z.record(z.string(), z.unknown())),
  missing: z.array(z.string()),
  omitted: z.array(z.string()).optional(),
});
