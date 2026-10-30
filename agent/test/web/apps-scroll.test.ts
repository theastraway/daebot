import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");

test("the Apps card is the one scroll container: no scroller inside it", () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const inner = rules.filter((r) => /\.apps-(body|sec|detail)|\.cd\b|\.app-row/.test(r.sel));
  for (const r of inner) assert.doesNotMatch(r.body, /overflow(-y)?:\s*(auto|scroll)/, `${r.sel} must not scroll on its own`);
  const card = rules.find((r) => r.sel.endsWith(".apps-card") && /overflow-y:\s*auto/.test(r.body));
  assert.ok(card, ".apps-card scrolls (overflow-y: auto)");
  assert.match(card.body, /max-height:\s*92dvh/);
});

test("no stylesheet caps the height of the Apps list (it would clip or add a second scroller)", () => {
  const brand = readFileSync(new URL("../../web/brand/brand.css", import.meta.url), "utf8");
  for (const [name, text] of [["style.css", css], ["brand.css", brand]] as const) {
    for (const m of text.matchAll(/([^{}]*\.apps-(?:body|sec)[^{}]*)\{([^{}]*)\}/g)) assert.doesNotMatch(m[2], /max-height/, `${name}: ${m[1].trim()}`);
  }
});
