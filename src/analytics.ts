import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { instrument } from "@posthog/mcp";
import { PostHog } from "posthog-node";

import type { Principal } from "./auth.ts";
import { POSTHOG_HOST, POSTHOG_PROJECT_TOKEN, PUBLIC_URL } from "./config.ts";

export function createAnalyticsClient(token = POSTHOG_PROJECT_TOKEN, host = POSTHOG_HOST): PostHog | null {
  return token ? new PostHog(token, { host }) : null;
}

const client = createAnalyticsClient();

// Cloud Run sends SIGTERM and allows 10 s before SIGKILL.
if (client && process.env.VITEST !== "true") {
  process.once("SIGTERM", () => {
    void client.shutdown(8000).finally(() => process.exit(0));
  });
}

// Tool schemas stay exactly as the hosts already accept them: no injected context,
// llm_model or conversation_id argument. Tool results carry customer data (project
// names, element lists) and never leave; arguments do. The server is built per request,
// so every request is a new session to the SDK and would announce the same person with
// its own $identify; the app already identifies that person by the same uid.
export function instrumentServer(server: McpServer, principal: Principal, posthog: PostHog | null = client): void {
  if (!posthog) return;
  instrument(server, posthog, {
    context: false,
    captureModel: false,
    enableConversationId: false,
    identify: { distinctId: principal.uid },
    serverBuild: process.env.K_REVISION || undefined,
    eventProperties: () => ({ mcp_public_url: PUBLIC_URL }),
    beforeSend: (event) => {
      if (event.event === "$identify") return null;
      delete event.properties.$mcp_response;
      dropClientMeta(event.properties.$mcp_parameters);
      // The probe's report is a device fingerprint, already logged in bounded form as
      // widget_probe; its raw argument stays out of PostHog.
      if (event.properties.$mcp_tool_name === "report_host_probe") delete event.properties.$mcp_parameters;
      return event;
    },
  });
}

// A request's _meta belongs to the client, not to the call.
export function dropClientMeta(parameters: unknown): void {
  const params = (parameters as { request?: { params?: unknown } } | null | undefined)?.request?.params;
  if (params !== null && typeof params === "object") delete (params as Record<string, unknown>)._meta;
}

const FLUSH_CAP_MS = 2000;

type Sender = { send: (message: never, options?: never) => Promise<void> };

// Cloud Run allocates CPU only while a request is open, and a client may close the
// connection the moment it has read its answer (the Python MCP SDK does, behind Open
// WebUI), so the event is sent before the answer is written, not before the stream ends.
// setImmediate lets the SDK's capture, enqueued a few promise hops after the tool
// returns, reach the queue first. Capped: PostHog being slow or down must not hold a
// tool call for longer than this.
export function flushBeforeResponse(transport: Sender, posthog: PostHog | null = client): void {
  if (!posthog) return;
  const send = transport.send.bind(transport) as (message: unknown, options?: unknown) => Promise<void>;
  (transport as unknown as { send: (message: unknown, options?: unknown) => Promise<void> }).send = async (message, options) => {
    const m = message as { id?: unknown; result?: unknown; error?: unknown };
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const flushed = new Promise<void>((resolve) => setImmediate(resolve)).then(() => posthog.flush()).catch(() => {});
      const capped = new Promise<void>((resolve) => setTimeout(resolve, FLUSH_CAP_MS).unref());
      await Promise.race([flushed, capped]);
    }
    return send(message, options);
  };
}
