import { describe, expect, it } from "vitest";

import { connect } from "./testing/harness.ts";

// The ChatGPT app's MCP scanner reads tools/list as JSON Schema 2020-12, the MCP default dialect.
// Draft-07's tuple form `items: [a, b]` is invalid there, and one such schema made every scan stop
// right after tools/list from 2026-10-11 (get_sheet_text's bbox) until the tuples were removed.
const DRAFT07_ONLY = ["additionalItems"];

function offences(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => offences(child, `${path}[${i}]`, out));
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "items" && Array.isArray(value)) out.push(`${path}.items is a tuple`);
    if (DRAFT07_ONLY.includes(key)) out.push(`${path}.${key}`);
    offences(value, `${path}.${key}`, out);
  }
}

describe("tool schemas", () => {
  it("use no draft-07-only form, with every tool registered as ChatGPT sees them", async () => {
    const client = await connect(
      { queryTools: true, printedTables: true, markups: true, panelSignIn: true },
      { chatgpt: true },
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["get_sheet_text", "add_markup", "list_markups"]));
    const found: string[] = [];
    for (const tool of tools) {
      offences(tool.inputSchema, `${tool.name}.inputSchema`, found);
      offences(tool.outputSchema, `${tool.name}.outputSchema`, found);
    }
    expect(found).toEqual([]);
  });
});
