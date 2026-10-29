import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CELL_DELTA, ScreenFeed, SIG_H, SIG_LEN, SIG_W, changeScore, pickKeyframes, regionToCells } from "../../src/screen/feed.ts";
import type { Frame } from "../../src/screen/feed.ts";
import { block, sig } from "./helpers.ts";

const jpeg = (tag = "a") => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(tag), Buffer.from([0xff, 0xd9])]);
const raw = (s: Uint8Array, tag = "a") => ({ jpeg: jpeg(tag), width: 1366, height: 768, screenWidth: 2732, screenHeight: 1536, cursorX: 5, cursorY: 6, sig: s });
const on = (feed: ScreenFeed) => feed.setState({ watching: true, permission: "granted" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("feed: frames are refused until the user's switch is on AND the OS permission is granted", () => {
  const f = new ScreenFeed();
  assert.equal(f.ingest(raw(sig())), false, "default is off");
  f.setState({ watching: true, permission: "needs-permission" });
  assert.equal(f.active(), false);
  assert.equal(f.ingest(raw(sig())), false, "switch on but no permission: nothing is stored");
  f.setState({ permission: "granted" });
  assert.equal(f.active(), true);
  assert.equal(f.ingest(raw(sig())), true);
  assert.equal(f.count(), 1);
});

test("feed: permission states are validated and each blocks capture", () => {
  const f = new ScreenFeed();
  for (const p of ["needs-permission", "restricted", "unsupported", "unknown"] as const) {
    f.setState({ watching: true, permission: p });
    assert.equal(f.active(), false, p);
  }
  f.setState({ permission: "bogus" as never });
  assert.equal(f.state().permission, "unknown", "an invalid permission value is ignored");
  f.setState({ permission: "granted" });
  assert.equal(f.active(), true);
});

test("feed: switching off, or losing the permission, drops every frame from memory", () => {
  const f = new ScreenFeed();
  on(f);
  f.ingest(raw(sig())); f.ingest(raw(sig()));
  assert.equal(f.count(), 2);
  f.setState({ permission: "needs-permission" });
  assert.equal(f.count(), 0, "permission revoked");
  on(f);
  f.ingest(raw(sig()));
  f.setState({ watching: false });
  assert.equal(f.count(), 0, "switched off");
  assert.equal(f.latest(), undefined);
});

test("feed: malformed frames are rejected", () => {
  const f = new ScreenFeed();
  on(f);
  assert.equal(f.ingest({ ...raw(sig()), sig: new Uint8Array(10) }), false, "wrong signature size");
  assert.equal(f.ingest({ ...raw(sig()), jpeg: Buffer.alloc(0) }), false, "empty jpeg");
  assert.equal(f.ingest({ ...raw(sig()), jpeg: Buffer.alloc(1_600_000, 1) }), false, "too big");
  assert.equal(f.ingest({ ...raw(sig()), width: 0 }), false);
  assert.equal(f.count(), 0);
});

test("ring buffer: keeps only the last bufferSeconds, newest last, ids increase", () => {
  let t = 1_000_000;
  const f = new ScreenFeed(() => t);
  f.setState({ watching: true, permission: "granted", bufferSeconds: 5 });
  for (let i = 0; i < 12; i++) { f.ingest(raw(sig(), String(i))); t += 1000; }
  // 12 frames one second apart; now = t; only frames newer than now-5s remain
  const kept = f.recent(100);
  assert.ok(kept.length <= 6 && kept.length >= 5, `kept ${kept.length}`);
  assert.ok(kept.every((x, i) => i === 0 || x.id > kept[i - 1].id));
  assert.equal(f.latest()!.jpeg.toString().includes("11"), true);
  assert.ok(f.span() <= 5);
});

test("ring buffer: a hard cap bounds memory even at a silly frame rate", () => {
  const f = new ScreenFeed(() => 5);
  f.setState({ watching: true, permission: "granted", bufferSeconds: 120 });
  for (let i = 0; i < 900; i++) f.ingest(raw(sig()));
  assert.equal(f.count(), 600);
});

test("ring buffer: recent(seconds) is a window, and bufferSeconds/fps are clamped", () => {
  let t = 10_000;
  const f = new ScreenFeed(() => t);
  f.setState({ watching: true, permission: "granted", bufferSeconds: 30 });
  for (let i = 0; i < 10; i++) { f.ingest(raw(sig())); t += 1000; }
  assert.equal(f.recent(3).length, 3);
  const s = f.setState({ bufferSeconds: 9999, fps: 99 });
  assert.equal(s.bufferSeconds, 120);
  assert.equal(s.fps, 5);
  assert.equal(f.setState({ bufferSeconds: 0, fps: 0 }).bufferSeconds, 2);
});

test("live(): needs the feed active and a recent frame", () => {
  let t = 0;
  const f = new ScreenFeed(() => t);
  assert.equal(f.live(), false);
  on(f);
  assert.equal(f.live(), false, "no frame yet");
  f.ingest(raw(sig()));
  assert.equal(f.live(), true);
  t += 10_000;
  assert.equal(f.live(), false, "stale frame");
});

test("changeScore: counts cells beyond the noise delta; identical and small noise score 0", () => {
  const a = sig(100);
  assert.equal(changeScore(a, sig(100)), 0);
  assert.equal(changeScore(a, sig(100 + CELL_DELTA)), 0, "within noise");
  assert.equal(changeScore(a, sig(100 + CELL_DELTA + 1)), 1);
  const b = block(a, 0, 0, SIG_W / 2, SIG_H, 200);
  assert.equal(changeScore(a, b), 0.5);
  assert.equal(changeScore(a, new Uint8Array(3)), 0, "wrong size never throws");
});

test("regionToCells: maps frame pixels to cells, clamps, rejects nonsense", () => {
  assert.deepEqual(regionToCells({ x: 0, y: 0, w: 1366, h: 768 }, 1366, 768), { x0: 0, y0: 0, x1: SIG_W, y1: SIG_H });
  assert.deepEqual(regionToCells({ x: 683, y: 0, w: 683, h: 384 }, 1366, 768), { x0: 32, y0: 0, x1: 64, y1: 18 });
  const tiny = regionToCells({ x: 10, y: 10, w: 1, h: 1 }, 1366, 768)!;
  assert.ok(tiny.x1 > tiny.x0 && tiny.y1 > tiny.y0, "at least one cell");
  assert.equal(regionToCells({ x: 0, y: 0, w: 0, h: 5 }, 1366, 768), undefined);
  assert.equal(regionToCells({ x: 5000, y: 0, w: 10, h: 10 }, 1366, 768), undefined);
  assert.equal(regionToCells({ x: NaN, y: 0, w: 10, h: 10 }, 1366, 768), undefined);
  const a = sig(100), b = block(a, 0, 0, 8, 8, 250);
  const box = regionToCells({ x: 0, y: 0, w: 1366 / 2, h: 768 / 2 }, 1366, 768)!;
  assert.ok(changeScore(a, b, { cells: box }) > changeScore(a, b), "a region makes a local change a bigger fraction");
});

test("waitForChange: returns the settled new frame when the screen changes", async () => {
  const f = new ScreenFeed();
  on(f);
  f.ingest(raw(sig(100), "base"));
  const p = f.waitForChange({ timeoutMs: 3000, settleMs: 60 });
  await sleep(20);
  f.ingest(raw(sig(100), "same"));
  await sleep(20);
  f.ingest(raw(block(sig(100), 0, 0, 20, 20, 240), "loading"));
  await sleep(30);
  f.ingest(raw(block(sig(100), 0, 0, 40, 30, 240), "loaded"));
  const keep = setInterval(() => f.ingest(raw(block(sig(100), 0, 0, 40, 30, 240), "loaded")), 30);
  const r = await p;
  clearInterval(keep);
  assert.ok(r && r.changed);
  assert.match(r!.frame.jpeg.toString(), /loaded/, "waited for the screen to stop moving before returning");
  assert.ok(r!.score > 0.02);
});

test("waitForChange: a change below the threshold does not wake it; it times out with changed:false", async () => {
  const f = new ScreenFeed();
  on(f);
  f.ingest(raw(sig(100)));
  const p = f.waitForChange({ timeoutMs: 250, threshold: 0.5 });
  await sleep(20);
  f.ingest(raw(block(sig(100), 0, 0, 10, 10, 250))); // ~4%
  const r = await p;
  assert.equal(r!.changed, false);
  assert.ok(r!.waitedMs >= 200);
});

test("waitForChange: region ignores changes elsewhere on the screen", async () => {
  const f = new ScreenFeed();
  on(f);
  f.ingest(raw(sig(100)));
  const p = f.waitForChange({ timeoutMs: 300, threshold: 0.2, region: { x: 0, y: 0, w: 1366 / 4, h: 768 / 4 } });
  await sleep(20);
  f.ingest(raw(block(sig(100), 40, 20, 20, 15, 250))); // bottom-right area
  const quiet = await p;
  assert.equal(quiet!.changed, false);
  const p2 = f.waitForChange({ timeoutMs: 1500, threshold: 0.2, settleMs: 40, region: { x: 0, y: 0, w: 1366 / 4, h: 768 / 4 } });
  await sleep(20);
  const hit = block(sig(100), 0, 0, 16, 9, 250);
  f.ingest(raw(hit));
  const t = setInterval(() => f.ingest(raw(hit)), 30);
  const loud = await p2;
  clearInterval(t);
  assert.equal(loud!.changed, true);
});

test("waitForChange: abort, and turning the feed off, end the wait", async () => {
  const f = new ScreenFeed();
  on(f);
  f.ingest(raw(sig()));
  const ac = new AbortController();
  const p = f.waitForChange({ timeoutMs: 5000, signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  const t0 = Date.now();
  const r = await p;
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r!.changed, false);
  const p2 = f.waitForChange({ timeoutMs: 5000 });
  setTimeout(() => f.setState({ watching: false }), 30);
  const t1 = Date.now();
  await p2;
  assert.ok(Date.now() - t1 < 1000, "off ends the wait at once");
});

test("pickKeyframes: first, last, and the biggest jumps in time order", () => {
  const frames: Frame[] = [];
  const mk = (i: number, s: Uint8Array): Frame => ({ id: i, t: i * 500, jpeg: jpeg(String(i)), width: 10, height: 10, screenWidth: 10, screenHeight: 10, cursorX: 0, cursorY: 0, sig: s });
  let cur = sig(50);
  for (let i = 0; i < 20; i++) {
    if (i === 7) cur = sig(200);          // big jump at 7
    if (i === 13) cur = block(cur, 0, 0, 20, 20, 10); // smaller jump at 13
    frames.push(mk(i, cur));
  }
  const k = pickKeyframes(frames, 4);
  assert.equal(k.length, 4);
  assert.equal(k[0].id, 0);
  assert.equal(k[k.length - 1].id, 19);
  assert.ok(k.some((x) => x.id === 7) && k.some((x) => x.id === 13), "the two moments the screen changed are in the clip");
  assert.ok(k.every((x, i) => i === 0 || x.t > k[i - 1].t));
  assert.equal(pickKeyframes(frames.slice(0, 3), 4).length, 3);
  assert.deepEqual(pickKeyframes(frames, 1).map((x) => x.id), [19]);
});

test("save writes frames only when asked, as plain JPEG files", () => {
  let t = 1000;
  const f = new ScreenFeed(() => t);
  on(f);
  f.ingest(raw(sig(), "one")); t += 500; f.ingest(raw(sig(), "two"));
  const dir = join(mkdtempSync(join(tmpdir(), "screen-save-")), "clip");
  assert.equal(readdirSync(tmpdir()).includes("clip"), false);
  const r = f.save(dir, 10);
  assert.equal(r.files.length, 2);
  assert.deepEqual(readdirSync(dir).sort(), r.files.sort());
  assert.ok(readFileSync(join(dir, r.files[0])).includes(Buffer.from("one")));
});
