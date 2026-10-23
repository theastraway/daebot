import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CHECK_INTERVAL_MS, FEED_URL, FIRST_CHECK_DELAY_MS, createUpdater, feedChannel, updaterDisabledReason } from "../src/lib/updater.mjs";
import { buildAppMenuTemplate, buildTrayTemplate, flatten } from "../src/lib/menu.mjs";

function rig(over = {}) {
  const au = new EventEmitter();
  au.calls = [];
  au.setFeedURL = (o) => au.calls.push(["setFeedURL", o]);
  au.checkForUpdates = async () => { au.calls.push(["check"]); if (au.onCheck) await au.onCheck(); return { downloadPromise: Promise.resolve() }; };
  au.quitAndInstall = (...a) => { au.calls.push(["quitAndInstall", ...a]); if (au.installThrows) throw new Error("boom"); };
  const dialogs = [];
  const dialog = { async showMessageBox(o) { dialogs.push(o); return { response: dialog.answer ?? 1 }; } };
  const timers = { fires: [], intervals: [], cleared: [], setTimeout: (f, ms) => { timers.fires.push([f, ms]); return { unref() {} }; }, setInterval: (f, ms) => { timers.intervals.push([f, ms]); return { unref() {} }; }, clearTimeout: (t) => timers.cleared.push(t), clearInterval: (t) => timers.cleared.push(t) };
  const events = { prepared: 0, aborted: [], changes: [] };
  const u = createUpdater({
    loadAutoUpdater: async () => au, dialog, platform: "darwin", arch: "arm64", version: "0.2.0", env: {}, isPackaged: true, smoke: false,
    prepareForInstall: async () => { events.prepared++; }, onInstallAborted: (m) => events.aborted.push(m), onChange: (s) => events.changes.push(s.status), timers,
    ...over,
  });
  return { au, u, dialog, dialogs, timers, events };
}
const downloaded = (au, v = "0.3.0") => { au.emit("update-available", { version: v }); au.emit("update-downloaded", { version: v }); };
const tick = () => new Promise((r) => setImmediate(r));

test("channel: only Windows on ARM leaves latest.yml; the feed is the daebot download folder", () => {
  assert.equal(feedChannel({ platform: "win32", arch: "arm64" }), "latest-arm64");
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) assert.equal(feedChannel({ platform, arch }), "latest");
  assert.equal(FEED_URL, "https://download.m-i-n-d.ai/download/daebot/");
});

test("disabled in smoke, unpackaged, opt-out, a .deb and unknown platforms; enabled for packaged mac/win/AppImage", () => {
  const base = { isPackaged: true, smoke: false, platform: "darwin", env: {} };
  assert.equal(updaterDisabledReason(base), null);
  assert.equal(updaterDisabledReason({ ...base, platform: "win32" }), null);
  assert.match(updaterDisabledReason({ ...base, smoke: true }), /smoke/);
  assert.match(updaterDisabledReason({ ...base, isPackaged: false }), /packaged/);
  assert.match(updaterDisabledReason({ ...base, env: { DAEBOT_DISABLE_UPDATES: "1" } }), /DISABLE/);
  assert.match(updaterDisabledReason({ ...base, platform: "linux" }), /AppImage/);
  assert.equal(updaterDisabledReason({ ...base, platform: "linux", env: { APPIMAGE: "/x/Daebot.AppImage" } }), null);
  assert.match(updaterDisabledReason({ ...base, platform: "freebsd" }), /unsupported/);
});

test("a disabled updater never loads electron-updater, never schedules, and has no menu item", async () => {
  let loaded = 0;
  const { u, timers } = rig({ smoke: true, loadAutoUpdater: async () => { loaded++; } });
  assert.equal(await u.start(), false);
  assert.equal(loaded, 0);
  assert.equal(timers.fires.length + timers.intervals.length, 0);
  assert.equal(u.menuItem(), null);
  assert.equal(u.getState().status, "disabled");
  assert.equal(await u.install(), false);
  assert.equal(u.installOnQuit(), false);
});

test("start: background download + install on quit, feed set per arch, check at 20 s then every 6 h", async () => {
  const { au, u, timers } = rig({ platform: "win32", arch: "arm64" });
  assert.equal(await u.start(), true);
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.allowDowngrade, false);
  assert.deepEqual(au.calls[0], ["setFeedURL", { provider: "generic", url: FEED_URL, channel: "latest-arm64" }]);
  assert.equal(timers.fires[0][1], FIRST_CHECK_DELAY_MS);
  assert.equal(FIRST_CHECK_DELAY_MS, 20_000);
  assert.equal(timers.intervals[0][1], CHECK_INTERVAL_MS);
  assert.equal(CHECK_INTERVAL_MS, 6 * 3600 * 1000);
  await u.start(); // idempotent
  assert.equal(timers.fires.length, 1);
  timers.fires[0][0]();
  await tick();
  assert.deepEqual(au.calls.filter((c) => c[0] === "check").length, 1);
  u.stop();
  assert.equal(timers.cleared.length, 2);
});

test("scheduled checks are silent when up to date; the menu check says so", async () => {
  const { au, u, dialogs } = rig();
  await u.start();
  au.onCheck = async () => { au.emit("checking-for-update"); au.emit("update-not-available", { version: "0.2.0" }); };
  await u.check("timer");
  assert.equal(dialogs.length, 0);
  assert.equal(u.getState().status, "not-available");
  await u.check("menu", { manual: true });
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /up to date/);
});

test("a manual check that fails says so; a scheduled failure is only recorded", async () => {
  const { au, u, dialogs } = rig();
  await u.start();
  au.checkForUpdates = async () => { throw new Error("net down"); };
  await u.check("timer");
  assert.equal(dialogs.length, 0);
  assert.equal(u.getState().status, "error");
  await u.check("menu", { manual: true });
  assert.match(dialogs[0].message, /Could not check/);
  assert.match(dialogs[0].detail, /net down/);
});

test("progress updates the menu text; downloaded asks Restart now / Later once per version", async () => {
  const { au, u, dialogs } = rig();
  await u.start();
  assert.equal(u.menuItem().label, "Check for updates...");
  au.emit("checking-for-update");
  assert.equal(u.menuItem().label, "Checking for updates...");
  au.emit("update-available", { version: "0.3.0" });
  au.emit("download-progress", { percent: 41.6 });
  assert.equal(u.menuItem().label, "Downloading update 0.3.0... 42%");
  assert.equal(u.menuItem().enabled, false);
  au.emit("update-downloaded", { version: "0.3.0" });
  await tick();
  assert.equal(dialogs.length, 1);
  assert.deepEqual(dialogs[0].buttons, ["Restart now", "Later"]);
  assert.match(dialogs[0].message, /Daebot 0\.3\.0 is ready/);
  assert.equal(u.menuItem().label, "Restart to Update to 0.3.0...");
  au.emit("update-downloaded", { version: "0.3.0" }); // same version again: no second prompt
  await tick();
  assert.equal(dialogs.length, 1);
});

test("Restart now: prepares the app first, then quitAndInstall (silent + run-after on Windows)", async () => {
  for (const [platform, args] of [["darwin", [false, true]], ["win32", [true, true]]]) {
    const { au, u, dialog, events } = rig({ platform });
    dialog.answer = 0;
    await u.start();
    downloaded(au);
    await tick(); await tick();
    assert.equal(events.prepared, 1);
    assert.deepEqual(au.calls.at(-1), ["quitAndInstall", ...args]);
  }
});

test("order: the app is quiesced before quitAndInstall runs (so the hide-on-close window and before-quit cannot block it)", async () => {
  const order = [];
  const { au, u, dialog } = rig({ prepareForInstall: async () => { await tick(); order.push("prepared"); } });
  au.quitAndInstall = () => order.push("quitAndInstall");
  dialog.answer = 0;
  await u.start();
  downloaded(au);
  await tick(); await tick(); await tick();
  assert.deepEqual(order, ["prepared", "quitAndInstall"]);
});

test("Later: nothing installs now; the menu item and installOnQuit still apply it later", async () => {
  const { au, u, dialog, events } = rig();
  dialog.answer = 1;
  await u.start();
  downloaded(au);
  await tick();
  assert.equal(events.prepared, 0);
  assert.equal(au.calls.some((c) => c[0] === "quitAndInstall"), false);
  assert.equal(u.installOnQuit(), true);
  assert.deepEqual(au.calls.at(-1), ["quitAndInstall", true, false]);
  assert.equal(u.installOnQuit(), false); // already installing
});

test("the menu item installs a downloaded update, and a manual check re-asks after Later", async () => {
  const { au, u, dialog, dialogs, events } = rig();
  dialog.answer = 1;
  await u.start();
  downloaded(au);
  await tick();
  await u.check("menu", { manual: true });
  assert.equal(dialogs.length, 2);
  dialog.answer = 0;
  u.menuItem().click();
  await tick(); await tick();
  assert.equal(events.prepared, 1);
});

test("a failed quitAndInstall hands the app back instead of leaving it half stopped", async () => {
  const { au, u, dialog, events } = rig();
  dialog.answer = 0;
  au.installThrows = true;
  await u.start();
  downloaded(au);
  await tick(); await tick();
  assert.deepEqual(events.aborted, ["boom"]);
  // an async installer error after quitAndInstall was accepted is handled the same way
  au.installThrows = false;
  assert.equal(await u.install(), true);
  au.emit("error", new Error("squirrel failed"));
  assert.deepEqual(events.aborted, ["boom", "squirrel failed"]);
  assert.equal(u.getState().status, "downloaded");
});

test("a download error shows as error and a later check can recover", async () => {
  const { au, u } = rig();
  await u.start();
  au.emit("update-available", { version: "0.3.0" });
  au.emit("error", new Error("sha512 mismatch"));
  assert.equal(u.getState().status, "error");
  assert.equal(u.menuItem().label, "Check for updates...");
  await u.check("timer");
  assert.equal(au.calls.filter((c) => c[0] === "check").length, 1);
});

test("menu builders: the update item is placed in the tray and the Mac app menu, and absent when null", () => {
  const h = { toggle() {}, newSession() {}, quit() {}, hideWindow() {}, setKernelMode() {}, signOut() {} };
  const item = { label: "Check for updates...", enabled: true, click() {} };
  assert.ok(flatten(buildTrayTemplate({ windowVisible: true, kernelMode: "shadow", shortcut: null, handlers: h, update: item })).some((i) => i.path === "Check for updates..."));
  assert.ok(flatten(buildAppMenuTemplate({ handlers: h, isMac: true, update: item })).some((i) => i.path === "Daebot > Check for updates..."));
  assert.equal(flatten(buildTrayTemplate({ windowVisible: true, kernelMode: "shadow", shortcut: null, handlers: h, update: null })).some((i) => /update/i.test(i.path)), false);
  assert.equal(flatten(buildAppMenuTemplate({ handlers: h, isMac: true })).some((i) => /update/i.test(i.path)), false);
});
