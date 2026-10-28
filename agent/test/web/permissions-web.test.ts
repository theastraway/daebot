import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { MODE_INFO, classWord, outcomeText, ruleLine, suggestText } from "../../web/permissions.js";
// @ts-expect-error plain browser module
import { feedbackAction } from "../../web/suggest.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("card texts", () => {
  assert.equal(outcomeText("allowed"), "Allowed once");
  assert.equal(outcomeText("allowed", "Any command starting with `git status`"), "Always allowed: Any command starting with `git status`");
  assert.equal(outcomeText("denied"), "Denied");
  assert.match(outcomeText("denied", "x"), /^Always denied/);
  assert.match(outcomeText("expired"), /No answer/);
  assert.equal(classWord("irreversible"), "Cannot be undone");
  assert.match(suggestText({ effect: "deny", count: 3 }), /said no to this 3 times\. Always deny this\?/);
  assert.match(suggestText({ effect: "allow", count: 3 }), /Always allow this\?/);
  assert.equal(suggestText(undefined), "");
  assert.deepEqual(Object.keys(MODE_INFO), ["risky", "writes", "everything"]);
  assert.match(ruleLine({ effect: "deny", tool: "bash", scope: "git push*" }), /^Deny · bash · git push/);
});

test("feedback action: unchanged chip = chosen, changed = edited, none = ignored", () => {
  assert.equal(feedbackAction("Yes, send it", "Yes, send it "), "chosen");
  assert.equal(feedbackAction("Yes, send it", "Yes, send it to Mike too"), "edited");
  assert.equal(feedbackAction("", "something else"), "ignored");
  assert.equal(feedbackAction(undefined, "x"), "ignored");
});

test("the served web assets contain the permission card, the Settings > Permissions panel and the suggestion chips", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");
  const perms = read("permissions.js");
  for (const needle of ["Allow once", "Always allow…", "Always deny…", "Deny", "/decide", "Settings", "Permissions"]) assert.ok(perms.includes(needle) || read("index.html").includes(needle), needle);
  const html = read("index.html");
  assert.ok(html.includes('id="suggest"') && html.includes('id="btn-perms"'));
  const app = read("app.js");
  assert.ok(app.includes('case "permission"') && app.includes('case "permissionResolved"') && app.includes("suggest.load(") && app.includes("suggest.onSend("));
  assert.ok(read("suggest.js").includes("/suggest-feedback"));
  assert.ok(!/\binnerHTML\b/.test(perms) && !/\binnerHTML\b/.test(read("suggest.js")), "DOM is built with textContent only");
});
