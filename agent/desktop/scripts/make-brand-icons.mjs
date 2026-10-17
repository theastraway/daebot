// Builds the app icons (icon.png, icon.icns, icon.ico) from the approved Daebot mascot icon, agent/web/brand/icon-512.png.
// It never draws anything: it only resizes and packages that one file. macOS only (sips + iconutil); the outputs are committed
// to build-resources/, so CI on Windows/Linux never needs to run it. Run: node scripts/make-brand-icons.mjs
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "build-resources");
const src = join(here, "..", "..", "web", "brand", "icon-512.png");
if (process.platform !== "darwin") { console.error("make-brand-icons needs macOS (sips, iconutil); use the committed files"); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), "daebot-icons-"));
const resize = (px, to) => execFileSync("sips", ["-z", String(px), String(px), src, "--out", to], { stdio: "ignore" });
try {
  mkdirSync(out, { recursive: true });
  copyFileSync(src, join(out, "icon.png")); // 512x512 master (Linux, window icon, electron-builder fallback)

  // .icns: 16..512 at 1x and 2x where the master has the pixels (the 512@2x slot would need 1024, so it is omitted rather than upscaled).
  const set = join(work, "icon.iconset");
  mkdirSync(set);
  for (const [name, px] of [["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128], ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512]]) resize(px, join(set, `icon_${name}.png`));
  execFileSync("iconutil", ["-c", "icns", set, "-o", join(out, "icon.icns")]);

  // .ico: PNG-compressed frames (Vista+), 16..256.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map((px) => { const f = join(work, `ico-${px}.png`); resize(px, f); return readFileSync(f); });
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = Buffer.concat(sizes.map((px, i) => {
    const e = Buffer.alloc(16);
    e[0] = px === 256 ? 0 : px; e[1] = px === 256 ? 0 : px; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(frames[i].length, 8); e.writeUInt32LE(offset, 12); offset += frames[i].length;
    return e;
  }));
  writeFileSync(join(out, "icon.ico"), Buffer.concat([head, dir, ...frames]));
  console.log("wrote icon.png, icon.icns, icon.ico to", out);
} finally {
  rmSync(work, { recursive: true, force: true });
}
