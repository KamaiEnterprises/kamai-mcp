import type { Principal } from "../auth.ts";

/** What a tool module needs from buildServer: who is calling, which tool set is on, and
 * the one way a failed call is reported. */
export interface ToolContext {
  principal: Principal;
  queryTools: boolean;
  printedTables: boolean;
  rotation: boolean;
  fail: (err: unknown, tool: string) => never;
}
