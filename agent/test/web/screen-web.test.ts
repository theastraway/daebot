import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain browser module
import { screenView } from "../../web/screen.js";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

test("screenView: off by default, on only when watching AND permission granted; the pill and card follow", () => {
  assert.deepEqual([screenView(null).checked, screenView(null).pill, screenView(null).card], [false, false, false]);
  const off = screenView({ watching: false, permission: "granted" });
  assert.deepEqual([off.checked, off.pill, off.card], [false, false, false]);
  assert.match(off.note, /Off/);
  const on = screenView({ watching: true, permission: "granted" });
  assert.deepEqual([on.checked, on.on, on.pill, on.card], [true, true, true, false]);
  assert.match(on.note, /red dot/);
  const needs = screenView({ watching: true, permission: "needs-permission", canOpenSettings: true });
  assert.deepEqual([needs.checked, needs.pill, needs.card, needs.canOpenSettings], [true, false, true, true]);
  assert.match(needs.note, /Screen Recording/);
  assert.equal(screenView({ watching: true, permission: "restricted" }).card, false);
  assert.match(screenView({ watching: true, permission: "restricted" }).note, /policy/);
  assert.match(screenView({ watching: true, permission: "granted", error: "no picture" }).note, /no picture/);
  assert.equal(screenView({ watching: "true", permission: "granted" }).checked, false, "only a real boolean counts");
});

test("screen switch markup: hidden until the desktop shell shows it, the pill has a Stop button, nothing is inline", () => {
  const html = read("index.html");
  assert.match(html, /id="am-screen"[^>]*role="menuitemcheckbox"[^>]*hidden/);
  assert.match(html, /Let Daebot watch my screen/);
  const pill = html.slice(html.indexOf('id="screen-pill"'), html.indexOf('id="app"'));
  assert.match(pill, /hidden/);
  assert.match(pill, /<button[^>]*aria-label="Stop watching my screen"/);
  const js = read("screen.js").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write|fetch\(/);
  assert.match(js, /window\.mindclawDesktop && window\.mindclawDesktop\.screen/);
  assert.match(read("app.js"), /initScreen\(/);
});
