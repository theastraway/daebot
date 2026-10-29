import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskBoardTool, deriveStatus, endsWithQuestion, loadTasks, resumeStopped, rowsFor, MAX_TASKS } from "../../src/board/board.ts";
import type { BoardTask } from "../../src/board/board.ts";
import type { HistoryEvent } from "../../src/types.ts";

function rig() {
  const boards = new Map<string, BoardTask[]>();
  const tool = createTaskBoardTool({ get: (s) => boards.get(s) ?? [], set: (s, t) => { boards.set(s, t); } });
  const run = (args: Record<string, unknown>, o: { origin?: "user" | "bot" } = {}) => tool.run(args, { cwd: "/", sessionId: "s1", ...o });
  return { boards, tool, run };
}

test("task_board is a local write tool with a description that tells the model when to stop a task", () => {
  const { tool } = rig();
  assert.equal(tool.spec.name, "task_board");
  assert.equal(tool.class, "write");
  assert.match(tool.spec.description, /stopped/);
  assert.match(tool.spec.description, /question/);
});

test("set: validates and stores the whole board; a stopped task carries its question, others carry none", async () => {
  const { run, boards } = rig();
  const r = await run({ action: "set", tasks: [
    { id: "t1", title: "Build the page", status: "in_progress", question: "ignored" },
    { id: "t2", title: "Pick a database", status: "stopped", question: "Postgres or SQLite?" },
    { id: "t3", title: "Write tests", status: "not_started" },
    { id: "t4", title: "Ship", status: "ready_to_test" },
  ] });
  assert.equal(r.ok, true, r.output);
  const b = boards.get("s1")!;
  assert.deepEqual(b.map((t) => [t.id, t.status, t.question]), [["t1", "in_progress", undefined], ["t2", "stopped", "Postgres or SQLite?"], ["t3", "not_started", undefined], ["t4", "ready_to_test", undefined]]);
});

test("set rejects: stopped without a question, bad status, bad or duplicate id, empty title, too many tasks, non-list", async () => {
  const { run, boards } = rig();
  const bad = async (tasks: unknown, re: RegExp) => { const r = await run({ action: "set", tasks }); assert.equal(r.ok, false); assert.match(r.output, re); };
  await bad([{ id: "a", title: "x", status: "stopped" }], /needs "question"/);
  await bad([{ id: "a", title: "x", status: "stopped", question: "   " }], /needs "question"/);
  await bad([{ id: "a", title: "x", status: "blocked" }], /status must be one of/);
  await bad([{ id: "has space", title: "x", status: "not_started" }], /task id/);
  await bad([{ id: "a", title: "x", status: "not_started" }, { id: "a", title: "y", status: "not_started" }], /duplicate/);
  await bad([{ id: "a", title: "  ", status: "not_started" }], /title is required/);
  await bad(Array.from({ length: MAX_TASKS + 1 }, (_, i) => ({ id: `t${i}`, title: "x", status: "not_started" })), /at most/);
  await bad("nope", /must be a list/);
  assert.equal(boards.has("s1"), false, "a rejected call changes nothing");
});

test("update: changes one task, can create one with title+status, refuses an unknown id without them", async () => {
  const { run, boards } = rig();
  await run({ action: "set", tasks: [{ id: "t1", title: "A", status: "in_progress" }, { id: "t2", title: "B", status: "not_started" }] });
  assert.equal((await run({ action: "update", id: "t1", status: "ready_to_test" })).ok, true);
  assert.deepEqual(boards.get("s1")!.map((t) => t.status), ["ready_to_test", "not_started"]);
  assert.equal((await run({ action: "update", id: "t2", status: "stopped" })).ok, false, "stopped needs a question");
  assert.equal((await run({ action: "update", id: "t2", status: "stopped", question: "Which color?" })).ok, true);
  assert.equal(boards.get("s1")![1].question, "Which color?");
  assert.equal((await run({ action: "update", id: "t2", status: "in_progress" })).ok, true);
  assert.equal(boards.get("s1")![1].question, undefined, "leaving stopped drops the question");
  assert.equal((await run({ action: "update", id: "zz", status: "in_progress" })).ok, false);
  assert.equal((await run({ action: "update", id: "t3", title: "C", status: "not_started" })).ok, true);
  assert.equal(boards.get("s1")!.length, 3);
  assert.equal((await run({ action: "nope" })).ok, false);
  const got = await run({ action: "get" });
  assert.match(got.output, /t3 \[not_started\] C/);
});

test("a message from another bot cannot edit the board", async () => {
  const { run, boards } = rig();
  const r = await run({ action: "set", tasks: [{ id: "a", title: "x", status: "not_started" }] }, { origin: "bot" });
  assert.equal(r.ok, false);
  assert.equal(boards.has("s1"), false);
});

test("resumeStopped: the user replied, so stopped tasks go back to in progress and lose the question", () => {
  const out = resumeStopped([{ id: "a", title: "A", status: "stopped", question: "q", updatedAt: 1 }, { id: "b", title: "B", status: "ready_to_test", updatedAt: 1 }], 9);
  assert.deepEqual(out.map((t) => [t.status, t.question, t.updatedAt]), [["in_progress", undefined, 9], ["ready_to_test", undefined, 1]]);
});

test("loadTasks drops junk from a stored record instead of throwing", () => {
  assert.deepEqual(loadTasks(undefined), []);
  assert.deepEqual(loadTasks([{ id: "a", title: "A", status: "stopped" }, { id: "b", title: "B", status: "in_progress", updatedAt: 5 }, 7]).map((t) => t.id), ["b"]);
});

// ---------- derived status ----------
const user = (text = "hi"): HistoryEvent => ({ type: "user", text });
const text = (delta: string): HistoryEvent => ({ type: "text", delta });
const permission = (id = "p1"): HistoryEvent => ({ type: "permission", id, tool: "mind_email_send", cls: "outward", title: "Send an email to Sam", detail: [], args: {}, allowOptions: [], denyOptions: [], expiresAt: 0 } as HistoryEvent);

test("derived: a session with no turns is red not started", () => {
  assert.equal(deriveStatus({ history: [], live: true }).status, "not_started");
  assert.equal(deriveStatus({ history: [{ type: "notice", level: "info", text: "x" }], live: false }).status, "not_started");
});

test("derived: a run in progress is yellow", () => {
  assert.deepEqual(deriveStatus({ history: [user(), text("working")], run: { status: "running" }, live: true }), { status: "in_progress" });
});

test("derived: a finished turn is green", () => {
  assert.deepEqual(deriveStatus({ history: [user(), text("Here is the report.")], run: { status: "done" }, live: true }), { status: "ready_to_test" });
  assert.equal(deriveStatus({ history: [user(), text("Here is the report.")], live: false }).status, "ready_to_test");
});

test("derived: a turn waiting on an approval card is red stopped, with the card title as the question", () => {
  const d = deriveStatus({ history: [user(), text("Sending."), permission()], run: { status: "running" }, live: true });
  assert.equal(d.status, "stopped");
  assert.match(d.question!, /Send an email to Sam/);
  // once the card is answered the turn is just running again
  const answered = deriveStatus({ history: [user(), permission(), { type: "permissionResolved", id: "p1", outcome: "allowed", by: "user" }], run: { status: "running" }, live: true });
  assert.equal(answered.status, "in_progress");
});

test("derived: a turn that ended on a typed confirmation is red stopped", () => {
  const d = deriveStatus({ history: [user(), { type: "confirm", id: "c1", tool: "mind_email_send", args: {}, reason: "This sends an email to a real person." }, { type: "done", finalText: "" }], run: { status: "done" }, live: true });
  assert.equal(d.status, "stopped");
  assert.match(d.question!, /sends an email/);
});

test("derived: a turn that ends on a question to the user is red stopped with that question", () => {
  const d = deriveStatus({ history: [user(), text("I built two versions.\n\nWhich one should I keep?")], run: { status: "done" }, live: true });
  assert.equal(d.status, "stopped");
  assert.equal(d.question, "Which one should I keep?");
  assert.equal(endsWithQuestion("Ready?)"), true);
  assert.equal(endsWithQuestion("Is it done? Yes, it is."), false);
});

test("derived: a turn the server lost (still 'running' on disk with no live owner, or errored) is stopped, not green", () => {
  assert.equal(deriveStatus({ history: [user(), text("part")], run: { status: "running" }, live: false }).status, "stopped");
  assert.equal(deriveStatus({ history: [user(), text("part")], run: { status: "error" }, live: true }).status, "stopped");
});

test("rows: a session with no declared tasks is one derived card; declared tasks win and a waiting turn adds a red row only if none is stopped", () => {
  const s = { id: "s1", title: "Landing page", updatedAt: 100 };
  const h = [user(), text("Which headline?")];
  const derived = rowsFor(s, [], { history: h, run: { status: "done" }, live: true });
  assert.equal(derived.length, 1);
  assert.deepEqual([derived[0].derived, derived[0].status, derived[0].title, derived[0].sessionTitle], [true, "stopped", "Landing page", "Landing page"]);

  const t = (id: string, status: BoardTask["status"], question?: string): BoardTask => ({ id, title: id, status, ...(question ? { question } : {}), updatedAt: 1 });
  const withDone = rowsFor(s, [t("a", "ready_to_test")], { history: h, run: { status: "done" }, live: true });
  assert.deepEqual(withDone.map((r) => [r.id, r.status]), [["a", "ready_to_test"], ["waiting", "stopped"]]);
  const withStop = rowsFor(s, [t("a", "stopped", "Which headline?")], { history: h, run: { status: "done" }, live: true });
  assert.deepEqual(withStop.map((r) => [r.id, r.status]), [["a", "stopped"]], "the model already stopped a task: no duplicate row");
  assert.ok(withStop.every((r) => r.sessionId === "s1" && r.sessionTitle === "Landing page"));
});
