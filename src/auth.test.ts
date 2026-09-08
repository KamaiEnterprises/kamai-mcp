import { describe, expect, it } from "vitest";

import { requireBearer } from "./auth.ts";
import { MCP_PATH, PUBLIC_URL } from "./config.ts";

// The transport answers on two paths, so this server exposes two resources and serves a metadata
// document for each. RFC 9728 §3.3 requires the document's `resource` to be identical to the URL
// the client used, so a challenge raised at /mcp must not point at the bare-root document.
const challengeFor = async (path: string): Promise<string> => {
  let header = "";
  const res = {
    status() { return this; },
    set(_name: string, value: string) { header = value; return this; },
    json() { return this; },
  } as unknown as Parameters<typeof requireBearer>[1];
  await requireBearer({ path, headers: {} } as Parameters<typeof requireBearer>[0], res, () => {});
  return /resource_metadata="([^"]+)"/.exec(header)?.[1] ?? "";
};

describe("the resource_metadata pointer follows the route", () => {
  it("points a refusal at /mcp to the /mcp document", async () => {
    expect(await challengeFor(MCP_PATH)).toBe(
      `${PUBLIC_URL}/.well-known/oauth-protected-resource${MCP_PATH}`,
    );
  });

  it("points a refusal at the bare root to the un-suffixed document", async () => {
    expect(await challengeFor("/")).toBe(`${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  });

  it("never reflects a caller-supplied path into the header", async () => {
    // Keyed off the MCP_PATH constant, not req.path, so an unrouted path cannot inject anything.
    expect(await challengeFor("/../../evil\"")).toBe(
      `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
    );
  });
});
