// Compiles the Daebot gateway binary (bun build --compile, web UI embedded) for the platform being packaged and leaves it in
// desktop/build/bin/, where electron-builder picks it up as extraResources.
//   node scripts/stage-bin.mjs mac      -> daebot-darwin-arm64 + daebot-darwin-x64 (both ship in the universal app)
//   node scripts/stage-bin.mjs win      -> daebot-windows-x64.exe + daebot-windows-arm64.exe
//   node scripts/stage-bin.mjs linux    -> daebot-linux-x64
//   node scripts/stage-bin.mjs host     -> just this machine's binary
// Needs `bun` on PATH (bun.sh). bun cross-compiles every target from any host.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agent = join(here, "..", "..");
const outdir = join(here, "..", "build", "bin");
const TARGETS = {
  mac: ["bun-darwin-arm64", "bun-darwin-x64"],
  win: ["bun-windows-x64", "bun-windows-arm64"],
  linux: ["bun-linux-x64"],
};

export function targetsFor(platform) {
  if (platform === "host") {
    const os = process.platform === "win32" ? "windows" : process.platform;
    return [`bun-${os}-${process.arch}`];
  }
  return TARGETS[platform];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const targets = targetsFor(process.argv[2] ?? "host");
  if (!targets) { console.error("usage: stage-bin.mjs mac|win|linux|host"); process.exit(1); }
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });
  for (const t of targets) {
    const r = spawnSync(process.execPath, [join(agent, "scripts", "build-bin.mjs"), "--target", t, "--outdir", outdir], { stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}
