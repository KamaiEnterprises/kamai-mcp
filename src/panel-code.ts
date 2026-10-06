import { AUTH_ISSUER } from "./config.ts";
import type { Principal } from "./auth.ts";

export interface PanelCode {
  panel_code: string;
  expires_in: number;
}

export async function mintPanelCode(principal: Principal, fetchImpl: typeof fetch = fetch): Promise<PanelCode> {
  const res = await fetchImpl(`${AUTH_ISSUER}/authorize/panel-code`, {
    method: "POST",
    headers: { authorization: `Bearer ${principal.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`panel sign-in is unavailable (${res.status})`);
  const body = (await res.json()) as Partial<PanelCode>;
  if (typeof body.panel_code !== "string" || !body.panel_code) throw new Error("panel sign-in returned no code");
  return { panel_code: body.panel_code, expires_in: Number(body.expires_in) || 60 };
}
