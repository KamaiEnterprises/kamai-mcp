import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WIDGET_NAMES } from "./index.ts";
import { connect } from "../testing/harness.ts";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "../../dist/widgets");

// The server serves built HTML, not the React source: a widget missing from the build
// list is a URI that answers with a file-not-found. Run after `bun run build:widgets`.
describe("widget build", () => {
  it("has built every widget, the table included", () => {
    for (const name of WIDGET_NAMES) {
      const path = join(DIST, `${name}.html`);
      expect(existsSync(path), `${name}.html`).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`<title>Kamai ${name}</title>`);
    }
  });
});

describe("widget resources", () => {
  it("lists the table widget only with the query tools", async () => {
    const off = (await (await connect({ queryTools: false })).listResources()).resources.map((r) => r.uri);
    const on = (await (await connect({ queryTools: true })).listResources()).resources.map((r) => r.uri);
    expect(off.some((uri) => uri.includes("/table@"))).toBe(false);
    expect(on.some((uri) => uri.includes("/table@"))).toBe(true);
  });
});
