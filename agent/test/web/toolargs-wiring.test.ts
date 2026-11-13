import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");

test("app.js takes argSummary from the module instead of keeping its own copy", () => {
  const app = read("app.js");
  assert.ok(app.includes('import { argSummary } from "/toolargs.js"'), "app.js imports the module");
  assert.equal(/function argSummary\s*\(/.test(app), false, "no local redefinition shadowing it");
  assert.ok(app.includes('h("span", "tool-args", argSummary(it.args))'), "the tool row still calls it");
});

test("the build collects web/ wholesale, so a new module ships without a manifest edit", () => {
  const build = readFileSync(fileURLToPath(new URL("../../scripts/build-bin.mjs", import.meta.url)), "utf8");
  assert.ok(/walk\(webDir\)/.test(build), "collectSite walks the whole web/ tree");
  assert.equal(/toolargs/.test(build), false, "and no per-file list has to name it");
});

test("the argument summary is the module's, and it marks a break instead of hiding it", () => {
  const src = read("toolargs.js");
  assert.ok(src.includes("BREAK_MARK"), "the module has a break marker");
  assert.ok(/replace\(\/ \*\\n \*\/g, BREAK_MARK\)/.test(src), "a newline becomes the marker");
  assert.ok(
    !/return s\.replace\(\/\\s\+\/g, " "\)/.test(src),
    "it never flattens a newline into a bare space",
  );
  // Other modules may still collapse whitespace for titles and previews; that is a different job.
  const app = read("app.js");
  assert.equal(/function argSummary\s*\(/.test(app), false, "app.js has no second implementation");
});
