# Kamai in Open WebUI

Adds Kamai to an Open WebUI you administer:

- **Kamai tools in the chat.** The model can list projects, count rooms and elements, and read takeoffs. Each person signs in with their own Kamai account.
- **The Kamai panel.** The Kamai app opens on the right side of the chat, so people see the drawings while they talk to the model.

It uses only Open WebUI's own extension points:

- the MCP connector (External Tool Server) with OAuth 2.1;
- one Tool, which draws the panel through the documented `execute` event.

Nothing in Open WebUI is patched, no Kamai key is stored, and no sandbox setting is changed.

## Requirements

- Open WebUI with the MCP connector and OAuth 2.1 sign-in, served over **https**. Tested on 0.11.4.
- An Open WebUI admin account, or an admin API key.
- Python 3.9+ on any machine that can reach your Open WebUI. Only the standard library is used.
- A model that can call tools several times in one answer. Native function calling is switched on for the models you choose. See [Which models work](#which-models-work).

## Install

```bash
python3 install_kamai_owui.py --url https://chat.example.com --email admin@example.com --models gpt-5.4-mini
```

- `--models` takes one or more model ids, comma-separated. The ids are shown in **Admin → Settings → Models**.
- Use `--api-key sk-…` instead of `--email` to sign in with an admin API key.
- The script is safe to run again, for example after an update or to add models. People stay signed in to Kamai.

It prints:

```
• Connected the Kamai MCP server (https://mcp.kamai.io/mcp) with OAuth 2.1 sign-in
• Added the Kamai panel tool
• Attached Kamai to gpt-5.4-mini

✓ Kamai is ready. Open a new chat with that model and ask: «open Kamai».
  Each person signs in to Kamai once: https://chat.example.com/oauth/clients/mcp:kamai/authorize
```

## Which models work

Kamai answers most questions in two or more tool steps (find the project, then count). The model and the route Open WebUI uses to reach it must both carry tool calls across those steps.

| Model and route | Status |
|---|---|
| Gemini 2.5 Pro / Flash via Vertex AI (OpenAI-compatible endpoint) | Tested, works |
| Gemini 3.x via Google's OpenAI-compatible endpoint (Vertex AI or AI Studio): tested 3.8 Flash, 3.1 Pro, 3 Flash | **Does not work with tools.** The second step fails with «missing a thought_signature». Open WebUI does not send Gemini 3's signature back ([open-webui#28492](https://github.com/open-webui/open-webui/issues/28492)). Turning thinking off (`thinking_budget: 0`) or down (`reasoning_effort: low`) does not help: the signature is still required. |
| Claude Sonnet 5.5 through an OpenAI-compatible Anthropic endpoint | Tested, works: several tool calls in a row, panel opens |
| OpenAI models through their own API | Expected to work (native tool calling), not tested by us |

Before you roll out, ask one question in a new chat, for example «How many rooms are in my project X?», and check that it finishes with a number.

## First use, for each person

1. **Sign in to Kamai for the tools.** The first time a Kamai tool runs, Open WebUI asks you to connect Kamai. You can also open the link the installer printed. Sign in with your Kamai account. Open WebUI keeps the session for you on its server.
2. **Open the panel.** Ask «open Kamai» or «open my project in Kamai». The first time, the panel shows **Connect this site to Kamai?**. Press **Connect this site**, check the address of your Open WebUI in the window that opens, then press **Allow and sign in**. You can revoke this any time in Kamai → Settings → Connected sites.

## What the panel does

- Opens on the right and narrows the chat. Drag its left edge to resize it.
- **Full screen** widens it over the chat. **Open in new tab** opens the same page in Kamai. **✕** or Esc closes it.
- Follows the light or dark theme of Open WebUI.
- When the model has a project id from a Kamai tool, it opens that project directly.

## What is changed in your Open WebUI

| Where | What |
|---|---|
| Admin → Settings → External Tools | A server named **Kamai**: type MCP, auth OAuth 2.1. Panel-only Kamai tools are hidden from the model. |
| Workspace → Tools | A tool named **Kamai panel**. Its valve `kamai_url` is the Kamai address. |
| Workspace → Models | The chosen models get both tools and native function calling. |

To remove Kamai, delete those three entries by hand.

## Troubleshooting

- **«Connect this site» is not shown and the panel says the address can't be read.** Your Open WebUI is served over plain http. Serve it over https.
- **The model gives a link instead of opening the panel.** Check that the model has **Kamai panel** under Tools, and that function calling is **Native**.
- **A Kamai tool says it needs sign-in.** Open the sign-in link from the installer output again.
- **A Kamai answer stops with «missing a thought_signature».** The model is Gemini 3 via an OpenAI-compatible endpoint. Use another model, see [Which models work](#which-models-work).
