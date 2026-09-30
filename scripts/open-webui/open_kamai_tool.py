"""
title: Open Kamai
author: kamai-mcp
version: 0.1.0
description: Opens the Kamai app as a Rich UI iframe embed in chat (same outcome as MCP open_kamai).
"""

from typing import Optional

from pydantic import BaseModel, Field
from starlette.responses import HTMLResponse


class Tools:
    class Valves(BaseModel):
        kamai_url: str = Field(
            default="https://app.kamai.io",
            description="Kamai origin to embed",
        )
        height: int = Field(default=560, description="Embed height in pixels")

    def __init__(self):
        self.valves = self.Valves()

    async def open_kamai(
        self,
        mode: Optional[str] = "pip",
        __event_emitter__=None,
    ) -> HTMLResponse:
        """
        Open the Kamai construction-blueprint app in an interactive panel.
        Default mode is pip (side-by-side when the host supports it).
        Call this whenever the user asks to open, show, or work in Kamai.
        """
        url = (self.valves.kamai_url or "https://app.kamai.io").rstrip("/")
        height = int(self.valves.height or 560)
        # Open WebUI Rich UI: Content-Disposition inline + HTML srcdoc embed.
        # Enable Settings → iframeSandboxAllowSameOrigin so nested Kamai can paint.
        html = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src {url} https://app.kamai.io; base-uri 'self'; object-src 'none'">
  <style>
    html, body {{ margin: 0; min-height: {height}px; background: #fff; }}
    iframe {{ border: 0; width: 100%; height: {height}px; display: block; }}
  </style>
</head>
<body>
  <iframe
    src="{url}"
    title="Kamai"
    allow="clipboard-write; fullscreen"
    referrerpolicy="strict-origin-when-cross-origin"
  ></iframe>
  <script>
    function report() {{
      var h = Math.max(document.documentElement.scrollHeight, {height});
      parent.postMessage({{ type: 'iframe:height', height: h }}, '*');
    }}
    window.addEventListener('load', report);
    setTimeout(report, 200);
    setTimeout(report, 1000);
  </script>
</body>
</html>"""
        return HTMLResponse(
            content=html,
            headers={"Content-Disposition": "inline"},
        )
