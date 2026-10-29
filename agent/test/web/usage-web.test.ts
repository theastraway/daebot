import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module
import { barFor, detailRows, extraState, initUsage, resetLabel, usageLine } from "../../web/usage.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");
const EN = "en-US";
const add = (over: Record<string, unknown> = {}) => ({ available: true, enabled: false, active: false, automatic: false, rateNote: null, overflowUsd: 0, ...over });
const mind = (over: Record<string, unknown> = {}) => ({ source: "mind", plan: "pro", planName: "Pro", percentLeft: 62, percentUsed: 38, resetAt: "2026-11-01T12:00:00.000Z", state: "normal", additional: add(), manageUrl: "https://m-i-n-d.ai", ...over });

test("usage line: plan, how much is left, reset date; the states from normal to past the limit", () => {
  assert.equal(usageLine(mind(), EN), "Pro · 62% left · resets Nov 1");
  assert.equal(usageLine(mind({ percentLeft: 12, state: "low" }), EN), "Pro · 12% left · resets Nov 1");
  assert.equal(usageLine(mind({ percentLeft: 0, state: "empty" }), EN), "Pro · Limit reached · resets Nov 1");
  assert.equal(usageLine(mind({ percentLeft: 0, state: "empty", additional: add({ enabled: true, active: true }) }), EN), "Pro · Past your limit · resets Nov 1", "overage on");
  assert.equal(usageLine(mind({ percentLeft: null, state: "normal" }), EN), "Pro · Usage billed as you go");
  assert.equal(usageLine(mind({ state: "unlimited", percentLeft: null }), EN), "Pro · Unlimited");
  assert.equal(usageLine({ source: "own-key" }), "Using your own API key");
  assert.equal(usageLine({ source: "owner" }), "Owner access");
  assert.equal(usageLine({ source: "mind", error: "unavailable" }), "Usage unavailable");
  assert.equal(usageLine(null), "");
  assert.equal(resetLabel("", EN), ""); assert.equal(resetLabel("nope", EN), "");
  assert.doesNotMatch(usageLine(mind()), /credit/i);
});

test("bar: width and tone by state; none when there is nothing to measure", () => {
  assert.deepEqual(barFor(mind()), { pct: 62, tone: "ok" });
  assert.deepEqual(barFor(mind({ percentLeft: 15, state: "low" })), { pct: 15, tone: "low" });
  assert.deepEqual(barFor(mind({ percentLeft: 0, state: "empty" })), { pct: 0, tone: "empty" });
  assert.equal(barFor(mind({ percentLeft: null })), null);
  assert.equal(barFor(mind({ state: "unlimited", percentLeft: null })), null);
  for (const u of [{ source: "own-key" }, { source: "owner" }, { source: "mind", error: "unavailable" }, null]) assert.equal(barFor(u), null);
  assert.deepEqual(detailRows(mind(), EN), [["Used", "38%"], ["Left", "62%"], ["Resets", "Nov 1"]]);
  assert.deepEqual(detailRows({ source: "own-key" }, EN), []);
});

test("Additional usage row: off says it stops at the limit, on says it keeps going, price only when MIND sent one, free and automatic plans have no switch", () => {
  const off = extraState(mind());
  assert.deepEqual([off.show, off.on, off.canToggle], [true, false, true]);
  assert.match(off.note, /^Off\. Usage stops at your plan limit\.$/, "no price invented");
  const on = extraState(mind({ additional: add({ enabled: true, active: true, rateNote: "Billed at cost plus 12%." }) }));
  assert.deepEqual([on.on, on.canToggle], [true, true]);
  assert.match(on.note, /^On\. You keep going past your plan limit\. Billed at cost plus 12%\.$/);
  const priced = extraState(mind({ additional: add({ rateNote: "Billed at cost plus 12%." }) }));
  assert.match(priced.note, /Billed at cost plus 12%\./);
  const free = extraState(mind({ plan: "free", additional: add({ available: false }) }));
  assert.deepEqual([free.show, free.canToggle], [true, false]); assert.match(free.note, /Paid plans/);
  const dark = extraState(mind({ additional: add({ available: false }) }));
  assert.match(dark.note, /Not available on your plan yet/); assert.equal(dark.canToggle, false);
  const auto = extraState(mind({ additional: add({ available: false, automatic: true }) }));
  assert.deepEqual([auto.on, auto.canToggle], [true, false]); assert.match(auto.note, /billed as you go/);
  for (const u of [{ source: "own-key" }, { source: "owner" }, { source: "mind", error: "unavailable" }, null]) assert.equal(extraState(u).show, false);
});

// ---- a tiny DOM, enough to drive initUsage end to end
class El {
  id: string; hidden = false; disabled = false; textContent = ""; title = ""; href = ""; style: Record<string, string> = {}; children: El[] = [];
  attrs = new Map<string, string>(); cls = new Set<string>(); handlers: Record<string, (() => void)[]> = {};
  constructor(id = "") { this.id = id; }
  get classList() { const s = this.cls; return { toggle: (c: string, on?: boolean) => ((on ?? !s.has(c)) ? s.add(c) : s.delete(c)), contains: (c: string) => s.has(c) }; }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k); }
  addEventListener(t: string, f: () => void) { (this.handlers[t] ??= []).push(f); }
  async click() { for (const f of this.handlers.click ?? []) await f(); await new Promise((r) => setImmediate(r)); }
  append(...c: El[]) { this.children.push(...c); }
  replaceChildren(...c: El[]) { this.children = c; }
}
function dom() {
  const ids = ["am-sub", "um-box", "usage-head", "usage-line", "usage-bar", "usage-fill", "usage-detail", "usage-rows", "usage-extra", "usage-switch", "usage-extra-note", "plan-link"];
  const els = Object.fromEntries(ids.map((i) => [i, new El(i)]));
  (globalThis as any).document = { getElementById: (i: string) => els[i] ?? null, createElement: () => new El() };
  return els;
}

test("initUsage: paints the line and bar, expands the detail, toggles through the gateway and shows what MIND answered", async () => {
  const els = dom();
  let view: any = mind();
  const calls: [string, any][] = [];
  const notes: string[] = [];
  const json = async (path: string, opts?: any) => {
    calls.push([path, opts?.body ? JSON.parse(opts.body) : null]);
    if (path === "/usage/additional") { const b = JSON.parse(opts.body); view = mind({ additional: add({ enabled: b.enabled, active: b.enabled }) }); }
    return view;
  };
  const u = initUsage({ json, notify: (m: string) => notes.push(m), locale: EN });
  await u.refresh();
  assert.equal(els["usage-line"].textContent, "Pro · 62% left · resets Nov 1");
  assert.equal(els["um-box"].hidden, false); assert.equal(els["am-sub"].hidden, true, "the usage line replaces the old sub line");
  assert.equal(els["usage-fill"].style.width, "62%"); assert.equal(els["usage-bar"].hidden, false);
  assert.equal(els["usage-detail"].hidden, true);
  await els["usage-head"].click();
  assert.equal(els["usage-detail"].hidden, false); assert.equal(els["usage-head"].getAttribute("aria-expanded"), "true");
  assert.equal(els["usage-rows"].children.length, 3);
  assert.equal(els["usage-switch"].getAttribute("aria-checked"), "false"); assert.equal(els["usage-switch"].disabled, false);
  assert.match(els["usage-extra-note"].textContent, /^Off\./);
  await els["usage-switch"].click();
  assert.deepEqual(calls.at(-1), ["/usage/additional", { enabled: true }]);
  assert.equal(els["usage-switch"].getAttribute("aria-checked"), "true"); assert.match(els["usage-extra-note"].textContent, /^On\./);
  await els["usage-switch"].click();
  assert.deepEqual(calls.at(-1), ["/usage/additional", { enabled: false }]);
  assert.equal(els["usage-switch"].getAttribute("aria-checked"), "false");
  // near limit and exhausted
  view = mind({ percentLeft: 8, state: "low" }); await u.refresh();
  assert.ok(els["usage-bar"].cls.has("low")); assert.equal(els["usage-fill"].style.width, "8%");
  view = mind({ percentLeft: 0, state: "empty" }); await u.refresh();
  assert.ok(els["usage-bar"].cls.has("empty") && !els["usage-bar"].cls.has("low"));
  // own key: calm line, no bar, nothing to expand, no switch
  view = { source: "own-key" }; await u.refresh();
  assert.equal(els["usage-line"].textContent, "Using your own API key"); assert.equal(els["usage-bar"].hidden, true);
  assert.equal(els["usage-head"].disabled, true); assert.equal(els["usage-detail"].hidden, true); assert.equal(els["usage-extra"].hidden, true);
  // a refusal from the gateway is shown and the switch goes back
  view = mind(); await u.refresh();
  const refuse = initUsage({ json: async (p: string) => { if (p === "/usage") return view; throw new Error("Additional usage is not available yet."); }, notify: (m: string) => notes.push(m), locale: EN });
  await refuse.refresh(); await els["usage-switch"].click();
  assert.deepEqual(notes, ["Additional usage is not available yet."]);
  assert.equal(els["usage-switch"].getAttribute("aria-checked"), "false"); assert.equal(els["usage-switch"].disabled, false);
  // MIND down on a fresh load: unavailable; down after a good read: keep the last good numbers
  const down = initUsage({ json: async () => { throw new Error("HTTP 502"); }, notify() {}, locale: EN });
  await down.refresh(); assert.equal(els["usage-line"].textContent, "Usage unavailable");
});

test("markup: the usage line sits under the name, the switch is an accessible switch, and the old plan block is gone", () => {
  const html = read("index.html");
  const who = html.slice(html.indexOf('class="am-who"'), html.indexOf('id="usage-detail"'));
  assert.ok(who.indexOf('id="am-name"') < who.indexOf('id="usage-head"'), "usage is under the name");
  assert.match(html, /id="usage-switch"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(html, /id="usage-head"[^>]*aria-expanded="false"[^>]*aria-controls="usage-detail"/);
  assert.doesNotMatch(html, /id="plan-text"|class="side-plan"|id="plan-name"/);
  assert.match(read("app.js"), /initUsage\(\{ json, notify \}\)/);
  assert.match(read("account.js"), /if \(onOpen\) onOpen\(\)/, "opening the menu re-reads usage");
  assert.match(read("style.css"), /@media \(min-width: 561px\) and \(max-height: 760px\) \{\s*\.acct-menu \{ max-height: calc\(100dvh - 90px\); overflow-y: auto/, "a short window scrolls the menu instead of clipping the usage line off the top");
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "every id in index.html is unique (a second id=usage let the session token meter write into the menu)");
});
