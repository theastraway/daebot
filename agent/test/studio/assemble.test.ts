import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleStudio, cleanDepartment, departmentSlug, needsOfRows, GENERAL_DEPT, MANAGER_DEPT, MAIN_ID, WORKING_WINDOW_MS } from "../../src/studio/index.ts";
import type { StudioInput } from "../../src/studio/index.ts";

const NOW = 1_800_000_000_000;
const row = (o: Record<string, unknown>) => ({ sessionId: "s1", sessionTitle: "Alpha", id: "t1", title: "x", status: "in_progress", updatedAt: NOW - 1000, ...o }) as any;

function base(): StudioInput {
  return {
    main: { name: "Dae", color: "#ffd25a", face: "analyst" },
    bots: [
      { id: "b_1", slug: "olivia", name: "Olivia", color: "#1a2b3c", face: "closer", department: "Talent marketing", purpose: "applications" },
      { id: "b_2", slug: "leo", name: "Leo", color: "#2a2b3c", department: " Talent   Marketing ", purpose: "research" },
      { id: "b_3", slug: "max", name: "Max", color: "bad", purpose: "dev" },
    ],
    sessions: [
      { id: "s1", title: "Alpha", updatedAt: NOW - 5000 },
      { id: "s2", title: "Olivia work", updatedAt: NOW - 2000, bot: "b_1", running: true },
      { id: "s3", title: "Leo work", updatedAt: NOW - 9000, bot: "b_2" },
      { id: "dm", title: "dm", updatedAt: NOW, bot: "b_1", peer: "b_2" },
      { id: "gone", title: "deleted bot", updatedAt: NOW, bot: "b_zzz" },
    ],
    rows: [
      row({ sessionId: "s1", id: "t1", title: "Ship the widget", status: "stopped", question: "Which colour?", lifeId: "L1" }),
      row({ sessionId: "s1", id: "t2", title: "Tests", status: "ready_to_test" }),
      row({ sessionId: "s3", id: "t1", title: "Research", status: "in_progress", bot: "b_2", updatedAt: NOW - WORKING_WINDOW_MS - 1 }),
      row({ sessionId: "s3", id: "t2", title: "Decide vendor", status: "stopped", bot: "b_2", peer: { by: "b_1" } }),
      row({ sessionId: "s2", id: "t1", title: "Backlog item", status: "not_started", bot: "b_1" }),
      row({ sessionId: "s2", id: "t1", title: "dup", status: "not_started", bot: "b_1" }),
    ],
    pending: [{ id: "p1", sessionId: "s2", tool: "bash" }, { id: "p2", sessionId: "nowhere" }],
    exchanges: [{ a: "b_1", b: "b_2", updatedAt: NOW - 10, count: 4 }, { a: "main", b: "b_1", updatedAt: NOW - 20, count: 2 }, { a: "b_3", b: "main", updatedAt: NOW - 30, count: 1 }],
    chip: { mode: "shadow", model: "qwen/qwen3.8-flash", tier: "coder" },
    now: NOW,
  };
}

test("department names clean to one line and slug to an island key; blank means General", () => {
  assert.equal(cleanDepartment("  Talent\n marketing \u0007 "), "Talent marketing");
  assert.equal(cleanDepartment("x".repeat(60)).length, 40);
  assert.equal(departmentSlug("Talent marketing"), "talent-marketing");
  assert.equal(departmentSlug("Pay & Bill!"), "pay-bill");
  assert.equal(departmentSlug("   "), GENERAL_DEPT.slug);
});

test("islands: the Manager office first, bots grouped by department (case and spacing folded), General last; counts per island", () => {
  const v = assembleStudio(base());
  assert.deepEqual(v.departments.map((d) => [d.slug, d.name, d.bots]), [
    [MANAGER_DEPT.slug, MANAGER_DEPT.name, [MAIN_ID]],
    ["talent-marketing", "Talent Marketing", ["b_2", "b_1"]], // the island is named by its first bot alphabetically (Leo typed "Talent   Marketing")
    [GENERAL_DEPT.slug, GENERAL_DEPT.name, ["b_3"]],
  ]);
  const tm = v.departments[1];
  // Leo's decision item + Olivia's permission card wait; Leo's in-progress row counts as working; Olivia's backlog row is next.
  assert.deepEqual(tm.counts, { done: 0, working: 1, next: 1, waiting: 2 });
  assert.equal(tm.needsYou, 2);
  const office = v.departments[0];
  assert.deepEqual(office.counts, { done: 1, working: 0, next: 0, waiting: 2 }); // Dae's question, plus the permission card of a session the floor does not know (it goes to the manager)
  assert.equal(office.lead, MAIN_ID);
});

test("the yellow badge: stopped rows are questions or decisions, pending permission cards count too, each attributed to its bot and island", () => {
  const v = assembleStudio(base());
  assert.deepEqual(v.needsYou.map((n) => [n.kind, n.bot, n.department, n.title]), [
    ["permission", "b_1", "talent-marketing", "Permission: bash"],
    ["permission", MAIN_ID, MANAGER_DEPT.slug, "Permission to run a tool"],
    ["question", MAIN_ID, MANAGER_DEPT.slug, "Ship the widget"],
    ["decision", "b_2", "talent-marketing", "Decide vendor"],
  ]);
  assert.equal(v.needsYou[2].question, "Which colour?");
  assert.equal(v.needsYou[2].taskId, "t1");
  assert.equal(v.needsYou[0].pendingId, "p1");
});

test("bot status: blocked beats working beats idle; working comes from a turn in flight or a fresh in-progress row", () => {
  const v = assembleStudio(base());
  const by = Object.fromEntries(v.bots.map((b) => [b.id, b]));
  assert.equal(by[MAIN_ID].status, "blocked"); // its question waits
  assert.equal(by.b_1.status, "blocked");      // the permission card
  assert.equal(by.b_2.status, "blocked");      // the decision
  assert.equal(by.b_3.status, "idle");
  const i = base();
  i.pending = []; const rows = i.rows.filter((r) => r.status !== "stopped"); i.rows = rows;
  const w = Object.fromEntries(assembleStudio(i).bots.map((b) => [b.id, b]));
  assert.equal(w.b_1.status, "working"); // running session
  assert.equal(w.b_2.status, "idle");    // its in-progress row is older than the window
  rows.push(row({ sessionId: "s3", id: "t9", title: "Fresh", status: "in_progress", bot: "b_2", updatedAt: NOW - 1 }));
  assert.equal(Object.fromEntries(assembleStudio(i).bots.map((b) => [b.id, b])).b_2.status, "working");
});

test("bots: the main Daebot first with the user's name and look, then alphabetical; a bad colour falls back; each carries its current task", () => {
  const v = assembleStudio(base());
  assert.deepEqual(v.bots.map((b) => b.id), [MAIN_ID, "b_2", "b_3", "b_1"]);
  assert.equal(v.bots[0].name, "Dae");
  assert.equal(v.bots[0].face, "analyst");
  assert.equal(v.bots.find((b) => b.id === "b_3")!.color, "#ffd25a");
  assert.deepEqual(v.bots[0].task, { id: "t1", sessionId: "s1", title: "Ship the widget", status: "stopped" });
  assert.equal(v.bots.find((b) => b.id === "b_1")!.sessions, 1); // the DM thread is not a session of its own
});

test("tasks: deduplicated, urgent first, with island, bot name and the MIND mark; the brain sums the floor", () => {
  const v = assembleStudio(base());
  assert.deepEqual(v.tasks.map((t) => [t.status, t.title, t.botName, t.department]), [
    ["stopped", "Ship the widget", "Dae", MANAGER_DEPT.slug],
    ["stopped", "Decide vendor", "Leo", "talent-marketing"],
    ["in_progress", "Research", "Leo", "talent-marketing"],
    ["not_started", "Backlog item", "Olivia", "talent-marketing"],
    ["ready_to_test", "Tests", "Dae", MANAGER_DEPT.slug],
  ]);
  assert.equal(v.tasks[0].inMind, true);
  assert.equal(v.tasks[1].peer, true);
  assert.deepEqual(v.brain, { bots: 3, sessions: 3, tasks: 5, inMind: 1, decisions: 1, working: 0, waiting: 4 });
});

test("links: bot_talk traffic folds onto island pairs, the main Daebot counts as the Manager office", () => {
  const v = assembleStudio(base());
  assert.deepEqual(v.links.map((l) => [l.a, l.b, l.count]), [
    ["talent-marketing", "talent-marketing", 4],
    ["manager-office", "talent-marketing", 2],
    ["general", "manager-office", 1],
  ]);
});

test("the chip is the router mode and the model; model text is one line", () => {
  const v = assembleStudio({ ...base(), chip: { mode: "off", model: "a/b\nc" } });
  assert.deepEqual(v.chip, { mode: "off", model: "a/b c" });
});

test("needsOfRows reads only stopped rows", () => {
  const who = () => ({ bot: "x", botName: "X", department: "d" });
  assert.equal(needsOfRows([row({ status: "in_progress" }), row({ status: "stopped" }), null as any], who).length, 1);
});
