// The web side of "MIND Cloud is the standard": the switch says what it does, a notice can carry one button, and the settings panel has the same switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const read = (f: string) => readFileSync(join(web, f), "utf8");
const rm = await import(join(web, "rowmenu.js"));
const ss = await import(join(web, "sessionsettings.js"));

test("the row menu's switch is Run on a computer: off says it runs in MIND Cloud, on names the computer", () => {
  const off = rm.menuItems({ pinned: false, remote: { state: "off" } })[3];
  assert.equal(off.label, "Run on a computer"); assert.equal(off.checked, false); assert.match(off.hint, /MIND Cloud/);
  const on = rm.menuItems({ pinned: false, remote: { state: "on", where: "Anthonys MacBook Pro" } })[3];
  assert.equal(on.checked, true); assert.match(on.hint, /Anthonys MacBook Pro/);
});

test("session settings show where it runs: a cloud session names MIND Cloud, a local one its computer", () => {
  assert.equal(ss.settingsFacts({ title: "t" }, undefined).where, "MIND Cloud");
  assert.equal(ss.settingsFacts({ title: "t" }, { name: "Anthonys MacBook Pro", kind: "machine", online: false }).online, false);
});

test("wiring: a plain session's switch sets its home (PATCH home), a notice's one button moves it, the bot drawer no longer promises auto-wake", () => {
  const app = read("app.js"), html = read("index.html"), sset = read("sessionsettings.js");
  assert.match(app, /home: on \? "local" : "cloud"/);
  assert.match(app, /async function noticeAction/);
  assert.match(app, /it\.action && it\.action\.label/, "a notice with an action draws one button");
  assert.match(app, /\.\.\.\(ev\.action \? \{ action: ev\.action \} : \{\}\)/, "the action survives from the stream into the transcript");
  assert.match(sset, /Run on a computer/); assert.match(sset, /onHome/);
  assert.match(html, /Run on a computer/); assert.match(html, /MIND Cloud/);
  assert.doesNotMatch(html, /Remote turns on by itself|Reachable from my other devices/);
});
