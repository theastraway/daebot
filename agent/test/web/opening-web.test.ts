import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const o: any = await import(new URL("../../web/opening.js", import.meta.url).href);
const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");

test("greetingFor: time of day and the name; junk names are dropped", () => {
  const at = (h: number) => new Date(2026, 10, 27, h, 0, 0);
  assert.equal(o.greetingFor(at(2), "Anthony"), "Up late, Anthony");
  assert.equal(o.greetingFor(at(9), "Anthony"), "Good morning, Anthony");
  assert.equal(o.greetingFor(at(14), ""), "Good afternoon");
  assert.equal(o.greetingFor(at(20), "<b>x</b>"), "Good evening");
  assert.equal(o.todayString(at(9)), "Friday, November 27, 2026");
});

test("cleanBrief keeps the shape the page renders; createOpening dedupes and memoises", async () => {
  assert.equal(o.cleanBrief(null), null);
  const c = o.cleanBrief({ name: "A", line: "x".repeat(400), starters: [{ label: "L", prompt: "P" }, { label: "", prompt: "P" }, { label: 5 }], at: 1 });
  assert.equal(c.line.length, 260); assert.deepEqual(c.starters, [{ label: "L", prompt: "P" }]);
  let calls = 0; let url = "";
  const op = o.createOpening({ json: async (u: string) => { calls++; url = u; return { name: "A", line: "Hi", starters: [] }; }, now: () => new Date(2026, 10, 27, 9) });
  const [a, b] = await Promise.all([op.load("main"), op.load("main")]);
  assert.equal(calls, 1); assert.equal(a.line, "Hi"); assert.equal(b.line, "Hi");
  assert.match(url, /^\/home\/brief\?bot=main&today=Friday%2C\+November\+27%2C\+2026$/);
  await op.load("main"); assert.equal(calls, 1, "memoised");
  await op.load("main", true); assert.equal(calls, 2); assert.match(url, /fresh=1/);
  assert.equal(op.cached("main").line, "Hi");
  const bad = o.createOpening({ json: async () => { throw new Error("down"); } });
  assert.equal(await bad.load("main"), null);
});

function fakeDom() {
  const mk = (tag: string, cls?: string, text?: string): any => ({ tag, cls, text, kids: [] as any[], title: "", type: "", on: {} as any, append(...k: any[]) { this.kids.push(...k); }, addEventListener(e: string, f: any) { this.on[e] = f; } });
  const box: any = { kids: [] as any[], cl: new Set<string>(), replaceChildren() { this.kids = []; }, append(...k: any[]) { this.kids.push(...k); }, classList: { toggle(c: string, on: boolean) { on ? box.cl.add(c) : box.cl.delete(c); } } };
  return { h: mk, box };
}

test("paintOpening: greeting, the line, starters that send their prompt; a quiet checking line while loading", () => {
  const { h, box } = fakeDom();
  const sent: string[] = [];
  o.paintOpening(box, null, { h, onStart: (p: string) => sent.push(p), loading: true, date: new Date(2026, 10, 27, 20) });
  assert.equal(box.kids[0].text, "Good evening.");
  assert.equal(box.kids[1].text, "Checking what needs you…"); assert.ok(box.cl.has("loading"));
  o.paintOpening(box, { name: "Anthony", line: "Andrew is waiting on you.", starters: [{ label: "Reply to Andrew", prompt: "Draft my reply to Andrew." }] }, { h, onStart: (p: string) => sent.push(p), date: new Date(2026, 10, 27, 20) });
  assert.equal(box.kids[0].text, "Good evening, Anthony.");
  assert.equal(box.kids[1].text, "Andrew is waiting on you.");
  const btn = box.kids[2].kids[0];
  assert.equal(btn.text, "Reply to Andrew"); assert.equal(btn.title, "Draft my reply to Andrew.");
  btn.on.click(); assert.deepEqual(sent, ["Draft my reply to Andrew."]);
  assert.ok(!box.cl.has("loading"));
});

test("web/app.js parses as a module (a duplicate declaration would blank the whole page)", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const f of ["app.js", "opening.js", "voice.js", "voicechat-bridge.js", "voiceagent.js"]) {
    const r = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: web(f), encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr.split("\n").slice(0, 6).join("\n")}`);
  }
});

test("the new-chat screen uses the opening (no kernel jargon), and opening.js never touches innerHTML", () => {
  const app = web("app.js");
  assert.match(app, /paintOpening\(box, held, \{ h, onStart: startFromOpening, loading: true \}\)/);
  assert.doesNotMatch(app, /Every claim here is checked by the kernel/);
  assert.doesNotMatch(web("opening.js"), /\.innerHTML\s*=|insertAdjacentHTML/);
  assert.match(web("style.css"), /\.opening-starter \{/);
});
