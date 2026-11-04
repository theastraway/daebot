import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const web = new URL("../../web/", import.meta.url);
const css = readFileSync(new URL("style.css", web), "utf8");
const shell = readFileSync(new URL("shell.js", web), "utf8");

function runShell(platform: string | null): string[] {
  const classes = new Set<string>();
  const root = { classList: { add: (c: string) => classes.add(c) }, style: { setProperty() {} } };
  const win: Record<string, unknown> = { addEventListener() {}, innerWidth: 1200 };
  if (platform) win.mindclawDesktop = { platform, titleBar: true };
  const doc = { documentElement: root, querySelector: () => null, addEventListener() {} };
  const nav = { userAgent: "Mozilla/5.0 (Macintosh) Electron", platform: "MacIntel", maxTouchPoints: 0 };
  vm.runInNewContext(shell, { window: win, document: doc, navigator: nav });
  return [...classes];
}

test("Mac desktop app gets html.mac-inset so the window can be dragged", () => {
  assert.ok(runShell("darwin").includes("mac-inset"));
  assert.ok(!runShell("darwin").includes("win-overlay"));
});

test("Windows, Linux and browser tabs never get mac-inset", () => {
  assert.ok(!runShell("win32").includes("mac-inset"));
  assert.ok(!runShell("linux").includes("mac-inset"));
  assert.ok(!runShell(null).includes("mac-inset"));
});

test("mac-inset makes the top bar and brand drag handles, controls stay clickable", () => {
  assert.match(css, /\.mac-inset \.topbar, \.mac-inset \.brand \{ -webkit-app-region: drag; \}/);
  assert.match(css, /\.mac-inset \.topbar :is\(button, a, input, select, textarea, label[^)]*\)/);
  assert.match(css, /\.mac-inset \.drawer, \.mac-inset \.screen-pill \{ -webkit-app-region: no-drag; \}/);
});
