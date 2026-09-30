import { describe, expect, it } from "vitest";

import snapshot from "./vocabulary.snapshot.json" with { type: "json" };
import { CATEGORIES, CLASSES, GROUP_KEYS, HANDINGS, ORDER_FIELDS, SUB_CLASSES } from "./vocabulary.ts";

// The enums this server validates against are the API layer's. The snapshot is GET
// /v1/vocabulary as recorded; scripts/check-vocabulary.ts compares it with a live API.
describe("vocabulary", () => {
  it("matches the recorded API vocabulary", () => {
    expect([...CATEGORIES].sort()).toEqual(Object.keys(snapshot.categories).sort());
    expect([...CLASSES].sort()).toEqual([...snapshot.classes].sort());
    expect([...SUB_CLASSES].sort()).toEqual([...snapshot.sub_classes].sort());
    expect([...GROUP_KEYS].sort()).toEqual([...snapshot.group_by].sort());
    expect([...ORDER_FIELDS].sort()).toEqual([...snapshot.order_by].sort());
    expect([...HANDINGS].sort()).toEqual([...snapshot.handing].sort());
  });

  it("derives doors and windows from sub_classes, with no 'door' value anywhere", () => {
    expect(SUB_CLASSES).not.toContain("door");
    const doors = snapshot.categories.doors.sub_classes_allowed;
    const windows = snapshot.categories.windows.sub_classes_allowed;
    expect([...doors].sort()).toEqual(["double swing door", "single swing door", "sliding door"]);
    expect([...windows].sort()).toEqual(["safe room window", "swing window", "window"]);
  });
});
