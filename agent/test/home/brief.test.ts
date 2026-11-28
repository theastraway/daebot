import { test } from "node:test";
import assert from "node:assert/strict";
import { factsBrief, mailFromMind, nameFromContext, parseBrief, pickTodos, spokenOpener, todosFromMind, writeBrief, briefMessages, BRIEF_SYSTEM } from "../../src/home/brief.ts";
import type { BriefInputs, BriefTodo } from "../../src/home/brief.ts";
import type { Provider, StreamEvent } from "../../src/types.ts";

const CTX = "# Canonical User Identity — Anthony Conti\n\n- **Full name:** Anthony Conti\n- **Timezone:** America/New_York\n\n## Priorities\n- Ship Ilyven tiers";
const TODOS: BriefTodo[] = [
  { title: "Carla: follow up with the Ohio lead", status: "in_progress", priority: "medium" },
  { title: "Finalize Ilyven enterprise tiers", status: "in_progress", priority: "high", due: "2026-11-25" },
  { title: "Reply to Andrew about the handbook", status: "in_progress", priority: "low", waiting: true },
  { title: "Old thing", status: "done", priority: "urgent" },
];
const INP: BriefInputs = { context: CTX, todos: TODOS, mail: [{ from: "Andrew", subject: "Handbook v4" }], today: "Friday, November 27, 2026" };

test("pickTodos: waiting on the user first, then due soon, then priority; done ones never", () => {
  const p = pickTodos(TODOS, "2026-11-27");
  assert.deepEqual(p.map((t) => t.title), ["Reply to Andrew about the handbook", "Finalize Ilyven enterprise tiers", "Carla: follow up with the Ohio lead"]);
});

test("nameFromContext reads the first name from MIND's identity text", () => {
  assert.equal(nameFromContext(CTX), "Anthony");
  assert.equal(nameFromContext("# Canonical User Identity — Maria Lopez\nstuff"), "Maria");
  assert.equal(nameFromContext("nothing here"), "");
});

test("factsBrief: a real line and starters from the to-dos; bots get their own; nothing at all is empty", () => {
  const b = factsBrief(INP, 1);
  assert.equal(b.name, "Anthony");
  assert.equal(b.source, "facts");
  assert.match(b.line, /^1 to-do is waiting on you\. Top of the list: Reply to Andrew about the handbook\.$/);
  assert.equal(b.starters.length, 3);
  assert.match(b.starters[0].label, /^Work on: Reply to Andrew/);
  assert.match(b.starters[0].prompt, /"Reply to Andrew about the handbook"/);
  assert.equal(b.starters[2].label, "Catch me up on email");
  const bot = factsBrief({ ...INP, bot: { name: "Sam", purpose: "Chief of staff." } });
  assert.equal(bot.line, "Sam here: Chief of staff.");
  assert.ok(bot.starters.length >= 2);
  const none = factsBrief({ context: "", todos: [], mail: [], today: "x" });
  assert.equal(none.source, "empty"); assert.equal(none.line, "");
  assert.equal(none.starters.length, 2, "plan my day and what's new");
});

test("parseBrief: JSON in, clean brief out; junk and empty are refused; markdown never reaches the page", () => {
  const raw = 'Sure! ```json\n{"name":"Anthony","line":"**Ilyven tiers** were due Nov 25 → finish today.","starters":[{"label":"**Finish** tiers","prompt":"Finish the Ilyven tiers."},{"label":"x","prompt":""},{"label":"Reply to Andrew","prompt":"Draft my reply to Andrew."},{"label":"a","prompt":"b"},{"label":"c","prompt":"d"}]}\n```';
  const b = parseBrief(raw, 5)!;
  assert.equal(b.name, "Anthony");
  assert.equal(b.line, "Ilyven tiers were due Nov 25 to finish today.");
  assert.deepEqual(b.starters.map((s) => s.label), ["Finish tiers", "Reply to Andrew", "a"]);
  assert.equal(b.source, "model");
  assert.equal(parseBrief("no json here"), undefined);
  assert.equal(parseBrief('{"name":"A","line":"","starters":[]}'), undefined);
  assert.equal(parseBrief('{"name":"<script>","line":"ok","starters":[]}')!.name, "");
});

test("briefMessages carries the rules, today, identity, to-dos with their flags and email", () => {
  const m = briefMessages(INP);
  assert.equal(m[0].content, BRIEF_SYSTEM);
  assert.match(BRIEF_SYSTEM, /Never invent/);
  assert.match(m[1].content, /Today is Friday, November 27, 2026/);
  assert.match(m[1].content, /WAITING ON THE USER\] Reply to Andrew/);
  assert.match(m[1].content, /due 2026-11-25/);
  assert.match(m[1].content, /from Andrew: Handbook v4/);
});

class Writer implements Provider {
  name = "w"; seen: any[] = []; out: string; delay: number;
  constructor(out: string, delay = 0) { this.out = out; this.delay = delay; }
  async *stream(req: any): AsyncIterable<StreamEvent> {
    this.seen.push(req);
    if (this.delay) await new Promise((r, j) => { const t = setTimeout(r, this.delay); req.signal?.addEventListener("abort", () => { clearTimeout(t); j(new Error("aborted")); }); });
    yield { type: "text", delta: this.out };
    yield { type: "done", usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.0002 }, finishReason: "stop" };
  }
}

test("writeBrief: the model's brief (name filled from MIND when it left it out); slow or broken models return undefined", async () => {
  const w = new Writer('{"name":"","line":"Andrew is waiting on your handbook reply.","starters":[{"label":"Reply to Andrew","prompt":"Draft my reply to Andrew about handbook v4."}]}');
  const r = await writeBrief({ provider: w, model: "m", inputs: INP });
  assert.equal(r?.brief.name, "Anthony");
  assert.equal(r?.brief.line, "Andrew is waiting on your handbook reply.");
  assert.equal(r?.usage?.costUsd, 0.0002);
  assert.equal(w.seen[0].noReasoning, true); assert.deepEqual(w.seen[0].tools, []);
  assert.equal(await writeBrief({ provider: new Writer("nope"), model: "m", inputs: INP }), undefined);
  assert.equal(await writeBrief({ provider: new Writer("{}", 5_000), model: "m", inputs: INP, timeoutMs: 50 }), undefined);
});

test("todosFromMind / mailFromMind read MIND's JSON (string or object) and drop junk", () => {
  const t = todosFromMind(JSON.stringify({ todos: [{ title: "A", status: "in_progress", priority: "high", due_date: "2026-12-01", waiting_on_reply: true, project_title: "P" }, { status: "x" }] }));
  assert.deepEqual(t, [{ title: "A", status: "in_progress", priority: "high", due: "2026-12-01", waiting: true, project: "P" }]);
  assert.deepEqual(todosFromMind("not json"), []);
  assert.deepEqual(mailFromMind({ messages: [{ from_name: "Andrew", subject: "Handbook" }, { from: "x" }] }), [{ from: "Andrew", subject: "Handbook" }]);
});

test("spokenOpener: the brief as a call's first line", () => {
  assert.equal(spokenOpener({ name: "Anthony", line: "Andrew is waiting on your reply." }), "Hey Anthony. Andrew is waiting on your reply. Want to start there?");
  assert.equal(spokenOpener({ name: "", line: "Should we ship it?" }), "Hey. Should we ship it?");
  assert.equal(spokenOpener({ name: "A", line: "" }), undefined);
});
