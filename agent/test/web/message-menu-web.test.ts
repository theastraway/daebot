import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../../web/msgmenu.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");

test("message menu: the rows are Anthony's, in his order", () => {
  const at = (s: string) => js.indexOf(s);
  const order = ['"Reply"', '"Mark as unread"', '"Copy"', '"Select Text"', '"Copy Request ID"', '"Report"'].map(at);
  assert.ok(order.every((i) => i > 0), "every row exists");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in order");
  assert.match(js, /QUICK = \["👍", "👎", "❤️", "😂", "🎉", "😮", "🔥", "👀", "🙏", "😢", "💯"\]/);
  assert.ok(!js.includes("innerHTML"), "no innerHTML");
});

test("message menu: bottom sheet on phones, dark-mode safe (theme variables only), icons and chip exist", () => {
  assert.match(css, /@media \(max-width: 640px\) \{[^}]*\.mx-backdrop/);
  assert.match(css, /\.mx-menu\.sheet \{ left: 0; right: 0; top: auto; bottom: 0;/);
  const block = css.slice(css.indexOf("/* ---- message menu"));
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(block.replace(/rgba?\([^)]*\)/g, "")), "no hard-coded colors in the menu CSS");
  for (const id of ["i-reply", "i-unread", "i-cursor", "i-flag", "i-smile-plus", "reply-chip"]) assert.ok(html.includes(`id="${id}"`), id);
});
