import { describe, expect, it } from "vitest";

import { resolvePrincipal } from "./local.ts";

const fetchWith = (status: number, body: unknown) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer kmi_test_key") return new Response("nope", { status: 401 });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

describe("local mode principal", () => {
  it("turns an accepted API key into the principal the tools run as", async () => {
    const p = await resolvePrincipal("kmi_test_key", fetchWith(200, { uid: "u-1", email: "dev@example.test" }));
    expect(p).toEqual({ uid: "u-1", email: "dev@example.test", token: "kmi_test_key" });
  });

  it("refuses to start on a rejected key rather than serving tools that will all fail", async () => {
    await expect(resolvePrincipal("wrong", fetchWith(200, { uid: "u-1" }))).rejects.toThrow("401");
  });

  it("refuses a /v1/me answer without a uid", async () => {
    await expect(resolvePrincipal("kmi_test_key", fetchWith(200, { email: "x" }))).rejects.toThrow("no uid");
  });
});
