# kamai-mcp

Kamai's MCP server: tools and MCP Apps widgets for
[Kamai](https://www.kamai.io) construction-blueprint projects, blueprints and
takeoffs. It runs against Kamai's MCP API and validates access tokens issued by
Kamai's OAuth authorization server. It holds no Kamai secrets.

## Tools

| Tool | What it does |
|---|---|
| `view_projects` | Interactive panel of the user's projects and blueprints |
| `list_blueprints` | Blueprints grouped by project, with their ids and whether they are ready |
| `view_blueprint` | A blueprint page with its take-off shapes drawn on top |
| `view_takeoff` | Measured take-off quantities as a sortable table |
| `list_elements` | Per-element rows (rooms, walls, doors, windows, objects) with outlines |
| `list_folders` | A blueprint's legend folders |
| `update_elements`, `move_elements`, `create_folder` | Rename, recolour and refile elements; create a folder |
| `set_opening_height` | Store a user-stated height, or a door/window tag, on wall-surface opening pieces |
| `create_project`, `update_project` | Create or rename a project |
| `list_jobs`, `get_job`, `cancel_job` | Processing jobs of a project |
| `view_upload` | Upload panel for a blueprint PDF |
| `ingest_blueprint_from_chat` | Import a PDF attached to a ChatGPT message (ChatGPT only) |
| `open_kamai` | Open the Kamai app in a panel |

With `KAMAI_QUERY_TOOLS=on` (see below):

| Tool | What it does |
|---|---|
| `count_elements` | Counts and totals by Kamai category (doors, windows, walls, wet rooms…), grouped, summed in the database |
| `find_elements` | Individual elements with type, folder, tag, handing and measurements |
| `calculate_wall_surface_area` | Net wall (paint or plaster) area of rooms |
| `render_table` | A table panel whose rows highlight their elements on the plan |
| `set_scale` | Set a blueprint's drawing scale |

`list_blueprints` also takes `include_inventory` (with a `project_id`): what each
blueprint contains.

`list_projects`, `get_project`, `get_blueprint`, `request_blueprint_upload`,
`finalize_blueprint_upload`, and with the query tools `get_table_row_elements` and
`get_element_outlines`, are app-only: callable by the widgets, not advertised to the
model.

## Run locally with your API key

The quickest way to run this server against your own Kamai data is local mode:
the host spawns the server, talks to it over stdio, and the credential is a
personal API key from Kamai (API Keys in the Kamai app) instead of OAuth.

    bun install
    bun run build:widgets
    KAMAI_API_KEY=... MCP_API_BASE_URL=https://mcp-api.kamai.io bun run local

Claude Code:

    claude mcp add --env KAMAI_API_KEY=... --env MCP_API_BASE_URL=https://mcp-api.kamai.io \
      --transport stdio kamai -- bun /path/to/kamai-mcp/src/local.ts

Claude Desktop (`claude_desktop_config.json`):

    { "mcpServers": { "kamai": {
        "command": "bun", "args": ["/path/to/kamai-mcp/src/local.ts"],
        "env": { "KAMAI_API_KEY": "...", "MCP_API_BASE_URL": "https://mcp-api.kamai.io" } } } }

The key is used as the bearer for every API call; the tools run as the key's owner.
Add `KAMAI_QUERY_TOOLS=on` to the environment for the query tools.

## Run the HTTP server

    bun install
    cp .env.example .env
    bun run dev

The values in `.env.example` are placeholders: set `MCP_PUBLIC_URL` and
`MCP_AUTH_ISSUER` to your tunnel and to a reachable authorization server before
starting, or every request will be refused with `invalid_token`.

| Variable | Meaning |
|---|---|
| `PORT` | Listen port, default 8006 |
| `MCP_PUBLIC_URL` | The URL hosts call and ask a token for (the `resource` in discovery); a tunnel, not `localhost` |
| `MCP_AUTH_ISSUER` | Issuer of the access tokens, matched byte for byte against the token's `iss` |
| `MCP_AUTH_JWKS_URI` | Optional. Defaults to `{MCP_AUTH_ISSUER}/jwks.json` |
| `MCP_API_BASE_URL` | Kamai MCP API base URL, `https://mcp-api.kamai.io`. Also the audience an access token must carry |
| `MCP_ACCEPTED_AUDIENCES` | Optional comma-separated audiences, for a cutover. Defaults to `MCP_API_BASE_URL` |
| `KAMAI_API_KEY` | Local mode only: the personal API key the tools run as |
| `KAMAI_APP_ORIGINS` | Optional comma-separated extra origins `open_kamai` may frame; the first becomes the default |
| `KAMAI_QUERY_TOOLS` | `on` registers the query tools. `https://mcp-api.kamai.io` serves them; leave it off against an API that answers `/v1/vocabulary` with 404 |
| `KAMAI_MCP_NO_INSTRUCTIONS` | `1` leaves the server instructions out, as claude.ai does, to test the tool descriptions on their own |

The MCP API and the authorization server are operated by Kamai, so running the
HTTP server end to end needs access to both. An MCP server is only really testable
against a real host, and a host can only reach a public HTTPS URL, so HTTP-mode
development means running behind a tunnel and pointing `MCP_PUBLIC_URL` at it.

`bun run dev` builds the widgets first: the server serves the built HTML from
`dist/widgets/`, not the React source, so rebuild after touching anything under
`src/widgets/app/`.

The widgets use React, TypeScript, Vite, Tailwind CSS, DaisyUI and Lucide. Vite
produces one self-contained HTML resource per widget, so nothing needs hosting.

Local builds require Bun 1.3.3 and Node.js 22.12 or newer.

## Layout

    src/index.ts       HTTP server, OAuth protected-resource metadata, MCP transport
    src/local.ts       stdio entrypoint for local mode (personal API key)
    src/auth.ts        Bearer-token verification (RFC 9728 challenges)
    src/server.ts      Tool and resource registration
    src/api.ts         Client for the Kamai MCP API
    src/elements.ts    list_elements paging, filtering and result budgeting
    src/errors.ts      The text a failed tool call shows the model
    src/query/         Query tools: descriptions, vocabulary, filters, budgets, contract
    src/widgets/       Widget resources, CSP metadata and the React widget sources
    scripts/           Widget build (escapes & so Open WebUI can embed the
                       widgets); check-routes and check-vocabulary against a live API
    scripts/open-webui/
                       Open WebUI helpers: an open_kamai Tool, a display-mode
                       host script, a local bridge demo

## Privacy and support

- Privacy policy: https://kamai.io/privacy-policy
- Support: https://kamai.io/support or contact@kamai.io

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go to the address in
[SECURITY.md](SECURITY.md), not to the issue tracker.

## License

[Apache-2.0](LICENSE). Copyright 2026 Kamai Enterprises LTD.

The Kamai name and logo are trademarks of Kamai Enterprises LTD and are not
covered by the license.
