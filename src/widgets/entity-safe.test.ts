import { describe, expect, it } from "vitest";

import { entitySafe } from "../../scripts/entity-safe.mjs";

// Open WebUI html-entity-decodes an embed before it becomes the frame's srcdoc; any
// `&name` / `&#` left in a bundle is rewritten and the widget dies with a SyntaxError.
// The build calls entitySafe on every bundle and fails if one survives.
const decode = (s: string) => s.replace(/&(gt|lt|amp);?/g, (_, e: string) => ({ gt: ">", lt: "<", amp: "&" })[e]!);

describe("entitySafe", () => {
  it("leaves nothing an entity decoder would change", () => {
    const js = 'var a=1,b=2;function gt(){return 1}function lt(){return 2}a&&gt(),b&&lt(),a&=b;var s="x&amp;y",r=/&lt/.test(s),t=`&gt${a}`;';
    const out = entitySafe("t", js);
    expect(out).not.toMatch(/&[A-Za-z#]/);
    expect(decode(out)).toBe(out);
  });

  it("keeps every string and template value and what each regex matches", () => {
    const js = 'var s="x&amp;y",t=`a&gt${1}b`,r=/&lt;/;globalThis.v=[s,t,r.test("a&lt;b"),r.test("a<b")];';
    const run = (code: string) => {
      new Function(code)();
      return (globalThis as { v?: unknown }).v;
    };
    expect(run(entitySafe("t", js))).toEqual(run(js));
  });

  it("keeps an escaped ampersand in a regex matching the same text", () => {
    const js = 'var r=/a\\&gt/;globalThis.v=[r.test("a&gt"),r.test("a>")];';
    const out = entitySafe("t", js);
    expect(out).not.toMatch(/&[A-Za-z#]/);
    new Function(out)();
    expect((globalThis as { v?: unknown }).v).toEqual([true, false]);
  });

  it("keeps an escaped backslash before an ampersand in a regex", () => {
    const js = 'var r=/a\\\\&gt/;globalThis.v=[r.test("a\\\\&gt"),r.test("a&gt")];';
    const out = entitySafe("t", js);
    expect(out).not.toMatch(/&[A-Za-z#]/);
    new Function(out)();
    expect((globalThis as { v?: unknown }).v).toEqual([true, false]);
  });

  it("rewrites a string inside a tagged template's interpolation", () => {
    const js = 'var tag=(s,...v)=>v.join("");globalThis.v=tag`x${"a&gt"}y`;';
    const out = entitySafe("t", js);
    expect(out).not.toMatch(/&[A-Za-z#]/);
    new Function(out)();
    expect((globalThis as { v?: unknown }).v).toBe("a&gt");
  });

  it("refuses a raw tagged template it cannot rewrite", () => {
    expect(() => entitySafe("t", "String.raw`a&gt`;")).toThrow(/raw template/);
  });
});
