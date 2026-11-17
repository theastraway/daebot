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

// @ts-expect-error plain browser module
import { EXAMPLES, LOUNGE_LINES, ROOMS, loungeLine, mergeLog, progressPct, walks } from "../../web/studio.js";

test("Studio 2 to 4: seven rooms, example prompts, and a lounge line that is stable within the hour and varies across bots", () => {
  assert.deepEqual(ROOMS.map((r: any) => r[0]), ["overview", "office", "meeting", "lounge", "workspaces", "team", "pipelines"]);
  assert.ok(EXAMPLES.length >= 3);
  assert.equal(loungeLine("b_1", 9), loungeLine("b_1", 9));
  assert.ok(LOUNGE_LINES.includes(loungeLine("b_1", 9)));
  const lines = new Set(["b_1", "b_2", "b_3", "b_4", "b_5", "b_6"].map((id) => loungeLine(id, 9)));
  assert.ok(lines.size >= 3, "different bots get different lines");
});

test("walks: an island pair gets a walking dot only when its link moved since the previous view", () => {
  const prev = { links: [{ a: "x", b: "y", at: 10 }, { a: "x", b: "z", at: 10 }] };
  const next = { links: [{ a: "x", b: "y", at: 20 }, { a: "x", b: "z", at: 10 }, { a: "q", b: "r", at: 5 }, { a: "s", b: "s", at: 99 }] };
  assert.deepEqual(walks(prev, next), [{ a: "x", b: "y" }]);
  assert.deepEqual(walks(null, next), []);
});

test("the communication log merges exchanges newest first with who spoke to whom; project progress is done over total", () => {
  const exs = [
    { id: "x1", a: { id: "main", name: "Dae", color: "#ffd25a" }, b: { id: "b_1", name: "Olivia", color: "#1a2b3c" }, messages: [{ id: "m1", from: "main", text: "Do it", at: 1, kind: "message" }, { id: "m2", from: "b_1", text: "Done", at: 3, kind: "reply" }] },
    { id: "x2", a: { id: "b_1", name: "Olivia" }, b: { id: "b_2", name: "Leo" }, messages: [{ id: "m1", from: "b_2", text: "Hi", at: 2, kind: "message" }, { bad: true }] },
    null,
  ];
  assert.deepEqual(mergeLog(exs).map((m: any) => [m.from, m.to, m.text, m.kind]), [["Olivia", "Dae", "Done", "reply"], ["Leo", "Olivia", "Hi", "message"], ["Dae", "Olivia", "Do it", "message"]]);
  assert.equal(mergeLog(exs, 1).length, 1);
  assert.equal(progressPct({ total: 4, done: 1 }), 25);
  assert.equal(progressPct({ total: 0, done: 0 }), 0);
});

// @ts-expect-error plain browser module
import { TIER_ROLES, fmtUsd, savingText, teamShares } from "../../web/studio.js";

test("Studio 3: tier shares of the turns, largest first; the saving line against the all-frontier counterfactual", () => {
  const s = { turns: 10, costUsd: 1.5, frontierUsd: 9, known: 10, byTier: { coder: { turns: 6, costUsd: 1, tokensIn: 10, tokensOut: 5, verified: 5 }, frontier: { turns: 1, costUsd: 0.4, tokensIn: 1, tokensOut: 1, verified: 1 }, light: { turns: 3, costUsd: 0.1, tokensIn: 0, tokensOut: 0, verified: 3 }, local: { turns: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, verified: 0 } } };
  assert.deepEqual(teamShares(s).map((x: any) => [x.tier, x.share]), [["coder", 60], ["light", 30], ["frontier", 10]]);
  assert.deepEqual(teamShares(undefined), []);
  assert.equal(savingText(s), "$1.50 spent vs $9.00 all-frontier (83% saved)");
  assert.equal(savingText({ known: 0 }), "No priced turns yet.");
  assert.equal(fmtUsd(0.001), "$0.0010");
  assert.equal(TIER_ROLES.frontier, "advisor");
});

// @ts-expect-error plain browser module
import { STAGE_MARK, countersLine, fmtNum, stageMarks } from "../../web/studio.js";

test("Studio 4: stage marks and the counters line on the island card", () => {
  assert.equal(stageMarks(["done", "running", "todo", "failed"]), "✓◐○✗");
  assert.equal(stageMarks(undefined), "");
  assert.equal(STAGE_MARK.done, "✓");
  assert.equal(countersLine([{ name: "applications", value: 389 }, { name: "docs live", value: 8 }, { name: "big", value: 1234567 }, { name: "fourth", value: 1 }]), "applications 389 · docs live 8 · big 1.2M");
  assert.equal(fmtNum(12345), "12.3k"); assert.equal(fmtNum(8.456), "8.46"); assert.equal(fmtNum("x"), "–");
});

import { readFileSync } from "node:fs";
// @ts-expect-error plain browser module
import { PILLS, deskGrid, dueText, hotIsland, iso, palOf, pillCounts, taskPill, worldBounds, brainNodes } from "../../web/studio.js";

test("style.css is balanced: an unclosed block once swallowed every Studio rule above 760px (the unstyled Studio of 11/16)", () => {
  const css = readFileSync(new URL("../../web/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0, min = 0;
  for (const ch of css) { if (ch === "{") depth++; else if (ch === "}") depth--; min = Math.min(min, depth); }
  assert.equal(depth, 0); assert.equal(min, 0);
  // The office rules sit at the top level, not inside a media query.
  const at = css.indexOf(".oc-top {");
  const before = css.slice(0, at);
  let d = 0; for (const ch of before) { if (ch === "{") d++; else if (ch === "}") d--; }
  assert.equal(d, 0, ".oc-top must not be nested in an @media block");
});

test("Studio 5: the office geometry, task pills, filter counts and the glowing card", () => {
  assert.deepEqual(iso(1, 0), { x: 250, y: 146 });
  assert.equal(palOf("nope"), palOf("indigo"));
  assert.equal(deskGrid(0).slots.length, 0);
  const g30 = deskGrid(30); assert.equal(g30.slots.length, 30); assert.ok(g30.scale < deskGrid(3).scale, "a crowded island draws smaller desks");
  const one = worldBounds([]); assert.ok(one.w >= 900 && one.h >= 560, "one island never fills the screen");
  const wide = worldBounds([{ u: -2, v: 2 }, { u: 2, v: -2 }]); assert.ok(wide.w > one.w);
  assert.deepEqual(taskPill({ status: "in_progress", progress: 42 }), { text: "42%", cls: "run" });
  assert.equal(taskPill({ status: "stopped" }).text, "WAIT");
  assert.equal(taskPill({ status: "ready_to_test" }).text, "DONE");
  const c = pillCounts({ tasks: [{ status: "stopped" }, { status: "in_progress" }, { status: "cancelled" }], scheduled: [{}] });
  assert.deepEqual(c, { all: 2, scheduled: 1, not_started: 0, in_progress: 1, waiting: 1, ready_to_test: 0 });
  assert.equal(PILLS.length, 6);
  assert.equal(hotIsland([{ slug: "a", counts: { working: 1 } }, { slug: "b", counts: { working: 3 } }]), "b");
  assert.equal(hotIsland([{ slug: "a", counts: { working: 0 } }]), "manager-office");
  assert.equal(dueText(Date.now() + 3 * 3600000), "in 3h");
  assert.deepEqual(brainNodes(10), brainNodes(10), "the Brain's graph is the same every paint");
});

// @ts-expect-error plain browser module
import { placeCards, tagText } from "../../web/studio.js";

test("Studio 5: island cards never collide, even when every island wants the same spot; name tags fit the room between desks", () => {
  // Five islands in a tight cluster (the 1440 layout where Compliance sat on the Manager office card), cards 150x110.
  const isl = (id: string, cx: number, cy: number, wx: number, wy: number) => ({ id, cx, cy, top: cy - 40, bottom: cy + 50, left: cx - 80, right: cx + 80, w: 150, h: 110, side: wy < 0 ? "above" : wy > 0 ? "below" : wx >= 0 ? "right" : "left", wx, wy });
  const items = [isl("manager", 530, 320, 0, -292), isl("compliance", 655, 400, 250, -146), isl("general", 225, 490, -500, 0), isl("sales", 838, 490, 500, 0), isl("finance", 530, 660, 0, 292)];
  const pill = { x: 440, y: 400, w: 190, h: 24 };
  const spots = placeCards(items, [pill], [], { w: 1060, h: 840 });
  const rects = items.map((it) => ({ x: spots[it.id].x, y: spots[it.id].y, w: it.w, h: it.h }));
  const hit = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let i = 0; i < rects.length; i++) { assert.ok(!hit(rects[i], pill), `${items[i].id} sits on the Brain label`); for (let j = i + 1; j < rects.length; j++) assert.ok(!hit(rects[i], rects[j]), `${items[i].id} collides with ${items[j].id}`); }
  assert.equal(spots.manager.side, "above", "the top island keeps its card above it");
  assert.equal(spots.finance.side, "below", "the bottom island keeps its card below it");
  const t = tagText("Atlas Adjustment Ontologist", 0.6, 62);
  assert.ok(t.text.endsWith("…") && t.w <= 62, "a long name is clipped to the room between desks");
  assert.equal(tagText("Kai", 1, 200).text, "Kai");
});
