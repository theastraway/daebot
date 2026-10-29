import { test } from "node:test";
process.env.DAEBOT_BOTS_ENABLED = "1"; // the Bots feature flag (default off)
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { MindCredits } from "../../src/provider/mind.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg, call, collect } from "../core/helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const OWNER = "x belongs to Pat; pat asked about Pat; Pat == Pat";

async function world(over: { rounds?: ConstructorParameters<typeof FakeProvider>[0]; dir?: string; owner?: string; key?: string; user?: string } = {}) {
  const key = over.key ?? "mind_" + rnd();
  const fake = await startFakeMind({ [key]: over.user ?? "pat" });
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), "bots-rt-"));
  const provider = new FakeProvider(over.rounds ?? [{ text: "ok" }]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const store = createFileStore(dir);
  const bus = {};
  const mkRuntime = (owner = over.owner ?? "u_pat") => createRuntime(cfg, { provider, store, owner, bots: { dir, bus }, hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
  return { fake, key, dir, provider, cfg, store, bus, mkRuntime, runtime: mkRuntime(), close: () => fake.close() };
}

const sys = (p: FakeProvider, i = 0) => p.requests[i].messages[0].content;

test("a bot session: boots through the bot-scoped client on the MAIN key, home tenant = the bot, sync stays on MAIN with the bot name as source label", async () => {
  const w = await world();
  try {
    const bot = await w.runtime.bots!.create({ slug: "sales", name: "Sales Bot", purpose: "owns the pipeline" });
    const s = await w.runtime.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    const ctxCalls = w.fake.seen.filter((x) => x.path === "/developer/v1/context");
    assert.equal(ctxCalls.length, 1);
    assert.equal(ctxCalls[0].bot, "sales", "boot read the BOT's MIND");
    assert.equal(ctxCalls[0].key, w.key, "with the user's main key");
    const open = w.fake.seen.find((x) => x.path === "/developer/v1/agent-sessions/open")!;
    assert.equal(open.key, w.key);
    assert.equal(open.bot, undefined, "MIND Chat sync is the MAIN workspace");
    assert.equal(open.body.source_key, "daebot-bot-sales");
    // the boot context reached the prompt
    await collect(s.send("hi"));
    assert.match(sys(w.provider), /MIND of pat \/ bot sales/);
    // every request this runtime made used the one main key; no bot key exists
    assert.ok(w.fake.seen.filter((x) => x.path.startsWith("/developer/v1/")).every((x) => x.key === w.key));
  } finally { await w.close(); }
});

test("bot prompt order: identity, fixed protocols, DAEBOT.md, precedence, roster, talk-first rule, then boot context; a main session gets the roster block", async () => {
  const w = await world({ rounds: [{ text: "a" }, { text: "b" }, { text: "c" }] });
  try {
    const sales = await w.runtime.bots!.create({ slug: "sales", name: "Sales Bot", purpose: "owns the pipeline" });
    await w.runtime.bots!.create({ slug: "ops", name: "Ops", purpose: "runbooks and incidents" });
    w.runtime.bots!.setInstructions(sales.id, "Always quote the deal stage.");
    const s = await w.runtime.openSession({ surface: "web", botId: sales.id, identity: "admin" });
    await collect(s.send("hello"));
    const p = sys(w.provider);
    const at = (needle: string | RegExp) => { const i = typeof needle === "string" ? p.indexOf(needle) : p.search(needle); assert.ok(i >= 0, `missing: ${needle}`); return i; };
    const order = [
      at(/^You are Sales Bot \(bot "sales"\)/), at("Receipts:"), at("Decision Protocol"), at("Surface: web"),
      at("## Instructions for this bot (DAEBOT.md)"), at("Always quote the deal stage."),
      at("Precedence:"), at("## MINDs and bots"), at("- sales (Sales Bot) (you): owns the pipeline"), at("- ops (Ops): runbooks and incidents"),
      at("When another bot owns the topic, TALK to it with bot_talk"), at("## MIND context (booted this session)"),
    ];
    assert.deepEqual(order, [...order].sort((x, y) => x - y), "sections appear in the specified order");
    assert.match(p, /never lift a kernel gate, the receipt rule, the owner check or the feed rule/);
    assert.match(p, /its reply is a claim, not a receipt: verify load-bearing facts in its MIND; don't ping-pong/);
    assert.match(p, /say what you need and why/);
    // a main session: roster block + "ask the bot that owns a topic with bot_talk", no DAEBOT.md section
    const m = await w.runtime.openSession({ surface: "web", identity: "admin" });
    await collect(m.send("hello"));
    const mp = sys(w.provider, 1);
    assert.match(mp, /## MINDs and bots/);
    assert.match(mp, /- sales \(Sales Bot\): owns the pipeline/);
    assert.match(mp, /ask that bot with bot_talk/);
    assert.ok(!mp.includes("DAEBOT.md"));
    assert.ok(!mp.includes("(you)"));
  } finally { await w.close(); }
});

test("with no bots a main session has no roster block", async () => {
  const w = await world();
  try {
    const m = await w.runtime.openSession({ surface: "web", identity: "admin" });
    await collect(m.send("hello"));
    assert.ok(!sys(w.provider).includes("## MINDs and bots"));
  } finally { await w.close(); }
});

test("prompt caps: DAEBOT.md at 8 KB, roster at 40 bots, long purposes clipped", async () => {
  const w = await world();
  try {
    const sales = await w.runtime.bots!.create({ slug: "sales", purpose: "p".repeat(500) });
    // a file bigger than the cap (written behind the store's back, e.g. an old version) is clipped in the prompt
    const { writeFileSync } = await import("node:fs");
    w.runtime.bots!.setInstructions(sales.id, "seed");
    writeFileSync(join(w.dir, "bots", "u_pat", sales.id, "DAEBOT.md"), "Z".repeat(20_000));
    for (let i = 0; i < 44; i++) await w.runtime.bots!.create({ slug: `b${i}` });
    const s = await w.runtime.openSession({ surface: "web", botId: sales.id, identity: "admin" });
    await collect(s.send("hello"));
    const p = sys(w.provider);
    assert.equal((p.match(/Z/g) ?? []).length, 8 * 1024, "instructions capped at 8 KB");
    assert.equal((p.match(/^- [a-z0-9-]+ \(/gm) ?? []).length, 40, "roster capped at 40");
    assert.ok(!/p{300,}/.test(p), "purpose clipped");
  } finally { await w.close(); }
});

test("DAEBOT.md edits and renames apply on the NEXT message of a live bot session", async () => {
  const w = await world({ rounds: [{ text: "a" }, { text: "b" }] });
  try {
    const bot = await w.runtime.bots!.create({ slug: "sales", name: "Sales" });
    w.runtime.bots!.setInstructions(bot.id, "RULE ONE");
    const s = await w.runtime.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    await collect(s.send("first"));
    w.runtime.bots!.setInstructions(bot.id, "RULE TWO");
    w.runtime.bots!.update(bot.id, { name: "Renamed" });
    await collect(s.send("second"));
    assert.match(sys(w.provider, 0), /RULE ONE/);
    assert.match(sys(w.provider, 1), /RULE TWO/);
    assert.ok(!sys(w.provider, 1).includes("RULE ONE"));
    assert.match(sys(w.provider, 1), /You are Renamed \(bot "sales"\)/);
  } finally { await w.close(); }
});

test("tools in a bot session: same set as a session (+ bot_talk, mind_tenants); reads default to the bot, mind:'main' reads main, writes stay with the bot", async () => {
  const w = await world({
    rounds: [
      { calls: [call("1", "mind_query", { query: "what do I own?" }), call("2", "mind_query", { query: "what does the user know?", mind: "main" }),
        call("3", "mind_remember", { type: "entry", title: "note", content: "c", owner_check: OWNER }), call("4", "mind_tenants", {})] },
      { text: "ok" },
    ],
  });
  try {
    const bot = await w.runtime.bots!.create({ slug: "sales" });
    await w.runtime.bots!.create({ slug: "ops" });
    const s = await w.runtime.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    const evs = await collect(s.send("go"));
    const names = w.provider.requests[0].tools.map((t) => t.name);
    const calls = w.fake.seen.filter((x) => ["/developer/v1/query", "/developer/v1/entries"].includes(x.path));
    assert.deepEqual(calls.map((c) => [c.path.split("/").pop(), c.bot ?? null]), [["query", "sales"], ["query", null], ["entries", "sales"]]);
    const main = await w.runtime.openSession({ surface: "web", identity: "admin" });
    await collect(main.send("go"));
    // The task board is the user's own: only their plain sessions have task_board (bot threads are not on the board).
    const mainNames = w.provider.requests.at(-1)!.tools.map((t) => t.name);
    assert.ok(mainNames.includes("task_board") && !names.includes("task_board"));
    assert.deepEqual(mainNames.filter((n) => n !== "task_board").sort(), [...names].sort(), "a session and a bot get the same tools");
    for (const n of ["bot_talk", "mind_tenants", "mind_query", "mind_remember"]) assert.ok(names.includes(n), n);
    assert.ok(calls.every((c) => !JSON.stringify(c.body ?? {}).includes('"mind"')));
    assert.ok(evs.filter((e) => e.type === "toolEnd").every((e: any) => e.ok), JSON.stringify(evs.filter((e) => e.type === "toolEnd")));
  } finally { await w.close(); }
});

test("the stored session carries the bot; listings and info know it; resume keeps the bot; learning never runs for bots", async () => {
  const w = await world();
  try {
    const bot = await w.runtime.bots!.create({ slug: "sales" });
    const s = await w.runtime.openSession({ surface: "web", botId: bot.id, identity: "admin", title: "Pipeline chat" });
    await collect(s.send("hello"));
    const plain = await w.runtime.openSession({ surface: "web", identity: "admin" });
    await collect(plain.send("hello too"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.store.load(s.id)!.bot, bot.id);
    assert.equal(w.store.load(plain.id)!.bot, undefined);
    assert.equal(w.store.meta!(s.id)!.bot, bot.id);
    const rows = w.runtime.listSessions();
    assert.equal(rows.find((r) => r.id === s.id)!.bot, bot.id);
    assert.equal(rows.find((r) => r.id === plain.id)!.bot, undefined);
    assert.deepEqual(w.runtime.sessionInfo!(s.id), { bot: bot.id, peer: undefined, model: undefined });
    // restart: a new runtime on the same store resumes the bot thread in the bot's MIND
    const rt2 = w.mkRuntime();
    const back = await rt2.openSession({ surface: "web", resumeId: s.id, identity: "admin" });
    assert.equal(rt2.sessionInfo!(back.id)!.bot, bot.id, "the bot is restored from the record");
    const ctx = w.fake.seen.filter((x) => x.path === "/developer/v1/context" && x.bot === "sales");
    assert.ok(ctx.length >= 1);
    // learning is off for bots: no lesson files are read or written under any key
    assert.ok(!w.fake.seen.some((x) => JSON.stringify(x.body ?? "").includes("daebot-learning") && x.bot));
  } finally { await w.close(); }
});

test("a bot belongs to ONE owner: another owner (or a made-up id) cannot open a session on it", async () => {
  const w = await world();
  try {
    const bot = await w.runtime.bots!.create({ slug: "sales" });
    const other = w.mkRuntime("u_other");
    assert.equal(other.bots!.get(bot.id), undefined);
    await assert.rejects(() => other.openSession({ surface: "web", botId: bot.id, identity: "admin" }), /no such bot/);
    await assert.rejects(() => w.runtime.openSession({ surface: "web", botId: "b_000000000000", identity: "admin" }), /no such bot/);
    // and a session of the owner cannot be re-bound to a different bot
    const s = await w.runtime.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    const bot2 = await w.runtime.bots!.create({ slug: "ops" });
    await assert.rejects(() => w.runtime.openSession({ surface: "web", resumeId: s.id, botId: bot2.id, identity: "admin" }), /different bot/);
  } finally { await w.close(); }
});

test("model per session: open with a model, change it for the next turn, it persists and survives a restart; the user default applies when none is set", async () => {
  const w = await world({ rounds: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }] });
  try {
    const s = await w.runtime.openSession({ surface: "web", identity: "admin", model: "vendor/model-a" });
    await collect(s.send("1"));
    s.setModel!("vendor/model-b");
    await collect(s.send("2"));
    assert.deepEqual(w.provider.requests.map((r) => r.model), ["vendor/model-a", "vendor/model-b"]);
    assert.match(sys(w.provider, 1), /you run on vendor\/model-b/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.store.load(s.id)!.model, "vendor/model-b");
    assert.equal(w.runtime.listSessions().find((r) => r.id === s.id)!.model, "vendor/model-b");
    const rt2 = w.mkRuntime();
    const back = await rt2.openSession({ surface: "web", resumeId: s.id, identity: "admin" });
    await collect(back.send("3"));
    assert.equal(w.provider.requests[2].model, "vendor/model-b", "the model survived the restart");
    // a bad id is ignored, never sent
    const junk = await w.runtime.openSession({ surface: "web", identity: "admin", model: "bad model!!" });
    await collect(junk.send("4"));
    assert.equal(w.provider.requests[3].model, "m/default");
    // the user's default (settings file) applies to sessions with no model of their own
    w.runtime.settings!.set({ defaultModel: "vendor/default-x" });
    assert.deepEqual(w.runtime.settings!.get(), { defaultModel: "vendor/default-x" });
    const fresh = await w.runtime.openSession({ surface: "web", identity: "admin" });
    await collect(fresh.send("5"));
    assert.equal(w.provider.requests[4].model, "vendor/default-x");
    w.runtime.settings!.set({ defaultModel: null });
    assert.deepEqual(w.runtime.settings!.get(), {});
    assert.throws(() => w.runtime.settings!.set({ defaultModel: "no good" }), /bad model id/);
  } finally { await w.close(); }
});

// ---------- billing: a bot turn's LLM request is on the MAIN key ----------
const sse = (text: string): Response => new Response(
  new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode([{ choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.001 } }].map((x) => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n")); c.close(); } }),
  { status: 200, headers: { "content-type": "text/event-stream" } });

test("a bot turn's LLM request uses the MAIN MIND key (billing stays on MAIN) and never the bot header", async () => {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  const llm: { key: string; bot?: string; url: string }[] = [];
  const f = (async (input: any, init?: any) => {
    const url = String(input);
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/llm/chat/completions")) { llm.push({ key: h["X-API-Key"], bot: h["X-MIND-Bot"], url }); return sse("hello from the bot"); }
    if (url.endsWith("/credits")) return new Response(JSON.stringify({ tier: "starter", credits_balance: 100, credits_limit: 500, upgrade_url: "https://up" }), { status: 200, headers: { "content-type": "application/json" } });
    return fetch(input, init);
  }) as typeof fetch;
  try {
    const dir = mkdtempSync(join(tmpdir(), "bots-rt-"));
    const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key, billing: "mind", openrouterKey: "", freeModel: "m/free" });
    const credits = new MindCredits({ mindBaseUrl: cfg.mindBaseUrl, fetchImpl: f });
    const rt = createRuntime(cfg, { fetchImpl: f, credits, store: createFileStore(dir), owner: "u_pat", bots: { dir, bus: {} }, hosted: { dailyUsdCap: 50, username: "pat", exempt: true } });
    const bot = await rt.bots!.create({ slug: "sales" });
    const s = await rt.openSession({ surface: "web", botId: bot.id, identity: "admin" });
    const evs = await collect(s.send("hi"));
    assert.ok(evs.some((e) => e.type === "text"), JSON.stringify(evs).slice(0, 300));
    assert.equal(llm.length, 1);
    assert.equal(llm[0].key, key, "the provider key is the user's MAIN key");
    assert.equal(llm[0].bot, undefined, "the LLM route is not bot-scoped");
    assert.ok(llm[0].url.endsWith("/llm/chat/completions"));
  } finally { await fake.close(); }
});

test("bot model override: a bot's threads run on the bot's model; main and other bots do not; clearing returns to the normal choice; survives a restart", async () => {
  const w = await world({ rounds: Array.from({ length: 12 }, (_, i) => ({ text: `r${i}` })) });
  try {
    const sales = await w.runtime.bots!.create({ slug: "sales", name: "Sales" });
    const ops = await w.runtime.bots!.create({ slug: "ops", name: "Ops" });
    w.runtime.settings!.set({ defaultModel: "vendor/default-x" });
    const last = () => w.provider.requests.at(-1)!;
    const run = async (s: { send(m: string): AsyncIterable<unknown> }, t: string) => { await collect(s.send(t) as any); return last(); };
    const sThread = await w.runtime.openSession({ surface: "web", botId: sales.id, identity: "admin" });
    const oThread = await w.runtime.openSession({ surface: "web", botId: ops.id, identity: "admin" });
    const main = await w.runtime.openSession({ surface: "web", identity: "admin", model: "vendor/header-pick" });
    // before any override everything follows the normal choice
    assert.equal((await run(sThread, "1")).model, "vendor/default-x");
    // set the override: the very next turn of the EXISTING thread runs on it (no reopen)
    w.runtime.bots!.update(sales.id, { model: "vendor/bot-model" });
    const r2 = await run(sThread, "2");
    assert.equal(r2.model, "vendor/bot-model");
    assert.match(r2.messages[0].content as string, /you run on vendor\/bot-model/, "the prompt names the bot's model too");
    // a session-level model on the bot thread does not beat the bot's model
    sThread.setModel!("vendor/header-pick");
    assert.equal((await run(sThread, "3")).model, "vendor/bot-model");
    // other bot and main are untouched
    assert.equal((await run(oThread, "4")).model, "vendor/default-x");
    assert.equal((await run(main, "5")).model, "vendor/header-pick");
    // a NEW thread of the same bot also uses it
    const sThread2 = await w.runtime.openSession({ surface: "web", botId: sales.id, identity: "admin" });
    assert.equal((await run(sThread2, "6")).model, "vendor/bot-model");
    // restart: the override is on the bot, the stored thread resumes on it
    await new Promise((r) => setTimeout(r, 50));
    const rt2 = w.mkRuntime();
    const back = await rt2.openSession({ surface: "web", resumeId: sThread.id, identity: "admin" });
    assert.equal((await run(back, "7")).model, "vendor/bot-model");
    // clearing: threads return to the normal choice (the thread's own pick, else the user default); main is still its own
    rt2.bots!.update(sales.id, { model: null });
    assert.equal((await run(back, "8")).model, "vendor/header-pick", "the thread's own earlier pick applies again");
    const fresh = await rt2.openSession({ surface: "web", botId: sales.id, identity: "admin" });
    assert.equal((await run(fresh, "9")).model, "vendor/default-x", "a thread with no pick of its own uses the user default");
    assert.equal((await run(main, "10")).model, "vendor/header-pick", "main never saw the bot's model");
  } finally { await w.close(); }
});
