import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-expect-error plain browser module
import { lruPut, raceAbort, windowPlan, scrollMemory } from "../../web/switchcache.js";

test("lruPut: newest last, a re-put moves to the end, the oldest fall off", () => {
  const m = new Map<string, number>();
  for (const [k, v] of [["a", 1], ["b", 2], ["c", 3]] as const) lruPut(m, k, v, 3);
  lruPut(m, "a", 10, 3);
  assert.deepEqual([...m.keys()], ["b", "c", "a"]);
  lruPut(m, "d", 4, 3);
  assert.deepEqual([...m.keys()], ["c", "a", "d"]);
});

test("raceAbort: passes the result through, rejects at once on abort, leaves the shared work alone", async () => {
  assert.equal(await raceAbort(Promise.resolve(7), undefined), 7);
  assert.equal(await raceAbort(Promise.resolve(8), new AbortController().signal), 8);
  const ctl = new AbortController();
  let finish!: (v: string) => void;
  const shared = new Promise<string>((r) => { finish = r; });
  const waiting = raceAbort(shared, ctl.signal);
  ctl.abort();
  await assert.rejects(waiting, (e: Error) => e.name === "AbortError");
  finish("later");
  assert.equal(await shared, "later", "another caller still gets the result");
  await assert.rejects(raceAbort(shared, ctl.signal), (e: Error) => e.name === "AbortError", "an already-aborted signal rejects immediately");
});

test("windowPlan: the newest items first, a window behind them; a chat left scrolled up is rebuilt whole", () => {
  assert.deepEqual(windowPlan({ total: 300, mem: undefined, first: 6, win: 40 }), { away: false, want: 40, tailFrom: 294, fillTo: 260 });
  assert.deepEqual(windowPlan({ total: 20, mem: { pinned: true, fromBottom: 0, shown: 20 }, first: 6, win: 40 }), { away: false, want: 20, tailFrom: 14, fillTo: 0 });
  assert.deepEqual(windowPlan({ total: 3, mem: undefined, first: 6, win: 40 }), { away: false, want: 3, tailFrom: 0, fillTo: 0 });
  const away = windowPlan({ total: 300, mem: { pinned: false, fromBottom: 5000, shown: 120 }, first: 6, win: 40 });
  assert.deepEqual(away, { away: true, want: 120, tailFrom: 180, fillTo: 180 });
});

test("scrollMemory: pinned near the bottom, otherwise the distance from it and how much was shown", () => {
  assert.deepEqual(scrollMemory({ scrollHeight: 5000, scrollTop: 4100, clientHeight: 900, total: 80, from: 40 }), { pinned: true, fromBottom: 0, shown: 40 });
  assert.deepEqual(scrollMemory({ scrollHeight: 5000, scrollTop: 1000, clientHeight: 900, total: 80, from: 0 }), { pinned: false, fromBottom: 3100, shown: 80 });
});

test("app.js wires fast switching: paint first, resume and read in the background, abort the previous chat, send waits for the resume", () => {
  const src = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const sel = src.slice(src.indexOf("async function selectSession"), src.indexOf("function prefetchNeighbors"));
  assert.ok(sel.indexOf("renderThread()") > 0 && sel.indexOf("renderThread()") < sel.indexOf("await read"), "the thread paints before any network wait");
  assert.ok(!/await resume\b/.test(sel.slice(0, sel.indexOf("await read"))), "the resume is not on the path to the first paint");
  assert.match(sel, /switchCtl\.abort\(\)/);
  assert.match(sel, /const gone = \(\) => seq !== switchSeq/);
  assert.match(src, /if \(state\.currentId\) \{ const r = resuming\.get\(state\.currentId\); if \(r\) await r;/);
  assert.match(src, /"if-none-match"/);
  assert.ok(!/await refreshSessions\(\);\s*\n\s*renderThread\(\);/.test(src), "switching no longer re-lists every session before drawing");
});
