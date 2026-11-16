// node --test scripts/check-feeds.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const run = (script, ...a) => spawnSync(process.execPath, [join(here, script), ...a], { encoding: "utf8" });

function fakeDist(v = "9.9.9") {
  const d = mkdtempSync(join(tmpdir(), "feeds-"));
  writeFileSync(join(d, `Daebot-Setup-${v}-x64.exe`), "x64 build");
  writeFileSync(join(d, `Daebot-Setup-${v}-arm64.exe`), "arm64 build");
  return d;
}

test("write-win-feeds: x64 feed names only the x64 exe, arm64 feed only the arm64 exe; check passes", () => {
  const d = fakeDist();
  assert.equal(run("write-win-feeds.mjs", d, "9.9.9").status, 0);
  assert.match(readFileSync(join(d, "latest.yml"), "utf8"), /url: Daebot-Setup-9\.9\.9-x64\.exe/);
  assert.doesNotMatch(readFileSync(join(d, "latest.yml"), "utf8"), /arm64/);
  assert.doesNotMatch(readFileSync(join(d, "latest-arm64.yml"), "utf8"), /x64/);
  const r = run("check-feeds.mjs", "--dir", d, "--feeds", "latest.yml,latest-arm64.yml", "--expect-version", "9.9.9");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /FEED CHECK PASSED/);
});

test("check-feeds fails loudly when an installer is overwritten after the feed was written (the 0.3.48 bug)", () => {
  const d = fakeDist();
  run("write-win-feeds.mjs", d, "9.9.9");
  writeFileSync(join(d, "Daebot-Setup-9.9.9-x64.exe"), "a DIFFERENT rebuild");
  const r = run("check-feeds.mjs", "--dir", d, "--feeds", "latest.yml");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FEED CHECK FAILED/);
  assert.match(r.stderr, /sha512/);
});

test("check-feeds fails when a feed names a file that is missing, or the wrong version", () => {
  const d = fakeDist();
  run("write-win-feeds.mjs", d, "9.9.9");
  assert.equal(run("check-feeds.mjs", "--dir", d, "--feeds", "latest-mac.yml").status, 1);
  assert.equal(run("check-feeds.mjs", "--dir", d, "--feeds", "latest.yml", "--expect-version", "9.9.8").status, 1);
});
