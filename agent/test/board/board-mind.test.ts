import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskBoardTool, loadTasks, resumeStopped, BOARD_PROMPT, DECISION_PROMPT } from "../../src/board/board.ts";
import type { BoardMind, BoardTask, ProjectLite } from "../../src/board/board.ts";
import { boardStatusOf, createBoardMind, lifeStatusOf, scopeOfNames } from "../../src/board/mind.ts";
import { checkDecision, createTaskDecisionTool } from "../../src/board/decision.ts";
import type { MindClient } from "../../src/types.ts";

/** An in-memory MIND: a few LIFE projects, items, and a log of every call. */
function fakeMind(projects: ProjectLite[] = [
  { id: "p-astra", name: "Atlas Monitor", focus: "Astra AI", scope: "astra" },
  { id: "p-mind", name: "Daebot", focus: "MIND", scope: "mind" },
]) {
  const log: string[] = [];
  const items = new Map<string, { status: string; title: string; cancelled?: boolean }>();
  const m: BoardMind & { log: string[]; items: typeof items; down?: boolean; removeFails?: boolean; projects_: ProjectLite[] } = {
    log, items, projects_: projects,
    async projects() { if (m.down) throw new Error("MIND life: HTTP 503"); return m.projects_; },
    async ensureProject(name, scope) { log.push(`ensure ${name} ${scope}`); const p: ProjectLite = { id: "p-new", name, scope, focus: scope === "astra" ? "Astra AI" : "MIND" }; m.projects_.push(p); return p; },
    async create(t) { if (m.down) throw new Error("MIND life: HTTP 503"); const id = `L${items.size + 1}`; items.set(id, { status: lifeStatusOf(t.status), title: t.title }); log.push(`create ${t.title} under ${t.project?.id}`); return { lifeId: id, lifeStatus: lifeStatusOf(t.status) }; },
    async push(t) { const it = items.get(t.lifeId!)!; it.status = lifeStatusOf(t.status); it.title = t.title; log.push(`push ${t.id} ${it.status}`); return it.status; },
    async cancel(t) { const it = items.get(t.lifeId!)!; it.status = "thought"; it.cancelled = true; log.push(`cancel ${t.id}`); return "thought"; },
    async remove(t) { if (m.removeFails) throw new Error("MIND life: HTTP 500 boom"); items.delete(t.lifeId!); log.push(`remove ${t.id}`); },
    async pull() { return new Map([...items].map(([k, v]) => [k, v.status])); },
    async saveDecision(title) { log.push(`decision ${title}`); return { id: "doc-" + (log.length) }; },
  };
  return m;
}

function rig(mind: BoardMind | null = fakeMind()) {
  const boards = new Map<string, BoardTask[]>();
  const io = { get: (s: string) => boards.get(s) ?? [], set: (s: string, t: BoardTask[]) => { boards.set(s, t); } };
  const tool = createTaskBoardTool({ ...io, ...(mind ? { mind } : {}) });
  const run = (args: Record<string, unknown>) => tool.run(args, { cwd: "/", sessionId: "s1" });
  return { boards, io, tool, run, mind };
}

test("a new task must name its MIND LIFE project: without one the call is refused and lists the user's real projects", async () => {
  const { run, boards } = rig();
  const r = await run({ action: "update", id: "t1", title: "Fix the sync", status: "in_progress" });
  assert.equal(r.ok, false);
  assert.match(r.output, /Atlas Monitor/);
  assert.match(r.output, /scope Astra AI/);
  assert.match(r.output, /Daebot/);
  assert.equal(boards.has("s1"), false, "nothing was declared");
});

test("a task declared with a project is linked: scope comes from the project's Focus, a LIFE item is created, and the card carries both", async () => {
  const mind = fakeMind();
  const { run, boards } = rig(mind);
  const r = await run({ action: "update", id: "t1", title: "Fix the sync", status: "in_progress", project: "atlas monitor" });
  assert.equal(r.ok, true, r.output);
  const t = boards.get("s1")![0];
  assert.equal(t.scope, "astra");
  assert.deepEqual(t.project, { id: "p-astra", name: "Atlas Monitor", focus: "Astra AI" });
  assert.equal(t.lifeId, "L1");
  assert.equal(t.lifeStatus, "active_mind");
  assert.deepEqual(mind.log, ["create Fix the sync under p-astra"]);
  const byId = rig(fakeMind());
  assert.equal((await byId.run({ action: "update", id: "t2", title: "x", status: "not_started", project: "p-mind" })).ok, true);
  assert.equal(byId.boards.get("s1")![0].scope, "mind");
  const bad = await byId.run({ action: "update", id: "t3", title: "x", status: "not_started", project: "No Such Project" });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /no LIFE project/);
});

test("new_project needs a scope and is created under the matching Focus; the model cannot invent a scope for an existing project", async () => {
  const mind = fakeMind([]);
  const { run, boards } = rig(mind);
  assert.equal((await run({ action: "update", id: "t1", title: "x", status: "not_started", new_project: "Reframe launch" })).ok, false);
  const r = await run({ action: "update", id: "t1", title: "x", status: "not_started", new_project: "Reframe launch", scope: "astra" });
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(mind.log.slice(0, 2), ["ensure Reframe launch astra", "create x under p-new"]);
  assert.equal(boards.get("s1")![0].scope, "astra");
  // an existing project keeps ITS scope even if the model passes another one
  const m2 = rig(fakeMind());
  await m2.run({ action: "update", id: "a", title: "x", status: "not_started", project: "Daebot", scope: "astra" });
  assert.equal(m2.boards.get("s1")![0].scope, "mind");
});

test("status changes and title changes are pushed to the LIFE item; a no-op update pushes nothing", async () => {
  const mind = fakeMind();
  const { run } = rig(mind);
  await run({ action: "update", id: "t1", title: "A", status: "not_started", project: "Daebot" });
  await run({ action: "update", id: "t1", status: "in_progress" });
  await run({ action: "update", id: "t1", status: "in_progress" });
  await run({ action: "update", id: "t1", status: "stopped", question: "Which one?" });
  await run({ action: "update", id: "t1", status: "ready_to_test" });
  assert.deepEqual(mind.log.filter((l) => l.startsWith("push")), ["push t1 active_mind", "push t1 action", "push t1 action"]);
});

test("cancel keeps the card as cancelled and tags the LIFE item; a cancelled task cannot be restarted or edited by the model", async () => {
  const mind = fakeMind();
  const { run, boards } = rig(mind);
  await run({ action: "update", id: "t1", title: "A", status: "in_progress", project: "Daebot" });
  const r = await run({ action: "cancel", id: "t1" });
  assert.equal(r.ok, true, r.output);
  const t = boards.get("s1")![0];
  assert.equal(t.status, "cancelled");
  assert.equal(t.lifeStatus, "thought");
  assert.equal(mind.items.get("L1")!.cancelled, true);
  assert.equal(boards.get("s1")!.length, 1, "kept in history");
  assert.equal((await run({ action: "update", id: "t1", status: "in_progress" })).ok, false);
  assert.equal((await run({ action: "set", tasks: [{ id: "t1", title: "A", status: "in_progress" }] })).ok, false, "set cannot restart it either");
  assert.equal((await run({ action: "update", id: "t9", title: "B", status: "cancelled", project: "Daebot" })).ok, false, "cancelled is not a status the model sets by hand");
  assert.equal((await run({ action: "cancel", id: "nope" })).ok, false);
});

test("delete removes the card AND the LIFE item; if MIND refuses, the card stays so nothing is half removed", async () => {
  const mind = fakeMind();
  const { run, boards } = rig(mind);
  await run({ action: "update", id: "t1", title: "A", status: "in_progress", project: "Daebot" });
  await run({ action: "update", id: "t2", title: "B", status: "in_progress", project: "Daebot" });
  mind.removeFails = true;
  const bad = await run({ action: "delete", id: "t1" });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /still on the board/);
  assert.equal(boards.get("s1")!.length, 2);
  mind.removeFails = false;
  assert.equal((await run({ action: "delete", id: "t1" })).ok, true);
  assert.deepEqual(boards.get("s1")!.map((t) => t.id), ["t2"]);
  assert.equal(mind.items.size, 1);
});

test("a MIND outage never blocks the work: the task is declared with a plain 'Not saved to MIND' note", async () => {
  const mind = fakeMind();
  mind.down = true;
  const { run, boards } = rig(mind);
  const r = await run({ action: "update", id: "t1", title: "A", status: "in_progress", project: "Daebot" });
  assert.equal(r.ok, true, r.output);
  const t = boards.get("s1")![0];
  assert.match(t.sync ?? "", /^Not saved to MIND/);
  assert.equal(t.lifeId, undefined);
  // when MIND is back, the next update with the project links it
  mind.down = false;
  await run({ action: "update", id: "t1", status: "in_progress", project: "Daebot" });
  const t2 = boards.get("s1")![0];
  assert.equal(t2.lifeId, "L1");
  assert.equal(t2.sync, undefined);
});

test("projects action lists the user's LIFE projects; set links new tasks and keeps linked tasks it leaves out", async () => {
  const { run, boards } = rig();
  const p = await run({ action: "projects" });
  assert.match(p.output, /Atlas Monitor \[id p-astra\] scope Astra AI, focus Astra AI/);
  const r = await run({ action: "set", tasks: [{ id: "a", title: "A", status: "in_progress", project: "Daebot" }, { id: "b", title: "B", status: "not_started", project: "Atlas Monitor" }] });
  assert.equal(r.ok, true, r.output);
  assert.deepEqual(boards.get("s1")!.map((t) => [t.id, t.scope]), [["a", "mind"], ["b", "astra"]]);
  const r2 = await run({ action: "set", tasks: [{ id: "a", title: "A", status: "ready_to_test" }] });
  assert.equal(r2.ok, true, r2.output);
  assert.deepEqual(boards.get("s1")!.map((t) => t.id), ["a", "b"], "b is linked to MIND, so a rewrite does not drop it");
  assert.match(r2.output, /use action delete/);
});

test("without MIND the board still works on its own (no project needed)", async () => {
  const { run, boards } = rig(null);
  assert.equal((await run({ action: "update", id: "t1", title: "A", status: "in_progress" })).ok, true);
  assert.equal(boards.get("s1")![0].scope, undefined);
  assert.equal((await run({ action: "cancel", id: "t1" })).ok, true);
  assert.equal((await run({ action: "delete", id: "t1" })).ok, true);
  assert.deepEqual(boards.get("s1"), []);
});

test("the MIND link survives a restart (loadTasks) and a reply that resumes a stopped task", () => {
  const linked = { id: "a", title: "A", status: "stopped", question: "q?", updatedAt: 5, scope: "astra", project: { id: "p", name: "P", focus: "Astra AI" }, lifeId: "L1", lifeStatus: "action", decision: { id: "d1", subject: "S", winner: "W" }, sync: "Not saved to MIND: x" };
  const [t] = loadTasks([linked, { id: "b", title: "B", status: "cancelled", updatedAt: 2, lifeId: "L2" }]);
  assert.deepEqual({ ...t }, { ...linked });
  assert.equal(loadTasks([{ id: "b", title: "B", status: "cancelled", updatedAt: 2 }])[0].status, "cancelled");
  const [r] = resumeStopped([t], 9);
  assert.equal(r.status, "in_progress");
  assert.equal(r.question, undefined);
  assert.deepEqual([r.scope, r.project?.name, r.lifeId, r.decision?.winner], ["astra", "P", "L1", "W"]);
  // junk in the MIND fields is dropped, not trusted
  const [j] = loadTasks([{ id: "c", title: "C", status: "in_progress", scope: "evil", project: { id: 5 }, lifeId: 7, decision: { id: "x" } }]);
  assert.deepEqual([j.scope, j.project, j.lifeId, j.decision], [undefined, undefined, undefined, undefined]);
});

test("scope is derived from the Focus or project name, and the client registry; status maps both ways", () => {
  assert.equal(scopeOfNames(["Astra AI", "Anything"]), "astra");
  assert.equal(scopeOfNames(["MIND", "Daebot"]), "mind");
  assert.equal(scopeOfNames([undefined, "Atlas intake"], ["Atlas"]), "astra");
  assert.equal(scopeOfNames([undefined, "Groceries"]), "mind");
  assert.deepEqual(["not_started", "in_progress", "stopped", "ready_to_test", "cancelled"].map((s) => lifeStatusOf(s as any)), ["ready", "active_mind", "action", "action", "thought"]);
  assert.deepEqual(["active_mind", "ready", "completed", "action", "thought"].map(boardStatusOf), ["in_progress", "not_started", "ready_to_test", undefined, undefined]);
});

test("createBoardMind talks to the user's own MIND with the right LIFE calls", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const c: MindClient = {
    async context() { return ""; }, async query() { return ""; },
    async remember(a) { calls.push({ tool: "remember", args: a as any }); return "saved document doc-77"; },
    async call(tool, args) {
      calls.push({ tool, args });
      if (tool === "focuses" && args.action === "list") return JSON.stringify({ focuses: [{ focus_id: "f1", name: "Astra AI" }] });
      if (tool === "life" && args.action === "list" && args.item_type === "project") return JSON.stringify({ items: [{ item_id: "p1", title: "Reframe", focus_id: "f1" }, { item_id: "p2", title: "Groceries", focus_id: null }] });
      if (tool === "life" && args.action === "create") return JSON.stringify({ item_id: "L9" });
      return "{}";
    },
  };
  const m = createBoardMind(c);
  const ps = await m.projects();
  assert.deepEqual(ps.map((p) => [p.id, p.name, p.focus, p.scope]), [["p1", "Reframe", "Astra AI", "astra"], ["p2", "Groceries", undefined, "mind"]]);
  const t: BoardTask = { id: "t", title: "Do it", status: "in_progress", updatedAt: 1, scope: "astra", project: { id: "p1", name: "Reframe" } };
  assert.deepEqual(await m.create(t), { lifeId: "L9", lifeStatus: "active_mind" });
  const made = calls.find((x) => x.tool === "life" && x.args.action === "create")!;
  assert.deepEqual([made.args.item_type, made.args.parent_id, made.args.status, made.args.title], ["outcome", "p1", "active_mind", "Do it"]);
  await m.cancel({ ...t, lifeId: "L9", status: "cancelled" });
  const cx = calls.filter((x) => x.args.action === "update").pop()!;
  assert.deepEqual([cx.args.item_id, cx.args.status, (cx.args.tags as string[]).includes("cancelled")], ["L9", "thought", true]);
  await m.remove({ ...t, lifeId: "L9" });
  assert.deepEqual(calls.pop(), { tool: "life", args: { action: "delete", item_id: "L9" } });
  const d = await m.saveDecision("Decision - X - 2026-11-01", "body");
  assert.equal(d.id, "doc-77");
  const doc = calls.find((x) => x.tool === "remember")!.args as any;
  assert.deepEqual([doc.type, doc.tags.includes("decision")], ["document", true], "a PRIVATE document, never the public feed");
  const failing = createBoardMind({ ...c, async remember() { throw new Error("down"); } });
  const l = await failing.saveDecision("T", "b");
  assert.equal(l.local, true);
  assert.match(l.id, /^local-/);
});

// ---------- the decision skill

const options = (n = 4) => Array.from({ length: n }, (_, i) => ({ name: `Option ${i + 1}`, consequences: `Upside and downside ${i + 1}`, score: i === 1 ? 9 : 5 }));
const decision = (over: Record<string, unknown> = {}) => ({ subject: "Which host", outcomes: ["Ship by Friday", "Keep cost flat"], options: options(), winner: "Option 2", mitigations: ["Back up first"], resolve: "Use Option 2. Dae builds, Anthony approves.", cost: "$0, no spend", ...over });

test("checkDecision: needs four options, a winner that is one of them with the top score, mitigations, resolve and a dollar cost", () => {
  assert.equal(checkDecision(decision()).ok, true);
  const bad = (over: Record<string, unknown>, re: RegExp) => { const r = checkDecision(decision(over)); assert.equal(r.ok, false); assert.match((r as any).error, re); };
  bad({ options: options(3) }, /at least 4/);
  bad({ winner: "Nope" }, /one of the options/);
  bad({ winner: "Option 1" }, /highest score/);
  bad({ options: [...options(3), { name: "x", consequences: "y", score: 11 }] }, /score/);
  bad({ outcomes: [] }, /outcomes/);
  bad({ mitigations: [] }, /mitigations/);
  bad({ resolve: "" }, /resolve/);
  bad({ cost: "" }, /cost/);
  bad({ subject: "" }, /subject/);
});

test("task_decision files a PRIVATE document and attaches the receipt to the task; the card then shows the winner", async () => {
  const mind = fakeMind();
  const { run, boards, io } = rig(mind);
  await run({ action: "update", id: "t1", title: "Pick a host", status: "in_progress", project: "Atlas Monitor" });
  const dec = createTaskDecisionTool({ mind, board: io });
  const r = await dec.run({ ...decision(), task_id: "t1" }, { cwd: "/", sessionId: "s1" });
  assert.equal(r.ok, true, r.output);
  const t = boards.get("s1")![0];
  assert.deepEqual(t.decision, { id: "doc-2", subject: "Which host", winner: "Option 2" });
  assert.match(mind.log.at(-1)!, /^decision Decision - Which host - \d{4}-\d{2}-\d{2}$/);
  assert.equal(t.scope, "astra", "the link survives");
  assert.equal(dec.class, "write");
  // unknown task, cancelled task, a bot, a bad decision
  assert.equal((await dec.run({ ...decision(), task_id: "zz" }, { cwd: "/", sessionId: "s1" })).ok, false);
  assert.equal((await dec.run(decision({ options: options(2) }), { cwd: "/", sessionId: "s1" })).ok, false);
  assert.equal((await dec.run({ ...decision(), task_id: "t1" }, { cwd: "/", sessionId: "s1", origin: "bot" })).ok, false);
  // no task: the document is still filed and the receipt returned
  const free = await dec.run(decision(), { cwd: "/", sessionId: "other" });
  assert.equal(free.ok, true);
  assert.match(free.output, /No task attached/);
});

test("the prompts tell Daebot what a task is, what is not, and when to run the decision skill", () => {
  assert.match(BOARD_PROMPT, /A chat turn, a question, a lookup/);
  assert.match(BOARD_PROMPT, /conversation itself is never a card/);
  assert.match(BOARD_PROMPT, /task_board action projects/);
  assert.match(DECISION_PROMPT, /task_decision/);
  assert.match(DECISION_PROMPT, /at least four options/);
  assert.match(DECISION_PROMPT, /PRIVATE MIND document/);
  const { tool } = rig();
  assert.match(tool.spec.description, /never for a chat turn, a question/);
});
