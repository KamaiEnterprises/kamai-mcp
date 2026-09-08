import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { build } from "vite";

const names = ["projects", "blueprint", "takeoff", "upload", "iframetest"];
const root = resolve("src/widgets/app");
const output = resolve("dist/widgets");
const temporary = resolve("dist/.widget-build");
const logo = await readFile(resolve(root, "assets/logoFullWhite.svg"));
const logoDataUrl = `data:image/svg+xml;base64,${logo.toString("base64")}`;

await mkdir(output, { recursive: true });

for (const name of names) {
  await build({
    configFile: false,
    root,
    base: "./",
    logLevel: "warn",
    define: { __KAMAI_LOGO__: JSON.stringify(logoDataUrl) },
    plugins: [
      {
        name: "kamai-widget-entry",
        transformIndexHtml: {
          order: "pre",
          handler: (html) => html.replace("/src.tsx", `/entries/${name}.tsx`),
        },
      },
      tailwindcss(),
    ],
    build: {
      outDir: temporary,
      emptyOutDir: true,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });

  const htmlPath = resolve(temporary, "index.html");
  let html = await readFile(htmlPath, "utf8");
  const script = html.match(/<script[^>]+src="([^"]+)"[^>]*><\/script>/);
  const stylesheet = html.match(/<link[^>]+href="([^"]+\.css)"[^>]*>/);

  if (!script || !stylesheet) throw new Error(`Could not inline ${name} widget assets`);

  const scriptPath = resolve(temporary, script[1].replace(/^\.\//, ""));
  const stylePath = resolve(temporary, stylesheet[1].replace(/^\.\//, ""));
  const javascript = (await readFile(scriptPath, "utf8")).replace(/<\/script/gi, "<\\/script");
  const css = (await readFile(stylePath, "utf8")).replace(/<\/style/gi, "<\\/style");

  html = html
    .replace(script[0], () => `<script type="module">${javascript}</script>`)
    .replace(stylesheet[0], () => `<style>${css}</style>`)
    .replace("<title>Kamai Widget</title>", `<title>Kamai ${name}</title>`);

  if (html.includes('src="./assets/') || html.includes('href="./assets/')) {
    throw new Error(`External assets remain in ${name} widget`);
  }

  await writeFile(resolve(output, `${name}.html`), html, "utf8");
}

await rm(temporary, { recursive: true, force: true });
