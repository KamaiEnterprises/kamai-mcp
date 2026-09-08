import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, api, parseProjectPage } from "./api.ts";

// The API layer refuses an unentitled upload before it mints a signed URL. What reaches
// the model is ApiError.message — `fail()` in server.ts rethrows exactly that — so the
// message is the whole user-visible surface of the gate.
describe("entitlement refusals", () => {
  it("names the plan and the shortfall on a quota refusal", () => {
    const err = new ApiError("quota_exceeded", 403, {
      plan: "monthly_150",
      quota_type: "blueprints",
      limit: 150,
      current: 150,
      action_required: "upgrade",
    });
    expect(err.message).toBe(
      "This Kamai account is on the monthly_150 plan and has used 150 of its 150 blueprints. " +
        "Use the `open_kamai` tool to open Kamai, where the plan can be changed.",
    );
  });

  it("still produces a usable sentence when the extension members are absent", () => {
    expect(new ApiError("quota_exceeded", 403).message).toBe(
      "This Kamai account has used its whole plan allowance. " +
        "Use the `open_kamai` tool to open Kamai, where the plan can be changed.",
    );
  });

  it("sends an org-limit refusal to an administrator, not to checkout", () => {
    const err = new ApiError("org_quota_exceeded", 403, { limit: 40, current: 40 });
    expect(err.message).toContain("40 of the 40 pages its organization allows");
    expect(err.message).toContain("administrator of the organization");
    expect(err.message).not.toContain("open_kamai");
  });

  it("tells a pending account what to do about it", () => {
    const err = new ApiError("subscription_pending", 403, { plan: "pending" });
    expect(err.message).toContain("no active plan yet");
    expect(err.message).toContain("open_kamai");
  });

  it("does not put the placeholder state into the expired sentence", () => {
    // subscription_type is literally "expired" for these accounts — an access state, not
    // a plan slug, so it must not render as "the Kamai expired subscription".
    expect(new ApiError("subscription_expired", 403, { plan: "expired" }).message).toContain(
      "The Kamai subscription has expired",
    );
    expect(new ApiError("subscription_expired", 403, { plan: "monthly_800" }).message).toContain(
      "The Kamai monthly_800 subscription has expired",
    );
  });

  it("treats an unverifiable entitlement as retryable, not as a refusal to fix", () => {
    const err = new ApiError("entitlement_unavailable", 503);
    expect(err.message).toBe("Kamai could not verify the plan just now. Try again shortly.");
  });

  it("leaves the pre-existing codes untouched", () => {
    expect(new ApiError("not_ready", 409).message).toBe("That blueprint is still being processed.");
    expect(new ApiError("forbidden", 403).message).toBe("You do not have access to that.");
  });

  it("does not claim the session expired when it cannot know that", () => {
    // invalid_token fires for ANY downstream 401, including an audience misconfiguration where
    // reconnecting never helps.
    const message = new ApiError("invalid_token", 401).message;
    expect(message).toBe("Kamai rejected the access token. If this persists, reconnect the connector.");
    expect(message).not.toContain("expired");
  });

  it("falls back to the generic message for a code it has never seen", () => {
    expect(new ApiError("some_future_code", 400).message).toBe(
      "Something went wrong on the Kamai side.",
    );
  });
});

describe("legacy project responses", () => {
  it("keeps usable projects and blueprints when sibling records are corrupt", () => {
    const page = parseProjectPage({
      items: [
        {
          id: "project-1",
          name: null,
          blueprints: [
            { id: "blueprint-1", name: "Plan A", ready: true },
            { updated: "2026-08-16T19:08:18.097307+00:00" },
          ],
        },
        { name: "Missing id" },
      ],
      next_cursor: 17,
    });

    expect(page).toEqual({
      items: [
        {
          id: "project-1",
          name: "Untitled project",
          description: "",
          last_modified: undefined,
          blueprints: [{ id: "blueprint-1", name: "Plan A", ready: true }],
        },
      ],
      next_cursor: null,
    });
  });

  it("salvages legacy record maps by taking ids from their keys", () => {
    const page = parseProjectPage({
      items: {
        "project-1": {
          name: "Project",
          description: "Description",
          blueprints: { "blueprint-1": { name: "Plan" } },
        },
      },
    });

    expect(page.items[0]).toMatchObject({
      id: "project-1",
      name: "Project",
      blueprints: [{ id: "blueprint-1", name: "Plan", ready: false }],
    });
  });
});

// The job routes are plain pass-throughs; what matters is that each one hits the
// path the API layer registers, with the method it expects, and that the JSON
// comes back untouched.
describe("job routes", () => {
  const principal = { token: "t", uid: "u", email: "u@example.com" } as unknown as Parameters<typeof api.listJobs>[0];
  const calls: { url: string; method: string }[] = [];

  const stubFetch = (payload: unknown) => {
    calls.length = 0;
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  };

  afterEach(() => vi.unstubAllGlobals());

  it("lists, reads and cancels through /v1/projects/{id}/jobs", async () => {
    const job = {
      id: "j1", blueprint_id: "b1", status: "RUNNING", state: "PREPARING_TILES",
      filename: "plan.pdf", progress: 7, error_message: null, error_code: null,
    };

    stubFetch([job]);
    expect(await api.listJobs(principal, "p 1")).toEqual([job]);
    expect(calls[0]).toEqual({ url: expect.stringMatching(/\/v1\/projects\/p%201\/jobs$/), method: "GET" });

    stubFetch(job);
    expect(await api.getJob(principal, "p1", "j/1")).toEqual(job);
    expect(calls[0]).toEqual({ url: expect.stringMatching(/\/jobs\/j%2F1$/), method: "GET" });

    stubFetch({ ...job, status: "CANCELLED" });
    expect((await api.cancelJob(principal, "p1", "j1")).status).toBe("CANCELLED");
    expect(calls[0]).toEqual({ url: expect.stringMatching(/\/jobs\/j1\/cancel$/), method: "POST" });
  });

  it("turns the API layer's not_ready problem into the standing sentence", async () => {
    calls.length = 0;
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ code: "not_ready", detail: "Job is already SUCCEEDED" }), {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      }));
    await expect(api.cancelJob(principal, "p1", "j1")).rejects.toMatchObject({ code: "not_ready", status: 409 });
  });
});
