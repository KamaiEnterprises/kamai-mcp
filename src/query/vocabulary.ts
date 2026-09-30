// Kamai's query vocabulary, as the API layer defines it. vocabulary.snapshot.json
// is the same vocabulary as GET /v1/vocabulary returns it; a test holds these lists to
// the snapshot and scripts/check-vocabulary.ts holds the snapshot to a live API.

export const CATEGORIES = [
  "doors",
  "windows",
  "openings",
  "opening_pieces",
  "rooms",
  "wet_rooms",
  "walls",
  "wet_walls",
  "wall_centerlines",
  "wall_surfaces",
  "fixtures",
  "footprint",
  "text",
] as const;

export const CLASSES = [
  "room",
  "wall",
  "wall_centerline",
  "wall_surface",
  "wall_surface_with_opening",
  "opening",
  "footprint",
  "other",
] as const;

export const SUB_CLASSES = [
  "window",
  "swing window",
  "safe room window",
  "single swing door",
  "double swing door",
  "sliding door",
  "toilet",
  "sink",
  "bathtub",
  "shower",
  "cooktop",
  "stairs",
  "elevator",
  "wet room",
  "wet wall",
] as const;

export const HANDINGS = ["LH", "RH", "LHR", "RHR"] as const;

// blueprint_id is the API's "sheet" key, spelled the way every other tool spells it.
export const GROUP_KEYS = [
  "blueprint_id",
  "folder",
  "folder_path",
  "class",
  "sub_class",
  "tag",
  "handing",
  "kind",
  "name",
  "color",
  "blueprint_discipline",
] as const;

export const ORDER_FIELDS = [
  "area_m2",
  "perimeter_m",
  "length_m",
  "width_m",
  "name",
  "tag",
  "handing",
  "class",
  "sub_class",
  "blueprint_discipline",
  "updated_at",
] as const;

export { HEIGHT_UNITS } from "./contract.ts";

export type Category = (typeof CATEGORIES)[number];
