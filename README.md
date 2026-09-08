# kamai-mcp

Kamai's MCP server: tools and MCP Apps widgets for
[Kamai](https://www.kamai.io) construction-blueprint projects, blueprints and
takeoffs. It runs against Kamai's MCP API and validates access tokens issued by
Kamai's OAuth authorization server. It holds no Kamai secrets.

## Tools

| Tool | What it does |
|---|---|
| `view_projects` | Interactive panel of the user's projects and blueprints |
| `view_blueprint` | A blueprint page with its take-off shapes drawn on top |
| `view_takeoff` | Measured take-off quantities as a sortable table |
| `list_elements` | Per-element rows (rooms, walls, doors, windows, objects) with outlines |
| `create_project`, `update_project` | Create or rename a project |
| `list_jobs`, `get_job`, `cancel_job` | Processing jobs of a project |
| `view_upload` | Upload panel for a blueprint PDF |
| `ingest_blueprint_from_chat` | Import a PDF attached to a ChatGPT message |
| `open_kamai` | Open the Kamai app in a panel |

`list_projects`, `get_project`, `get_blueprint`, `request_blueprint_upload` and
`finalize_blueprint_upload` are app-only: callable by the widgets, not advertised to
the model.

## Run locally

    bun install
    cp .env.example .env
    bun run dev

The values in `.env.example` are placeholders: set `MCP_PUBLIC_URL` and
`MCP_AUTH_ISSUER` to your tunnel and to a reachable authorization server before
starting, or every request will be refused with `invalid_token`.

| Variable | Meaning |
|---|---|
| `PORT` | Listen port, default 8006 |
| `MCP_PUBLIC_URL` | The URL hosts call. The accepted token audience is derived from it, so it has to be the public URL, not `localhost` |
| `MCP_AUTH_ISSUER` | Issuer of the access tokens, matched byte for byte against the token's `iss` |
| `MCP_AUTH_JWKS_URI` | Optional. Defaults to `{MCP_AUTH_ISSUER}/jwks.json` |
| `MCP_API_BASE_URL` | Kamai MCP API base URL |
| `KAMAI_APP_ORIGINS` | Optional comma-separated extra origins `open_kamai` may frame; the first becomes the default |

The MCP API and the authorization server are operated by Kamai, so running this
server end to end needs access to both. An MCP server is only really testable
against a real host, and a host can only reach a public HTTPS URL, so local
development means running behind a tunnel and pointing `MCP_PUBLIC_URL` at it.

`bun run dev` builds the widgets first: the server serves the built HTML from
`dist/widgets/`, not the React source, so rebuild after touching anything under
`src/widgets/app/`.

The widgets use React, TypeScript, Vite, Tailwind CSS, DaisyUI and Lucide. Vite
produces one self-contained HTML resource per widget, so nothing needs hosting.

Local builds require Bun 1.3.3 and Node.js 22.12 or newer.

## Layout

    src/index.ts       HTTP server, OAuth protected-resource metadata, MCP transport
    src/auth.ts        Bearer-token verification (RFC 9728 challenges)
    src/server.ts      Tool and resource registration
    src/api.ts         Client for the Kamai MCP API
    src/elements.ts    list_elements paging, filtering and result budgeting
    src/widgets/       Widget resources, CSP metadata and the React widget sources

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go to the address in
[SECURITY.md](SECURITY.md), not to the issue tracker.

## License

[Apache-2.0](LICENSE). Copyright 2026 Kamai Enterprises LTD.

The Kamai name and logo are trademarks of Kamai Enterprises LTD and are not
covered by the license.
