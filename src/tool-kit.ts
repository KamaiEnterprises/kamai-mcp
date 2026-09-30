// Shared by every module that registers tools.

// Every tool states all four hints. A host that finds one missing assumes the worst
// (destructive, open-world) and asks the user before every call.
export const READONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
// A write that repeats to the same end state: renames, recolours, stored heights.
export const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
// A write that creates something new each time it runs.
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const DESTRUCTIVE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

// Superseded by a view_* tool. Still callable by id, just not advertised — every
// advertised tool costs the user another approval prompt. The snake-dialect twin
// keeps them callable from widgets on ChatGPT surfaces that gate on it.
export const APP_ONLY = { ui: { visibility: ["app"] }, "openai/widgetAccessible": true };

// Both halves are load-bearing. FastMCP derived an output schema from the Python
// tools' `-> dict` annotation and so emitted content AND structuredContent; the
// widgets read the latter, so dropping it silently hands them undefined.
export const text = (value: unknown) => {
  const content = [{ type: "text" as const, text: JSON.stringify(value) }];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { content, structuredContent: value as Record<string, unknown> }
    : { content };
};

