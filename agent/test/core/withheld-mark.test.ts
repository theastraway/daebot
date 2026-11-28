import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WITHHELD_MARK, stripWithheldMarks } from "../../src/loop.ts";

test("the receipt gate's withheld marker never reaches the user (server final text and the web view)", () => {
  const copied = `${WITHHELD_MARK}\n${WITHHELD_MARK}\nHere is the paragraph.\n\nMIND is premium.`;
  assert.equal(stripWithheldMarks(copied), "Here is the paragraph.\n\nMIND is premium.");
  assert.equal(stripWithheldMarks("plain"), "plain");
  const app = readFileSync(join(import.meta.dirname, "..", "..", "web", "app.js"), "utf8");
  assert.ok(app.includes(`const WITHHELD_MARK = "${WITHHELD_MARK}"`), "web strips the same marker");
  assert.match(app, /renderMarkdown\(shownText\(it\.text\)\)/);
});
