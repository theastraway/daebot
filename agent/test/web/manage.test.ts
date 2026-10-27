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
