import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const c: any = await import(new URL("../../web/craft.js", import.meta.url).href);
const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");

function mem(throwing = false) {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => { if (throwing) throw new Error("denied"); return m.has(k) ? m.get(k)! : null; }, setItem: (k: string, v: string) => { if (throwing) throw new Error("denied"); m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}

test("the switch state is per chat, defaults to Chat, survives a missing or throwing storage, and moves to the new chat's id", () => {
  const s = mem();
  assert.equal(c.craftOn(s, "a"), false);
  c.setCraft(s, "a", true);
  assert.equal(c.craftOn(s, "a"), true); assert.equal(c.craftOn(s, "b"), false);
  c.setCraft(s, "a", false); assert.equal(s.m.size, 0, "off is the default, nothing kept");
  c.setCraft(s, "__draft__", true); c.moveCraft(s, "__draft__", "sess1");
  assert.equal(c.craftOn(s, "sess1"), true); assert.equal(c.craftOn(s, "__draft__"), false, "the next new chat starts as Chat");
  assert.equal(c.craftOn(mem(true), "a"), false);
  assert.doesNotThrow(() => c.setCraft(mem(true), "a", true));
  assert.equal(c.craftOn(null, "a"), false);
  assert.equal(c.CRAFT_PLACEHOLDER, "Describe what to make — Daebot builds it until it scores 9/10");
});

const snap = (o: any = {}) => ({ id: "L1", goal: "write a launch plan", bar: 9, cycle: 2, cycles: 3, phase: "build", scores: [7.4], categories: { correctness: 9, completeness: 6, clarity: 8 }, rubric: ["correctness", "completeness", "clarity"], weakest: "completeness", startedAt: 1_000, done: false, mode: "write", ...o });

test("scorecardModel: round N of M, the weakest highlighted, the rail against the bar, elapsed, the finish lines", () => {
  const m = c.scorecardModel(snap(), 66_000);
  assert.equal(m.round, "Round 2 of 3");
  assert.deepEqual(m.categories.map((x: any) => [x.name, x.score, x.weakest]), [["correctness", 9, false], ["completeness", 6, true], ["clarity", 8, false]]);
  assert.deepEqual(m.rail.map((r: any) => r.kind), ["score", "now", "todo"]);
  assert.equal(m.elapsed, "1m 05s");
  assert.equal(m.finish, "");
  assert.equal(m.last, 7.4);
  const before = c.scorecardModel(snap({ cycle: 0, phase: "study", scores: [], categories: {}, weakest: undefined }), 2_000);
  assert.equal(before.round, "Round 1 of 3");
  assert.deepEqual(before.categories.map((x: any) => x.score), [null, null, null], "rubric shown before the first grade");
  assert.ok(!before.categories.some((x: any) => x.weakest));
  const cleared = c.scorecardModel(snap({ done: true, phase: "cleared", scores: [7.4, 8.1, 9.2], endedAt: 181_000 }), 999_999);
  assert.equal(cleared.finish, "Cleared 9.2 in 3 rounds");
  assert.deepEqual(cleared.rail.map((r: any) => r.kind), ["score", "score", "pass"]);
  assert.equal(cleared.elapsed, "3m 00s", "a finished loop's clock stops");
  assert.equal(c.finishText(snap({ done: true, phase: "stopped", scores: [7, 8.4, 8.1] })), "Best 8.4 after 3 rounds — the weakest was completeness");
  assert.equal(c.finishText(snap({ done: true, phase: "cleared", scores: [9] })), "Cleared 9.0 in 1 round");
  assert.equal(c.finishText(snap({ done: true, phase: "failed", scores: [] })), "No round was graded");
  assert.equal(c.scorecardModel(snap({ likeness: { measured: false, note: "not measured here (no browser to capture pages in this environment)" } })).likeness, "likeness: not measured here (no browser to capture pages in this environment)");
  assert.equal(c.scorecardModel(snap({ likeness: { measured: true, similarity: 87.25, widths: [{ width: 390, similarity: 80.4 }, { width: 1280, similarity: 91 }] } })).likeness, "likeness 87.3% · 390px 80% · 1280px 91%");
});

function fakeDom() {
  const mk = (tag: string, cls?: string, text?: string): any => {
    const el: any = {
      tag, className: cls || "", textContent: text ?? "", kids: [] as any[], attrs: {} as Record<string, string>, on: {} as any, hidden: false, title: "", type: "", tabIndex: 0, dataset: {},
      style: { props: {} as any, setProperty(k: string, v: string) { this.props[k] = v; } },
      append(...k: any[]) { this.kids.push(...k); }, replaceChildren(...k: any[]) { this.kids = [...k]; },
      setAttribute(k: string, v: string) { this.attrs[k] = v; }, addEventListener(e: string, f: any) { this.on[e] = f; },
      focus() {}, click() { this.on.click && this.on.click(); },
      classList: { set: new Set<string>(), toggle(k: string, on: boolean) { on ? this.set.add(k) : this.set.delete(k); } },
    };
    return el;
  };
  return mk;
}
const find = (el: any, cls: string): any => { if (String(el.className).split(" ").includes(cls)) return el; for (const k of el.kids || []) { const f = find(k, cls); if (f) return f; } return null; };

test("buildScorecard: DOM built once, repainted in place; weakest row marked; finish line on the end; the clock stops", () => {
  const h = fakeDom();
  const card = c.buildScorecard(snap(), { h, now: () => 10_000 });
  assert.equal(card.className, "craft-card running");
  assert.equal(find(card, "craft-round").textContent, "Round 2 of 3");
  assert.equal(find(card, "craft-goal").textContent, "write a launch plan");
  const rows = find(card, "craft-cats").kids;
  assert.equal(rows.length, 3);
  assert.equal(rows[1].className, "craft-cat weakest");
  assert.match(rows[1].attrs["aria-label"], /completeness: 6\.0 of 10, the weakest/);
  assert.equal(find(card, "craft-rail").kids.map((s: any) => s.className).join(","), "craft-seg score,craft-seg now,craft-seg todo");
  assert.equal(find(card, "craft-finish").hidden, true);
  card.update(snap({ done: true, phase: "cleared", cycle: 3, scores: [7.4, 9.3], categories: { correctness: 10, completeness: 9, clarity: 9.5 }, weakest: "completeness", endedAt: 50_000 }));
  assert.equal(card.className, "craft-card cleared");
  assert.equal(find(card, "craft-finish").textContent, "Cleared 9.3 in 2 rounds");
  assert.equal(find(card, "craft-finish").hidden, false);
  assert.equal(find(card, "craft-big").textContent, "9.3");
  assert.equal(find(card, "craft-like").hidden, true, "no likeness line for a non-UI goal");
});

test("initCraftSwitch: a radio pair, remembers per chat, arrow keys switch, onChange repaints the placeholder", () => {
  const h = fakeDom();
  const mount = h("div", "mode-row");
  const s = mem();
  let key = "a"; const changes: boolean[] = [];
  const sw = c.initCraftSwitch({ h, mount, storage: s, getKey: () => key, onChange: (on: boolean) => changes.push(on) });
  const group = mount.kids[0];
  assert.equal(group.attrs.role, "radiogroup");
  const [chat, craft] = group.kids;
  assert.equal(chat.textContent, "Chat"); assert.equal(craft.textContent, "Craft");
  assert.equal(chat.attrs["aria-checked"], "true"); assert.equal(craft.attrs["aria-checked"], "false");
  craft.on.click();
  assert.equal(sw.on(), true); assert.equal(craft.attrs["aria-checked"], "true"); assert.deepEqual(changes, [true]);
  key = "b"; sw.render();
  assert.equal(sw.on(), false, "another chat keeps its own mode");
  key = "a"; sw.render(); assert.equal(sw.on(), true);
  let prevented = false;
  craft.on.keydown({ key: "ArrowLeft", preventDefault: () => { prevented = true; } });
  assert.ok(prevented); assert.equal(sw.on(), false);
  assert.deepEqual(c.initCraftSwitch({ h, mount: null }).on(), false);
});

test("wiring: app.js sends capability craft, paints loop events as a scorecard, keeps the user's words; DOM only, theme tokens, reduced motion, phone width", () => {
  const app = web("app.js");
  assert.match(app, /import \{[^}]*buildScorecard[^}]*\} from "\/craft\.js"/);
  assert.match(app, /if \(craft\) capabilities\.push\(CRAFT_CAP\)/);
  assert.match(app, /case "loop": node = buildScorecard\(it\.loop/);
  assert.match(app, /it\.node\.update\(ev\.loop\)/);
  assert.match(app, /craftOn\(craftStore, tkey\(\)\) \? CRAFT_PLACEHOLDER : CHAT_PLACEHOLDER/);
  assert.match(app, /moveCraft\(craftStore, startKey, id\)/);
  const js = web("craft.js");
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(js), "no HTML strings");
  const css = web("style.css");
  const block = css.slice(css.indexOf("---- Craft mode (web/craft.js)"));
  assert.ok(block.length > 2000);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(block), "theme tokens only, no hard-coded colours");
  assert.match(block, /prefers-reduced-motion: reduce/);
  assert.match(block, /max-width: 520px/);
  assert.match(css, /\.mode-row:not\(:has\(\.mode-btn:not\(\[hidden\]\)\)\):not\(:has\(\.craft-switch\)\) \{ display: none; \}/);
});

test("web/craft.js parses as a module", () => {
  const r = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: web("craft.js"), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
