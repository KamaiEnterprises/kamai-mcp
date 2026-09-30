type JsonRecord = Record<string, unknown>;

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as JsonRecord;
  return Object.keys(record).length === 1 && "result" in record ? record.result : value;
}

/** Resolve a ui/notifications/tool-result (or tools/call) payload.
 *
 * Prefers structuredContent; falls back to JSON in content[0].text so hosts that
 * drop structuredContent (ext-apps#696) or only forward content text (Open WebUI's
 * MCP App Bridge) still hydrate the widget.
 */
export function parseToolResultParams(params: JsonRecord | undefined): unknown {
  if (!params) return undefined;
  if (params.structuredContent !== undefined && params.structuredContent !== null) {
    return unwrap(params.structuredContent);
  }
  const block = Array.isArray(params.content) ? params.content[0] : null;
  if (block && typeof block === "object" && typeof (block as JsonRecord).text === "string") {
    const text = (block as JsonRecord).text as string;
    if (!text) return undefined;
    try {
      return unwrap(JSON.parse(text));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Bootstrap values hosts inject as globals before (or instead of) tool-result RPC. */
export function parseInjectedToolResult(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (!value) return undefined;
    try {
      return unwrap(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (typeof value === "object") return unwrap(value);
  return undefined;
}
