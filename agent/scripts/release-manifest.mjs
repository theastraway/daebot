#!/usr/bin/env node
// Fills web/download/releases.json from a folder of built installers (size, sha256, public URL) for one version.
//   node scripts/release-manifest.mjs <artifactsDir> <version> [--base https://download.m-i-n-d.ai/daebot]
// Files are matched by the names the electron-builder config produces. A file that is not in the folder keeps an empty
// url, so its button stays on "Coming soon". Upload the files to <base>/<version>/ yourself; this script only reads them.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "web", "download", "releases.json");
const DEFAULT_BASE = "https://download.m-i-n-d.ai/daebot";

export function expectedFiles(version) {
  return {
    mac: [`Daebot-${version}-mac-universal.dmg`],
    windows: [`Daebot-Setup-${version}-x64.exe`, `Daebot-Setup-${version}-arm64.exe`],
    linux: [`Daebot-${version}-linux-x86_64.AppImage`, `Daebot-${version}-linux-amd64.deb`],
  };
}

export function fillManifest(manifest, version, dir, base = DEFAULT_BASE) {
  const names = expectedFiles(version);
  const out = structuredClone(manifest);
  out.version = version;
  for (const [key, plat] of Object.entries(out.platforms)) {
    (plat.files ?? []).forEach((f, i) => {
      f.file = names[key]?.[i] ?? f.file;
      const p = join(dir, f.file);
      if (existsSync(p)) {
        f.size = statSync(p).size;
        f.sha256 = createHash("sha256").update(readFileSync(p)).digest("hex");
        f.url = `${base.replace(/\/+$/, "")}/${version}/${f.file}`;
      } else {
        f.size = 0; f.sha256 = ""; f.url = "";
      }
    });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dir, version] = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== process.argv[process.argv.indexOf("--base") + 1]);
  const bi = process.argv.indexOf("--base");
  if (!dir || !version) { console.error("usage: release-manifest.mjs <artifactsDir> <version> [--base URL]"); process.exit(1); }
  const next = fillManifest(JSON.parse(readFileSync(MANIFEST, "utf8")), version, dir, bi >= 0 ? process.argv[bi + 1] : undefined);
  writeFileSync(MANIFEST, `${JSON.stringify(next, null, 2)}\n`);
  for (const [k, p] of Object.entries(next.platforms)) for (const f of p.files) console.log(`${k.padEnd(8)} ${f.url ? "ready      " : "coming soon"} ${f.file}`);
}
