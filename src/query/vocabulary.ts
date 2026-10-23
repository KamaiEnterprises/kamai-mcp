// Kamai's query vocabulary comes from the API layer: GET /v1/vocabulary, generated there from
// Kamai's enums and grammar. This server builds its tool input enums from it and
// keeps no list of its own. vocabulary.snapshot.json is that answer as recorded at build time:
// the enums a fresh instance starts with, and keeps whenever the API cannot be read, so
// tools/list is never empty or broken. scripts/check-vocabulary.ts holds it to a live API.

import { logEvent } from "../log.ts";
import type { Vocabulary } from "./contract.ts";
import snapshot from "./vocabulary.snapshot.json" with { type: "json" };

export { HEIGHT_UNITS } from "./contract.ts";

type Words = [string, ...string[]];

export type VocabularyLists = {
  categories: Words;
  classes: Words;
  sub_classes: Words;
  handing: Words;
  group_by: Words;
  order_by: Words;
};

// The route needs a principal, so a refresh rides on a caller's request; the answer is the same
// for every caller. A failed read is retried a minute later, never on every request.
export const VOCABULARY_TTL_MS = 10 * 60_000;
const RETRY_MS = 60_000;

const words = (value: unknown): Words | null =>
  Array.isArray(value) && value.length > 0 && value.every((w) => typeof w === "string" && w.length > 0)
    ? (value as Words)
    : null;

/** The six lists a tool input is built from, or null when any is missing or empty. */
export function listsOf(v: Pick<Vocabulary, "categories" | "classes" | "sub_classes" | "handing" | "group_by" | "order_by">): VocabularyLists | null {
  const lists = {
    categories: words(v.categories && typeof v.categories === "object" ? Object.keys(v.categories) : null),
    classes: words(v.classes),
    sub_classes: words(v.sub_classes),
    handing: words(v.handing),
    group_by: words(v.group_by),
    order_by: words(v.order_by),
  };
  return Object.values(lists).every(Boolean) ? (lists as VocabularyLists) : null;
}

const BUILT_IN = listsOf(snapshot as unknown as Vocabulary)!;

let current: VocabularyLists = BUILT_IN;
let source: "built-in" | "api" = "built-in";
let nextReadAt = 0;
let inFlight: Promise<void> | null = null;

/** The vocabulary tool inputs are built from now: the API's last good answer, else the built-in one. */
export function vocabulary(): VocabularyLists {
  return current;
}

export function vocabularySource(): "built-in" | "api" {
  return source;
}

/** Read the vocabulary again when it is due. Never throws: a failed or malformed answer keeps
 * the last good lists. */
export function refreshVocabulary(read: () => Promise<Vocabulary>, now = Date.now()): Promise<void> {
  if (inFlight || now < nextReadAt) return inFlight ?? Promise.resolve();
  nextReadAt = now + RETRY_MS;
  inFlight = read()
    .then((answer) => {
      const lists = listsOf(answer);
      if (!lists) {
        logEvent("vocabulary_read", { ok: false, reason: "malformed", kept: source });
        return;
      }
      const changed = JSON.stringify(lists) !== JSON.stringify(current);
      current = lists;
      source = "api";
      nextReadAt = now + VOCABULARY_TTL_MS;
      logEvent("vocabulary_read", { ok: true, changed });
    })
    .catch((err: unknown) => {
      logEvent("vocabulary_read", { ok: false, reason: err instanceof Error ? err.name : "error", kept: source });
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Only for tests: no read until reset, so a test's own API stub sees only its own calls. */
export function holdVocabulary(): void {
  nextReadAt = Number.POSITIVE_INFINITY;
}

/** Only for tests. */
export function resetVocabulary(): void {
  current = BUILT_IN;
  source = "built-in";
  nextReadAt = 0;
  inFlight = null;
}
