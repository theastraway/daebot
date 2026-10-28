import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyKeepWorking, keepWorkingNote } from "../src/lib/keepworking.mjs";
import { normalizeConfig, loadConfig, saveKeepWorking, DEFAULT_CONFIG } from "../src/lib/config.mjs";
import { buildTrayTemplate, flatten } from "../src/lib/menu.mjs";

const fakePsb = () => {
  const started = new Set(); const log = []; let n = 0;
  return { log, start: (t) => { log.push(`start:${t}`); started.add(++n); return n; }, stop: (i) => { log.push(`stop:${i}`); started.delete(i); }, isStarted: (i) => started.has(i) };
};

test("keepWorking defaults on, validates as boolean only, and round-trips through desktop.json next to other keys", () => {
  assert.equal(DEFAULT_CONFIG.keepWorking, true);
  assert.equal(normalizeConfig({ keepWorking: false }).keepWorking, false);
  assert.equal(normalizeConfig({ keepWorking: "no" }).keepWorking, true);
  const p = join(mkdtempSync(join(tmpdir(), "kw-")), "desktop.json");
  writeFileSync(p, JSON.stringify({ kernelMode: "shadow" }));
  saveKeepWorking(false, p);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { kernelMode: "shadow", keepWorking: false });
  assert.equal(loadConfig(p).keepWorking, false);
});

test("applyKeepWorking: starts prevent-app-suspension once, stops on off, never throws", () => {
  const psb = fakePsb();
  const id = applyKeepWorking({ powerSaveBlocker: psb, enabled: true, current: null });
  assert.equal(id, 1);
  assert.equal(applyKeepWorking({ powerSaveBlocker: psb, enabled: true, current: id }), 1); // idempotent
  assert.equal(applyKeepWorking({ powerSaveBlocker: psb, enabled: false, current: id }), null);
  assert.deepEqual(psb.log, ["start:prevent-app-suspension", "stop:1"]);
  const boom = { start() { throw new Error("x"); }, stop() {}, isStarted: () => false };
  assert.equal(applyKeepWorking({ powerSaveBlocker: boom, enabled: true, current: null }), null);
});

test("tray menu: Keep working in the background is a checkbox that toggles the setting", () => {
  const calls = [];
  const h = { toggle() {}, newSession() {}, quit() {}, signOut() {}, setKernelMode() {}, setKeepWorking: (v) => calls.push(v) };
  const on = flatten(buildTrayTemplate({ windowVisible: true, kernelMode: "enforced", shortcut: null, handlers: h, keepWorking: true }));
  const item = on.find((i) => i.path === "Keep working in the background");
  assert.equal(item.item.type, "checkbox");
  assert.equal(item.item.checked, true);
  item.item.click();
  const off = flatten(buildTrayTemplate({ windowVisible: true, kernelMode: "enforced", shortcut: null, handlers: h, keepWorking: false }));
  off.find((i) => i.path === "Keep working in the background").item.click();
  assert.deepEqual(calls, [false, true]);
});

test("the setting's help text says what does not work while locked", () => {
  assert.match(keepWorkingNote("win32"), /locked/);
  assert.match(keepWorkingNote("win32"), /Screen capture/);
});
