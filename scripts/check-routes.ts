// bun scripts/check-routes.ts <api-base-url>
//
// Asserts every route in API_ROUTES (method + path) is served by the API layer at
// <api-base-url>, read from its /openapi.json. Run it against a real API before shipping
// a tool that calls a new route: a fetch-mocked test cannot tell a route that exists from
// one that does not.
import { API_ROUTES } from "../src/api.ts";
import { missingRoutes } from "../src/route-check.ts";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: bun scripts/check-routes.ts <api-base-url>");
  process.exit(2);
}

const response = await fetch(`${base}/openapi.json`);
if (!response.ok) {
  console.error(`${base}/openapi.json answered ${response.status}; is the API docs route enabled there?`);
  process.exit(2);
}
const missing = missingRoutes((await response.json()) as { paths?: Record<string, Record<string, unknown>> });
const total = Object.keys(API_ROUTES).length;
if (missing.length) {
  console.error(`${missing.length} of ${total} routes are not served by ${base}:`);
  for (const route of missing) console.error(`  ${route.method} ${route.template}  (api.${route.name})`);
  process.exit(1);
}
console.log(`all ${total} routes are served by ${base}`);
