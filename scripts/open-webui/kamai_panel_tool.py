"""
title: Kamai panel
author: Kamai
version: 1.0.0
description: Opens the Kamai app in a side panel next to the chat.
required_open_webui_version: 0.11.0
"""

import json
from typing import Optional

from pydantic import BaseModel, Field

# The panel is drawn in the chat page through Open WebUI's documented `execute` event
# (docs.openwebui.com, Plugin > Development > Events). It needs no iframe sandbox change.
PANEL_JS = r"""
const APP = __APP__, PATH = __PATH__;
const ID = "kamai-panel";
const dark = () => document.documentElement.classList.contains("dark");
let host = document.getElementById(ID);
if (!host) {
  host = document.createElement("div");
  host.id = ID;
  host.innerHTML = `
    <style>
      #kamai-panel{position:fixed;top:0;right:0;bottom:0;z-index:60;display:flex;flex-direction:column;
        width:var(--kamai-w,46vw);min-width:380px;max-width:92vw;background:var(--kp-bg);color:var(--kp-fg);
        border-left:1px solid var(--kp-line);box-shadow:-8px 0 24px rgb(0 0 0 / .08);transition:transform .2s ease}
      #kamai-panel.kp-full{width:100vw!important;max-width:100vw}
      #kamai-panel .kp-bar{display:flex;align-items:center;gap:6px;height:44px;padding:0 8px 0 14px;border-bottom:1px solid var(--kp-line);
        font:600 14px system-ui,sans-serif}
      #kamai-panel .kp-bar span{flex:1}
      #kamai-panel button,#kamai-panel a{all:unset;cursor:pointer;padding:6px 9px;border-radius:7px;font:500 13px system-ui,sans-serif;color:var(--kp-fg)}
      #kamai-panel button:hover,#kamai-panel a:hover{background:var(--kp-soft)}
      #kamai-panel button:focus-visible,#kamai-panel a:focus-visible{outline:2px solid #2f6fdf}
      #kamai-panel iframe{flex:1;width:100%;border:0;background:#fff}
      #kamai-panel .kp-grip{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize}
      html.kamai-open body{margin-right:var(--kamai-w,46vw)!important}
      html.kamai-open.kamai-full body{margin-right:0!important}
    </style>
    <div class="kp-grip" title="Drag to resize"></div>
    <div class="kp-bar"><span>Kamai</span>
      <a class="kp-tab" target="_blank" rel="noopener">Open in new tab</a>
      <button class="kp-full-btn" type="button">Full screen</button>
      <button class="kp-close" type="button" aria-label="Close Kamai">✕</button></div>
    <iframe title="Kamai" allow="clipboard-read; clipboard-write; fullscreen"></iframe>`;
  document.body.appendChild(host);
  const root = document.documentElement;
  const theme = () => {
    const d = dark();
    host.style.setProperty("--kp-bg", d ? "#171717" : "#ffffff");
    host.style.setProperty("--kp-fg", d ? "#e5e5e5" : "#171717");
    host.style.setProperty("--kp-line", d ? "#2e2e2e" : "#e5e5e5");
    host.style.setProperty("--kp-soft", d ? "#262626" : "#f2f2f2");
  };
  theme();
  new MutationObserver(theme).observe(root, { attributes: true, attributeFilter: ["class"] });
  const close = () => { host.remove(); root.classList.remove("kamai-open", "kamai-full"); };
  host.querySelector(".kp-close").onclick = close;
  host.querySelector(".kp-full-btn").onclick = (e) => {
    const full = host.classList.toggle("kp-full");
    root.classList.toggle("kamai-full", full);
    e.currentTarget.textContent = full ? "Side panel" : "Full screen";
  };
  addEventListener("keydown", (e) => { if (e.key === "Escape" && document.getElementById(ID)) close(); });
  host.querySelector(".kp-grip").onpointerdown = (e) => {
    e.preventDefault();
    const frame = host.querySelector("iframe");
    frame.style.pointerEvents = "none";
    const move = (ev) => root.style.setProperty("--kamai-w", Math.max(380, innerWidth - ev.clientX) + "px");
    const up = () => { frame.style.pointerEvents = ""; removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
}
const url = APP + PATH;
const frame = host.querySelector("iframe");
if (frame.getAttribute("src") !== url) frame.setAttribute("src", url);
host.querySelector(".kp-tab").href = url;
document.documentElement.classList.add("kamai-open");
return "open";
"""


class Tools:
    class Valves(BaseModel):
        kamai_url: str = Field(default="https://app.kamai.io", description="The Kamai app address")

    def __init__(self):
        self.valves = self.Valves()

    async def open_kamai(self, project_id: Optional[str] = None, __event_call__=None) -> str:
        """
        Open the Kamai app in a side panel next to the chat, so the user can see and work on their
        projects, blueprints and takeoffs. Use it when the user asks to open Kamai or to see a project
        in Kamai. Pass project_id (from a Kamai tool result) to open that project directly.
        :param project_id: Optional Kamai project id to open.
        """
        app = self.valves.kamai_url.rstrip("/")
        path = f"/projects/{project_id}" if project_id else "/projects"
        if __event_call__ is None:
            return f"Kamai can't open a panel here. The user can open it at {app}{path}"
        code = PANEL_JS.replace("__APP__", json.dumps(app)).replace("__PATH__", json.dumps(path))
        result = await __event_call__({"type": "execute", "data": {"code": code}})
        if isinstance(result, dict) and result.get("error"):
            return f"Kamai could not open in this browser tab. The user can open it at {app}{path}"
        return (
            "Kamai is open in the side panel next to the chat. If the panel asks to connect or sign in, "
            "the user does that once in the panel."
        )
