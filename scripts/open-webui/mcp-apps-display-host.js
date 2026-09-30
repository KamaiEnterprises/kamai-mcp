/**
 * MCP Apps display host for Open WebUI — Custom JS, all MCP App embeds.
 * Honours ui/request-display-mode: inline | pip | fullscreen. No chrome.
 */
(function () {
  if (window.__MCP_APPS_DISPLAY_HOST__) return;
  window.__MCP_APPS_DISPLAY_HOST__ = true;

  var mode = "inline";
  var iframe, home, next, ph;

  function ensure() {
    if (document.getElementById("mcp-apps-host")) return;
    var s = document.createElement("style");
    s.textContent =
      "#mcp-apps-host{position:fixed;inset:0;pointer-events:none;z-index:50}" +
      "#mcp-apps-host .dock{pointer-events:auto;display:none;background:#fff}" +
      "#mcp-apps-host[data-mode=pip] .dock{display:block;position:absolute;top:0;right:0;bottom:0;width:min(52vw,720px);border-left:1px solid #e4e4e7}" +
      "#mcp-apps-host[data-mode=fullscreen] .dock{display:block;position:absolute;inset:0}" +
      "#mcp-apps-host .dock iframe{position:absolute;inset:0;width:100%;height:100%;border:0}";
    document.documentElement.appendChild(s);
    var r = document.createElement("div");
    r.id = "mcp-apps-host";
    r.dataset.mode = "inline";
    r.innerHTML = '<div class="dock"></div>';
    document.documentElement.appendChild(r);
  }

  function find(src) {
    var list = document.querySelectorAll("iframe");
    for (var i = 0; i < list.length; i++) {
      try {
        if (list[i].contentWindow === src) return list[i];
      } catch (_) {}
    }
    return null;
  }

  function tell(el, m) {
    if (!el || !el.contentWindow) return;
    try {
      el.contentWindow.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { displayMode: m, availableDisplayModes: ["inline", "pip", "fullscreen"] },
        },
        "*"
      );
    } catch (_) {}
  }

  function setMode(m, el) {
    if (m !== "inline" && m !== "pip" && m !== "fullscreen") m = "pip";
    ensure();
    var root = document.getElementById("mcp-apps-host");
    var dock = root.querySelector(".dock");
    if (el) iframe = el;

    if (m === "inline") {
      if (iframe && ph && ph.parentNode) ph.parentNode.replaceChild(iframe, ph);
      else if (iframe && home) home.insertBefore(iframe, next);
      ph = home = next = null;
      root.dataset.mode = "inline";
      mode = "inline";
      tell(iframe, m);
      return m;
    }

    if (!iframe) return mode;
    if (iframe.parentNode !== dock) {
      home = iframe.parentNode;
      next = iframe.nextSibling;
      ph = document.createElement("div");
      if (home) home.insertBefore(ph, iframe);
      dock.appendChild(iframe);
    }
    root.dataset.mode = m;
    mode = m;
    tell(iframe, m);
    return m;
  }

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || d.jsonrpc !== "2.0") return;

    if (d.method === "ui/initialize") {
      try {
        ev.source.postMessage(
          {
            jsonrpc: "2.0",
            id: d.id,
            result: {
              protocolVersion: d.params && d.params.protocolVersion,
              hostContext: {
                displayMode: "inline",
                availableDisplayModes: ["inline", "pip", "fullscreen"],
              },
            },
          },
          "*"
        );
      } catch (_) {}
      return;
    }

    if (d.method !== "ui/request-display-mode") return;
    var granted = setMode((d.params && d.params.mode) || "pip", find(ev.source) || iframe);
    try {
      ev.source.postMessage({ jsonrpc: "2.0", id: d.id, result: { mode: granted } }, "*");
    } catch (_) {}
  });
})();
