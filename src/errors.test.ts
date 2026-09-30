import { describe, expect, it } from "vitest";

import { ApiError } from "./api.ts";
import { BadArgument } from "./elements.ts";
import { toolErrorText } from "./errors.ts";

const on = { queryTools: true };
const off = { queryTools: false };

describe("toolErrorText", () => {
  it("names the tool in the generic internal error", () => {
    const expected =
      "Kamai hit an internal error on count_elements. Try once more; if it fails again, tell the user Kamai could not complete it.";
    expect(toolErrorText(new Error("boom at 10.0.0.1"), "count_elements", on)).toBe(expected);
    expect(toolErrorText(new ApiError("internal", 500), "count_elements", on)).toBe(expected);
    expect(toolErrorText(new ApiError("some_future_code", 400), "count_elements", on)).toBe(expected);
  });

  it("passes a caller mistake through as written", () => {
    expect(toolErrorText(new BadArgument("Pass project_id."), "count_elements", on)).toBe("Pass project_id.");
  });

  // The grammar's refusal names the legal values, which is exactly what the model needs
  // to fix the call in the same turn.
  it("surfaces an invalid_request detail from the query routes only", () => {
    const detail = "unknown field 'colour'. Known fields: class, color, …";
    const query = new ApiError("invalid_request", 400, {}, { detail, route: "queryAggregate" });
    expect(toolErrorText(query, "count_elements", on)).toBe(detail);
    const legacy = new ApiError("invalid_request", 400, {}, { detail: "internal wording", route: "createFolder" });
    expect(toolErrorText(legacy, "create_folder", on)).toBe("That request was not valid.");
  });

  it("says how to fix a missing scale, depending on whether set_scale exists", () => {
    const err = new ApiError("needs_scale", 400);
    expect(toolErrorText(err, "count_elements", on)).toMatch(/set it with set_scale/);
    expect(toolErrorText(err, "view_takeoff", off)).toMatch(/has to be set in Kamai first/);
    expect(toolErrorText(err, "view_takeoff", off)).not.toMatch(/set_scale/);
  });

  it("tells finalize what not_ready means there", () => {
    expect(toolErrorText(new ApiError("not_ready", 409), "finalize_blueprint_upload", on)).toBe(
      "The file has not reached Kamai yet: PUT it to the signed URL first, then finalize.",
    );
    expect(toolErrorText(new ApiError("not_ready", 409), "view_blueprint", on)).toBe(
      "That blueprint is still being processed.",
    );
  });

  it("tells the model a missing route is final for the conversation", () => {
    expect(toolErrorText(new ApiError("route_missing", 404), "set_scale", on)).toMatch(
      /not available on the server yet\. Do not call it again in this conversation/,
    );
  });

  it("asks a busy caller to wait, once", () => {
    expect(toolErrorText(new ApiError("busy", 429), "count_elements", on)).toBe(
      "Kamai is still running this account's other queries. Wait for them to finish, then ask once more.",
    );
  });
});
