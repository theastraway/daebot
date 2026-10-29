process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/bots/store.ts";
import { createBotManageTool } from "../../src/bots/manage-tool.ts";
import { createBotSelfTool } from "../../src/bots/self-tool.ts";
import { createBotBus } from "../../src/bots/bus.ts";
import { RoutineHub } from "../../src/routines/store.ts";

function rig(runRoutine?: (o: string, b: string, r: string) => Promise<{ ok: boolean; message: string }>) {
  const remote = new Set<string>();
  const dir = mkdtempSync(join(tmpdir(), "routines-manage-"));
  const store = new BotStore({ dir, owner: "u1", mind: { async list() { return [...remote].map((slug) => ({ slug })); }, async create(slug) { remote.add(slug); }, async remove(slug) { remote.delete(slug); } } });
  const hub = new RoutineHub(dir);
  const t = createBotManageTool({ bots: store, owner: "u1", hooks: () => ({ runRoutine, publicBase: () => "https://daebot.live" }), threads: () => 0, routines: hub });
  const run = (args: Record<string, unknown>, origin?: "user" | "bot") => t.run(args, { cwd: "/", sessionId: "s", origin });
  return { store, hub, t, run, dir };
}

test("bot_manage routine actions: add (timed + trigger), list, update, run now, remove; the answer carries the timing in plain words", async () => {
  const calls: string[] = [];
  const r = rig(async (_o, _b, id) => { calls.push(id); return { ok: true, message: "Ran (ok): 12:00" }; });
  await r.run({ action: "create", slug: "clock", name: "Clock", purpose: "tells time" });
  const a = await r.run({ action: "add_routine", slug: "clock", name: "Tick", prompt: "Write the time in one line.", kind: "timed", expression: "*/2 * * * *", tz: "America/New_York" });
  assert.equal(a.ok, true, a.output);
  assert.equal(JSON.parse(a.output).added.when, "every 2 minutes");
  const w = await r.run({ action: "add_routine", slug: "clock", name: "Ack", prompt: "Reply ACK.", trigger: "thread_message" });
  assert.equal(JSON.parse(w.output).added.kind, "trigger");
  const h = JSON.parse((await r.run({ action: "add_routine", slug: "clock", name: "Hook", prompt: "Log it.", trigger: "webhook" })).output).added;
  assert.match(h.webhookUrl, /^https:\/\/daebot\.live\/hooks\/r_[0-9a-f]{12}\//);
  const l = JSON.parse((await r.run({ action: "list_routines", slug: "clock" })).output);
  assert.deepEqual(l.routines.map((x: any) => x.name), ["Heartbeat", "Tick", "Ack", "Hook"]);
  const u = await r.run({ action: "update_routine", slug: "clock", routine: "tick", expression: "0 9 * * 1-5" });
  assert.equal(JSON.parse(u.output).updated.when, "every weekday at 9:00 AM New York");
  assert.equal((await r.run({ action: "update_routine", slug: "clock", routine: "Heartbeat", enabled: false })).ok, true);
  assert.equal((await r.run({ action: "update_routine", slug: "clock", routine: "Heartbeat", name: "x" })).ok, false);
  assert.equal((await r.run({ action: "remove_routine", slug: "clock", routine: "Heartbeat" })).ok, false);
  const now = await r.run({ action: "run_routine_now", slug: "clock", routine: "Tick" });
  assert.equal(now.ok, true);
  assert.equal(calls.length, 1);
  assert.equal((await r.run({ action: "remove_routine", slug: "clock", routine: "Tick" })).ok, true);
  assert.equal(JSON.parse((await r.run({ action: "list_routines", slug: "clock" })).output).routines.length, 3);
});

test("bot_manage routine validation and who may ask", async () => {
  const r = rig();
  await r.run({ action: "create", slug: "clock", name: "Clock" });
  for (const bad of [
    { name: "x", prompt: "y", kind: "timed", expression: "61 * * * *" },
    { name: "x", prompt: "y", kind: "timed", expression: "* * * * *", tz: "Not/AZone" },
    { name: "x", prompt: "", kind: "timed", expression: "* * * * *" },
    { name: "x", prompt: "y", trigger: "pigeon" },
    { name: "", prompt: "y", trigger: "webhook" },
  ]) assert.equal((await r.run({ action: "add_routine", slug: "clock", ...bad })).ok, false, JSON.stringify(bad));
  assert.equal((await r.run({ action: "add_routine", slug: "nope", name: "x", prompt: "y", trigger: "webhook" })).ok, false);
  // a message from another bot cannot change routines; it can still read them
  assert.equal((await r.run({ action: "add_routine", slug: "clock", name: "x", prompt: "y", trigger: "webhook" }, "bot")).ok, false);
  assert.equal((await r.run({ action: "list_routines", slug: "clock" }, "bot")).ok, true);
  assert.equal(r.t.classFor!({ action: "remove_routine" }), "irreversible");
  assert.equal(r.t.classFor!({ action: "add_routine" }), "write");
  assert.equal(r.t.classFor!({ action: "list_routines" }), "read");
});

test("deleting a bot drops its routines; another owner's hub never sees them", async () => {
  const r = rig();
  await r.run({ action: "create", slug: "clock", name: "Clock" });
  const id = r.store.bySlug("clock")!.id;
  const added = JSON.parse((await r.run({ action: "add_routine", slug: "clock", name: "T", prompt: "y", trigger: "webhook" })).output).added;
  assert.equal(r.hub.find(added.id)?.book.owner, "u1");
  assert.equal(new RoutineHub(r.dir).book("u2", id).get(added.id), undefined);
  assert.equal((await r.run({ action: "delete", slug: "clock" })).ok, true);
  assert.equal(r.hub.find(added.id), undefined);
  assert.equal(new RoutineHub(r.dir).book("u1", id).get(added.id), undefined, "routines.json went with the bot folder");
});

test("bot_self: continue and stop only inside the Heartbeat run; learn is available; thread listing works", async () => {
  const log: string[] = [];
  const t = createBotSelfTool({
    threads: async () => [{ id: "t1", title: "Plan", updatedAt: 1, state: "user message not answered", tasks: [] }],
    isHeartbeat: (sid) => sid === "hb",
    continueThread: async (id, note) => { log.push(`continue ${id} ${note}`); return "resumed"; },
    stopThread: async (id, q) => { log.push(`stop ${id} ${q}`); return "stopped"; },
    learn: async (l) => ({ ok: true, text: `lesson ${l.behavior}` }),
  });
  const run = (args: Record<string, unknown>, sessionId: string) => t.run(args, { cwd: "/", sessionId });
  assert.equal((await run({ action: "threads" }, "chat")).ok, true);
  assert.equal((await run({ action: "continue", thread: "t1", note: "go" }, "chat")).ok, false, "a normal chat cannot steer other threads");
  assert.equal((await run({ action: "continue", thread: "t1", note: "go" }, "hb")).ok, true);
  assert.equal((await run({ action: "stop", thread: "t1" }, "hb")).ok, false, "a stop needs its question");
  assert.equal((await run({ action: "stop", thread: "t1", question: "Which date?" }, "hb")).ok, true);
  assert.deepEqual(log, ["continue t1 go", "stop t1 Which date?"]);
  assert.equal((await run({ action: "learn", kind: "win", trigger: "t", behavior: "Short replies", rule: "r", evidence: "e" }, "chat")).ok, true);
  assert.equal(t.classFor!({ action: "threads" }), "read");
});

test("bot_message: a bot_talk delivery tells the listener once, with who sent it", async () => {
  const seen: any[] = [];
  const bots: any = { bySlug: (s: string) => (s === "zed" ? { id: "b_aaaaaaaaaaaa", slug: "zed", name: "Zed" } : undefined), roster: () => [], get: () => ({ name: "Quinn", slug: "quinn" }) };
  const bus = createBotBus({
    manager: {
      async open() { return { id: "dm" }; },
      get: (id: string) => ({ owner: "u1", busy: false, turns: 1, turnNonce: "n", ...(id ? {} : {}) }),
      async turn(_id: string, _t: string, on: any) { on({ type: "done", finalText: "ok" }); },
    } as any,
    botsFor: () => bots,
    onBotMessage: (m) => seen.push(m),
  });
  const res = await bus.talk({ owner: "u1", fromSession: "s1", selfBot: "quinn", to: "zed", message: "ping" });
  assert.equal(res.ok, true, res.output);
  assert.deepEqual(seen, [{ owner: "u1", to: "b_aaaaaaaaaaaa", from: "quinn", text: "ping" }]);
});
