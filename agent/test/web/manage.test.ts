import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { botDeleteText, sessionDeleteText, updateText } from "../../web/manage.js";

test("session delete text names the session; long titles are clipped", () => {
  assert.match(sessionDeleteText("Quarterly plan").title, /"Quarterly plan"/);
  assert.match(sessionDeleteText("").title, /Untitled/);
  assert.ok(sessionDeleteText("x".repeat(200)).title.length < 80);
});

test("bot delete text says what goes (bot, DAEBOT.md, threads, its MIND) and what stays (main MIND)", () => {
  const t = botDeleteText("Ops", 3);
  assert.match(t.title, /Ops/);
  assert.match(t.body, /3 threads/);
  assert.match(t.body, /bot's own MIND/);
  assert.match(t.body, /main MIND is not touched/);
  assert.match(botDeleteText("Ops", 1).body, /1 thread,/);
});

test("update text", () => {
  const u = updateText("1.0", "1.1");
  assert.equal(u.available, "Update available: v1.1");
  assert.equal(u.done, "Updated to v1.1");
});

// @ts-expect-error plain browser module
import { renameDecision } from "../../web/manage.js";

test("inline rename: a changed non-empty title saves; empty or unchanged reverts; whitespace and length are normalised", () => {
  assert.deepEqual(renameDecision("Old", "New name"), { save: true, title: "New name" });
  assert.deepEqual(renameDecision("Old", "  New \t name \n"), { save: true, title: "New name" });
  assert.deepEqual(renameDecision("Old", ""), { save: false, title: "Old" });
  assert.deepEqual(renameDecision("Old", "   "), { save: false, title: "Old" });
  assert.deepEqual(renameDecision("Old", "Old"), { save: false, title: "Old" });
  assert.equal(renameDecision("Old", "z".repeat(200)).title.length, 80);
});
