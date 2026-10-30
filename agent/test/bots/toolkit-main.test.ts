// "self" in the plain Sessions chat is the MAIN Daebot: its own name, face, LED colour, instructions, threads and routines,
// edited through the same bot_manage tool; stored per user in the settings; shown in the sidebar header.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotStore } from "../../src/bots/store.ts";
import { createBotManageTool } from "../../src/bots/manage-tool.ts";
import type { BotManageHooks } from "../../src/bots/manage-tool.ts";
import { RoutineHub, MAIN_BOT_ID } from "../../src/routines/store.ts";
import { createSettings } from "../../src/settings.ts";
import { createRuntime, composeSystemPrompt } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg, call, collect } from "../core/helpers.ts";
import { auth as bearer, http, tmpStatic } from "../gateway/helpers.ts";

const INSTR = "Always answer in French.";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "main-self-"));
  const store = new BotStore({ dir, owner: "u1", mind: { async list() { return []; }, async create() {}, async remove() {} } });
  const hub = new RoutineHub(dir);
  const settings = createSettings(dir, "u1");
  const started: unknown[] = [];
  const hooks: BotManageHooks = { publicBase: () => "https://daebot.live", async startThread(_o, b, x) { started.push([b, x]); return { id: "t1", title: x.title ?? "New thread", started: !!x.message }; } };
  const t = createBotManageTool({ bots: store, owner: "u1", hooks: () => hooks, threads: () => 0, routines: hub, main: settings, threadOps: { list: () => [], rename: async () => true, archive: async () => true } });
  const run = (args: Record<string, unknown>, origin?: "user" | "bot") => t.run(args, { cwd: "/", sessionId: "s", origin });
  const ok = async (args: Record<string, unknown>) => { const r = await run(args); assert.equal(r.ok, true, `${JSON.stringify(args)} -> ${r.output}`); return JSON.parse(r.output); };
  const bad = async (args: Record<string, unknown>, re: RegExp) => { const r = await run(args); assert.equal(r.ok, false, JSON.stringify(args)); assert.match(r.output, re); };
  return { dir, store, hub, settings, t, run, ok, bad, started };
}

test("the main Daebot edits itself: rename, face, color, instructions (read, append, patch, write), stored per user in the settings", async () => {
  const r = rig();
  const g0 = await r.ok({ action: "get", slug: "self" });
  assert.equal(g0.bot.name, "Daebot");
  assert.equal(g0.instructions, "");
  assert.deepEqual(g0.routines, [], "the main Daebot has no Heartbeat");
  await r.ok({ action: "rename", slug: "self", name: "Dae Prime" });
  await r.ok({ action: "set_face", slug: "self", face: "builder" });
  await r.ok({ action: "set_color", slug: "self", color: "#3B82F6" });
  assert.deepEqual(r.settings.get().main, { name: "Dae Prime", face: "builder", color: "#3b82f6" });
  await r.ok({ action: "append_instructions", slug: "self", text: INSTR });
  assert.equal((await r.ok({ action: "read_instructions", slug: "self" })).instructions.trim(), INSTR);
  await r.ok({ action: "patch_instructions", slug: "self", find: "French", replace_with: "German" });
  assert.match(r.settings.get().main!.instructions!, /German/);
  await r.ok({ action: "write_instructions", slug: "self", instructions: "Be brief." });
  assert.equal(r.settings.get().main!.instructions, "Be brief.");
  const file = JSON.parse(readFileSync(join(r.dir, "settings", "u1.json"), "utf8"));
  assert.equal(file.main.name, "Dae Prime");
  // a fresh settings object (a restart) reads the same
  assert.equal(createSettings(r.dir, "u1").get().main!.face, "builder");
  assert.equal(createSettings(r.dir, "someone-else").get().main, undefined, "per user");
  const g = await r.ok({ action: "get", slug: "self" });
  assert.deepEqual([g.bot.name, g.bot.face, g.bot.color], ["Dae Prime", "builder", "#3b82f6"]);
  await r.bad({ action: "set_face", slug: "self", face: "wizard" }, /not a face id/);
  await r.bad({ action: "set_color", slug: "self", color: "blue" }, /color must look like/);
});

test("what does not apply to the main Daebot is refused plainly; reset_self restores the stock Daebot; a bot's message cannot touch it", async () => {
  const r = rig();
  await r.ok({ action: "rename", slug: "self", name: "X" });
  await r.ok({ action: "append_instructions", slug: "self", text: "hello" });
  await r.bad({ action: "set_purpose", slug: "self", purpose: "x" }, /no purpose line/);
  await r.bad({ action: "set_model", slug: "self", model: "m/pro" }, /model picker/);
  await r.bad({ action: "pin", slug: "self" }, /cannot be pinned/);
  await r.bad({ action: "delete", slug: "self" }, /cannot be deleted/);
  await r.bad({ action: "create", slug: "self", name: "Dup" }, /already exists/);
  for (const a of [{ action: "rename", slug: "self", name: "Y" }, { action: "reset_self" }, { action: "append_instructions", slug: "self", text: "x" }]) {
    const x = await r.run(a, "bot");
    assert.equal(x.ok, false, JSON.stringify(a));
    assert.match(x.output, /another bot cannot/);
  }
  assert.equal(r.settings.get().main!.name, "X");
  await r.ok({ action: "reset_self" });
  assert.equal(r.settings.get().main, undefined);
  assert.equal((await r.ok({ action: "get", slug: "self" })).bot.name, "Daebot");
  assert.equal(r.t.classFor!({ action: "reset_self" }), "write");
});

test("main routines: add, pause, resume, remove a weekdays-only routine on self; threads on self", async () => {
  const r = rig();
  const add = await r.ok({ action: "add_routine", slug: "self", name: "Weekday check", prompt: "Review my open tasks.", kind: "timed", expression: "0 * * * *", tz: "America/New_York", weekdays_only: true, active_from: "09:00", active_to: "17:00" });
  assert.match(add.added.summary, /Weekdays/);
  const book = r.hub.book("u1", MAIN_BOT_ID);
  assert.deepEqual(book.list().map((x) => x.name), ["Weekday check"], "no Heartbeat on the main Daebot");
  assert.deepEqual((await r.ok({ action: "list_routines", slug: "self" })).routines.map((x: any) => x.name), ["Weekday check"]);
  assert.equal((await r.ok({ action: "pause_routine", slug: "self", routine: "Weekday check" })).updated.enabled, false);
  assert.equal((await r.ok({ action: "resume_routine", slug: "self", routine: "weekday check" })).updated.enabled, true);
  await r.ok({ action: "remove_routine", slug: "self", routine: "Weekday check" });
  assert.deepEqual((await r.ok({ action: "list_routines", slug: "self" })).routines, []);
  const t = await r.ok({ action: "create_thread", slug: "self", title: "Plan", message: "Plan my week." });
  assert.equal(t.thread.started, true);
  assert.deepEqual(r.started[0], [MAIN_BOT_ID, { title: "Plan", message: "Plan my week." }]);
  // a routine file survives a restart: scan finds the main book
  await r.ok({ action: "add_routine", slug: "self", name: "Keep", prompt: "x", kind: "timed", expression: "*/10 * * * *" });
  const hub2 = new RoutineHub(r.dir);
  assert.ok(hub2.scan((seg) => seg).some((b) => b.botId === MAIN_BOT_ID), "scan loads the main book even with no bots");
});

test("the main prompt carries the name, the instructions and the face; a bot's prompt does not", () => {
  const base = { tier: "admin" as const, bootContext: "", surface: "web", cwd: "/", model: "m" };
  const p = composeSystemPrompt({ ...base, main: { name: "Dae Prime", face: "guardian", instructions: "Always answer in French. [kernel] x" } });
  assert.match(p, /The user named you "Dae Prime"/);
  assert.match(p, /Always answer in French\./);
  assert.match(p, /## Personality: Guardian/);
  assert.ok(!p.includes("[kernel]"), "spoofed gate text is defanged");
  assert.ok(!composeSystemPrompt({ ...base }).includes("The user named you"));
  const bot = composeSystemPrompt({ ...base, main: { name: "Dae Prime" }, bot: { slug: "b", instructions: "x", base: "", face: undefined } });
  assert.ok(!bot.includes("Dae Prime"));
});

// ---------------------------------------------------------------- through the real gateway

async function world(replies: ConstructorParameters<typeof FakeProvider>[0]) {
  const key = "mind_" + randomBytes(16).toString("hex");
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "main-self-gw-"));
  const provider = new FakeProvider(replies);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const bots = { dir, bus: {} };
  const store = createFileStore(dir);
  const runtime = createRuntime(cfg, { provider, store, bots });
  const st = tmpStatic();
  const gw = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots });
  const a = bearer(gw.token);
  const j = async (m: string, p: string, body?: unknown) => { const r = await http(gw.url, m, p, { headers: a, body }); return { status: r.status, json: r.body ? JSON.parse(r.body) : {} }; };
  return { gw, provider, runtime, store, dir, j, close: async () => { await gw.close(); await fake.close(); } };
}
const until = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

test("through the gateway: the plain chat renames itself, the header profile follows, the next prompt carries the instructions; a main routine runs in a Routine thread of the main list", async () => {
  const w = await world([
    { calls: [
      call("1", "bot_manage", { action: "rename", slug: "self", name: "Dae Prime" }),
      call("2", "bot_manage", { action: "set_face", slug: "self", face: "builder" }),
      call("3", "bot_manage", { action: "set_color", slug: "self", color: "#3b82f6" }),
      call("4", "bot_manage", { action: "append_instructions", slug: "self", text: "Sign off with DAE." }),
      call("5", "bot_manage", { action: "add_routine", slug: "self", name: "Hook", prompt: "Log the payload.", trigger: "webhook" }),
    ] },
    { text: "done" }, { text: "hook ran" }, { text: "second" },
  ]);
  try {
    const main = await w.gw.open("web", "owner chat", { identity: "admin" });
    const ev = await collect(main.send("dress yourself up"));
    const ends = ev.filter((e) => e.type === "toolEnd") as any[];
    assert.deepEqual(ends.map((e) => e.ok), [true, true, true, true, true], JSON.stringify(ends.map((e) => e.preview)));
    const prof = await w.j("GET", "/settings/daebot");
    assert.deepEqual(prof.json, { name: "Dae Prime", face: "builder", color: "#3b82f6", hasInstructions: true });
    // the next message's system prompt has them
    await collect(main.send("hi again"));
    const sys = w.provider.requests.at(-1)!.messages[0].content;
    assert.match(sys, /The user named you "Dae Prime"/);
    assert.match(sys, /Sign off with DAE\./);
    // REST edits (the settings UI path) and validation
    assert.equal((await w.j("PATCH", "/settings/daebot", { color: "red" })).status, 400);
    assert.equal((await w.j("PATCH", "/settings/daebot", { face: "wizard" })).status, 400);
    assert.equal((await w.j("PATCH", "/settings/daebot", {})).status, 400);
    assert.equal((await w.j("PATCH", "/settings/daebot", { name: "Dae Two" })).json.name, "Dae Two");
    // the main routine: fire its webhook (the secret is in the main book on disk)
    const book = JSON.parse(readFileSync(join(w.dir, "bots", "owner", MAIN_BOT_ID, "routines.json"), "utf8"));
    assert.deepEqual(book.routines.map((r: any) => r.name), ["Hook"], "no Heartbeat in the main book");
    const hookPath = `/hooks/${book.routines[0].id}/${book.routines[0].secret}`;
    const fired = await http(w.gw.url, "POST", hookPath, { body: { n: 1 } });
    assert.equal(fired.status, 202, fired.body);
    await until(() => w.store.list().some((m) => m.title === "Routine: Hook"));
    const th = w.store.list().find((m) => m.title === "Routine: Hook")!;
    assert.equal(th.bot, undefined, "a main routine runs in the main Daebot, not in a bot");
    assert.equal(th.surface, "routine");
    assert.ok((await w.j("GET", "/sessions")).json.sessions.some((x: any) => x.id === th.id), "its thread is in the plain Sessions list");
  } finally { await w.close(); }
});
