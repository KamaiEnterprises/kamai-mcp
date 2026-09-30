import { parseAst } from "vite";

// Open WebUI html-entity-decodes a tool's embed before it becomes the frame's srcdoc, script
// text included: minified `a&&gt()` reaches the browser as `a&>()` and the bundle is a
// SyntaxError. No `&` followed by a letter or `#` may survive. Between tokens `& ` is free;
// inside a string, template or regex `\x26` is the same value. A raw (tagged) template has
// no such escape, so it fails the build.
const ENTITY_LIKE = /&(?=[A-Za-z#])/g;

function literalsOf(ast) {
  const found = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "Literal" && (typeof node.value === "string" || node.regex))
      found.push({ start: node.start, end: node.end, regex: Boolean(node.regex), value: node.regex ? `/${node.regex.pattern}/${node.regex.flags}` : node.value });
    if (node.type === "TaggedTemplateExpression") {
      for (const q of node.quasi.quasis) found.push({ start: q.start, end: q.end, raw: true, value: q.value.raw });
      walk(node.tag);
      walk(node.quasi.expressions);
      return;
    }
    if (node.type === "TemplateElement") found.push({ start: node.start, end: node.end, value: node.value.cooked });
    for (const key in node) if (key !== "value" && key !== "regex") walk(node[key]);
  })(ast);
  return found;
}

export function entitySafe(name, js) {
  const before = literalsOf(parseAst(js));
  const out = js.replace(ENTITY_LIKE, (amp, i) => {
    const literal = before.find((l) => i >= l.start && i < l.end);
    if (!literal) return "& ";
    if (literal.raw) throw new Error(`${name} widget: entity-like text in a raw template at ${JSON.stringify(js.slice(i - 12, i + 12))}`);
    // `\&` in a regex or string is an identity escape for `&`; `\x26` after that backslash
    // would read as a literal backslash-x. Counting backslashes tells the two apart.
    let slashes = 0;
    while (js[i - 1 - slashes] === "\\") slashes++;
    return slashes % 2 ? "x26" : "\\x26";
  });
  // Walk escapes left to right so `\\` pairs are consumed before `\&` / `\x26` are read.
  const same = (l) => (l.regex ? l.value.replace(/\\(x26|.)|&/gs, (m, e) => (m === "&" || e === "&" || e === "x26" ? "&" : m)) : l.value);
  const after = literalsOf(parseAst(out)).map(same);
  if (after.length !== before.length || after.some((v, i) => v !== same(before[i])))
    throw new Error(`${name} widget: making the bundle entity-safe changed a literal`);
  return out;
}
