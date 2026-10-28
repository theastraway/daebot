import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { compareBuild, webUpdateText } from "../../web/webupdate.js";

test("first read becomes the running build; same build is up to date", () => {
  const a = compareBuild(null, { build: "aaaaaaaaaaaa" });
  assert.deepEqual(a, { loaded: "aaaaaaaaaaaa", latest: "aaaaaaaaaaaa", stale: false });
  assert.equal(compareBuild(a.loaded, { build: "aaaaaaaaaaaa" }).stale, false);
});

test("a different live build marks this tab stale and offers Reload", () => {
  const s = compareBuild("aaaaaaaaaaaa", { build: "bbbbbbbbbbbb" });
  assert.equal(s.stale, true);
  assert.equal(s.loaded, "aaaaaaaaaaaa");
  assert.deepEqual(webUpdateText(s), { text: "A new version of Daebot is ready", button: "Reload" });
});

test("an unreadable or buildless /health never claims an update", () => {
  assert.equal(compareBuild("aaaaaaaaaaaa", null).stale, false);
  assert.equal(compareBuild("aaaaaaaaaaaa", {}).stale, false);
  assert.equal(compareBuild(null, null).stale, false);
  assert.equal(webUpdateText(compareBuild(null, null)).text, "Daebot");
  assert.match(webUpdateText(compareBuild("3a2dedb99c91", { build: "3a2dedb99c91" })).text, /up to date \(3a2dedb\)/);
});
