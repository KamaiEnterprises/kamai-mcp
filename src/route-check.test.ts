import { describe, expect, it } from "vitest";

import { missingRoutes } from "./route-check.ts";

describe("missingRoutes", () => {
  const routes = {
    patch: { method: "PATCH" as const, template: "/v1/blueprints/{blueprint_id}/features/{feature_id}" },
    scale: { method: "PUT" as const, template: "/v1/projects/{project_id}/blueprints/{blueprint_id}/scale" },
  };

  it("passes routes the API serves, whatever it calls the placeholders", () => {
    const spec = {
      paths: {
        "/v1/blueprints/{bp}/features/{fid}": { patch: {} },
        "/v1/projects/{project_id}/blueprints/{blueprint_id}/scale": { put: {}, get: {} },
      },
    };
    expect(missingRoutes(spec, routes)).toEqual([]);
  });

  // The failure this exists for: a route the API does not serve, which every
  // fetch-mocked test still passes against.
  it("names a route the API does not serve, and a method it does not take", () => {
    const spec = {
      paths: {
        "/v1/blueprints/{blueprint_id}": { get: {} },
        "/v1/projects/{project_id}/blueprints/{blueprint_id}/scale": { get: {} },
      },
    };
    expect(missingRoutes(spec, routes).map((r) => r.name)).toEqual(["patch", "scale"]);
  });

  it("checks every route the client calls by default", () => {
    expect(missingRoutes({ paths: {} }).length).toBeGreaterThan(20);
  });
});
