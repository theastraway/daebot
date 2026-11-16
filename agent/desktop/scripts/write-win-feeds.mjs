#!/usr/bin/env node
// Writes the two Windows update feeds from the FINAL installers in <dist>, so a feed can never describe a different build than the file it names.
//   latest.yml        -> Daebot-Setup-<v>-x64.exe only   (Windows x64 apps, channel "latest")
//   latest-arm64.yml  -> Daebot-Setup-<v>-arm64.exe only (Windows on ARM apps, channel "latest-arm64", see src/lib/updater.mjs feedChannel)
// Why this exists (2026-11-15): electron-builder's `win.target` listed both arches, so each of the two dist:win runs rebuilt BOTH installers
// under the same file names; the second run overwrote the first run's exes, and latest.yml kept the first run's sha512. Windows x64 stayed on 0.3.46.
// Usage: node scripts/write-win-feeds.mjs [distDir] [version]     (defaults: ./dist and the version in package.json)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeed } from "./feed-yml.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] || join(here, "..", "dist"));
const version = process.argv[3] || JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;
const releaseDate = new Date().toISOString();
for (const [feed, arch] of [["latest.yml", "x64"], ["latest-arm64.yml", "arm64"]]) {
  const text = await buildFeed({ version, dir, names: [`Daebot-Setup-${version}-${arch}.exe`], releaseDate });
  writeFileSync(join(dir, feed), text);
  console.log(`wrote ${join(dir, feed)} -> Daebot-Setup-${version}-${arch}.exe`);
}
