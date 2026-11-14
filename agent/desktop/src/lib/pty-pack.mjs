// What a packed desktop app must contain for node-pty, and the electron-builder fields that put it there.
// asar is false today. The unpack glob is set anyway so turning asar on later still extracts the native module.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PTY_NODE = "node_modules/node-pty/build/Release/pty.node";
export const PTY_SPAWN_HELPER = "node_modules/node-pty/build/Release/spawn-helper";

const WIN_HELPERS = [
  "node_modules/node-pty/build/Release/conpty/conpty.dll",
  "node_modules/node-pty/build/Release/conpty/OpenConsole.exe",
  "node_modules/node-pty/build/Release/winpty.dll",
  "node_modules/node-pty/build/Release/winpty-agent.exe",
];

/** Relative to the packed app directory (resources/app when asar is false). */
export const PTY_PACK_FILES = {
  "linux-x64": [PTY_NODE],
  "darwin-x64": [PTY_NODE, PTY_SPAWN_HELPER],
  "darwin-arm64": [PTY_NODE, PTY_SPAWN_HELPER],
  "darwin-universal": [PTY_NODE, PTY_SPAWN_HELPER],
  "win32-x64": [PTY_NODE, ...WIN_HELPERS],
  "win32-arm64": [PTY_NODE, ...WIN_HELPERS],
};

/**
 * @param {string} appDir packed resources/app (or a fixture laid out the same way)
 * @param {string} target one of the PTY_PACK_FILES keys
 * @param {(p: string) => boolean} [exists]
 */
export function checkPtyPack(appDir, target, exists = existsSync) {
  const rels = PTY_PACK_FILES[target];
  if (!rels) return { ok: false, missing: [`unknown target ${target}`] };
  const missing = [];
  for (const rel of rels) {
    if (exists(join(appDir, rel))) continue;
    // A Windows pack cross-built from a Mac or Linux cannot compile node-pty, so it ships the package's own prebuilds/<target>/ files;
    // node-pty's loader falls back to them when build/Release is absent.
    if (target.startsWith("win32-") && exists(join(appDir, rel.replace("build/Release", `prebuilds/${target}`)))) continue;
    missing.push(rel);
  }
  return { ok: missing.length === 0, missing };
}

/** Paths inside the .app that codesign must cover. asar false uses Resources/app. */
export function macPtyBinaries(asar) {
  const root = asar ? "Contents/Resources/app.asar.unpacked" : "Contents/Resources/app";
  return [`${root}/node_modules/node-pty/build/Release/spawn-helper`];
}

// Identical Mach-O copies of node-pty's prebuilds sit in both halves of a universal app.
// x64ArchFiles keeps them as the x64 file instead of failing the lipo merge. build/Release differs per arch and is merged.
export const PTY_X64_ARCH_FILES = "{Contents/Resources/bin/*,**/node-pty/prebuilds/**}";
export const PTY_ASAR_UNPACK = ["**/node_modules/node-pty/**"];
export const PTY_WIN_SIGN_EXTS = [".exe", ".dll", ".node"];

/** Relative to node_modules/node-pty. Both arches, build output and the prebuilds the package ships. */
export const PTY_WIN_SIGN_REL = [
  "build/Release/pty.node",
  "build/Release/conpty.node",
  "build/Release/conpty_console_list.node",
  "build/Release/winpty.dll",
  "build/Release/winpty-agent.exe",
  "build/Release/conpty/conpty.dll",
  "build/Release/conpty/OpenConsole.exe",
  "prebuilds/win32-x64/pty.node",
  "prebuilds/win32-x64/conpty.node",
  "prebuilds/win32-x64/winpty.dll",
  "prebuilds/win32-x64/winpty-agent.exe",
  "prebuilds/win32-x64/conpty/conpty.dll",
  "prebuilds/win32-x64/conpty/OpenConsole.exe",
  "prebuilds/win32-arm64/pty.node",
  "prebuilds/win32-arm64/conpty.node",
  "prebuilds/win32-arm64/winpty.dll",
  "prebuilds/win32-arm64/winpty-agent.exe",
  "prebuilds/win32-arm64/conpty/conpty.dll",
  "prebuilds/win32-arm64/conpty/OpenConsole.exe",
];
