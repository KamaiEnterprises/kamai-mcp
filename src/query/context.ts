import type { Principal } from "../auth.ts";

/** What a tool module needs from buildServer: who is calling, which tool set is on, and
 * the one way a failed call is reported. */
export interface ToolContext {
  principal: Principal;
  queryTools: boolean;
  fail: (err: unknown, tool: string) => never;
  /** Key of the per-caller list_elements scan cache, dropped after a write. */
  scanKey: (projectId: string, blueprintId: string) => string;
}
