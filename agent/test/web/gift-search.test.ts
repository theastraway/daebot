import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gift: any = await import(new URL("../../web/gift.js", import.meta.url).href);
const search: any = await import(new URL("../../web/search.js", import.meta.url).href);
const faces: any = await import(new URL("../../web/faces.js", import.meta.url).href);
const web = (f: string) => readFileSync(new URL(`../../web/${f}`, import.meta.url), "utf8");

test("gift: the X intent link carries the copy and the plain link, nothing else", () => {
  const u = new URL(gift.xIntentUrl());
  assert.equal(u.origin + u.pathname, "https://x.com/intent/post");
  assert.equal(u.searchParams.get("url"), "https://daebot.live");
  assert.equal(u.searchParams.get("text"), gift.GIFT_TEXT);
  assert.doesNotMatch(gift.GIFT_TEXT, /free|credit|week|reward|\$/i, "no offer is promised");
  assert.equal(new URL(gift.xIntentUrl("https://a.test/?x=1&y=2", "hi there")).searchParams.get("url"), "https://a.test/?x=1&y=2");
});

test("gift: the cast is several mascots, each with a different real face and colour", () => {
  assert.ok(gift.GIFT_CAST.length >= 4);
  const ids = new Set(faces.FACES.map((f: any) => f.id));
  for (const c of gift.GIFT_CAST) { assert.ok(ids.has(c.face)); assert.match(c.color, /^#[0-9a-f]{6}$/); }
  assert.equal(new Set(gift.GIFT_CAST.map((c: any) => c.face)).size, gift.GIFT_CAST.length);
  assert.equal(new Set(gift.GIFT_CAST.map((c: any) => c.color)).size, gift.GIFT_CAST.length);
});

test("search: every word must match, bots come first, threads newest first, junk ignored", () => {
  const bots = [{ id: "b1", name: "Ledger", purpose: "Reconcile invoices" }, { id: "b2", name: "Scout", purpose: "Research a company" }];
  const sessions = [
    { id: "s1", title: "Invoice review", updatedAt: 10 },
    { id: "s2", title: "Ledger notes on invoices", updatedAt: 30, bot: "b1" },
    { id: "s3", title: "Lunch", updatedAt: 99 },
    null, { nope: 1 },
  ];
  const r = search.searchItems("invoice", { bots, sessions });
  assert.deepEqual(r.map((x: any) => `${x.kind}:${x.id}`), ["bot:b1", "thread:s2", "thread:s1"]);
  assert.equal(r[1].sub, "Ledger");
  assert.equal(r[2].sub, "Session");
  assert.deepEqual(search.searchItems("ledger invoices", { bots, sessions }).map((x: any) => x.id), ["b1", "s2"]);
  assert.deepEqual(search.searchItems("   ", { bots, sessions }), []);
  assert.deepEqual(search.searchItems("zzz", { bots, sessions }), []);
  assert.equal(search.searchItems("a", { bots: [], sessions: Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, title: "a" })) }).length, 30);
});

test("sidebar markup: logo row has Search and New bot, the bottom bar has the gift button, the modal is labelled and closable", () => {
  const html = web("index.html");
  assert.match(html, /<div class="brand-actions">[\s\S]*id="btn-search"[\s\S]*id="btn-newbot"[\s\S]*<\/div>/);
  assert.match(html, /id="btn-gift"[^>]*aria-label="Give MIND to a friend"/);
  assert.match(html, /id="gift-modal"[\s\S]*aria-labelledby="gift-title"[\s\S]*id="gift-close"[\s\S]*Give MIND to a friend who loves AI[\s\S]*Share on X[\s\S]*Copy link/);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.match(html, /btn-gift[\s\S]{0,400}btn-apps/, "gift sits next to Apps");
  const app = web("app.js");
  assert.match(app, /initGift\(\)/);
  assert.match(app, /btn-newbot[\s\S]{0,80}bots\.openCard\(\)/);
  assert.doesNotMatch(web("gift.js") + web("search.js"), /innerHTML|insertAdjacentHTML|eval\(/);
});

test("layout fixes: the header title keeps its width and the usage text shrinks first; thread meta is one ellipsised line; Update is not a capsule", () => {
  const css = web("style.css");
  assert.match(css, /\.top-title \{ flex: 1 1 auto; min-width: 140px; \}/);
  assert.match(css, /\.top-meta \{[^}]*flex: 0 100 auto[^}]*overflow: hidden; text-overflow: ellipsis/);
  assert.match(css, /\.sess-m \{[^}]*white-space: nowrap[^}]*text-overflow: ellipsis/);
  const upd = /\.bot-upd \{[^}]*\}/.exec(css)![0];
  assert.doesNotMatch(upd, /border-radius|border: 1px|background: var/);
  const bots = web("bots.js");
  assert.match(bots, /\.replace\(\/\^from \/, ""\)/);
  assert.match(bots, /item\.append\(pm\)/, "the pin mark is its own slot beside the dot");
});
