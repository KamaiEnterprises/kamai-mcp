import { z } from "zod";

// The query routes' response contract, mirrored as the decoders kamai-mcp applies to
// what the API layer returns.
//
// Loose on purpose: an unknown field passes through, so the backend can add one without
// a coordinated deploy. Strict where it matters: structure (arrays, objects) and the
// measurement fields, which are DISPLAY STRINGS in the drawing's own units. A number
// arriving where a display string belongs is the raw SI value the model must never see,
// and it fails the decode rather than reaching the model.

export const HEIGHT_UNITS = ["mm", "cm", "m", "in", "ft"] as const;
export type HeightUnit = (typeof HEIGHT_UNITS)[number];

/** A height exactly as the user stated it. The backend checks `quote` states `value` in
 * `unit` next to the word for what it measures, and refuses it otherwise. */
export type HeightStatement = { value: number; unit: HeightUnit; quote: string };

const display = z.string().nullish();
const idMap = z.record(z.string(), z.array(z.string()));

const blueprintRef = z.looseObject({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  units: z.string().nullish(),
  has_scale: z.boolean().nullish(),
});

const excluded = z.looseObject({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  reason: z.string(),
});

export const findRowSchema = z.looseObject({
  ref: z.string(),
  id: z.string(),
  blueprint_id: z.string(),
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
  area: display,
  perimeter: display,
  length: display,
  width: display,
});

export const selectResultSchema = z.looseObject({
  project_id: z.string(),
  project_name: z.string().nullish(),
  blueprints: z.array(blueprintRef),
  rows: z.array(findRowSchema),
  total: z.number(),
  returned: z.number(),
  offset: z.number(),
  next_offset: z.number().nullable(),
  excluded: z.array(excluded),
  total_is_partial: z.boolean(),
  notes: z.array(z.string()),
  selection: z.string().nullable(),
});

export const aggregateGroupSchema = z.looseObject({
  blueprint_name: z.string().nullish(),
  count: z.number(),
  area: display,
  perimeter: display,
  length: display,
  width_min: display,
  width_max: display,
  area_note: z.string().nullish(),
  units_conflict: z.string().nullish(),
  unmeasured_count: z.number().nullish(),
  element_count: z.number(),
  element_ids: idMap.nullish(),
  element_ids_truncated: z.boolean().nullish(),
  // Words (category text): word ids, which are not element ids.
  text_ids: idMap.nullish(),
  text_ids_truncated: z.boolean().nullish(),
});

export const aggregateResultSchema = z.looseObject({
  project_id: z.string(),
  project_name: z.string().nullish(),
  blueprints: z.array(blueprintRef),
  group_by: z.array(z.string()),
  groups: z.array(aggregateGroupSchema),
  groups_total: z.number(),
  groups_truncated: z.boolean(),
  total: z.looseObject({
    count: z.number(),
    area: display,
    area_note: z.string().nullish(),
    count_is_partial: z.boolean(),
    area_is_partial: z.boolean().nullish(),
    units_conflict: z.string().nullish(),
  }),
  excluded: z.array(excluded),
  total_is_partial: z.boolean(),
  notes: z.array(z.string()),
  selection: z.string().nullable(),
});

export const wallRoomSchema = z.looseObject({
  ref: z.string(),
  id: z.string(),
  blueprint_id: z.string(),
  blueprint_name: z.string().nullish(),
  name: z.string().nullish(),
  basis: z.string().nullish(),
  net_wall_area: display,
  gross_wall_area: display,
  opening_area: display,
  wall_run: display,
  perimeter: display,
  coverage_ratio: z.number().nullish(),
  perimeter_net_wall_area: display,
  room_height: display,
  room_height_source: z.string().nullish(),
  defaulted_heights: z.array(z.string()).nullish(),
  openings_left_undeducted_count: z.number().nullish(),
  missing_opening_width_count: z.number().nullish(),
  assumed_window_count: z.number().nullish(),
  unknown_opening_length: display,
  error: z.string().nullish(),
  note: z.string().nullish(),
  element_ids: idMap,
  element_count: z.number(),
  element_ids_truncated: z.boolean(),
  opening_ids: idMap.nullish(),
  opening_count: z.number().nullish(),
  opening_ids_truncated: z.boolean().nullish(),
});

export const wallSurfaceResultSchema = z.looseObject({
  project_id: z.string(),
  project_name: z.string().nullish(),
  method: z.string().nullish(),
  defaults: z.looseObject({ room: display, door: display, window: display }).nullish(),
  stated_heights: z.array(z.looseObject({})).nullish(),
  rooms: z.array(wallRoomSchema),
  unknown_room_refs: z.array(z.string()),
  skipped_non_rooms: z.number(),
  total: z.looseObject({
    net_wall_area: display,
    rooms_measured: z.number(),
    rooms_failed: z.number(),
    units_conflict: z.string().nullish(),
  }),
  notes: z.array(z.string()),
  selection: z.string().nullable(),
});

const cell = z.union([z.string(), z.number(), z.null()]);

export const tableColumnSchema = z.looseObject({
  key: z.string(),
  label: z.string(),
  type: z.string().nullish(),
  unit: z.string().nullish(),
  align: z.string().nullish(),
});

/** What identifies a Kamai-built row when the table is rebuilt: a count group's
 * group_by values, or a find / wall-surface row's {ref}; {} is the whole query. */
export const rowKeySchema = z.record(z.string(), z.string().nullable());

export const tableRowSchema = z.looseObject({
  index: z.number(),
  cells: z.record(z.string(), cell),
  kind: z.string(),
  element_ids: idMap,
  element_count: z.number(),
  element_ids_truncated: z.boolean(),
  key: rowKeySchema.nullish(),
});

export const tableResultSchema = z.looseObject({
  project_id: z.string(),
  project_name: z.string().nullish(),
  source: z.string(),
  language: z.string(),
  blueprints: z.array(z.looseObject({ blueprint_id: z.string(), name: z.string().nullish() })),
  columns: z.array(tableColumnSchema),
  rows: z.array(tableRowSchema),
  notes: z.array(z.string()),
  problems: z.array(z.looseObject({ row: z.number(), reason: z.string() })),
});

export const resolvedRowSchema = z.looseObject({
  element_ids: idMap,
  element_count: z.number(),
  element_ids_truncated: z.boolean(),
  problem: z.string().nullish(),
});

export const resolveResultSchema = z.looseObject({ rows: z.array(resolvedRowSchema) });

const countMap = z.record(z.string(), z.number());

export const inventoryBlueprintSchema = z.looseObject({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  state: z.string(),
  status: z.string(),
  has_scale: z.boolean(),
  scale_label: z.string().nullish(),
  scale_unconfirmed: z.boolean(),
  units: z.string().nullish(),
  discipline: z.string().nullish(),
  // null on a not_indexed blueprint: what it holds is unknown, never "nothing".
  words: z.number().nullable(),
  classes: z
    .record(
      z.string(),
      z.looseObject({
        count: z.number(),
        sub_classes: countMap,
        sub_classes_other: z.number().nullish(),
        folders: countMap,
        folders_other: z.number().nullish(),
      }),
    )
    .nullable(),
  single_swing_doors: z.looseObject({ total: z.number(), with_handing: z.number() }).nullish(),
  note: z.string().nullish(),
});

export const inventoryResultSchema = z.looseObject({
  project_id: z.string(),
  project_name: z.string().nullish(),
  language_sample: z.string(),
  blueprints: z.array(inventoryBlueprintSchema),
});

// `label` may be absent: the pipeline saves a sheet it could not read a scale off with a
// placeholder ratio and no label. A strict string here failed the decode AFTER set_scale
// had written, and the tool reported an internal error for a scale it had set.
const scaleInfo = z.looseObject({ label: z.string().nullish(), type: z.string().nullish(), units: z.string().nullish() });

export const scaleResultSchema = z.looseObject({
  blueprint_id: z.string(),
  name: z.string().nullish(),
  previous: scaleInfo.nullable(),
  scale: scaleInfo,
  stored_heights_reinterpreted: z.number(),
  needs_scale: z.boolean(),
  scale_unconfirmed: z.boolean(),
});

// The same projection the geometry page uses, declared here rather than imported from
// api.ts so the two modules do not import each other.
export const outlineFeatureSchema = z.looseObject({
  i: z.number(),
  id: z.string().nullish(),
  cls: z.string(),
  name: z.string(),
  folder: z.string().nullish(),
  color: z.looseObject({ r: z.number(), g: z.number(), b: z.number(), a: z.number() }).nullish(),
  rings: z.array(z.array(z.number())).nullish(),
  lines: z.array(z.array(z.number())).nullish(),
  pts: z.array(z.number()).nullish(),
  area: z.number().nullish(),
  len: z.number().nullish(),
});

export const geometrySelectResultSchema = z.looseObject({
  blueprint_id: z.string(),
  grid: z.number(),
  features: z.array(outlineFeatureSchema),
  missing: z.array(z.string()),
});

export const vocabularySchema = z.looseObject({
  classes: z.array(z.string()),
  sub_classes: z.array(z.string()),
  kinds: z.array(z.string()),
  handing: z.array(z.string()),
  disciplines: z.array(z.looseObject({ letter: z.string(), name: z.string() })),
  categories: z.record(
    z.string(),
    z.looseObject({
      where: z.unknown(),
      include_text: z.boolean(),
      sub_classes_allowed: z.array(z.string()),
    }),
  ),
  group_by: z.array(z.string()),
  order_by: z.array(z.string()),
  fields: z.array(z.looseObject({ name: z.string(), kind: z.string(), doc: z.string().nullish() })),
  operators: z.array(z.unknown()),
  limits: z.record(z.string(), z.unknown()),
});

export type SelectResult = z.infer<typeof selectResultSchema>;
export type FindRow = z.infer<typeof findRowSchema>;
export type AggregateResult = z.infer<typeof aggregateResultSchema>;
export type WallSurfaceResult = z.infer<typeof wallSurfaceResultSchema>;
export type TableResult = z.infer<typeof tableResultSchema>;
export type TableColumn = z.infer<typeof tableColumnSchema>;
export type ResolveResult = z.infer<typeof resolveResultSchema>;
export type InventoryResult = z.infer<typeof inventoryResultSchema>;
export type InventoryBlueprint = z.infer<typeof inventoryBlueprintSchema>;
export type ScaleResult = z.infer<typeof scaleResultSchema>;
export type GeometrySelectResult = z.infer<typeof geometrySelectResultSchema>;
export type Vocabulary = z.infer<typeof vocabularySchema>;
export type IdMap = z.infer<typeof idMap>;
