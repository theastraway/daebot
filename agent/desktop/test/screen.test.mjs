import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAC_SCREEN_SETTINGS_URL, permissionSettingsUrl, screenAccess } from "../src/lib/screen-permission.mjs";
import { SIG_H, SIG_LEN, SIG_W, captureGeometry, cursorInFrame, frameQuery, redDotBitmap, signature } from "../src/lib/screen-frame.mjs";
import { ScreenCapture, clampFps } from "../src/lib/screen-capture.mjs";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveWatchScreen } from "../src/lib/config.mjs";
import { buildTrayTemplate, flatten } from "../src/lib/menu.mjs";

// ---------- permission-state handling ----------
test("permission: Windows and Linux need none; macOS maps every status; the Settings link is the Screen Recording pane only", () => {
  assert.equal(screenAccess({ platform: "win32" }).state, "granted");
  assert.equal(screenAccess({ platform: "linux" }).state, "granted");
  assert.equal(screenAccess({ platform: "freebsd" }).state, "unsupported");
  assert.equal(screenAccess({ platform: "darwin", status: "granted" }).state, "granted");
  const nd = screenAccess({ platform: "darwin", status: "not-determined" });
  assert.deepEqual([nd.state, nd.askable, nd.canOpenSettings], ["needs-permission", true, true]);
  const dn = screenAccess({ platform: "darwin", status: "denied" });
  assert.deepEqual([dn.state, dn.askable, dn.canOpenSettings], ["needs-permission", false, true]);
  assert.equal(screenAccess({ platform: "darwin", status: "restricted" }).state, "restricted");
  assert.equal(screenAccess({ platform: "darwin", status: "restricted" }).canOpenSettings, false);
  assert.equal(screenAccess({ platform: "darwin", status: "unknown" }).state, "needs-permission", "anything unknown on a Mac is treated as not granted");
  assert.equal(screenAccess({ platform: "darwin" }).state, "needs-permission");
  assert.equal(permissionSettingsUrl("darwin"), "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  assert.equal(MAC_SCREEN_SETTINGS_URL, permissionSettingsUrl("darwin"));
  assert.equal(permissionSettingsUrl("win32"), null);
});

// ---------- frame helpers ----------
test("geometry: width = min(1366, physical), same factor as the computer tool's screenshot", () => {
  assert.deepEqual(captureGeometry({ width: 1920, height: 1080, scaleFactor: 1 }), { physW: 1920, physH: 1080, width: 1366, height: 768, f: 1920 / 1366 });
  const retina = captureGeometry({ width: 1440, height: 900, scaleFactor: 2 });
  assert.equal(retina.physW, 2880);
  assert.equal(retina.width, 1366);
  assert.equal(retina.height, 854, "1800 physical rows scaled by the same factor as the width");
  const small = captureGeometry({ width: 1280, height: 720, scaleFactor: 1 });
  assert.deepEqual([small.width, small.height, small.f], [1280, 720, 1]);
  assert.equal(captureGeometry({ width: 1920, height: 1080, scaleFactor: 1.5 }, 800).width, 800);
});

test("signature: BGRA 64x36 -> luma bytes; wrong size is refused", () => {
  const px = Buffer.alloc(SIG_LEN * 4);
  for (let i = 0; i < SIG_LEN; i++) { px[i * 4] = 0; px[i * 4 + 1] = 0; px[i * 4 + 2] = 255; px[i * 4 + 3] = 255; } // pure red in BGRA
  const s = signature(px);
  assert.equal(s.length, SIG_LEN);
  assert.equal(s[0], 76, "red luma 0.299 * 255");
  assert.equal(signature(Buffer.alloc(10)), null);
  assert.equal(signature(null), null);
  assert.equal(SIG_W * SIG_H, 2304);
});

test("cursor: mapped into frame pixels and clamped", () => {
  const display = { bounds: { x: 0, y: 0 }, scaleFactor: 2 };
  const geo = captureGeometry({ width: 1440, height: 900, scaleFactor: 2 });
  const c = cursorInFrame({ x: 720, y: 450 }, display, geo);
  assert.ok(Math.abs(c.x - geo.width / 2) <= 1 && Math.abs(c.y - geo.height / 2) <= 1);
  assert.deepEqual(cursorInFrame({ x: -50, y: 99999 }, display, geo), { x: 0, y: geo.height - 1 });
});

test("frameQuery: all meta and a url-safe signature of exactly SIG_LEN bytes", () => {
  const s = new Uint8Array(SIG_LEN).fill(7);
  const q = new URLSearchParams(frameQuery({ width: 1366, height: 768, screenWidth: 2732, screenHeight: 1536, cursorX: 1, cursorY: 2, sig: s }));
  assert.deepEqual([q.get("w"), q.get("h"), q.get("sw"), q.get("sh"), q.get("cx"), q.get("cy")], ["1366", "768", "2732", "1536", "1", "2"]);
  assert.equal(Buffer.from(q.get("sig"), "base64url").length, SIG_LEN);
});

test("red dot: a red, anti-aliased circle with a transparent corner", () => {
  const b = redDotBitmap(32);
  assert.equal(b.length, 32 * 32 * 4);
  const mid = (16 * 32 + 16) * 4;
  assert.deepEqual([b[mid], b[mid + 1], b[mid + 2], b[mid + 3]], [40, 40, 235, 255]);
  assert.equal(b[3], 0, "corner is transparent");
});

// ---------- capture loop ----------
function img(w, h, { empty = false } = {}) {
  return {
    isEmpty: () => empty, getSize: () => ({ width: w, height: h }), toJPEG: (q) => Buffer.from([0xff, 0xd8, q, 0xff, 0xd9]),
    resize: ({ width, height }) => ({ toBitmap: () => Buffer.alloc(width * height * 4, 128) }),
  };
}
function rig(over = {}) {
  const calls = { sources: [], posts: [], reports: [] };
  const timers = [];
  const o = {
    desktopCapturer: { getSources: async (opts) => { calls.sources.push(opts); if (over.fail) throw new Error(over.fail); return [{ display_id: "1", thumbnail: img(opts.thumbnailSize.width, opts.thumbnailSize.height, { empty: over.empty }) }]; } },
    screen: { getPrimaryDisplay: () => ({ id: 1, size: { width: 1920, height: 1080 }, scaleFactor: 1, bounds: { x: 0, y: 0 } }), getCursorScreenPoint: () => ({ x: 960, y: 540 }) },
    getAccess: over.getAccess ?? (() => ({ state: "granted" })),
    post: async (f) => { calls.posts.push(f); if (over.postFail) throw new Error("gateway down"); },
    report: (s) => calls.reports.push(s),
    setTimer: (fn, ms) => { const t = { fn, ms, off: false, unref() {} }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.off = true; },
    log: () => {},
    fps: over.fps,
    ...over.extra,
  };
  const cap = new ScreenCapture(o);
  const fire = async () => { const t = timers.filter((x) => !x.off).pop(); assert.ok(t, "a timer is pending"); t.off = true; t.fn(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  return { cap, calls, timers, fire };
}

test("capture: off by default; nothing is captured or reported until start()", async () => {
  const { cap, calls, timers } = rig();
  assert.equal(cap.watching, false);
  assert.equal(timers.length, 0);
  assert.equal(calls.sources.length, 0);
});

test("capture: granted -> reports watching+granted, then one downscaled JPEG frame per tick at the chosen fps", async () => {
  const { cap, calls, fire, timers } = rig({ fps: 2 });
  await cap.start();
  assert.deepEqual(calls.reports.at(-1), { watching: true, permission: "granted", fps: 2 });
  await fire();
  assert.equal(calls.sources.length, 1);
  assert.deepEqual(calls.sources[0].thumbnailSize, { width: 1366, height: 768 }, "downscaled to <= 1366 wide");
  assert.deepEqual(calls.sources[0].types, ["screen"]);
  assert.equal(calls.posts.length, 1);
  const f = calls.posts[0];
  assert.deepEqual([f.width, f.height, f.screenWidth, f.screenHeight], [1366, 768, 1920, 1080]);
  assert.equal(f.jpeg[0], 0xff);
  assert.equal(f.sig.length, SIG_LEN);
  assert.ok(f.cursorX > 600 && f.cursorX < 760);
  // the next tick is scheduled about 1/fps (500 ms) after the start of this one
  const next = timers.filter((t) => !t.off).pop();
  assert.ok(next.ms <= 500 && next.ms > 400, `next in ${next.ms}`);
  cap.setFps(0.5);
  assert.equal(cap.fps, 0.5);
  assert.equal(clampFps(99), 5);
  assert.equal(clampFps(0), 0.2);
  assert.equal(clampFps(undefined), 2);
});

test("capture: macOS permission missing -> nothing is captured, state says needs-permission, and it picks the grant up when the user gives it", async () => {
  let status = "denied";
  const { cap, calls, timers, fire } = rig({ getAccess: () => screenAccess({ platform: "darwin", status }) });
  await cap.start();
  assert.deepEqual(calls.reports.at(-1), { watching: true, permission: "needs-permission", fps: 2 });
  assert.equal(calls.sources.length, 0, "no capture attempt without permission (denied, so no probe either)");
  assert.equal(calls.posts.length, 0);
  assert.equal(cap.running, false);
  await fire(); // the 3 s re-check: still denied
  assert.equal(calls.sources.length, 0);
  status = "granted";
  await fire();
  assert.equal(cap.running, true);
  assert.equal(calls.reports.at(-1).permission, "granted");
  await fire();
  assert.equal(calls.posts.length, 1);
});

test("capture: macOS never asked -> one tiny probe so the OS shows ITS prompt; we never grant anything", async () => {
  let status = "not-determined";
  const { cap, calls } = rig({ getAccess: () => screenAccess({ platform: "darwin", status }), extra: {} });
  // the probe makes the OS ask; the user says no
  const orig = cap.o.desktopCapturer.getSources;
  cap.o.desktopCapturer.getSources = async (o) => { const r = await orig(o); status = "denied"; return r; };
  await cap.start();
  assert.equal(calls.sources.length, 1);
  assert.deepEqual(calls.sources[0].thumbnailSize, { width: 1, height: 1 });
  assert.equal(calls.posts.length, 0);
  assert.equal(calls.reports.at(-1).permission, "needs-permission");
  await cap.start(); // second start: already waiting, no second probe
  assert.equal(calls.sources.length, 1);
});

test("capture: restricted / unsupported do not poll and do not capture", async () => {
  const r = rig({ getAccess: () => ({ state: "restricted" }) });
  await r.cap.start();
  assert.equal(r.calls.reports.at(-1).permission, "restricted");
  assert.equal(r.timers.filter((t) => !t.off).length, 0);
  assert.equal(r.calls.sources.length, 0);
});

test("capture: stop() reports watching:false (so the gateway drops its buffer) and cancels the loop", async () => {
  const { cap, calls, timers, fire } = rig();
  await cap.start();
  await fire();
  cap.stop();
  assert.equal(calls.reports.at(-1).watching, false);
  assert.equal(cap.watching, false);
  assert.ok(timers.every((t) => t.off), "no timer left running");
  const before = calls.posts.length;
  cap.stop();
  assert.equal(calls.posts.length, before);
  assert.equal(calls.reports.filter((x) => x.watching === false).length, 1, "stopping twice reports once");
});

test("capture: a frame in flight when the user stops is dropped, not uploaded", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { cap, calls, timers } = rig();
  const orig = cap.o.desktopCapturer.getSources;
  cap.o.desktopCapturer.getSources = async (o) => { await gate; return orig(o); };
  await cap.start();
  const t = timers.filter((x) => !x.off).pop(); t.off = true; t.fn();
  cap.stop();
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.posts.length, 0);
});

test("capture: repeated failures are reported once, a good frame clears them; the loop keeps going", async () => {
  const r = rig({ fail: "boom" });
  await r.cap.start();
  for (let i = 0; i < 3; i++) await r.fire();
  const err = r.calls.reports.at(-1);
  assert.match(err.error, /boom/);
  const n = r.calls.reports.length;
  await r.fire();
  assert.equal(r.calls.reports.length, n, "the same error is not re-reported every tick");
  assert.ok(r.timers.some((t) => !t.off), "still trying");
  const e = rig({ empty: true });
  await e.cap.start();
  for (let i = 0; i < 3; i++) await e.fire();
  assert.match(e.calls.reports.at(-1).error, /no picture/);
});

test("capture: a gateway that is down counts as a failure but never crashes the loop", async () => {
  const r = rig({ postFail: true });
  await r.cap.start();
  for (let i = 0; i < 4; i++) await r.fire();
  assert.ok(r.calls.reports.at(-1).error);
  assert.equal(r.cap.running, true);
});

// ---------- the switch is a saved setting, OFF by default ----------
test("config: watchScreen is false by default and only a literal true turns it on", () => {
  assert.equal(DEFAULT_CONFIG.watchScreen, false);
  assert.equal(normalizeConfig({}).watchScreen, false);
  assert.equal(normalizeConfig({ watchScreen: "yes" }).watchScreen, false);
  assert.equal(normalizeConfig({ watchScreen: 1 }).watchScreen, false);
  assert.equal(normalizeConfig({ watchScreen: true }).watchScreen, true);
  const dir = mkdtempSync(join(tmpdir(), "daebot-cfg-"));
  const path = join(dir, "desktop.json");
  assert.equal(loadConfig(path).watchScreen, false, "missing file");
  saveWatchScreen(true, path);
  assert.equal(loadConfig(path).watchScreen, true);
  saveWatchScreen(false, path);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).watchScreen, false);
});

// ---------- tray ----------
test("tray: a checkbox for the switch; while it is on the FIRST item is the red-dot stop, one click", () => {
  const calls = [];
  const h = { toggle() {}, newSession() {}, quit() {}, setKernelMode() {}, setWatchScreen: (v) => calls.push(v) };
  const off = flatten(buildTrayTemplate({ windowVisible: true, kernelMode: "enforced", shortcut: null, handlers: h, watchingScreen: false }));
  const sw = off.find((i) => i.path === "Let Daebot watch my screen");
  assert.equal(sw.item.checked, false);
  assert.ok(!off.some((i) => i.path.includes("is watching your screen")));
  sw.item.click();
  const on = flatten(buildTrayTemplate({ windowVisible: true, kernelMode: "enforced", shortcut: null, handlers: h, watchingScreen: true }));
  assert.match(on[0].path, /^● Daebot is watching your screen/);
  on[0].item.click();
  on.find((i) => i.path === "Let Daebot watch my screen").item.click();
  assert.deepEqual(calls, [true, false, false]);
});
