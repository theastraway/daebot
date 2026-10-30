// The bot toolkit: Daebot (and each bot, for itself) runs bots through bot_manage: one test per new action, self mode, the threads
// plumbing through the real runtime and gateway, the bot_self threads defect, and the system-prompt section.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/bots/store.ts";
import { createBotManageTool } from "../../src/bots/manage-tool.ts";
import type { BotManageHooks, ThreadOps } from "../../src/bots/manage-tool.ts";
import { createBotSelfTool } from "../../src/bots/self-tool.ts";
import { BOT_TOOLKIT_PROMPT } from "../../src/bots/skill.ts";
import { RoutineHub } from "../../src/routines/store.ts";
import { createRuntime, composeSystemPrompt } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg, call, collect } from "../core/helpers.ts";
import { auth as bearer, http, tmpStatic } from "../gateway/helpers.ts";

const MODELS = { default: "m/default", models: [{ id: "m/default", name: "Default", allowed: true }, { id: "m/pro", name: "Pro", allowed: true }] };
const INSTR = "# Role\nYou are Scout. Your job: find leads.\n\n# How you work\n- Look in MIND first.\n\n# Never\n- Guess.\n";

type Th = { id: string; title: string; updatedAt: number; surface: string; archived?: boolean };
function rig(o: { selfBot?: string; hooks?: BotManageHooks } = {}) {
  const remote = new Set<string>();
  const dir = mkdtempSync(join(tmpdir(), "toolkit-"));
  const store = new BotStore({ dir, owner: "u1", mind: { async list() { return [...remote].map((slug) => ({ slug })); }, async create(slug) { remote.add(slug); }, async remove(slug) { remote.delete(slug); } } });
  const hub = new RoutineHub(dir);
  const threads = new Map<string, Th[]>();
  const started: { bot: string; title?: string; message?: string }[] = [];
  const ops: ThreadOps = {
    list: (b, all) => (threads.get(b) ?? []).filter((t) => all || !t.archived),
    async rename(b, id, title) { const t = (threads.get(b) ?? []).find((x) => x.id === id); if (t) t.title = title; return !!t; },
    async archive(b, id, on) { const t = (threads.get(b) ?? []).find((x) => x.id === id); if (t) { if (on) t.archived = true; else delete t.archived; } return !!t; },
  };
  const hooks: BotManageHooks = o.hooks ?? {
    async models() { return MODELS; },
    publicBase: () => "https://daebot.live",
    async startThread(_owner, botId, x) {
      started.push({ bot: botId, title: x.title, message: x.message });
      const id = "t" + (threads.get(botId)?.length ?? 0);
      const title = x.title || "New thread";
      threads.set(botId, [...(threads.get(botId) ?? []), { id, title, updatedAt: Date.now(), surface: "web" }]);
      return { id, title, started: !!x.message };
    },
  };
  const t = createBotManageTool({ bots: store, owner: "u1", hooks: () => hooks, threads: (id) => (threads.get(id) ?? []).filter((x) => !x.archived).length, routines: hub, threadOps: ops, selfBot: o.selfBot });
  const run = (args: Record<string, unknown>, origin?: "user" | "bot") => t.run(args, { cwd: "/", sessionId: "s", origin });
  const ok = async (args: Record<string, unknown>) => { const r = await run(args); assert.equal(r.ok, true, `${JSON.stringify(args)} -> ${r.output}`); return JSON.parse(r.output); };
  const bad = async (args: Record<string, unknown>, re: RegExp) => { const r = await run(args); assert.equal(r.ok, false, JSON.stringify(args)); assert.match(r.output, re); };
  return { store, hub, t, run, ok, bad, threads, started, dir };
}

test("get returns settings, instructions and routines; rename, set_face, set_color, set_purpose and set_model each change just that field", async () => {
  const r = rig();
  await r.ok({ action: "create", slug: "scout", name: "Scout", purpose: "finds leads", instructions: INSTR });
  const g = await r.ok({ action: "get", slug: "scout" });
  assert.equal(g.bot.name, "Scout");
  assert.equal(g.instructions, INSTR);
  assert.deepEqual(g.routines.map((x: any) => x.name), ["Heartbeat"]);
  await r.ok({ action: "rename", slug: "scout", name: "Scout Prime" });
  await r.ok({ action: "set_face", slug: "scout", face: "analyst" });
  await r.ok({ action: "set_color", slug: "scout", color: "#3b82f6" });
  await r.ok({ action: "set_purpose", slug: "scout", purpose: "finds and ranks leads" });
  await r.ok({ action: "set_model", slug: "scout", model: "m/pro" });
  const b = r.store.bySlug("scout")!;
  assert.deepEqual([b.name, b.face, b.color, b.purpose, b.model], ["Scout Prime", "analyst", "#3b82f6", "finds and ranks leads", "m/pro"]);
  assert.equal(r.store.instructions(b.id), INSTR, "instructions untouched");
  await r.ok({ action: "set_model", slug: "scout", model: "" });
  assert.equal(r.store.bySlug("scout")!.model, undefined);
  await r.bad({ action: "rename", slug: "scout" }, /rename needs name/);
  await r.bad({ action: "set_face", slug: "scout", face: "wizard" }, /not a face id/);
  await r.bad({ action: "set_color", slug: "scout", color: "blue" }, /color must look like/);
  await r.bad({ action: "set_model", slug: "scout", model: "nope/none" }, /not in the user's model list/);
  await r.bad({ action: "get", slug: "ghost" }, /no bot "ghost"/);
});

test("pin and unpin", async () => {
  const r = rig();
  await r.ok({ action: "create", slug: "scout", name: "Scout" });
  await r.ok({ action: "pin", slug: "scout" });
  assert.ok(r.store.bySlug("scout")!.pinnedAt);
  assert.equal((await r.ok({ action: "get", slug: "scout" })).bot.pinned, true);
  await r.ok({ action: "unpin", slug: "scout" });
  assert.equal(r.store.bySlug("scout")!.pinnedAt, undefined);
});

test("instructions: read, write (replace), append and patch, with every refusal", async () => {
  const r = rig();
  await r.ok({ action: "create", slug: "scout", name: "Scout", instructions: INSTR });
  const id = r.store.bySlug("scout")!.id;
  const rd = await r.ok({ action: "read_instructions", slug: "scout" });
  assert.equal(rd.instructions, INSTR);
  assert.equal(rd.maxBytes, 8192);
  await r.ok({ action: "append_instructions", slug: "scout", text: "# Voice\n- Plain words." });
  assert.equal(r.store.instructions(id), INSTR.trimEnd() + "\n\n# Voice\n- Plain words.\n");
  await r.ok({ action: "patch_instructions", slug: "scout", find: "find leads", replace_with: "find and rank leads" });
  assert.match(r.store.instructions(id), /Your job: find and rank leads\./);
  await r.bad({ action: "patch_instructions", slug: "scout", find: "nothing like this", replace_with: "x" }, /does not appear/);
  await r.bad({ action: "patch_instructions", slug: "scout", find: "- ", replace_with: "* " }, /appears \d+ times/);
  await r.ok({ action: "patch_instructions", slug: "scout", find: "- ", replace_with: "* ", all: true });
  assert.ok(!r.store.instructions(id).includes("- "));
  await r.bad({ action: "patch_instructions", slug: "scout", find: "Guess" }, /needs replace_with/);
  await r.bad({ action: "patch_instructions", slug: "scout", replace_with: "x" }, /needs find/);
  await r.bad({ action: "append_instructions", slug: "scout", text: "  " }, /needs text/);
  await r.bad({ action: "append_instructions", slug: "scout", text: "x".repeat(9000) }, /capped at 8 KB/);
  await r.ok({ action: "write_instructions", slug: "scout", instructions: INSTR });
  assert.equal(r.store.instructions(id), INSTR, "write_instructions replaces everything");
  await r.bad({ action: "write_instructions", slug: "scout" }, /needs instructions/);
  await r.bad({ action: "write_instructions", slug: "scout", instructions: "  " }, /non-empty/);
});

test("threads: list, create (with and without a first message), rename, archive, unarchive; a thread of another bot is refused", async () => {
  const r = rig();
  await r.ok({ action: "create", slug: "scout", name: "Scout" });
  await r.ok({ action: "create", slug: "other", name: "Other" });
  const bid = r.store.bySlug("scout")!.id;
  const a = await r.ok({ action: "create_thread", slug: "scout" });
  assert.equal(a.thread.title, "New thread");
  assert.equal(a.thread.started, false);
  const b = await r.ok({ action: "create_thread", slug: "scout", title: "Lead sweep", message: "Find 5 leads in Boston." });
  assert.equal(b.thread.started, true);
  assert.deepEqual(r.started.at(-1), { bot: bid, title: "Lead sweep", message: "Find 5 leads in Boston." });
  assert.deepEqual((await r.ok({ action: "list_threads", slug: "scout" })).threads.map((x: any) => x.title), ["New thread", "Lead sweep"]);
  assert.equal((await r.ok({ action: "get", slug: "scout" })).bot.threads, 2);
  await r.ok({ action: "rename_thread", slug: "scout", thread: a.thread.id, title: "Inbox" });
  await r.ok({ action: "archive_thread", slug: "scout", thread: a.thread.id });
  assert.deepEqual((await r.ok({ action: "list_threads", slug: "scout" })).threads.map((x: any) => x.title), ["Lead sweep"]);
  const all = (await r.ok({ action: "list_threads", slug: "scout", archived: true })).threads;
  assert.deepEqual(all.map((x: any) => [x.title, !!x.archived]), [["Inbox", true], ["Lead sweep", false]]);
  await r.ok({ action: "unarchive_thread", slug: "scout", thread: a.thread.id });
  assert.equal((await r.ok({ action: "list_threads", slug: "scout" })).threads.length, 2);
  await r.bad({ action: "rename_thread", slug: "other", thread: a.thread.id, title: "x" }, /no thread/);
  await r.bad({ action: "archive_thread", slug: "scout", thread: "nope" }, /no thread "nope"/);
  await r.bad({ action: "rename_thread", slug: "scout", thread: a.thread.id }, /title must be/);
  await r.bad({ action: "rename_thread", slug: "scout", title: "x" }, /needs thread/);
  await r.bad({ action: "create_thread", slug: "scout", title: "x".repeat(81) }, /title must be/);
});

test("routines on ANY bot, pause and resume, weekdays-only hourly with active hours", async () => {
  const r = rig();
  await r.ok({ action: "create", slug: "scout", name: "Scout" });
  await r.ok({ action: "create", slug: "other", name: "Other" });
  const add = await r.ok({ action: "add_routine", slug: "other", name: "Hourly", prompt: "Check the pipeline.", kind: "timed", expression: "0 * * * *", tz: "America/New_York", weekdays_only: true, active_from: "09:00", active_to: "17:00" });
  assert.match(add.added.when, /hour/i);
  assert.match(add.added.summary, /Weekdays/);
  assert.match(add.added.summary, /9 AM/);
  assert.deepEqual(add.added.timing.filter, { weekdays: true, from: "09:00", to: "17:00" });
  assert.equal((await r.ok({ action: "list_routines", slug: "scout" })).routines.length, 1, "other's routine is not scout's");
  const p = await r.ok({ action: "pause_routine", slug: "other", routine: "Hourly" });
  assert.equal(p.updated.enabled, false);
  assert.equal(r.hub.book("u1", r.store.bySlug("other")!.id).list().find((x) => x.name === "Hourly")!.enabled, false);
  const s = await r.ok({ action: "resume_routine", slug: "other", routine: "Hourly" });
  assert.equal(s.updated.enabled, true);
  await r.ok({ action: "update_routine", slug: "other", routine: "Hourly", prompt: "Check pipeline and stalled deals." });
  await r.ok({ action: "update_routine", slug: "scout", routine: "Heartbeat", enabled: false });
  await r.bad({ action: "pause_routine", slug: "other" }, /needs routine/);
  await r.ok({ action: "remove_routine", slug: "other", routine: "Hourly" });
  assert.equal((await r.ok({ action: "list_routines", slug: "other" })).routines.length, 1);
});

test("run_routine_now goes through the gateway's runner", async () => {
  const ran: string[] = [];
  const r = rig({ hooks: { async runRoutine(_o, _b, id) { ran.push(id); return { ok: true, message: "Ran (ok)" }; }, publicBase: () => "https://daebot.live" } });
  await r.ok({ action: "create", slug: "scout", name: "Scout" });
  const id = JSON.parse((await r.run({ action: "add_routine", slug: "scout", name: "Tick", prompt: "x", kind: "timed", expression: "*/5 * * * *" })).output).added.id;
  const n = await r.run({ action: "run_routine_now", slug: "scout", routine: "Tick" });
  assert.equal(n.ok, true);
  assert.deepEqual(ran, [id]);
});

test("classes: reads are read, every edit is write, delete and remove_routine are irreversible; a message from another bot changes nothing", async () => {
  const r = rig();
  for (const a of ["list", "get", "faces", "models", "read_instructions", "list_threads", "list_routines"]) assert.equal(r.t.classFor!({ action: a }), "read", a);
  for (const a of ["create", "update", "rename", "set_face", "set_color", "set_purpose", "set_model", "pin", "unpin", "write_instructions", "append_instructions", "patch_instructions", "create_thread", "rename_thread", "archive_thread", "unarchive_thread", "add_routine", "update_routine", "pause_routine", "resume_routine", "run_routine_now"]) assert.equal(r.t.classFor!({ action: a }), "write", a);
  for (const a of ["delete", "remove_routine"]) assert.equal(r.t.classFor!({ action: a }), "irreversible", a);
  await r.ok({ action: "create", slug: "scout", name: "Scout", instructions: INSTR });
  for (const args of [{ action: "rename", slug: "scout", name: "X" }, { action: "append_instructions", slug: "scout", text: "x" }, { action: "create_thread", slug: "scout" }, { action: "pause_routine", slug: "scout", routine: "Heartbeat" }, { action: "pin", slug: "scout" }]) {
    const x = await r.run(args, "bot");
    assert.equal(x.ok, false, JSON.stringify(args));
    assert.match(x.output, /another bot cannot/);
  }
  assert.equal(r.store.bySlug("scout")!.name, "Scout");
  assert.equal((await r.run({ action: "read_instructions", slug: "scout" }, "bot")).ok, true, "reads still work");
});

test("self: a bot's session edits ITSELF through slug self (or its own slug) and nothing else", async () => {
  const main = rig();
  await main.ok({ action: "create", slug: "scout", name: "Scout", instructions: INSTR });
  await main.ok({ action: "create", slug: "other", name: "Other" });
  const id = main.store.bySlug("scout")!.id;
  // the same stores, seen from scout's own session
  const hooks: BotManageHooks = { async models() { return MODELS; }, publicBase: () => "https://daebot.live", async startThread(_o, b, x) { return { id: "t9", title: x.title ?? "New thread", started: !!x.message }; } };
  const self = createBotManageTool({ bots: main.store, owner: "u1", hooks: () => hooks, threads: () => 0, routines: main.hub, threadOps: { list: () => [], rename: async () => true, archive: async () => true }, selfBot: id });
  const run = async (args: Record<string, unknown>) => { const x = await self.run(args, { cwd: "/", sessionId: "s" }); return { ...x, j: x.ok ? JSON.parse(x.output) : null }; };
  assert.equal((await run({ action: "rename", slug: "self", name: "Scout Two" })).ok, true);
  assert.equal(main.store.bySlug("scout")!.name, "Scout Two");
  assert.equal((await run({ action: "set_color", color: "#112233" })).ok, true, "slug may be left out: it is itself");
  assert.equal((await run({ action: "set_face", slug: "scout", face: "coach" })).ok, true, "its own slug works too");
  assert.equal((await run({ action: "append_instructions", slug: "self", text: "# Style\n- Brief." })).ok, true);
  assert.match(main.store.instructions(id), /# Style\n- Brief\./);
  assert.equal((await run({ action: "read_instructions", slug: "self" })).j.bot, "scout");
  const rt = await run({ action: "add_routine", slug: "self", name: "Morning", prompt: "Plan the day.", kind: "timed", expression: "0 9 * * 1-5", tz: "America/New_York" });
  assert.equal(rt.ok, true, rt.output);
  assert.equal((await run({ action: "pause_routine", slug: "self", routine: "Morning" })).j.updated.enabled, false);
  assert.equal((await run({ action: "create_thread", slug: "self", title: "Plan" })).j.thread.title, "Plan");
  // not anyone else, and no creating or deleting
  const other = await run({ action: "rename", slug: "other", name: "Hijacked" });
  assert.equal(other.ok, false);
  assert.match(other.output, /only change itself/);
  assert.equal(main.store.bySlug("other")!.name, "Other");
  assert.match((await run({ action: "create", slug: "kid", name: "Kid" })).output, /cannot create or delete/);
  assert.match((await run({ action: "delete", slug: "self" })).output, /cannot create or delete/);
  assert.ok(main.store.bySlug("scout"));
  assert.equal((await run({ action: "list" })).ok, true, "reads of the roster still work");
  // the main Daebot is not a bot: self means nothing there
  await main.bad({ action: "rename", slug: "self", name: "x" }, /"self" means the bot you are running as/);
});

test("bot_self threads needs NO thread argument (the Heartbeat defect): bare call lists all, a thread id only narrows, continue still needs one", async () => {
  const rows = [{ id: "a1", title: "One", updatedAt: 1, state: "answered", tasks: [] }, { id: "a2", title: "Two", updatedAt: 2, state: "user message not answered", tasks: [] }];
  const t = createBotSelfTool({ threads: async () => rows, isHeartbeat: () => true, continueThread: async () => "resumed", stopThread: async () => "stopped", learn: async () => ({ ok: true, text: "ok" }) });
  const run = (args: Record<string, unknown>) => t.run(args, { cwd: "/", sessionId: "hb" });
  const bare = await run({ action: "threads" });
  assert.equal(bare.ok, true, bare.output);
  assert.deepEqual(JSON.parse(bare.output).threads.map((x: any) => x.id), ["a1", "a2"]);
  assert.deepEqual(JSON.parse((await run({ action: "threads", thread: "a2" })).output).threads.map((x: any) => x.id), ["a2"]);
  assert.equal(JSON.parse((await run({ action: "threads", thread: "zzz" })).output).threads.length, 2, "an unknown id never makes it fail");
  assert.match((await run({ action: "continue", note: "go" })).output, /needs a thread id/);
  const d = t.spec.description;
  assert.match(d, /threads \{\}/);
  assert.match(d, /NO other argument/);
});

test("the system prompt lists the toolkit (main session and bot session), and the Heartbeat prompt tells the model threads takes no id", async () => {
  const names = ["bot_manage"];
  const main = composeSystemPrompt({ tier: "admin", bootContext: "", surface: "web", cwd: "/", model: "m", toolNames: names, botManage: true });
  assert.ok(main.includes(BOT_TOOLKIT_PROMPT));
  assert.match(main, /## Creating a Daebot/);
  for (const w of ["create_thread", "patch_instructions", "pause_routine", "set_color", "archive_thread", "unpin", "Never tell the user you cannot"]) assert.ok(main.includes(w), w);
  const bot = composeSystemPrompt({ tier: "admin", bootContext: "", surface: "web", cwd: "/", model: "m", toolNames: names, botManage: true, bot: { slug: "scout", instructions: INSTR, base: "", face: undefined } });
  assert.ok(bot.includes(BOT_TOOLKIT_PROMPT) && bot.includes('slug "self"'));
  assert.ok(!bot.includes("## Creating a Daebot"), "a bot does not create bots");
  const none = composeSystemPrompt({ tier: "admin", bootContext: "", surface: "web", cwd: "/", model: "m", toolNames: [], botManage: false });
  assert.ok(!none.includes("Managing bots"));
  const { HEARTBEAT_PROMPT } = await import("../../src/routines/store.ts");
  assert.match(HEARTBEAT_PROMPT, /\{"action":"threads"\} \(no other argument/);
});

// ---------------------------------------------------------------- through the real runtime and gateway

async function world(replies: ConstructorParameters<typeof FakeProvider>[0]) {
  const key = "mind_" + randomBytes(16).toString("hex");
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "toolkit-gw-"));
  const provider = new FakeProvider(replies);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const bots = { dir, bus: {} };
  const store = createFileStore(dir);
  const runtime = createRuntime(cfg, { provider, store, bots });
  const st = tmpStatic();
  const gw = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots });
  const a = bearer(gw.token);
  const j = async (m: string, p: string, body?: unknown) => { const r = await http(gw.url, m, p, { headers: a, body }); return { status: r.status, json: r.body ? JSON.parse(r.body) : {} }; };
  return { gw, provider, runtime, store, j, close: async () => { await gw.close(); await fake.close(); } };
}
const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

test("through the gateway: Daebot creates a bot, opens threads (empty and with a first message), renames, archives and restores them; the sidebar list follows", async () => {
  const w = await world([
    { calls: [call("1", "bot_manage", { action: "create", slug: "toolcheck", name: "Toolkit Check", purpose: "checks the toolkit", color: "#3b82f6", face: "analyst" })] },
    { calls: [call("2", "bot_manage", { action: "create_thread", slug: "toolcheck", title: "Empty one" })] },
    { calls: [call("3", "bot_manage", { action: "create_thread", slug: "toolcheck", title: "Working one", message: "Say hello in one word." })] },
    { text: "done" }, { text: "done" }, { text: "done" },
  ]);
  try {
    const main = await w.gw.open("web", "owner chat", { identity: "admin" });
    await collect(main.send("set up a test bot with two threads"));
    const bot = w.runtime.bots!.bySlug("toolcheck")!;
    assert.equal(bot.color, "#3b82f6");
    const list = async (q = "") => (await w.j("GET", `/sessions?bot=${bot.id}${q}`)).json.sessions as { id: string; title: string; archived?: boolean }[];
    await until(() => w.store.list().filter((m) => m.bot === bot.id).length >= 2);
    const titles = (await list()).map((s) => s.title).sort();
    assert.deepEqual(titles, ["Empty one", "Working one"], "both threads are in the sidebar's list for that bot");
    // the one with a message really ran a turn in the bot's thread
    const working = (await list()).find((s) => s.title === "Working one")!;
    await until(() => (w.runtime.history?.(working.id) ?? []).some((e) => e.type === "user"));
    assert.ok((w.runtime.history!(working.id) ?? []).some((e) => e.type === "user" && /Say hello/.test(e.text)));
    const empty = (await list()).find((s) => s.title === "Empty one")!;
    // direct runtime calls are what the tool's ThreadOps call
    assert.equal(await w.runtime.renameSession!(empty.id, "Renamed"), true);
    assert.equal(await w.runtime.archiveSession!(empty.id, true), true);
    assert.deepEqual((await list()).map((s) => s.title), ["Working one"], "archived threads leave the list");
    assert.equal(w.runtime.listSessions().find((s) => s.id === empty.id)!.archived, true, "but nothing is deleted");
    assert.equal(await w.runtime.archiveSession!(empty.id, false), true);
    assert.deepEqual((await list()).map((s) => s.title).sort(), ["Renamed", "Working one"]);
    assert.equal(await w.runtime.archiveSession!("nope", true), false);
  } finally { await w.close(); }
});

test("through the runtime: a bot's own session has bot_manage (self only) and the toolkit prompt; its tool edits itself", async () => {
  const w = await world([
    { calls: [call("1", "bot_manage", { action: "rename", slug: "self", name: "Renamed By Me" }), call("2", "bot_manage", { action: "rename", slug: "main-thing", name: "Nope" })] },
    { text: "ok" },
  ]);
  try {
    const bot = await w.runtime.bots!.create({ slug: "me", name: "Me", purpose: "tests" });
    const s = await w.runtime.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    const ev = await collect(s.send("rename yourself"));
    const req = w.provider.requests[0];
    assert.ok(req.tools.some((t) => t.name === "bot_manage"), "bots have the toolkit");
    assert.ok(req.messages[0].content.includes(BOT_TOOLKIT_PROMPT));
    assert.equal(w.runtime.bots!.get(bot.id)!.name, "Renamed By Me");
    const ends = ev.filter((e) => e.type === "toolEnd") as any[];
    assert.deepEqual(ends.map((e) => e.ok), [true, false], "itself yes, anyone else no");
  } finally { await w.close(); }
});
