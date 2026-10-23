#!/usr/bin/env python3
"""Add Kamai to an Open WebUI you administer.

Uses only Open WebUI's own admin API, the same settings an admin can change by hand:
  1. connects the Kamai MCP server as an External Tool Server with OAuth 2.1, so every
     person signs in with their own Kamai account;
  2. adds the "Kamai panel" tool, which opens the Kamai app beside the chat;
  3. attaches both to the models you choose.
Nothing in Open WebUI is patched, and no Kamai key is stored. Safe to run again.

    python3 install_kamai_owui.py --url https://chat.example.com --email admin@example.com --models gpt-5.4-mini
    python3 install_kamai_owui.py --url https://chat.example.com --api-key sk-... --models gpt-5.4-mini
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PANEL_TOOL_ID = "kamai_panel"
MCP_ID = "kamai"
DEFAULT_MCP_URL = "https://mcp.kamai.io/mcp"
# Open WebUI shows a server's whole tool list to the model, including tools the server marks app-only
# (answered by Kamai's own panels, or superseded by a view_* tool). The server's open_kamai is replaced by the panel tool.
HIDDEN = [
    "open_kamai", "open_kamai_session", "get_table_row_elements", "get_element_outlines", "report_host_probe", "probe_host",
    "list_projects", "get_project", "get_blueprint", "request_blueprint_upload", "finalize_blueprint_upload",
]


class OpenWebUI:
    def __init__(self, url: str, token: str = ""):
        self.url = url.rstrip("/")
        self.token = token

    def sign_in(self, email: str, password: str) -> None:
        self.token = self.call("POST", "/api/v1/auths/signin", {"email": email, "password": password})["token"]

    def call(self, method: str, path: str, body=None, allow_missing: bool = False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            if allow_missing and err.code in (401, 404):
                return None
            detail = err.read().decode(errors="replace")[:400]
            sys.exit(f"✗ {method} {path} → {err.code}: {detail}")
        except urllib.error.URLError as err:
            sys.exit(f"✗ Cannot reach {self.url}: {err.reason}")


def step(msg: str) -> None:
    print(f"• {msg}")


def connect_mcp(owui: OpenWebUI, mcp_url: str) -> None:
    current = owui.call("GET", "/api/v1/configs/tool_servers")["TOOL_SERVER_CONNECTIONS"]
    others = [c for c in current if (c.get("info") or {}).get("id") != MCP_ID]
    # People's Kamai sign-ins are bound to the registered client: registering a new one on
    # every run would sign everyone out, so keep it while the server address is the same.
    existing = next(
        (c for c in current if (c.get("info") or {}).get("id") == MCP_ID and c.get("url") == mcp_url
         and (c.get("info") or {}).get("oauth_client_info")),
        None,
    )
    client_info = existing["info"]["oauth_client_info"] if existing else None
    if not client_info:
        client_info = owui.call(
            "POST", "/api/v1/configs/oauth/clients/register?type=mcp",
            {"url": mcp_url, "client_id": MCP_ID, "oauth_scope": "mcp"},
        )["oauth_client_info"]
    connection = {
        "url": mcp_url,
        "path": "",
        "type": "mcp",
        "auth_type": "oauth_2.1",
        "key": "",
        "config": {"enable": True, "function_name_filter_list": ",".join(f"!{n}" for n in HIDDEN), "access_grants": []},
        "info": {
            "id": MCP_ID,
            "name": "Kamai",
            "description": "Kamai projects, blueprints and takeoffs",
            "oauth_scope": "mcp",
            "oauth_resource_parameter": "auto",
            "oauth_client_info": client_info,
        },
    }
    owui.call("POST", "/api/v1/configs/tool_servers", {"TOOL_SERVER_CONNECTIONS": [*others, connection]})
    step(f"Connected the Kamai MCP server ({mcp_url}) with OAuth 2.1 sign-in")


def install_panel(owui: OpenWebUI, kamai_url: str) -> None:
    form = {
        "id": PANEL_TOOL_ID,
        "name": "Kamai panel",
        "content": (HERE / "kamai_panel_tool.py").read_text(),
        "meta": {"description": "Opens the Kamai app beside the chat", "manifest": {"title": "Kamai panel"}},
    }
    exists = owui.call("GET", f"/api/v1/tools/id/{PANEL_TOOL_ID}", allow_missing=True)
    owui.call("POST", f"/api/v1/tools/id/{PANEL_TOOL_ID}/update" if exists else "/api/v1/tools/create", form)
    owui.call("POST", f"/api/v1/tools/id/{PANEL_TOOL_ID}/valves/update", {"kamai_url": kamai_url})
    step(f"{'Updated' if exists else 'Added'} the Kamai panel tool")


def attach(owui: OpenWebUI, models: list[str]) -> None:
    listed = {m["id"]: m for m in owui.call("GET", "/api/models")["data"]}
    missing = [m for m in models if m not in listed]
    if missing:
        sys.exit(f"✗ Unknown model(s): {', '.join(missing)}. Available: {', '.join(sorted(listed))}")
    for model_id in models:
        quoted = urllib.parse.quote(model_id, safe="")
        model = owui.call("GET", f"/api/v1/models/model?id={quoted}", allow_missing=True)
        meta = dict((model or {}).get("meta") or {})
        meta["toolIds"] = sorted(set(meta.get("toolIds") or []) | {PANEL_TOOL_ID, f"server:mcp:{MCP_ID}"})
        params = dict((model or {}).get("params") or {})
        params["function_calling"] = "native"
        form = {
            "id": model_id,
            "name": (model or listed[model_id]).get("name") or model_id,
            "base_model_id": (model or {}).get("base_model_id"),
            "meta": meta,
            "params": params,
        }
        owui.call("POST", "/api/v1/models/model/update" if model else "/api/v1/models/create", form)
        step(f"Attached Kamai to {model_id}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--url", required=True, help="Open WebUI address as people type it, e.g. https://chat.example.com")
    p.add_argument("--email", help="Admin email (you are asked for the password)")
    p.add_argument("--api-key", help="Admin API key, instead of email and password")
    p.add_argument("--models", required=True, help="Model id(s) to attach Kamai to, comma-separated")
    p.add_argument("--mcp-url", default=DEFAULT_MCP_URL, help=argparse.SUPPRESS)
    p.add_argument("--kamai-url", default="https://app.kamai.io", help=argparse.SUPPRESS)
    a = p.parse_args()
    if not a.email and not a.api_key:
        p.error("pass --email or --api-key")

    owui = OpenWebUI(a.url, a.api_key or "")
    if a.email:
        owui.sign_in(a.email, getpass.getpass(f"Open WebUI password for {a.email}: "))
    me = owui.call("GET", "/api/v1/auths/")
    if (me or {}).get("role") != "admin":
        sys.exit("✗ This account is not an Open WebUI admin.")

    connect_mcp(owui, a.mcp_url)
    install_panel(owui, a.kamai_url.rstrip("/"))
    attach(owui, [m.strip() for m in a.models.split(",") if m.strip()])
    print("\n✓ Kamai is ready. Open a new chat with that model and ask: «open Kamai».")
    print(f"  Each person signs in to Kamai once: {owui.url}/oauth/clients/mcp:{MCP_ID}/authorize")


if __name__ == "__main__":
    main()
