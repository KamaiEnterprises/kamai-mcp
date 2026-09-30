import { API_ROUTES, type HttpMethod } from "./api.ts";

// Used by scripts/check-routes.ts. A fetch-mocked tool test passes against a route that
// does not exist; this compares every route the client calls with what a real API
// layer's /openapi.json says it serves.

type OpenApi = { paths?: Record<string, Record<string, unknown>> };

/** Placeholder names are the API layer's business; only their positions must match. */
const shape = (template: string) => template.replace(/\{[^}]+\}/g, "{}");

export function missingRoutes(
  spec: OpenApi,
  routes: Record<string, { method: HttpMethod; template: string }> = API_ROUTES,
): Array<{ name: string; method: string; template: string }> {
  const served = new Set<string>();
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(operations)) served.add(`${method.toUpperCase()} ${shape(path)}`);
  }
  return Object.entries(routes)
    .filter(([, route]) => !served.has(`${route.method} ${shape(route.template)}`))
    .map(([name, route]) => ({ name, method: route.method, template: route.template }));
}
