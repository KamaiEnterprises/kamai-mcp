import { ApiError, MESSAGES, type RouteName } from "./api.ts";
import { BadArgument } from "./elements.ts";

// Routes whose `invalid_request` detail is a fix message the API layer wrote for the
// caller: the query grammar's refusals ("unknown field 'x'. Known fields: …") and the
// validation handler's compact field list, which never echoes an input value. Everywhere
// else the detail stays unread, because it can carry internal wording.
const DETAIL_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  "querySelect",
  "queryAggregate",
  "queryWallSurface",
  "queryTable",
  "queryResolve",
  "getInventory",
  "setScale",
  "geometrySelect",
  "setOpeningPieceAttributes",
]);

export const NEEDS_SCALE_WITH_SET_SCALE =
  "This blueprint has no usable scale, so nothing on it can be measured. Ask the user for the scale printed on the sheet, then set it with set_scale.";

const FINALIZE_NOT_READY =
  "The file has not reached Kamai yet: PUT it to the signed URL first, then finalize.";

const internalError = (tool: string) =>
  `Kamai hit an internal error on ${tool}. Try once more; if it fails again, tell the user Kamai could not complete it.`;

export interface ErrorContext {
  queryTools: boolean;
}

/** The sentence a failed tool call puts in front of the model. Never an upstream string,
 * except the fix messages of DETAIL_ROUTES; never a status number. */
export function toolErrorText(err: unknown, tool: string, ctx: ErrorContext): string {
  if (err instanceof BadArgument) return err.message;
  if (!(err instanceof ApiError)) return internalError(tool);
  if (err.code === "invalid_request" && err.detail && err.route && DETAIL_ROUTES.has(err.route)) {
    return err.detail;
  }
  if (err.code === "needs_scale") return ctx.queryTools ? NEEDS_SCALE_WITH_SET_SCALE : err.message;
  if (err.code === "not_ready" && tool === "finalize_blueprint_upload") return FINALIZE_NOT_READY;
  if (err.code === "internal" || !(err.code in MESSAGES)) return internalError(tool);
  return err.message;
}
