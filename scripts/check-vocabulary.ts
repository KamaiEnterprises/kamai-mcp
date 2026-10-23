// bun scripts/check-vocabulary.ts <api-base-url> <api-key> [--write]
//
// Compares GET /v1/vocabulary with src/query/vocabulary.snapshot.json, the built-in answer a
// fresh instance starts with (and keeps while the API cannot be read). --write records the live
// answer as the new snapshot.
import { writeFileSync } from "node:fs";

import type { Vocabulary } from "../src/query/contract.ts";
import snapshot from "../src/query/vocabulary.snapshot.json" with { type: "json" };
import { listsOf } from "../src/query/vocabulary.ts";

const [baseArg, key, flag] = process.argv.slice(2);
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

const response = await fetch(`${base}/v1/vocabulary`, {
  headers: { authorization: `Bearer ${key}`, accept: "application/json" },
});
if (!response.ok) {
  console.error(`${base}/v1/vocabulary answered ${response.status}`);
  process.exit(2);
}
const live = await response.json();
if (flag === "--write") {
  // The snapshot is what every fresh instance starts from: never record one that lacks a list.
  if (!listsOf(live as Vocabulary)) {
    console.error("live answer is missing or has an empty list; snapshot not written");
    process.exit(1);
  }
  writeFileSync(new URL("../src/query/vocabulary.snapshot.json", import.meta.url), `${JSON.stringify(live, null, 2)}\n`);
  console.log("snapshot written");
  process.exit(0);
}
problems.push(...diff(snapshot, live));

if (problems.length) {
  console.error(`vocabulary drift (${problems.length}):`);
  for (const line of problems) console.error(`  ${line}`);
  process.exit(1);
}
console.log("vocabulary matches the snapshot");
