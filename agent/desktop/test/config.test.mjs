import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, isValidAccelerator, loadConfig, normalizeConfig, resolveBounds, saveKernelMode, desktopHome, configPath } from "../src/lib/config.mjs";
import { envForKernelMode, isKernelMode } from "../src/lib/kernel.mjs";

test("default shortcut is Alt+Space and kernel is enforced", () => {
  assert.deepEqual(loadConfig("/nonexistent/desktop.json"), { shortcut: "Alt+Space", kernelMode: "enforced", idleTrimSeconds: 300 });
  assert.equal(DEFAULT_CONFIG.shortcut, "Alt+Space");
});

test("accelerator validation accepts real combos and rejects junk", () => {
  for (const ok of ["Alt+Space", "CommandOrControl+Shift+M", "Ctrl+Alt+F12", "Cmd+Option+/"]) assert.ok(isValidAccelerator(ok), ok);
  for (const bad of ["", "Space", "a", "Alt+", "Alt+Alt+Space", "Foo+Space", "Ctrl+Alt+Shift+Cmd+K", "Alt+Space; rm", 42, null]) assert.ok(!isValidAccelerator(bad), String(bad));
});

test("config file overrides valid keys only; bad values fall back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcd-"));
  const p = join(dir, "desktop.json");
  writeFileSync(p, JSON.stringify({ shortcut: "Ctrl+Alt+M", kernelMode: "SHADOW" }));
  assert.deepEqual(loadConfig(p), { shortcut: "Ctrl+Alt+M", kernelMode: "shadow", idleTrimSeconds: 300 });
  assert.equal(normalizeConfig({ idleTrimSeconds: 0 }).idleTrimSeconds, 0);
  assert.equal(normalizeConfig({ idleTrimSeconds: -5 }).idleTrimSeconds, 300);
  assert.equal(normalizeConfig({ idleTrimSeconds: "9" }).idleTrimSeconds, 300);
  writeFileSync(p, JSON.stringify({ shortcut: "nope", kernelMode: "yolo" }));
  assert.deepEqual(loadConfig(p), DEFAULT_CONFIG);
  writeFileSync(p, "{ not json");
  assert.deepEqual(loadConfig(p), DEFAULT_CONFIG);
  assert.equal(normalizeConfig({ shortcut: null }).shortcut, null, "null opts out of the global shortcut");
  assert.deepEqual(normalizeConfig([1, 2]), DEFAULT_CONFIG);
});

test("saveKernelMode preserves other keys, is 0600, and round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcd-"));
  const p = join(dir, "sub", "desktop.json");
  saveKernelMode("shadow", p);
  writeFileSync(p, JSON.stringify({ shortcut: "Ctrl+Alt+M", extra: 1, kernelMode: "shadow" }));
  saveKernelMode("off", p);
  const j = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(j, { shortcut: "Ctrl+Alt+M", extra: 1, kernelMode: "off" });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test("desktop home honors override env", () => {
  assert.equal(desktopHome({ MINDCLAW_DESKTOP_HOME: "/x/y" }), "/x/y");
  assert.equal(configPath({ HOME: "/h" }), "/h/.mindclaw/desktop.json");
});

test("window bounds: clamps size, drops off-screen position, keeps visible position", () => {
  const areas = [{ x: 0, y: 0, width: 1440, height: 900 }];
  assert.deepEqual(resolveBounds(undefined, areas), { width: 1100, height: 760 });
  assert.deepEqual(resolveBounds({ x: 100, y: 80, width: 900, height: 600 }, areas), { x: 100, y: 80, width: 900, height: 600 });
  const off = resolveBounds({ x: 5000, y: 5000, width: 900, height: 600 }, areas);
  assert.equal(off.x, undefined);
  assert.equal(off.width, 900);
  assert.equal(resolveBounds({ width: 10, height: 99999 }, areas).width, 480);
  assert.equal(resolveBounds({ width: 10, height: 99999 }, areas).height, 6000);
  assert.equal(resolveBounds({ width: 800, height: 600, maximized: true }, areas).maximized, true);
  assert.equal(resolveBounds({ x: "a", y: 1, width: 800, height: 600 }, areas).x, undefined);
});

test("kernel mode maps to the env vars the agent reads (src/config.ts)", () => {
  assert.deepEqual(envForKernelMode("enforced"), { MINDCLAW_KERNEL: "1", MINDCLAW_SHADOW: "0" });
  assert.deepEqual(envForKernelMode("shadow"), { MINDCLAW_KERNEL: "1", MINDCLAW_SHADOW: "1" });
  assert.deepEqual(envForKernelMode("off"), { MINDCLAW_KERNEL: "0", MINDCLAW_SHADOW: "0" });
  assert.throws(() => envForKernelMode("yolo"));
  assert.ok(isKernelMode("shadow") && !isKernelMode("toString") && !isKernelMode(undefined));
});

test("gateway child gets Bots on by default, matching daebot.live; an explicit env value wins", async () => {
  const { buildSpawnPlan } = await import("../src/lib/launcher.mjs");
  const base = { agentRoot: "/a", entry: "/a/e.mjs", nodePath: "/n", kernelMode: "enforced" };
  assert.equal(buildSpawnPlan({ ...base, baseEnv: {} }).env.DAEBOT_BOTS_ENABLED, "1");
  assert.equal(buildSpawnPlan({ ...base, baseEnv: { DAEBOT_BOTS_ENABLED: "0" } }).env.DAEBOT_BOTS_ENABLED, "0");
});
