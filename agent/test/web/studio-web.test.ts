import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain browser module
import { badgeText, deskSlots, filterTasks, isoPoints, islandOf, layoutIslands, safeColor, FILTERS, LIGHT, VIEW_W, VIEW_H } from "../../web/studio.js";
// @ts-expect-error plain browser module
import { nextView, viewOf } from "../../web/bots.js";

test("the yellow badge reads like the office screenshot: N waiting approval", () => {
  assert.equal(badgeText(1), "1 waiting approval");
  assert.equal(badgeText(3), "3 waiting approval");
});

test("islands: one sits at the top; several ring the brain clockwise starting at the top, all inside the view", () => {
  assert.deepEqual(layoutIslands(0), []);
  const one = layoutIslands(1);
  assert.equal(one.length, 1);
  assert.equal(one[0].x, VIEW_W / 2);
  const four = layoutIslands(4);
  assert.equal(four.length, 4);
  assert.ok(four[0].y < four[2].y, "the first island is above the third");
  assert.ok(four[1].x > four[3].x, "the second island is right of the fourth");
  for (const p of layoutIslands(9)) { assert.ok(p.x > 0 && p.x < VIEW_W); assert.ok(p.y > 0 && p.y < VIEW_H); }
});

test("an isometric top face is a rhombus around its centre; desks sit inside the face in a near-square grid", () => {
  assert.equal(isoPoints(100, 50, 40, 20), "100,40 120,50 100,60 80,50");
  assert.deepEqual(deskSlots(0, 0, 0, 200, 100), []);
  const one = deskSlots(1, 0, 0, 200, 100);
  assert.deepEqual(one, [{ x: 0, y: 0 }]);
  const five: { x: number; y: number }[] = deskSlots(5, 0, 0, 250, 125);
  assert.equal(five.length, 5);
  for (const s of five) { assert.ok(Math.abs(s.x) / 125 + Math.abs(s.y) / 62.5 <= 1.001, `desk ${JSON.stringify(s)} is on the slab`); }
  assert.equal(new Set(five.map((s) => `${s.x},${s.y}`)).size, 5, "no two desks share a spot");
});

test("the task filters: waiting is the red rows, each status its own, All keeps cancelled rows; bad rows are dropped", () => {
  const tasks = [
    { title: "a", status: "stopped" }, { title: "b", status: "in_progress" }, { title: "c", status: "not_started" },
    { title: "d", status: "ready_to_test" }, { title: "e", status: "cancelled" }, null, { status: "stopped" },
  ];
  assert.deepEqual(filterTasks(tasks, "all").map((t: any) => t.title), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(filterTasks(tasks, "waiting").map((t: any) => t.title), ["a"]);
  assert.deepEqual(filterTasks(tasks, "in_progress").map((t: any) => t.title), ["b"]);
  assert.deepEqual(filterTasks(tasks, "ready_to_test").map((t: any) => t.title), ["d"]);
  assert.deepEqual(filterTasks(undefined, "all"), []);
  assert.deepEqual(FILTERS.map((f: any) => f[0]), ["all", "waiting", "in_progress", "not_started", "ready_to_test"]);
  assert.deepEqual(LIGHT, { not_started: "red", in_progress: "yellow", ready_to_test: "green", stopped: "red", cancelled: "grey" });
});

test("a bot's island is found by id; unknown bots fall back to the Manager office; colours fall back to the LED yellow", () => {
  const view = { departments: [{ slug: "manager-office", bots: ["main"] }, { slug: "sales", bots: ["b_1"] }] };
  assert.equal(islandOf(view, "b_1"), "sales");
  assert.equal(islandOf(view, "nope"), "manager-office");
  assert.equal(islandOf(undefined, "x"), "manager-office");
  assert.equal(safeColor("#1A2B3C"), "#1A2B3C");
  assert.equal(safeColor("red"), "#ffd25a");
});

test("the sidebar remembers three views and the arrow keys cycle through them, skipping the Studio when its tab is absent", () => {
  assert.equal(viewOf("studio"), "studio");
  assert.equal(viewOf("bots"), "bots");
  assert.equal(viewOf("nonsense"), "sessions");
  assert.equal(nextView("sessions", 1, true), "bots");
  assert.equal(nextView("bots", 1, true), "studio");
  assert.equal(nextView("studio", 1, true), "sessions");
  assert.equal(nextView("sessions", -1, true), "studio");
  assert.equal(nextView("bots", 1, false), "sessions");
  assert.equal(nextView("garbage", 1, false), "bots");
});
