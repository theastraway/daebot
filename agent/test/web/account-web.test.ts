import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module
import { appLinks, deviceKind, initialOf, updateBanner } from "../../web/account.js";
// @ts-expect-error plain browser module
import { CHAT_MODES, chatModeName } from "../../web/permissions.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("sidebar bottom bar: avatar + name, connection dot, Apps icon; the old Sign out / Permissions / Apps buttons, Signed in as line and Updates bar are gone", () => {
  const html = read("index.html");
  const bar = html.slice(html.indexOf('class="side-bar"'), html.indexOf("</aside>"));
  for (const id of ["acct-btn", "acct-avatar", "acct-name", "conn-dot", "btn-apps", "acct-menu"]) assert.match(bar, new RegExp(`id="${id}"`), id);
  assert.ok(bar.indexOf('id="acct-btn"') < bar.indexOf('id="conn-dot"') && bar.indexOf('id="conn-dot"') < bar.indexOf('id="btn-apps"'), "order: avatar, dot, Apps");
  assert.doesNotMatch(html, /class="side-who"|class="side-apps"|class="side-update"|class="side-foot"|Signed in as/);
  const menu = html.slice(html.indexOf('id="acct-menu"'), html.indexOf('id="acct-btn"'));
  for (const id of ["btn-logout", "btn-perms", "am-apps", "am-mobile", "am-desktop", "am-switch", "am-accounts", "upd"]) assert.match(menu, new RegExp(`id="${id}"`), id);
  assert.match(menu, /role="menu"/);
  assert.match(html, /id="acct-btn"[^>]*aria-haspopup="menu"/);
  assert.match(html, /id="acct-btn"[^>]*aria-expanded="false"/);
  for (const id of ["mode-btn", "mode-menu", "bypass-chip"]) assert.match(html, new RegExp(`id="${id}"`), id);
});

test("account menu: apps links are device-aware and hidden inside the apps", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
  assert.equal(deviceKind(mac, "MacIntel", 0), "mac");
  assert.equal(deviceKind(iphone), "ios");
  assert.equal(deviceKind(android), "android");
  assert.equal(deviceKind("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "windows");
  assert.equal(deviceKind(mac, "MacIntel", 5), "ios", "an iPad that reports as a Mac");
  assert.deepEqual(appLinks({ desktopShell: false, mobileShell: false, kind: "mac" }), { mobile: true, desktop: true });
  assert.deepEqual(appLinks({ desktopShell: true, mobileShell: false, kind: "mac" }), { mobile: true, desktop: false });
  assert.deepEqual(appLinks({ desktopShell: false, mobileShell: false, kind: "ios" }), { mobile: true, desktop: false });
  assert.deepEqual(appLinks({ desktopShell: false, mobileShell: true, kind: "android" }), { mobile: false, desktop: false });
});

test("avatar initial and the update banner (desktop): shows only when there is something to do", () => {
  assert.equal(initialOf("alice"), "A");
  assert.equal(initialOf("  7up"), "7");
  assert.equal(initialOf(""), "D");
  assert.equal(updateBanner({ enabled: true, status: "idle" }), null);
  assert.equal(updateBanner({ enabled: false, status: "downloaded" }), null);
  assert.deepEqual(updateBanner({ enabled: true, status: "downloaded", nextVersion: "0.4.0" }), { text: "New update available (0.4.0)", action: "Restart to update" });
  assert.equal(updateBanner({ enabled: true, status: "downloading", nextVersion: "0.4.0", percent: 40 })!.action, "");
});

test("per-chat modes: the three account modes plus Bypass; the label falls back to the account default", () => {
  assert.deepEqual(CHAT_MODES.map((m: { id: string }) => m.id), ["risky", "writes", "everything", "bypass"]);
  assert.equal(chatModeName(null, "writes"), "Ask before changes");
  assert.equal(chatModeName("bypass", "risky"), "Bypass permissions");
});

test("web wiring: account.js and the waiver build DOM with textContent only, sign out/switch use the real endpoints, desktop bridge exposes accounts", () => {
  const acct = strip(read("account.js")), perms = strip(read("permissions.js")), app = strip(read("app.js"));
  assert.doesNotMatch(acct, /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/);
  assert.doesNotMatch(perms, /innerHTML|insertAdjacentHTML/);
  assert.match(acct, /\/auth\/switch/); assert.match(acct, /\/auth\/accounts/); assert.match(acct, /\/logout/); assert.match(acct, /login\?add=1/);
  assert.match(acct, /accounts\.switch/); assert.match(acct, /accounts\.add/);
  assert.match(app, /from "\/account\.js"/); assert.match(app, /initChatMode/);
  assert.match(perms, /\/permissions\/waiver/); assert.match(perms, /acknowledged: true/);
  assert.match(perms, /go\.disabled = true/); assert.match(perms, /go\.disabled = !box\.checked/);
  const preload = readFileSync(fileURLToPath(new URL("../../desktop/src/preload.cjs", import.meta.url)), "utf8");
  assert.match(preload, /accounts: Object\.freeze/); assert.match(preload, /desktop:account-switch/);
});
