import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { windowChromeOptions, titleBarOverlayFor, shortcutAction, runShortcut, isOverlayPlatform, OVERLAY_HEIGHT } from "../src/lib/winchrome.mjs";
import { buildAppMenuTemplate } from "../src/lib/menu.mjs";

const css = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8");
const token = (re) => re.exec(css)?.[1];

test("Windows and Linux: hidden title bar with an overlay, auto-hidden menu; Mac keeps hiddenInset and no overlay", () => {
  for (const p of ["win32", "linux"]) {
    const o = windowChromeOptions(p, false);
    assert.equal(o.titleBarStyle, "hidden");
    assert.equal(o.autoHideMenuBar, true);
    assert.equal(o.titleBarOverlay.height, 36);
    assert.equal(OVERLAY_HEIGHT, 36);
  }
  assert.deepEqual(windowChromeOptions("darwin", true), { titleBarStyle: "hiddenInset" });
  assert.ok(isOverlayPlatform("win32") && isOverlayPlatform("linux") && !isOverlayPlatform("darwin"));
});

test("overlay colors are the web --bg and --ink tokens, light and dark", () => {
  const light = titleBarOverlayFor(false), dark = titleBarOverlayFor(true);
  assert.equal(light.color, token(/:root \{[^}]*?--bg: (#[0-9a-f]{6})/s));
  assert.equal(light.symbolColor, token(/:root \{[^}]*?--ink: (#[0-9a-f]{6})/s));
  const darkBlock = /:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)[1];
  assert.equal(dark.color, /--bg:(#[0-9a-f]{6})/.exec(darkBlock)[1]);
  assert.equal(dark.symbolColor, /--ink:(#[0-9a-f]{6})/.exec(darkBlock)[1]);
  assert.equal(windowChromeOptions("win32", true).titleBarOverlay.color, dark.color);
});

const key = (k, mods = {}) => ({ type: "keyDown", key: k, control: false, shift: false, alt: false, meta: false, ...mods });

test("shortcuts the removed menu gave still work on Windows and Linux", () => {
  const ctrl = (k, m = {}) => shortcutAction(key(k, { control: true, ...m }), "win32");
  assert.equal(ctrl("c"), "copy");
  assert.equal(ctrl("v"), "paste");
  assert.equal(ctrl("x"), "cut");
  assert.equal(ctrl("a"), "selectAll");
  assert.equal(ctrl("z"), "undo");
  assert.equal(ctrl("z", { shift: true }), "redo");
  assert.equal(ctrl("y"), "redo");
  assert.equal(ctrl("C"), "copy"); // caps lock
  assert.equal(ctrl("n"), "newSession");
  assert.equal(ctrl("w"), "hideWindow");
  assert.equal(ctrl("r"), "reload");
  assert.equal(ctrl("r", { shift: true }), "forceReload");
  assert.equal(ctrl("i", { shift: true }), "devtools");
  assert.equal(ctrl("="), "zoomIn");
  assert.equal(ctrl("+", { shift: true }), "zoomIn");
  assert.equal(ctrl("-"), "zoomOut");
  assert.equal(ctrl("0"), "zoomReset");
  assert.equal(shortcutAction(key("F5"), "linux"), "reload");
  assert.equal(shortcutAction(key("F12"), "linux"), "devtools");
  assert.equal(shortcutAction(key("F11"), "win32"), "fullscreen");
});

test("shortcuts ignore plain typing, AltGr, key-up, Cmd, and the Mac entirely", () => {
  assert.equal(shortcutAction(key("c"), "win32"), null);
  assert.equal(shortcutAction(key("c", { control: true, alt: true }), "win32"), null); // AltGr+c types a character on some layouts
  assert.equal(shortcutAction({ ...key("c", { control: true }), type: "keyUp" }, "win32"), null);
  assert.equal(shortcutAction(key("c", { meta: true }), "win32"), null);
  assert.equal(shortcutAction(key("c", { control: true }), "darwin"), null);
  assert.equal(shortcutAction(key("q", { control: true }), "win32"), null);
  assert.equal(shortcutAction(null, "win32"), null);
});

test("runShortcut drives the right webContents call; zoom is clamped", () => {
  const calls = [];
  let zoom = 0;
  const wc = new Proxy({}, { get: (_t, n) => n === "getZoomLevel" ? () => zoom : n === "setZoomLevel" ? (z) => { zoom = z; calls.push(`zoom:${z}`); } : () => calls.push(String(n)) });
  const win = { isFullScreen: () => false, setFullScreen: (v) => calls.push(`fs:${v}`) };
  const handlers = { newSession: () => calls.push("new"), hideWindow: () => calls.push("hide") };
  for (const a of ["copy", "paste", "cut", "selectAll", "undo", "redo", "reload", "forceReload", "newSession", "hideWindow", "fullscreen", "zoomIn", "zoomReset"]) runShortcut(a, { wc, win, handlers });
  assert.deepEqual(calls, ["copy", "paste", "cut", "selectAll", "undo", "redo", "reload", "reloadIgnoringCache", "new", "hide", "fs:true", "zoom:0.5", "zoom:0"]);
  zoom = 5; calls.length = 0;
  runShortcut("zoomIn", { wc, win, handlers });
  assert.deepEqual(calls, ["zoom:5"]);
});

test("the Mac app menu is unchanged and still has Edit with copy and paste", () => {
  const t = buildAppMenuTemplate({ handlers: { quit() {}, newSession() {}, hideWindow() {} }, isMac: true });
  const edit = t.find((m) => m.label === "Edit");
  assert.ok(edit.submenu.some((i) => i.role === "copy") && edit.submenu.some((i) => i.role === "paste"));
});

test("web: the drag strip, no-drag controls, and right padding for the window buttons exist behind html.win-overlay only", () => {
  assert.match(css, /\.win-overlay \.topbar \{[^}]*-webkit-app-region: drag;[^}]*padding-right: max\(16px, var\(--wco-right\)\)/);
  assert.match(css, /\.win-overlay \.topbar :is\(button[^)]*\),[^{]*\{ -webkit-app-region: no-drag; \}/);
  assert.equal([...css.matchAll(/-webkit-app-region/g)].filter((m) => !css.slice(Math.max(0, m.index - 400), m.index).includes(".win-overlay")).length, 0);
  const shell = readFileSync(new URL("../../web/shell.js", import.meta.url), "utf8");
  assert.match(shell, /desk\.platform === "win32" \|\| desk\.platform === "linux"/);
});
