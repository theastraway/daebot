import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { clip, dividerLabel, involves, needsDivider, otherOf, titleOf, unreadList, safeColor } from "../../web/exchanges.js";
// @ts-expect-error plain browser module
import { generalSessions } from "../../web/bots.js";

test("timestamp dividers read like the chat: Today, Yesterday, weekday, date", () => {
  const now = new Date(2026, 9, 28, 20, 0).getTime();
  assert.match(dividerLabel(new Date(2026, 9, 28, 19, 30).getTime(), now), /^Today 7:30\s?PM$/);
  assert.match(dividerLabel(new Date(2026, 9, 27, 9, 5).getTime(), now), /^Yesterday 9:05\s?AM$/);
  assert.match(dividerLabel(new Date(2026, 9, 24, 16, 10).getTime(), now), /^Sat 4:10\s?PM$/);
  assert.match(dividerLabel(new Date(2026, 8, 3, 8, 0).getTime(), now), /^Sep 3, 8:00\s?AM$/);
});

test("a divider opens the transcript and again after an hour of silence", () => {
  assert.equal(needsDivider(undefined, 5), true);
  assert.equal(needsDivider(1000, 1000 + 59 * 60000), false);
  assert.equal(needsDivider(1000, 1000 + 60 * 60000), true);
});

test("exchange helpers: the other end, title, who is involved, unread only", () => {
  const ex = { id: "e", a: { id: "main", name: "Daebot" }, b: { id: "b_1", name: "LinkedIn Voice" }, unread: 2 };
  assert.equal(otherOf(ex, "main").name, "LinkedIn Voice");
  assert.equal(otherOf(ex, "b_1").name, "Daebot");
  assert.equal(titleOf(ex), "Daebot ↔ LinkedIn Voice");
  assert.equal(involves(ex, "b_1"), true);
  assert.equal(involves(ex, "b_9"), false);
  assert.deepEqual(unreadList([ex, { ...ex, id: "f", unread: 0 }]).map((x: any) => x.id), ["e"]);
  assert.equal(clip("a\n  b   c", 20), "a b c");
  assert.equal(clip("x".repeat(50), 10).length, 10);
  assert.equal(safeColor("javascript:alert(1)"), "#ffd25a");
});

test("agent-to-agent DM threads never appear in the plain Sessions list", () => {
  assert.deepEqual(generalSessions([{ id: "1" }, { id: "2", bot: "b" }, { id: "3", peer: "b" }]).map((s: any) => s.id), ["1"]);
});
