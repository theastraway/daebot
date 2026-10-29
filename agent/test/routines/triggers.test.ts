// The trigger catalog: every trigger that is listed really fires. Messages, finished replies, the weekdays / active-hours limit on a
// trigger, the polled MIND sources, and the desktop sources (app opened, wake, folder, screen).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutineError } from "../../src/routines/store.ts";
import type { RoutineHub } from "../../src/routines/store.ts";
import { CATALOG, catalogFor, checkTrigger, containsPhrase, matchEvent } from "../../src/routines/triggers.ts";
import { pollSource } from "../../src/routines/poll.ts";
import type { MindCall } from "../../src/routines/poll.ts";
import { LocalSources } from "../../src/routines/watchers.ts";
import { ScreenFeed, SIG_LEN } from "../../src/screen/feed.ts";
import { BOT, OWNER, rig } from "./rig.ts";

const MIN = 60_000;
const add = (hub: RoutineHub, name: string, trigger: Record<string, unknown>) => hub.book(OWNER, BOT).add({ name, prompt: `handle ${name}`, kind: "trigger", trigger });
const settle = () => new Promise((r) => setImmediate(r));
const NY = "America/New_York";

test("the catalog lists only what a deployment can detect: a hosted server has no desktop triggers", () => {
  const hosted = catalogFor({ desktop: false }).map((d) => d.type);
  const desktop = catalogFor({ desktop: true }).map((d) => d.type);
  for (const t of ["app_opened", "wake", "file_changed", "screen_change"]) { assert.ok(!hosted.includes(t as any), t); assert.ok(desktop.includes(t as any), t); }
  assert.equal(new Set(CATALOG.map((d) => d.type)).size, CATALOG.length);
  for (const d of CATALOG) assert.ok(d.label && d.description.length > 20, d.type);
  const r = rig();                                                      // hosted-style hub: desktop false
  assert.throws(() => add(r.hub, "w", { type: "wake" }), (e) => e instanceof RoutineError && /desktop app/.test(e.message));
  const d = rig({ desktop: true });
  assert.equal(add(d.hub, "w", { type: "wake" }).trigger!.type, "wake");
});

test("every trigger validates its own fields", () => {
  const caps = { desktop: true };
  assert.deepEqual(checkTrigger({ type: "keyword", phrase: " Invoice , urgent " }, caps), { type: "keyword", phrase: "Invoice , urgent", where: "either" });
  assert.throws(() => checkTrigger({ type: "keyword" }, caps), /words to look for/);
  assert.throws(() => checkTrigger({ type: "keyword", phrase: "x", where: "me" }, caps), /where/);
  assert.equal(checkTrigger({ type: "turn_done" }, caps).on, "done");
  assert.throws(() => checkTrigger({ type: "turn_done", on: "sometimes" }, caps), /on must be/);
  assert.equal(checkTrigger({ type: "mail_new" }, caps).every, 15);
  assert.equal(checkTrigger({ type: "mind_task", every: "30" }, caps).every, 30);
  assert.throws(() => checkTrigger({ type: "mind_task", every: 1 }, caps), /every must be/);
  assert.equal(checkTrigger({ type: "screen_change" }, caps).sensitivity, "medium");
  assert.throws(() => checkTrigger({ type: "file_changed", path: "relative/dir" }, caps), /full path/);
  assert.throws(() => checkTrigger({ type: "file_changed", path: "/definitely/not/here" }, caps), /not a folder/);
  assert.equal(checkTrigger({ type: "file_changed", path: tmpdir() }, caps).path!.length > 1, true);
  assert.throws(() => checkTrigger({ type: "nope" }, caps), /trigger must be one of/);
  // the limit works on every trigger
  const t = checkTrigger({ type: "webhook", filter: { weekdays: true, from: "9:00", to: "17:00" }, tz: NY }, caps);
  assert.deepEqual(t.filter, { weekdays: true, from: "09:00", to: "17:00" });
  assert.equal(t.tz, NY);
  assert.throws(() => checkTrigger({ type: "webhook", filter: { from: "09:00" }, tz: NY }, caps), /both a start and an end/);
  assert.throws(() => checkTrigger({ type: "webhook", filter: { weekdays: true }, tz: "Mars/Base" }, caps), /time zone/);
});

test("keyword: fires on a message that contains one of the words, in the places you chose", async () => {
  assert.equal(containsPhrase("Please pay the INVOICE today", "invoice, refund"), true);
  assert.equal(containsPhrase("nothing here", "invoice, refund"), false);
  const r = rig();
  const both = add(r.hub, "either", { type: "keyword", phrase: "invoice, refund" });
  const mine = add(r.hub, "mine", { type: "keyword", phrase: "invoice", where: "user" });
  const bots = add(r.hub, "bots", { type: "keyword", phrase: "invoice", where: "bot" });
  assert.equal(r.runner.trigger(OWNER, BOT, "thread_message", { text: "where is my Invoice?" }), 2);     // either + mine
  await settle();
  assert.deepEqual(r.turns.map((t) => t.thread).sort(), ["Routine: either", "Routine: mine"]);
  assert.match(r.turns[0].text, /started by a keyword/);
  assert.match(r.turns[0].text, /where is my Invoice\?/);
  assert.equal(r.runner.trigger(OWNER, BOT, "thread_message", { text: "nothing relevant" }), 0);
  r.turns.length = 0;
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.runner.trigger(OWNER, BOT, "bot_message", { text: "a refund for you", from: "ally" }), 1);   // either only: "refund" not in bots' phrase
  assert.equal(r.runner.trigger(OWNER, BOT, "bot_message", { text: "the invoice", from: "ally" }), 2);       // either + bots
  assert.ok(both.id && mine.id && bots.id);
});

test("turn_done: a finished or failed reply fires the routines that want that ending", async () => {
  const r = rig();
  add(r.hub, "done", { type: "turn_done" });
  add(r.hub, "failed", { type: "turn_done", on: "failed" });
  add(r.hub, "any", { type: "turn_done", on: "any" });
  assert.equal(r.runner.trigger(OWNER, BOT, "turn_done", { text: "All set.", ok: true }), 2);
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(r.turns.map((t) => t.thread).sort(), ["Routine: any", "Routine: done"]);
  assert.match(r.turns[0].text, /Trigger data from the turn done/);
  r.turns.length = 0;
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.runner.trigger(OWNER, BOT, "turn_done", { text: "Turn failed: boom", ok: false }), 2);      // failed + any
  assert.ok(matchEvent({ type: "turn_done", on: "done" }, { kind: "turn_done", text: "x" }));
});

test("weekdays only / active hours work on a trigger: outside the limit nothing runs (a webhook says why)", async () => {
  const r = rig();                                                          // clock: Wed 2026-10-28 08:00 New York
  const f = { weekdays: true, from: "09:00", to: "17:00" };
  const kw = add(r.hub, "limited", { type: "keyword", phrase: "go", filter: f, tz: NY });
  const hook = add(r.hub, "hooked", { type: "webhook", filter: f, tz: NY });
  assert.equal(r.runner.trigger(OWNER, BOT, "thread_message", { text: "go" }), 0);                           // 8 AM: closed
  assert.equal(r.runner.webhook(hook.id, "x").ok, false);
  assert.match(r.hub.book(OWNER, BOT).get(hook.id)!.runs!.at(-1)!.result!, /outside this routine's weekdays/);
  r.clock.t = Date.parse("2026-10-28T14:00:00Z");                                                           // 10 AM: open
  assert.equal(r.runner.trigger(OWNER, BOT, "thread_message", { text: "go" }), 1);
  assert.equal(r.runner.webhook(hook.id, "x").ok, true);
  await new Promise((res) => setTimeout(res, 20));
  r.clock.t = Date.parse("2026-10-31T16:00:00Z");                                                           // Saturday noon: closed
  assert.equal(r.runner.trigger(OWNER, BOT, "thread_message", { text: "go" }), 0);
  assert.ok(kw.id);
});

// ---------------------------------------------------------------- polled MIND sources
function fakeMind() {
  const data: Record<string, any> = {
    documents: { documents: [{ id: "d1", title: "Old doc", source: "Upload", created_at: "2026-10-01" }] },
    tasks: { tasks: [{ task_id: "t1", title: "Old task", status: "open", due_date: "2026-12-31" }] },
    crm: { contacts: [{ contact_id: "c1", name: "Old Contact", email: "old@example.com", type: "lead" }] },
    email: { messages: [{ id: "m1", from_name: "Ann", from_email: "ann@example.com", subject: "Old mail", is_read: false }] },
  };
  const calls: string[] = [];
  let failNext = "";
  const call: MindCall = async (_owner, tool, args) => {
    calls.push(`${tool}:${args.action}`);
    if (failNext) { const m = failNext; failNext = ""; throw new Error(m); }
    return JSON.stringify(data[tool]);
  };
  return { data, calls, call, fail: (m: string) => { failNext = m; } };
}

test("polled MIND triggers: the first look only learns what exists; each NEW item runs once; a failed look is shown and retried", async () => {
  const mind = fakeMind();
  const r = rig({ deps: { poll: (owner, _b, trig, now, signal) => pollSource(mind.call, owner, trig, now, signal) } });
  const cases: [string, string, () => void, RegExp][] = [
    ["mind_document", "documents", () => mind.data.documents.documents.unshift({ id: "d2", title: "Board notes", source: "daebot", created_at: "2026-10-29" }), /New MIND document "Board notes"/],
    ["mind_task", "tasks", () => mind.data.tasks.tasks.unshift({ task_id: "t2", title: "Call Sam", status: "open", due_date: null }), /New MIND task "Call Sam"/],
    ["mind_contact", "crm", () => mind.data.crm.contacts.unshift({ contact_id: "c2", name: "Pat Lee", email: "pat@example.com", type: "lead" }), /New CRM contact Pat Lee <pat@example.com>/],
    ["mail_new", "email", () => mind.data.email.messages.unshift({ id: "m2", from_name: "Bo", from_email: "bo@example.com", subject: "Quote please", is_read: false, preview: "hi" }), /New email from Bo <bo@example.com>: Quote please/],
  ];
  for (const [type] of cases) add(r.hub, type, { type, every: 5 });
  await r.runner.tick(r.clock.t);                                   // first look: primes only
  assert.equal(r.turns.length, 0);
  assert.equal(mind.calls.length, 4);
  for (const [type] of cases) assert.equal(r.hub.book(OWNER, BOT).list().find((x) => x.name === type)!.tstate!.primed, true);
  await r.runner.tick(r.clock.t + MIN);                              // not due yet
  assert.equal(mind.calls.length, 4);
  for (const [, , change] of cases) change();
  r.clock.t += 5 * MIN;
  await r.runner.tick(r.clock.t);
  assert.equal(r.turns.length, 4);
  for (const [type, , , re] of cases) assert.match(r.turns.find((t) => t.thread === `Routine: ${type}`)!.text, re);
  assert.match(r.turns[0].text, /untrusted data to read/);
  r.turns.length = 0;
  r.clock.t += 5 * MIN;
  await r.runner.tick(r.clock.t);
  assert.equal(r.turns.length, 0, "the same items never run twice");
  // a failed look is recorded on the routine and tried again at the next interval
  mind.fail("MIND is down");
  r.clock.t += 5 * MIN;
  await r.runner.tick(r.clock.t);
  const bad = r.hub.book(OWNER, BOT).list().filter((x) => x.tstate?.error);
  assert.equal(bad.length, 1);
  assert.match(bad[0].tstate!.error!, /MIND is down/);
  r.clock.t += 5 * MIN;
  await r.runner.tick(r.clock.t);
  assert.equal(r.hub.book(OWNER, BOT).list().filter((x) => x.tstate?.error).length, 0);
});

test("a MIND task that comes due runs once; tasks already due when the routine was saved are not replayed", async () => {
  const mind = fakeMind();
  mind.data.tasks.tasks = [{ task_id: "late", title: "Already late", status: "open", due_date: "2026-10-01" }, { task_id: "soon", title: "Send the quote", status: "open", due_date: "2026-10-30" }];
  const r = rig({ deps: { poll: (owner, _b, trig, now, signal) => pollSource(mind.call, owner, trig, now, signal) } });
  add(r.hub, "due", { type: "mind_task_due", every: 15, tz: "UTC", filter: { weekdays: false } });
  await r.runner.tick(r.clock.t);                                    // Wed 10-28: primes (Already late is known, not replayed)
  assert.equal(r.turns.length, 0);
  r.clock.t = Date.parse("2026-10-29T12:00:00Z");
  await r.runner.tick(r.clock.t);
  assert.equal(r.turns.length, 0);                                   // due tomorrow
  r.clock.t = Date.parse("2026-10-30T12:00:00Z");
  await r.runner.tick(r.clock.t);
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0].text, /MIND task "Send the quote" is due \(2026-10-30\)/);
  mind.data.tasks.tasks[1].status = "done";
  r.clock.t += 15 * MIN; await r.runner.tick(r.clock.t);
  assert.equal(r.turns.length, 1);
});

test("a polled trigger outside its weekdays / hours forgets nothing: the item runs at the first look inside the limit", async () => {
  const mind = fakeMind();
  const r = rig({ deps: { poll: (owner, _b, trig, now, signal) => pollSource(mind.call, owner, trig, now, signal) } });   // Wed 08:00 New York
  add(r.hub, "docs", { type: "mind_document", every: 15, filter: { weekdays: true, from: "09:00", to: "17:00" }, tz: NY });
  await r.runner.tick(r.clock.t);                                    // primes
  mind.data.documents.documents.unshift({ id: "d9", title: "Overnight", source: "x", created_at: "t" });
  r.clock.t += 15 * MIN; await r.runner.tick(r.clock.t);             // 08:15: closed
  assert.equal(r.turns.length, 0);
  r.clock.t = Date.parse("2026-10-28T13:00:00Z"); await r.runner.tick(r.clock.t);   // 09:00: open
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0].text, /Overnight/);
});

test("turning a polled trigger off and on again starts a fresh look: nothing from the time it was off is replayed", async () => {
  const mind = fakeMind();
  const r = rig({ deps: { poll: (owner, _b, trig, now, signal) => pollSource(mind.call, owner, trig, now, signal) } });
  const rt = add(r.hub, "docs", { type: "mind_document", every: 5 });
  await r.runner.tick(r.clock.t);
  r.hub.book(OWNER, BOT).update(rt.id, { enabled: false });
  mind.data.documents.documents.unshift({ id: "while-off", title: "x", source: "x", created_at: "t" });
  r.clock.t += 10 * MIN; await r.runner.tick(r.clock.t);
  r.hub.book(OWNER, BOT).update(rt.id, { enabled: true });
  await r.runner.tick(r.clock.t);
  assert.equal(r.turns.length, 0);
});

// ---------------------------------------------------------------- desktop sources
test("app_opened fires once when the desktop app starts; wake fires when the computer comes back from sleep", async () => {
  const r = rig({ desktop: true });
  add(r.hub, "opened", { type: "app_opened" });
  add(r.hub, "woke", { type: "wake" });
  await r.runner.tick(r.clock.t);
  assert.deepEqual(r.turns.map((t) => t.thread), ["Routine: opened"]);
  await r.runner.tick(r.clock.t + 15_000);
  assert.equal(r.turns.length, 1, "app_opened runs once per start");
  await r.runner.tick(r.clock.t + 30_000);
  assert.equal(r.turns.length, 1, "a normal tick is not a wake");
  await r.runner.tick(r.clock.t + 30_000 + 25 * MIN);                // 25 minutes of silence = the computer slept
  assert.deepEqual(r.turns.map((t) => t.thread), ["Routine: opened", "Routine: woke"]);
  assert.match(r.turns[1].text, /woke up after about 25 minutes/);
  const h = rig();                                                    // not desktop: neither exists
  assert.throws(() => add(h.hub, "opened", { type: "app_opened" }), RoutineError);
});

test("file_changed: a change in the watched folder runs the routine once, with the file names, after the changes settle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  const r = rig({ desktop: true });
  const rt = add(r.hub, "files", { type: "file_changed", path: dir });
  const fired: string[] = [];
  const local = new LocalSources({ settleMs: 80, fire: (o, b, id, text) => { fired.push(text); return r.runner.fireRoutine(o, b, id, text); } });
  local.sync(r.hub.all());
  await new Promise((res) => setTimeout(res, 400));                  // the OS watcher needs a moment to start
  writeFileSync(join(dir, "invoice.pdf"), "x");
  writeFileSync(join(dir, "notes.txt"), "y");
  writeFileSync(join(dir, ".hidden"), "z");
  const t0 = Date.now();
  while (!fired.length && Date.now() - t0 < 4000) await new Promise((res) => setTimeout(res, 25));
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(fired.length, 1, "one run for the whole burst");
  assert.match(fired[0], /Files changed in /);
  assert.match(fired[0], /- invoice\.pdf/);
  assert.match(fired[0], /- notes\.txt/);
  assert.doesNotMatch(fired[0], /\.hidden/);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.turns.length, 1);
  assert.match(r.turns[0].text, /started by a file changed/);
  // turned off: the watcher goes away
  r.hub.book(OWNER, BOT).update(rt.id, { enabled: false });
  local.sync(r.hub.all());
  writeFileSync(join(dir, "later.txt"), "q");
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(fired.length, 1);
  local.stop();
});

test("screen_change: a big change that holds still runs the routine once; small noise and the one-minute cooldown do not", async () => {
  const feed = new ScreenFeed();
  feed.setState({ watching: true, permission: "granted" });
  const r = rig({ desktop: true });
  add(r.hub, "screen", { type: "screen_change", sensitivity: "medium" });
  let now = 1_000_000;
  const fired: string[] = [];
  const local = new LocalSources({ screen: feed, screenSettleMs: 40, cooldownMs: 60_000, now: () => now, fire: (o, b, id, text) => { fired.push(text); return r.runner.fireRoutine(o, b, id, text); } });
  local.sync(r.hub.all());
  const frame = (luma: number, changeCells = 0) => {
    const sig = new Uint8Array(SIG_LEN).fill(luma);
    for (let i = 0; i < changeCells; i++) sig[i] = 255;
    return { jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), width: 100, height: 60, screenWidth: 1000, screenHeight: 600, cursorX: 0, cursorY: 0, sig };
  };
  assert.ok(feed.ingest(frame(10)));                                  // baseline
  assert.ok(feed.ingest(frame(10, 20)));                              // 20 of 2304 cells: below 5%
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(fired.length, 0);
  assert.ok(feed.ingest(frame(10, 400)));                             // ~17% of the screen changed
  assert.ok(feed.ingest(frame(10, 410)));
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(fired.length, 1);
  assert.match(fired[0], /The screen changed \(about \d+% of it\)/);
  now += 5_000;
  assert.ok(feed.ingest(frame(200)));                                 // changes again, inside the cooldown
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(fired.length, 1);
  now += 61_000;
  assert.ok(feed.ingest(frame(10)));
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(fired.length, 2);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.turns.length, 2);
  local.stop();
});
