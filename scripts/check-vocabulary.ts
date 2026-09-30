// bun scripts/check-vocabulary.ts <api-base-url> <api-key>
//
// Compares GET /v1/vocabulary with src/query/vocabulary.snapshot.json, and the enums
// kamai-mcp validates tool inputs against with that snapshot. A drift here is a tool
// that refuses a value the API accepts, or sends one it refuses.
import snapshot from "../src/query/vocabulary.snapshot.json" with { type: "json" };
import { CATEGORIES, CLASSES, GROUP_KEYS, HANDINGS, ORDER_FIELDS, SUB_CLASSES } from "../src/query/vocabulary.ts";

const [baseArg, key] = process.argv.slice(2);
const base = (baseArg ?? "").replace(/\/+$/, "");
if (!base || !key) {
  console.error("usage: bun scripts/check-vocabulary.ts <api-base-url> <api-key>");
  process.exit(2);
}

/** Every path at which `a` and `b` differ. Arrays compare in order. */
function diff(a: unknown, b: unknown, path = "$", out: string[] = []): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out);
  } else {
    out.push(`${path}: snapshot ${JSON.stringify(a)} / live ${JSON.stringify(b)}`);
  }
  return out;
}

const problems: string[] = [];
const sorted = (values: readonly string[]) => [...values].sort();
const enums: Array<[string, readonly string[], readonly string[]]> = [
  ["categories", CATEGORIES, Object.keys(snapshot.categories)],
  ["classes", CLASSES, snapshot.classes],
  ["sub_classes", SUB_CLASSES, snapshot.sub_classes],
  ["group_by", GROUP_KEYS, snapshot.group_by],
  ["order_by", ORDER_FIELDS, snapshot.order_by],
  ["handing", HANDINGS, snapshot.handing],
];
for (const [name, ours, recorded] of enums) {
  if (JSON.stringify(sorted(ours)) !== JSON.stringify(sorted(recorded))) {
    problems.push(`src/query/vocabulary.ts ${name} differs from the snapshot`);
  }
}

const response = await fetch(`${base}/v1/vocabulary`, {
  headers: { authorization: `Bearer ${key}`, accept: "application/json" },
});
if (!response.ok) {
  console.error(`${base}/v1/vocabulary answered ${response.status}`);
  process.exit(2);
}
problems.push(...diff(snapshot, await response.json()));

if (problems.length) {
  console.error(`vocabulary drift (${problems.length}):`);
  for (const line of problems) console.error(`  ${line}`);
  process.exit(1);
}
console.log("vocabulary matches the snapshot");
