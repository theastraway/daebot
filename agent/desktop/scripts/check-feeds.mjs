#!/usr/bin/env node
// Post-upload feed integrity check. For every file named by latest.yml, latest-arm64.yml, latest-mac.yml and latest-linux.yml it downloads
// the file the way a client would, then compares the sha512 (base64) and byte size with the feed. Any mismatch, 404 or wrong-version file
// name exits 1 with a loud banner. electron-updater rejects a sha512 mismatch, so a drifted feed means installed apps never update.
//
//   node scripts/check-feeds.mjs                       live feeds at https://download.m-i-n-d.ai/download/daebot/
//   node scripts/check-feeds.mjs --dir agent/desktop/dist   the same check against a local build folder (run before uploading)
//   --base <url>        another feed folder          --feeds latest.yml,latest-mac.yml   only some feeds
//   --expect-version X  every feed must say version X   --concurrency N (default 3)
//
// Exit 0 only when every feed's every file matches. Feeds that do not exist are a failure unless excluded with --feeds.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashFile, parseFeed } from "./feed-yml.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = (opt("--base", "https://download.m-i-n-d.ai/download/daebot/")).replace(/\/?$/, "/");
const DIR = opt("--dir") ? resolve(opt("--dir")) : null;
const FEEDS = (opt("--feeds") || "latest.yml,latest-arm64.yml,latest-mac.yml,latest-linux.yml").split(",");
const EXPECT = opt("--expect-version");
const CONC = Number(opt("--concurrency", "3"));
const where = DIR ? `local ${DIR}` : BASE;

async function readText(name) {
  if (DIR) return existsSync(`${DIR}/${name}`) ? readFileSync(`${DIR}/${name}`, "utf8") : null;
  const r = await fetch(BASE + name, { cache: "no-store", headers: { "cache-control": "no-cache" } });
  return r.ok ? await r.text() : null;
}
async function digest(name) {
  if (DIR) {
    if (!existsSync(`${DIR}/${name}`)) return { error: "file missing" };
    return await hashFile(`${DIR}/${name}`);
  }
  const r = await fetch(BASE + name, { cache: "no-store" });
  if (!r.ok) return { error: `HTTP ${r.status}` };
  const h = createHash("sha512");
  let size = 0;
  for await (const c of r.body) { h.update(c); size += c.length; }
  return { sha512: h.digest("base64"), size };
}

const problems = [];
const jobs = [];
const rows = [];
for (const feed of FEEDS) {
  const text = await readText(feed);
  if (text == null) { problems.push(`${feed}: feed not found at ${where}`); continue; }
  const f = parseFeed(text);
  if (!f.version || f.files.length === 0) { problems.push(`${feed}: unreadable (no version or files)`); continue; }
  if (EXPECT && f.version !== EXPECT) problems.push(`${feed}: version ${f.version}, expected ${EXPECT}`);
  if (f.path && !f.files.some((x) => x.url === f.path)) problems.push(`${feed}: path ${f.path} is not in files`);
  const top = f.files.find((x) => x.url === f.path);
  if (top && f.sha512 && top.sha512 !== f.sha512) problems.push(`${feed}: top-level sha512 differs from the sha512 of ${f.path}`);
  if (feed === "latest.yml" && f.files.some((x) => /arm64/i.test(x.url))) problems.push(`${feed}: the x64 feed names an arm64 file`);
  if (feed === "latest-arm64.yml" && f.files.some((x) => /x64/i.test(x.url))) problems.push(`${feed}: the arm64 feed names an x64 file`);
  for (const file of f.files) {
    if (!file.url.includes(f.version)) problems.push(`${feed}: ${file.url} does not contain feed version ${f.version}`);
    jobs.push({ feed, file, version: f.version });
  }
}

let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { feed, file } = jobs[next++];
    let d;
    try { d = await digest(file.url); } catch (e) { d = { error: String(e.message || e) }; }
    let verdict = "ok";
    if (d.error) verdict = `FAIL ${d.error}`;
    else {
      const bad = [];
      if (d.size !== file.size) bad.push(`size feed=${file.size} actual=${d.size}`);
      if (d.sha512 !== file.sha512) bad.push(`sha512 feed=${String(file.sha512).slice(0, 14)}... actual=${d.sha512.slice(0, 14)}...`);
      if (bad.length) verdict = `FAIL ${bad.join("; ")}`;
    }
    if (verdict !== "ok") problems.push(`${feed}: ${file.url}: ${verdict.slice(5)}`);
    rows.push(`  ${verdict === "ok" ? "ok  " : "FAIL"}  ${feed.padEnd(17)} ${file.url}${d.size ? `  ${d.size} bytes` : ""}${verdict === "ok" ? "" : `   <- ${verdict.slice(5)}`}`);
  }
}
console.log(`feed check: ${where}`);
await Promise.all(Array.from({ length: Math.max(1, CONC) }, worker));
for (const r of rows.sort()) console.log(r);
if (problems.length) {
  console.error("\n!!!!!!!!!!!!!!!!!!!!!!!! FEED CHECK FAILED !!!!!!!!!!!!!!!!!!!!!!!!");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Installed apps reject a feed whose sha512 or size does not match the file. Do NOT call this release live.\n");
  process.exit(1);
}
console.log(`\nFEED CHECK PASSED: ${FEEDS.length} feeds, ${jobs.length} files, every sha512 and size matches.`);
