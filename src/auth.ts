import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NextFunction, Request, Response } from "express";

import {
  ACCEPTED_AUDIENCES,
  AUTH_ISSUER,
  AUTH_JWKS_URI,
  CLOCK_SKEW_SECONDS,
  MCP_PATH,
  PUBLIC_URL,
  RESOURCE_URL,
} from "./config.ts";

export interface Principal {
  uid: string;
  email?: string;
  token: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: Principal;
    }
  }
}

const jwks = createRemoteJWKSet(new URL(AUTH_JWKS_URI));

export async function verifyAccessToken(token: string): Promise<Principal> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: AUTH_ISSUER,
    audience: ACCEPTED_AUDIENCES,
    algorithms: ["RS256"],
    clockTolerance: CLOCK_SKEW_SECONDS,
  });
  const uid = typeof payload.sub === "string" ? payload.sub : "";
  if (!uid) throw new Error("token has no subject");
  const email = typeof payload.email === "string" ? payload.email : undefined;
  return { uid, email, token };
}

function challenge(req: Request, res: Response, description: string): void {
  // The transport answers on two paths, so this server exposes two distinct resources and serves
  // a metadata document for each. Pointing every challenge at the un-suffixed one told a client
  // refused at /mcp to go read a document declaring `resource` as the bare root - not the
  // resource it asked for. RFC 9728 requires the advertised resource to be identical to the URL
  // the client used, so the pointer has to follow the route.
  //
  // Keyed off the MCP_PATH constant rather than raw req.path: nothing caller-controlled is ever
  // reflected into a response header.
  const suffix = req.path === MCP_PATH ? MCP_PATH : "";
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      `Bearer error="invalid_token", error_description="${description}", ` +
        `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource${suffix}"`,
    )
    .json({ error: "invalid_token", error_description: description });
}

export async function requireBearer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") {
    challenge(req, res, "missing bearer token");
    return;
  }
  try {
    req.principal = await verifyAccessToken(token);
    next();
  } catch (err) {
    challenge(req, res, err instanceof Error ? err.message : "token rejected");
  }
}

// RFC 9728. Served for both live resource forms because the transport answers
// at /mcp and at bare root, and a client discovers metadata per resource.
export function protectedResourceMetadata(resource: string) {
  return {
    resource,
    authorization_servers: [AUTH_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: [],
    resource_name: "Kamai MCP Server",
  };
}

export const RESOURCE_FORMS = [RESOURCE_URL, `${PUBLIC_URL}/`];
