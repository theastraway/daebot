// Tiny reader/writer for the flat electron-updater feed format (latest*.yml). No dependencies, so the release scripts run on a fresh checkout.
import { createHash } from "node:crypto";
import { createReadStream, statSync, existsSync } from "node:fs";

/** Parse `version`, `files: [{url, sha512, size, blockMapSize}]`, `path`, `sha512`, `releaseDate` from a feed file. */
export function parseFeed(text) {
  const out = { version: null, files: [], path: null, sha512: null, releaseDate: null };
  let cur = null;
  const val = (s) => s.trim().replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let m;
    if ((m = raw.match(/^  - url:\s*(.+)$/))) { cur = { url: val(m[1]) }; out.files.push(cur); continue; }
    if ((m = raw.match(/^    (sha512|size|blockMapSize):\s*(.+)$/)) && cur) { cur[m[1]] = m[1] === "sha512" ? val(m[2]) : Number(val(m[2])); continue; }
    if ((m = raw.match(/^(version|path|sha512|releaseDate):\s*(.+)$/))) { out[m[1]] = val(m[2]); cur = null; continue; }
    if (/^files:\s*$/.test(raw)) { cur = null; continue; }
  }
  return out;
}

/** sha512 (base64, as electron-updater expects) and byte size of a local file. */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha512");
    let size = 0;
    createReadStream(file).on("data", (c) => { h.update(c); size += c.length; }).on("error", reject).on("end", () => resolve({ sha512: h.digest("base64"), size }));
  });
}

/** Feed text in the exact shape electron-builder writes, built from FINAL files on disk (never from a build's intermediate output). */
export async function buildFeed({ version, dir, names, releaseDate = new Date().toISOString() }) {
  const files = [];
  for (const name of names) {
    if (!existsSync(`${dir}/${name}`)) throw new Error(`missing ${dir}/${name}`);
    const { sha512, size } = await hashFile(`${dir}/${name}`);
    const bm = existsSync(`${dir}/${name}.blockmap`) ? statSync(`${dir}/${name}.blockmap`).size : null;
    files.push({ url: name, sha512, size, blockMapSize: bm });
  }
  const lines = [`version: ${version}`, "files:"];
  for (const f of files) {
    lines.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
    if (f.blockMapSize) lines.push(`    blockMapSize: ${f.blockMapSize}`);
  }
  lines.push(`path: ${files[0].url}`, `sha512: ${files[0].sha512}`, `releaseDate: '${releaseDate}'`, "");
  return lines.join("\n");
}
