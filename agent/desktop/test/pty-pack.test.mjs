import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPtyPack, macPtyBinaries, PTY_ASAR_UNPACK, PTY_NODE, PTY_PACK_FILES, PTY_SPAWN_HELPER, PTY_WIN_SIGN_EXTS, PTY_WIN_SIGN_REL, PTY_X64_ARCH_FILES } from "../src/lib/pty-pack.mjs";
import { signPtyWindows } from "../scripts/sign-pty-win.mjs";
import builderConfig from "../electron-builder.config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("electron-builder keeps node-pty out of a merged asar and signs the helpers", () => {
  assert.equal(builderConfig.asar, false);
  assert.equal(builderConfig.npmRebuild, true);
  assert.equal(builderConfig.buildDependenciesFromSource, true);
  assert.ok(builderConfig.files.includes("node_modules/node-pty/**/*"));
  assert.deepEqual(builderConfig.asarUnpack, PTY_ASAR_UNPACK);
  assert.deepEqual(builderConfig.asarUnpack, ["**/node_modules/node-pty/**"]);
  assert.equal(builderConfig.mac.x64ArchFiles, PTY_X64_ARCH_FILES);
  assert.match(builderConfig.mac.x64ArchFiles, /node-pty\/prebuilds/);
  assert.match(builderConfig.mac.x64ArchFiles, /Contents\/Resources\/bin/);
  assert.equal(builderConfig.mac.mergeASARs, true);
  assert.deepEqual(builderConfig.mac.binaries, macPtyBinaries(false));
  assert.ok(builderConfig.mac.binaries[0].endsWith("Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper"));
  assert.deepEqual(macPtyBinaries(true), ["Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper"]);
  assert.deepEqual(builderConfig.win.signExts, PTY_WIN_SIGN_EXTS);
  assert.deepEqual(builderConfig.win.signExts, [".exe", ".dll", ".node"]);
  assert.equal(typeof builderConfig.afterPack, "function");
  assert.ok(builderConfig.mac.hardenedRuntime);
  const winArches = builderConfig.win.target.map((t) => t.arch);
  assert.ok(winArches.some((a) => a.includes("x64") && a.includes("arm64")) || winArches.flat().includes("x64"));
  assert.ok(JSON.stringify(builderConfig.win.target).includes("arm64"));
  assert.ok(JSON.stringify(builderConfig.linux.target).includes("x64"));
  assert.ok(JSON.stringify(builderConfig.mac.target).includes("universal"));
});

test("checkPtyPack wants the helpers for each target and nothing else", () => {
  const dir = mkdtempSync(join(tmpdir(), "pty-pack-"));
  try {
    const touch = (rel) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, "x"); };
    touch(PTY_NODE);
    assert.deepEqual(checkPtyPack(dir, "linux-x64"), { ok: true, missing: [] });
    const mac = checkPtyPack(dir, "darwin-arm64");
    assert.equal(mac.ok, false);
    assert.deepEqual(mac.missing, [PTY_SPAWN_HELPER]);
    touch(PTY_SPAWN_HELPER);
    assert.equal(checkPtyPack(dir, "darwin-universal").ok, true);
    assert.equal(checkPtyPack(dir, "darwin-x64").ok, true);
    const win = checkPtyPack(dir, "win32-x64");
    assert.equal(win.ok, false);
    for (const rel of PTY_PACK_FILES["win32-arm64"]) if (rel !== PTY_NODE) touch(rel);
    assert.equal(checkPtyPack(dir, "win32-arm64").ok, true);
    assert.equal(checkPtyPack(dir, "win32-x64").ok, true);
    const unknown = checkPtyPack(dir, "freebsd-x64");
    assert.equal(unknown.ok, false);
    assert.match(unknown.missing[0], /freebsd-x64/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the pack check script exits 2 without args and 1 when a helper is missing", () => {
  const usage = spawnSync(process.execPath, ["scripts/check-pty-pack.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage/);
  const dir = mkdtempSync(join(tmpdir(), "pty-pack-script-"));
  try {
    const missing = spawnSync(process.execPath, ["scripts/check-pty-pack.mjs", dir, "linux-x64"], { cwd: root, encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /pty\.node/);
    mkdirSync(join(dir, "node_modules/node-pty/build/Release"), { recursive: true });
    writeFileSync(join(dir, PTY_NODE), "x");
    const ok = spawnSync(process.execPath, ["scripts/check-pty-pack.mjs", dir, "linux-x64"], { cwd: root, encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /pty pack ok for linux-x64/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows signing runs only when DAEBOT_SIGN=1 and only for files that exist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pty-sign-"));
  const signed = [];
  const prev = process.env.DAEBOT_SIGN;
  try {
    const nodePty = join(dir, "resources", "app", "node_modules", "node-pty");
    const rel = "build/Release/conpty/OpenConsole.exe";
    mkdirSync(join(nodePty, dirname(rel)), { recursive: true });
    writeFileSync(join(nodePty, rel), "x");
    const context = {
      electronPlatformName: "win32",
      appOutDir: dir,
      packager: { signIf: async (file) => { signed.push(file); } },
    };
    delete process.env.DAEBOT_SIGN;
    await signPtyWindows(context);
    assert.deepEqual(signed, []);
    process.env.DAEBOT_SIGN = "1";
    await signPtyWindows({ ...context, electronPlatformName: "darwin" });
    assert.deepEqual(signed, []);
    await signPtyWindows(context);
    assert.equal(signed.length, 1);
    assert.ok(signed[0].endsWith(rel));
    assert.ok(PTY_WIN_SIGN_REL.includes(rel));
    assert.ok(PTY_WIN_SIGN_REL.some((p) => p.includes("prebuilds/win32-arm64/conpty/conpty.dll")));
    assert.ok(PTY_WIN_SIGN_REL.some((p) => p.endsWith("winpty-agent.exe")));
  } finally {
    if (prev === undefined) delete process.env.DAEBOT_SIGN;
    else process.env.DAEBOT_SIGN = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
