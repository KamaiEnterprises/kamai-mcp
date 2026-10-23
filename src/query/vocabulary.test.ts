import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "../server.ts";
import type { Vocabulary } from "./contract.ts";
import snapshot from "./vocabulary.snapshot.json" with { type: "json" };
import { VOCABULARY_TTL_MS, holdVocabulary, refreshVocabulary, resetVocabulary, vocabulary, vocabularySource } from "./vocabulary.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const live = (over: Partial<Vocabulary> = {}) => ({ ...(snapshot as unknown as Vocabulary), ...over });

async function categoryEnum(): Promise<string[]> {
  holdVocabulary();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer({ uid: "t", token: "t" }, {}, { queryTools: true });
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const tool = (await client.listTools()).tools.find((t) => t.name === "count_elements")!;
  return (tool.inputSchema.properties as Record<string, { enum: string[] }>).category!.enum;
}

describe("vocabulary from the API", () => {
  beforeEach(() => resetVocabulary());
  afterEach(() => holdVocabulary());

  it("starts from the built-in answer, in the API's order", () => {
    expect(vocabularySource()).toBe("built-in");
    expect(vocabulary().categories).toEqual(Object.keys(snapshot.categories));
    expect(vocabulary().classes).toEqual(snapshot.classes);
    expect(vocabulary().sub_classes).toEqual(snapshot.sub_classes);
    expect(vocabulary().group_by).toEqual(snapshot.group_by);
    expect(vocabulary().order_by).toEqual(snapshot.order_by);
    expect(vocabulary().handing).toEqual(snapshot.handing);
  });

  it("builds tool enums from the API's answer once read", async () => {
    const categories = { ...snapshot.categories, stairs_and_lifts: snapshot.categories.doors };
    await refreshVocabulary(async () => live({ categories } as Partial<Vocabulary>), 0);
    expect(vocabularySource()).toBe("api");
    expect(await categoryEnum()).toEqual(Object.keys(categories));
  });

  it("keeps the last good lists when the API fails or answers an empty list", async () => {
    await refreshVocabulary(async () => { throw new Error("down"); }, 0);
    expect(vocabularySource()).toBe("built-in");
    await refreshVocabulary(async () => live({ classes: [] }), 120_000);
    expect(vocabularySource()).toBe("built-in");
    expect(await categoryEnum()).toEqual(Object.keys(snapshot.categories));
  });

  it("reads again only when due: a minute after a failure, the TTL after a success", async () => {
    let reads = 0;
    const read = async () => { reads += 1; return live(); };
    await refreshVocabulary(async () => { reads += 1; throw new Error("down"); }, 0);
    await refreshVocabulary(read, 30_000);
    expect(reads).toBe(1);
    await refreshVocabulary(read, 61_000);
    expect(reads).toBe(2);
    await refreshVocabulary(read, 61_000 + VOCABULARY_TTL_MS - 1);
    expect(reads).toBe(2);
    await refreshVocabulary(read, 61_000 + VOCABULARY_TTL_MS);
    expect(reads).toBe(3);
  });

  it("keeps doors and windows as the API defines them, with no 'door' value", () => {
    expect(vocabulary().sub_classes).not.toContain("door");
    expect([...snapshot.categories.doors.sub_classes_allowed].sort()).toEqual(["double swing door", "single swing door", "sliding door"]);
  });
});
