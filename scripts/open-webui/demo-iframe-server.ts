#!/usr/bin/env bun
/**
 * Local demo that mimics Open WebUI's MCP App Bridge:
 * - Serves the open_kamai widget HTML
 * - Injects CSP (incl. frameDomains) + __MCP_TOOL_RESULT__ like the bridge tool
 * - Embeds it in a sandboxed iframe the way Open WebUI Rich UI does
 *
 * Open http://127.0.0.1:3099/
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, "../..");
const WIDGET = join(ROOT, "dist/widgets/iframetest.html");
const PORT = Number(process.env.DEMO_PORT ?? 3099);
const KAMAI_URL = process.env.KAMAI_APP_URL ?? "https://app.kamai.io";
// Open WebUI's default: "iframe Sandbox Allow Same Origin" is off per user. With it off the
// frame's origin is null and app.kamai.io's crossorigin module scripts are blocked by CORS.
// DEMO_ALLOW_SAME_ORIGIN=1 reproduces a user who switched the setting on.
const SANDBOX = process.env.DEMO_ALLOW_SAME_ORIGIN === "1"
  ? "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  : "allow-scripts allow-popups allow-downloads";

if (!existsSync(WIDGET)) {
  console.error("dist/widgets/iframetest.html missing — run: bun run build:widgets");
  process.exit(1);
}

const payload = {
  url: KAMAI_URL,
  open_in: "fullscreen",
  expand_button: true,
  chrome: false,
  declared_frame_domains: [new URL(KAMAI_URL).origin],
};

const resultText = JSON.stringify(payload);

function bridgeInject(html: string): string {
  // Mirrors Classic298/open-webui-plugins mcp-app-bridge CSP + data inject.
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; ` +
    `script-src 'self' 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data: https://storage.googleapis.com; ` +
    `font-src 'self'; ` +
    `connect-src 'none'; ` +
    `frame-src ${new URL(KAMAI_URL).origin}; ` +
    `object-src 'none'; ` +
    `base-uri 'self'` +
    `">\n`;

  const data =
    `<script>\n` +
    `window.__MCP_TOOL_RESULT__ = ${JSON.stringify(resultText)};\n` +
    `window.__MCP_TOOL_ARGS__ = {};\n` +
    `window.__MCP_TOOL_NAME__ = "open_kamai";\n` +
    `</script>\n`;

  const shim =
    `<script>\n` +
    `(function(){\n` +
    `  var _result = ${JSON.stringify(resultText)};\n` +
    `  var _notification = {\n` +
    `    jsonrpc: '2.0',\n` +
    `    method: 'ui/notifications/tool-result',\n` +
    `    params: { content: [{ type: 'text', text: _result }] }\n` +
    `  };\n` +
    `  try {\n` +
    `    var _parsed = JSON.parse(_result);\n` +
    `    if (_parsed && typeof _parsed === 'object')\n` +
    `      _notification.params.structuredContent = _parsed;\n` +
    `  } catch (e) {}\n` +
    `  function _dispatch() {\n` +
    `    window.dispatchEvent(new MessageEvent('message', {\n` +
    `      data: _notification,\n` +
    `      origin: window.location.origin,\n` +
    `      source: window.parent\n` +
    `    }));\n` +
    `  }\n` +
    `  if (document.readyState === 'complete' || document.readyState === 'interactive')\n` +
    `    setTimeout(_dispatch, 50);\n` +
    `  else\n` +
    `    window.addEventListener('DOMContentLoaded', function(){ setTimeout(_dispatch, 50); });\n` +
    `})();\n` +
    `</script>\n`;

  const height =
    `<script>\n` +
    `function reportHeight(){\n` +
    `  var h=Math.max(document.documentElement.scrollHeight, 560);\n` +
    `  window.parent.postMessage({type:'iframe:height',height:h},'*');\n` +
    `}\n` +
    `window.addEventListener('load', function(){ reportHeight(); setTimeout(reportHeight, 200); });\n` +
    `new MutationObserver(reportHeight).observe(document.documentElement,{childList:true,subtree:true});\n` +
    `</script>\n`;

  const injection = csp + data + shim + height;
  if (html.includes("<head>")) return html.replace("<head>", "<head>\n" + injection);
  return injection + html;
}

const shell = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Open WebUI–style Kamai iframe demo</title>
  <script src="/mcp-apps-display-host.js"></script>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f4f4f5; color: #18181b; }
    header { padding: 16px 20px; background: #fff; border-bottom: 1px solid #e4e4e7; }
    header h1 { margin: 0; font-size: 16px; font-weight: 600; }
    header p { margin: 4px 0 0; font-size: 13px; color: #71717a; }
    main { padding: 16px; }
    .chat-card {
      max-width: 960px; margin: 0 auto; background: #fff; border: 1px solid #e4e4e7;
      border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgb(0 0 0 / 4%);
    }
    .chat-card .label {
      padding: 10px 14px; font-size: 12px; color: #71717a; border-bottom: 1px solid #f4f4f5;
      background: #fafafa;
    }
    iframe {
      display: block; width: 100%; height: 560px; border: 0; background: #fff;
    }
  </style>
</head>
<body>
  <header>
    <h1>Open WebUI MCP App Bridge simulation</h1>
    <p>Same inject path as the bridge tool: CSP frameDomains + <code>__MCP_TOOL_RESULT__</code> → nested Kamai iframe.</p>
  </header>
  <main>
    <div class="chat-card">
      <div class="label">Rich UI embed · open_kamai → ${KAMAI_URL}</div>
      <iframe
        id="widget"
        src="/widget"
        sandbox="${SANDBOX}"
        allow="clipboard-write; fullscreen"
        title="Kamai MCP App"
      ></iframe>
    </div>
  </main>
  <script>
    window.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'iframe:height') return;
      const frame = document.getElementById('widget');
      if (frame && typeof e.data.height === 'number') frame.style.height = e.data.height + 'px';
    });
  </script>
</body>
</html>`;

createServer((req, res) => {
  const url = req.url?.split("?")[0] ?? "/";
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(shell);
    return;
  }
  if (url === "/mcp-apps-display-host.js") {
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(join(DIR, "mcp-apps-display-host.js")));
    return;
  }
  if (url === "/widget") {
    const html = bridgeInject(readFileSync(WIDGET, "utf8"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  res.writeHead(404).end("not found");
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Open WebUI iframe demo: http://127.0.0.1:${PORT}/`);
  console.log(`  framing ${KAMAI_URL}`);
});
