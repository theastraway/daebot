import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { cropRaster, decodePng } from "../../src/likeness/png.ts";
import { compareRasters, createBrowserCapture, measureLikeness, LIKENESS_WIDTHS, type PageCapture } from "../../src/likeness/measure.ts";
import { likenessMode, type Raster } from "../../src/likeness/score.ts";
import type { BrowserHost } from "../../src/browser/host.ts";

/** A minimal PNG encoder for the tests (CRC is not checked by the decoder). Filter per row: cycles 0..4 to exercise each. */
function png(w: number, h: number, ch: 3 | 4, px: (x: number, y: number) => number[]): Buffer {
  const color = ch === 4 ? 6 : 2;
  const rows: number[] = [];
  const raw: number[][] = [];
  for (let y = 0; y < h; y++) { const r: number[] = []; for (let x = 0; x < w; x++) r.push(...px(x, y).slice(0, ch)); raw.push(r); }
  for (let y = 0; y < h; y++) {
    const f = y % 5, cur = raw[y], up = y ? raw[y - 1] : new Array(w * ch).fill(0);
    rows.push(f);
    for (let i = 0; i < cur.length; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = up[i], c = i >= ch ? up[i - ch] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      rows.push((cur[i] - pred) & 0xff);
    }
  }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = color;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const grad = (x: number, y: number) => [(x * 37) & 255, (y * 53) & 255, (x * y) & 255, 200];

test("decodePng: RGB and RGBA, every filter type, round-trips the pixels; bad input throws", () => {
  for (const ch of [3, 4] as const) {
    const r = decodePng(png(13, 11, ch, grad));
    assert.equal(r.width, 13); assert.equal(r.height, 11);
    for (const [x, y] of [[0, 0], [12, 10], [5, 7], [3, 4]]) {
      const i = (y * 13 + x) * 4, want = grad(x, y);
      assert.deepEqual([...r.data.slice(i, i + 3)], want.slice(0, 3), `${ch} ch at ${x},${y}`);
      assert.equal(r.data[i + 3], ch === 4 ? 200 : 255);
    }
  }
  assert.throws(() => decodePng(Buffer.from("not a png at all, clearly not")), /not a PNG/);
  const c = cropRaster(decodePng(png(10, 10, 3, grad)), 4, 3);
  assert.equal(c.width, 4); assert.equal(c.height, 3); assert.equal(c.data.length, 48);
});

const solid = (w: number, h: number, v: number): Raster => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });

test("measureLikeness: per width, the reference cached, the shorter page sets the height; never throws", async () => {
  const calls: string[] = [];
  const cap: PageCapture = { available: () => true, async shot(url, w) { calls.push(`${url}@${w}`); return url === "ref" ? solid(w, 64, 255) : solid(w, 48, url === "same" ? 255 : 0); } };
  const cache = new Map<string, Raster>();
  const same = await measureLikeness({ capture: cap, reference: "ref", build: "same", refCache: cache });
  assert.equal(same.measured, true); assert.equal(same.similarity, 100);
  assert.deepEqual(same.widths!.map((w) => w.width), [...LIKENESS_WIDTHS]);
  const far = await measureLikeness({ capture: cap, reference: "ref", build: "black", refCache: cache });
  assert.ok(far.similarity! < 50, String(far.similarity));
  assert.equal(calls.filter((c) => c.startsWith("ref@")).length, 3, "reference captured once per width across rounds");
  assert.equal(compareRasters(solid(20, 30, 9), solid(16, 8, 9), 16).similarity, 100);
  assert.match((await measureLikeness({ capture: undefined, reference: "a", build: "b" })).note!, /not measured here/);
  assert.match((await measureLikeness({ capture: { available: () => false, reason: "no pane", shot: cap.shot }, reference: "a", build: "b" })).note!, /not measured here \(no pane\)/);
  assert.match((await measureLikeness({ capture: cap, reference: "ref" })).note!, /no preview URL/);
  assert.match((await measureLikeness({ capture: cap, build: "x" })).note!, /no reference URL/);
  const slow: PageCapture = { available: () => true, shot: () => new Promise(() => {}) };
  assert.match((await measureLikeness({ capture: slow, reference: "a", build: "b", timeoutMs: 20 })).note!, /timed out/);
});

test("browser capture: own tab, width via device metrics, a PNG of the viewport, the tab closed; refused URLs never open", async () => {
  const log: { op: string; args: any }[] = [];
  const host: BrowserHost = {
    connected: () => true,
    snapshot: () => ({ tabs: [], gatewayOrigin: "http://127.0.0.1:7777" }) as any,
    async call(op, args) {
      log.push({ op, args });
      if (op === "open") return { tabId: "t9" };
      if (op === "cdp" && args.method === "Page.captureScreenshot") return { data: png(4, 3, 4, grad).toString("base64") };
      return {};
    },
  };
  const cap = createBrowserCapture(() => host, { settleMs: 1 });
  assert.equal(cap.available(), true);
  const r = await cap.shot("http://localhost:5173/", 390);
  assert.equal(r.width, 4);
  const metrics = log.find((l) => l.args.method === "Emulation.setDeviceMetricsOverride")!;
  assert.equal(metrics.args.params.width, 390); assert.equal(metrics.args.params.mobile, true);
  assert.equal(log.find((l) => l.args.method === "Page.captureScreenshot")!.args.params.format, "png");
  assert.equal(log.at(-1)!.op, "close"); assert.equal(log.at(-1)!.args.tabId, "t9");
  log.length = 0;
  await assert.rejects(cap.shot("file:///etc/passwd", 390), /refused/);
  await assert.rejects(cap.shot("http://127.0.0.1:7777/", 390), /refused/);
  assert.equal(log.length, 0, "no tab opened for a refused URL");
  assert.equal(createBrowserCapture(() => undefined).available(), false);
  assert.equal(likenessMode({}), "off");
});
