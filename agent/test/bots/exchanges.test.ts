// Agent exchanges: the pair transcripts behind bot_talk. Store (persisted, owner-isolated), bus (delivery both ways, reply lands,
// loop cap, no self messages, wait_for_reply:false), the card event the loop emits, and one real end-to-end through the gateway.
process.env.DAEBOT_BOTS_ENABLED = "1"; // the Bots feature flag (default off)
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotBus, dmThreadId } from "../../src/bots/bus.ts";
import type { BusManager } from "../../src/bots/bus.ts";
import { ExchangeHub, exchangeId, pairOf, MAIN } from "../../src/bots/exchanges.ts";
import { BotStore } from "../../src/bots/store.ts";
import type { BotMindApi } from "../../src/bots/store.ts";
import { createBotTalkTool } from "../../src/bots/talk-tool.ts";
import { BusyError } from "../../src/gateway/sessions.ts";
import { createAgentSession } from "../../src/loop.ts";
import { createKernel } from "../../src/kernel/index.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, FakeSync, baseCfg, call, collect } from "../core/helpers.ts";
import { auth as bearer, http, parseSse, tmpStatic } from "../gateway/helpers.ts";
import type { AgentEvent } from "../../src/types.ts";

const okMind = (): BotMindApi => ({ list: async () => [], create: async () => {}, remove: async () => {} });

interface Row { owner: string; busy: boolean; turns: number; bot?: string; peer?: string; surface?: string }
class FakeMgr implements BusManager {
  rows = new Map<string, Row>();
  turnsRun: { id: string; text: string }[] = [];
  run: (id: string, text: string, emit: (e: AgentEvent) => void) => Promise<string> = async () => "pong";
  async open(o: { resumeId?: string; owner?: string; bot?: string; peer?: string }) {
    const id = o.resumeId!;
    if (!this.rows.has(id)) this.rows.set(id, { owner: o.owner ?? "owner", busy: false, turns: 0, bot: o.bot, peer: o.peer, surface: "bot" });
    return { id };
  }
  get(id: string) { return this.rows.get(id); }
  async turn(id: string, text: string, onEvent: (e: AgentEvent) => void) {
    const r = this.rows.get(id)!;
    if (r.busy) throw new BusyError("busy");
    r.busy = true; r.turns++;
    this.turnsRun.push({ id, text });
    try { onEvent({ type: "done", finalText: await this.run(id, text, onEvent) }); } finally { r.busy = false; }
  }
}

async function world(over: Partial<Parameters<typeof createBotBus>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "xchg-"));
  const store = new BotStore({ dir, owner: "u1", mind: okMind() });
  const other = new BotStore({ dir, owner: "u2", mind: okMind() });
  const ids: Record<string, string> = {};
  for (const slug of ["a", "b"]) ids[slug] = (await store.create({ slug, name: slug.toUpperCase(), purpose: `${slug} stuff`, face: "analyst", color: "#7dff9a" })).id;
  const theirs = (await other.create({ slug: "theirs", name: "Theirs" })).id;
  const hub = new ExchangeHub(dir);
  const mgr = new FakeMgr();
  mgr.rows.set("S", { owner: "u1", busy: true, turns: 1, surface: "web" });          // the person's session, mid-turn
  mgr.rows.set("A-thread", { owner: "u1", busy: true, turns: 1, bot: ids.a, surface: "web" }); // a person typing in bot A's thread
  mgr.rows.set("A-routine", { owner: "u1", busy: true, turns: 1, bot: ids.a, surface: "routine" }); // a routine run of bot A: nobody is driving
  mgr.rows.set("M-routine", { owner: "u1", busy: true, turns: 1, surface: "routine" });
  mgr.rows.set("U2", { owner: "u2", busy: true, turns: 1, surface: "web" });
  const bus = createBotBus({ manager: mgr, exchanges: hub, botsFor: (o) => (o === "u1" ? store : o === "u2" ? other : undefined), maxCallsPerTurn: 99, budgetPerRoot: 99, perMinute: 9999, ...over });
  const talk = (from: string, to: string, message = "ping", selfBot?: string, owner = "u1", waitForReply?: boolean) =>
    bus.talk({ owner, fromSession: from, selfBot, to, message, waitForReply });
  return { bus, mgr, store, other, ids, theirs, hub, dir, talk };
}

// ---------------------------------------------------------------- store

test("pairs: one exchange per pair whichever way round, main first; ids are deterministic and per owner", () => {
  assert.deepEqual(pairOf("b_2", MAIN), [MAIN, "b_2"]);
  assert.deepEqual(pairOf("b_2", "b_1"), ["b_1", "b_2"]);
  assert.equal(exchangeId("u1", "b_1", "b_2"), exchangeId("u1", "b_2", "b_1"));
  assert.notEqual(exchangeId("u1", "b_1", "b_2"), exchangeId("u2", "b_1", "b_2"));
  assert.match(exchangeId("u1", MAIN, "b_1"), /^ex_[0-9a-f]{24}$/);
});

test("the exchange thread is persisted (a new hub on the same folder reads it back) and owner-isolated", () => {
  const dir = mkdtempSync(join(tmpdir(), "xchg-store-"));
  const hub = new ExchangeHub(dir);
  const { exchange } = hub.append("u1", MAIN, "b_1", { from: MAIN, text: "hello", kind: "message" });
  hub.append("u1", MAIN, "b_1", { from: "b_1", text: "hi back", kind: "reply", tools: [{ name: "mind_query", ok: true, preview: "found 3" }] });
  const again = new ExchangeHub(dir);
  const rec = again.get("u1", exchange.id)!;
  assert.deepEqual(rec.messages.map((m) => [m.from, m.text, m.kind]), [[MAIN, "hello", "message"], ["b_1", "hi back", "reply"]]);
  assert.equal(rec.messages[1].tools![0].name, "mind_query");
  assert.ok(rec.messages[1].at > rec.messages[0].at, "timestamps strictly increase");
  // another owner can neither read, list nor touch it
  assert.equal(again.get("u2", exchange.id), undefined);
  assert.deepEqual(again.list("u2"), []);
  assert.equal(again.markSeen("u2", exchange.id), false);
  assert.equal(again.purgeBot("u2", "b_1"), 0);
  assert.equal(again.list("u1").length, 1);
  assert.equal(again.get("u1", "../../etc/passwd"), undefined);
});

test("unread: new messages are unread until seen; deleting a bot removes its exchanges", () => {
  const hub = new ExchangeHub(mkdtempSync(join(tmpdir(), "xchg-unread-")));
  const { exchange } = hub.append("u1", MAIN, "b_1", { from: "b_1", text: "FYI", kind: "message" });
  assert.equal(hub.list("u1")[0].unread, 1);
  hub.markSeen("u1", exchange.id);
  assert.equal(hub.list("u1")[0].unread, 0);
  hub.append("u1", MAIN, "b_1", { from: MAIN, text: "ok", kind: "reply" });
  assert.equal(hub.list("u1")[0].unread, 1);
  hub.append("u1", "b_1", "b_2", { from: "b_1", text: "x", kind: "message" });
  assert.equal(hub.purgeBot("u1", "b_1"), 2);
  assert.deepEqual(hub.list("u1"), []);
  assert.deepEqual(new ExchangeHub(hub.dir.replace(/\/exchanges$/, "")).list("u1"), [], "gone from disk too");
});

// ---------------------------------------------------------------- bus: delivery, replies, cards

test("main -> bot: delivered, the reply lands back, both are in the exchange; the person drove it so nothing is unread; the card carries both", async () => {
  const w = await world();
  w.mgr.run = async () => "12 open deals";
  const r = await w.talk("S", "a", "how many deals?");
  assert.equal(r.ok, true, r.output);
  const ex = w.hub.list("u1");
  assert.equal(ex.length, 1);
  const rec = w.hub.get("u1", ex[0].id)!;
  assert.deepEqual(rec.messages.map((m) => [m.from, m.kind, m.text]), [[MAIN, "message", "how many deals?"], [w.ids.a, "reply", "12 open deals"]]);
  assert.equal(ex[0].unread, 0);
  const c = r.exchange!;
  assert.equal(c.type, "exchange");
  assert.equal(c.exchangeId, rec.id);
  assert.deepEqual([c.from.id, c.from.kind, c.from.name], [MAIN, "main", "Daebot"]);
  assert.deepEqual([c.to.id, c.to.kind, c.to.slug, c.to.face, c.to.color], [w.ids.a, "bot", "a", "analyst", "#7dff9a"]);
  assert.equal(c.message, "how many deals?");
  assert.deepEqual(c.reply, { text: "12 open deals", ok: true });
});

test("bot -> bot: delivered on the recipient's DM thread, recorded in ONE exchange for the pair whichever bot speaks", async () => {
  const w = await world();
  w.mgr.run = async (_id, text) => (/question/.test(text) ? "the answer" : "thanks");
  const r1 = await w.talk("A-thread", "b", "question for you", w.ids.a);
  assert.equal(r1.ok, true, r1.output);
  assert.equal(w.mgr.turnsRun.at(-1)!.id, dmThreadId("u1", w.ids.b, w.ids.a));
  const r2 = await w.talk("A-thread", "b", "second", w.ids.a);
  assert.equal(r2.ok, true);
  // and b talking to a lands in the same exchange
  w.mgr.rows.set("B-thread", { owner: "u1", busy: true, turns: 1, bot: w.ids.b, surface: "web" });
  await w.talk("B-thread", "a", "reverse", w.ids.b);
  const list = w.hub.list("u1");
  assert.equal(list.length, 1, "one exchange per pair");
  const rec = w.hub.get("u1", list[0].id)!;
  assert.equal(rec.messages.length, 6);
  assert.deepEqual(rec.messages.slice(0, 2).map((m) => [m.from, m.kind]), [[w.ids.a, "message"], [w.ids.b, "reply"]]);
  assert.equal(r1.exchange!.from.name, "A");
  assert.equal(r1.exchange!.to.name, "B");
});

test("bot -> main: a bot can message the main Daebot; main's reply lands back; outside a person's turn it is UNREAD", async () => {
  const w = await world();
  w.mgr.run = async () => "noted";
  const r = await w.talk("A-routine", "main", "heads up: the invoice is late", w.ids.a);
  assert.equal(r.ok, true, r.output);
  const dmId = dmThreadId("u1", MAIN, w.ids.a);
  assert.equal(w.mgr.turnsRun.at(-1)!.id, dmId, "main's turn runs on a DM thread keyed (main, sender)");
  const row = w.mgr.rows.get(dmId)!;
  assert.equal(row.bot, undefined, "a main-side thread has no bot");
  assert.equal(row.peer, w.ids.a);
  assert.match(w.mgr.turnsRun.at(-1)!.text, /^\[message from A \(bot "a"\)\./);
  const ex = w.hub.list("u1")[0];
  assert.equal(ex.unread, 2, "nobody was driving: the message and the reply are both unread");
  assert.deepEqual([r.exchange!.from.name, r.exchange!.to.name, r.exchange!.to.kind], ["A", "Daebot", "main"]);
  assert.equal(r.exchange!.reply!.text, "noted");
});

test("self messages are refused: main to main, a bot to itself", async () => {
  const w = await world();
  const m = await w.talk("S", "main", "me?");
  assert.equal(m.ok, false);
  assert.match(m.output, /cannot message yourself/);
  const b = await w.talk("A-thread", "a", "me?", w.ids.a);
  assert.equal(b.ok, false);
  assert.match(b.output, /cannot message yourself/);
  assert.equal(w.mgr.turnsRun.length, 0);
  assert.deepEqual(w.hub.list("u1"), []);
});

test("a message cannot loop back: main -> a -> main is refused, a -> b -> a is refused", async () => {
  const w = await world();
  let inner = "";
  w.mgr.run = async (id) => {
    const row = w.mgr.rows.get(id)!;
    if (row.bot === w.ids.a) { inner = (await w.talk(id, "main", "back to you", w.ids.a)).output; return "a done"; }
    return "?";
  };
  const r = await w.talk("S", "a", "go");
  assert.equal(r.ok, true);
  assert.match(inner, /already in this conversation chain/);
});

test("exchange loop cap: 10 messages without the person speaking, then refused; the person speaking starts it over", async () => {
  const w = await world();
  for (let i = 1; i <= 10; i++) {
    const r = await w.talk("M-routine", "a", `m${i}`);
    assert.equal(r.ok, true, `message ${i}: ${r.output}`);
  }
  const eleventh = await w.talk("M-routine", "a", "m11");
  assert.equal(eleventh.ok, false);
  assert.match(eleventh.output, /10 messages since the user last spoke/);
  assert.equal(w.mgr.turnsRun.length, 10, "no turn started for the refused one");
  assert.equal(w.hub.get("u1", w.hub.list("u1")[0].id)!.messages.filter((m) => m.kind === "message").length, 10);
  // a person typing in a session starts the count over for that pair
  const again = await w.talk("S", "a", "the person asks");
  assert.equal(again.ok, true, again.output);
  assert.equal(w.hub.get("u1", w.hub.list("u1")[0].id)!.sinceUser, 1);
});

test("exchanges are owner-isolated through the bus: another owner's bots and exchanges never mix", async () => {
  const w = await world();
  await w.talk("S", "a", "hello");
  const theirs = await w.talk("U2", "theirs", "hi", undefined, "u2");
  assert.equal(theirs.ok, true, theirs.output);
  assert.equal(w.hub.list("u1").length, 1);
  assert.equal(w.hub.list("u2").length, 1);
  assert.notEqual(w.hub.list("u1")[0].id, w.hub.list("u2")[0].id);
  assert.equal(w.hub.get("u2", w.hub.list("u1")[0].id), undefined);
  const cross = await w.talk("U2", "a", "your bot?", undefined, "u2");
  assert.equal(cross.ok, false, "u2 cannot reach u1's bot");
  assert.equal(w.hub.get("u1", w.hub.list("u1")[0].id)!.messages.length, 2, "u1's exchange was not touched");
});

test("tool calls the recipient made are kept with its reply (collapsed in the UI)", async () => {
  const w = await world();
  w.mgr.run = async (_id, _t, emit) => {
    emit({ type: "toolStart", receiptId: "c1", tool: "mind_query", args: {} });
    emit({ type: "toolEnd", receiptId: "c1", tool: "mind_query", ok: true, preview: "3 deals" });
    return "3 deals";
  };
  await w.talk("S", "a", "count");
  const rec = w.hub.get("u1", w.hub.list("u1")[0].id)!;
  assert.deepEqual(rec.messages[1].tools, [{ name: "mind_query", ok: true, preview: "3 deals" }]);
});

test("wait_for_reply:false delivers and returns at once; the reply lands in the exchange later and stays unread", async () => {
  const w = await world();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  w.mgr.run = async () => { await gate; return "late answer"; };
  const r = await w.talk("S", "a", "take your time", undefined, "u1", false);
  assert.equal(r.ok, true, r.output);
  assert.match(r.output, /sent to A/);
  assert.equal(r.exchange!.reply, undefined, "no reply yet");
  assert.equal(w.hub.get("u1", r.exchange!.exchangeId)!.messages.length, 1);
  release();
  await new Promise((res) => setTimeout(res, 30));
  const rec = w.hub.get("u1", r.exchange!.exchangeId)!;
  assert.deepEqual(rec.messages.map((m) => m.kind), ["message", "reply"]);
  assert.equal(rec.messages[1].text, "late answer");
  assert.equal(w.hub.list("u1")[0].unread, 1, "the late reply is unread: nobody was watching");
});

// ---------------------------------------------------------------- the card event

test("bot_talk leaves an `exchange` card event in the sender's turn (right after its toolEnd), and the tool takes wait_for_reply and `main`", async () => {
  const seen: Record<string, unknown>[] = [];
  const bus = { talk: async (req: Record<string, unknown>) => { seen.push(req); return { ok: true, output: "[reply]", exchange: { type: "exchange" as const, exchangeId: "ex_" + "a".repeat(24), from: { id: MAIN, kind: "main" as const, name: "Daebot" }, to: { id: "b_1", kind: "bot" as const, name: "Sales" }, message: "hi", reply: { text: "yo", ok: true }, at: 1 } }; } };
  const tool = createBotTalkTool({ bus: { current: bus }, owner: "u1" });
  assert.ok((tool.spec.parameters as any).properties.wait_for_reply, "wait_for_reply is offered");
  const provider = new FakeProvider([{ calls: [call("1", "bot_talk", { to: "main", message: "hi", wait_for_reply: false })] }, { text: "done" }]);
  const s = createAgentSession({ id: "s1", surface: "web", provider, kernel: createKernel({ shadow: false, enabled: true }), tools: [tool], sync: new FakeSync(), cfg: baseCfg(), cwd: "/", systemPrompt: "SYS", bootContext: "booted" });
  const ev = await collect(s.send("tell sales hi"));
  const i = ev.findIndex((e) => e.type === "toolEnd");
  assert.equal(ev[i + 1].type, "exchange", "the card follows the tool result");
  assert.equal((ev[i + 1] as any).to.name, "Sales");
  assert.equal(seen[0].to, "main");
  assert.equal(seen[0].waitForReply, false);
});

// ---------------------------------------------------------------- end to end through the gateway

test("end to end: main asks a bot -> card event in the stream, exchange listed and readable over REST (read-only); a bot messages main from its own thread", async () => {
  const key = "mind_" + randomBytes(16).toString("hex");
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "xchg-int-"));
  const provider = new FakeProvider([
    { calls: [call("t1", "bot_talk", { to: "sales", message: "how many open deals?" })], },  // main session
    { text: "12 open deals" },                                                              // sales' DM turn
    { text: "Sales says 12." },                                                             // main's final answer
    { calls: [call("t2", "bot_talk", { to: "main", message: "heads up from sales" })] },    // sales in its own thread
    { text: "Thanks, noted." },                                                             // main's DM turn
    { text: "Told main." },                                                                 // sales' final answer
  ]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const bots = { dir, bus: {} };
  const store = createFileStore(dir);
  const runtime = createRuntime(cfg, { provider, store, bots });
  const st = tmpStatic();
  const gw = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots });
  const a = bearer(gw.token);
  const get = async (p: string) => { const r = await http(gw.url, "GET", p, { headers: a }); return { status: r.status, json: r.body ? JSON.parse(r.body) : null }; };
  try {
    const bot = JSON.parse((await http(gw.url, "POST", "/bots", { headers: a, body: { slug: "sales", name: "Sales", purpose: "pipeline", face: "closer", color: "#5ee0ff" } })).body).bot;
    const { sessionId } = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: a, body: { surface: "web" } })).body);
    const r = await http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: a, body: { text: "ask sales about the pipeline" } });
    const evs = parseSse(r.body);
    const card = evs.find((e) => e.type === "exchange") as any;
    assert.ok(card, "the stream carries an exchange card: " + JSON.stringify(evs.map((e) => e.type)));
    assert.deepEqual([card.from.kind, card.to.slug, card.to.face, card.message, card.reply.text], ["main", "sales", "closer", "how many open deals?", "12 open deals"]);

    // history replays the card
    const hist = (await get(`/sessions/${sessionId}/history`)).json.events as any[];
    assert.ok(hist.some((e) => e.type === "exchange" && e.exchangeId === card.exchangeId), "the card is in the saved transcript");

    // REST: list + one exchange, both sides, read-only
    const list = (await get("/exchanges")).json;
    assert.equal(list.exchanges.length, 1);
    assert.equal(list.exchanges[0].unread, 0, "the person was there: nothing unread");
    assert.deepEqual([list.exchanges[0].a.name, list.exchanges[0].b.name], ["Daebot", "Sales"]);
    const one = (await get(`/exchanges/${card.exchangeId}`)).json.exchange;
    assert.equal(one.readOnly, true);
    assert.deepEqual(one.messages.map((m: any) => [m.from === "main" ? "main" : "sales", m.kind, m.text]), [["main", "message", "how many open deals?"], ["sales", "reply", "12 open deals"]]);
    assert.equal((await http(gw.url, "POST", `/exchanges/${card.exchangeId}`, { headers: a, body: { text: "jump in" } })).status, 405, "no writing into an exchange");
    assert.equal((await get("/exchanges/ex_" + "0".repeat(24))).status, 404);
    assert.equal((await http(gw.url, "GET", "/exchanges", { headers: {} })).status, 401, "needs the token");

    // the DM thread of the exchange is internal: not in the general sessions list
    const general = (await get("/sessions")).json.sessions as any[];
    assert.ok(!general.some((s) => s.peer), "peer threads stay out of the plain Sessions list");

    // a bot messages main from its own thread
    const bt = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: a, body: { surface: "web", bot: bot.id } })).body).sessionId;
    const r2 = await http(gw.url, "POST", `/sessions/${bt}/send`, { headers: a, body: { text: "tell main something" } });
    const card2 = parseSse(r2.body).find((e) => e.type === "exchange") as any;
    assert.deepEqual([card2.from.name, card2.to.kind, card2.reply.text], ["Sales", "main", "Thanks, noted."]);
    assert.equal(card2.exchangeId, card.exchangeId, "same pair, same exchange");
    const both = (await get(`/exchanges/${card.exchangeId}`)).json.exchange.messages as any[];
    assert.equal(both.length, 4);
    // main's reply turn had no bot_manage / mcp_connect (a peer can ask, never reconfigure)
    const mainDmTools = provider.requests[4].tools.map((t) => t.name);
    assert.ok(!mainDmTools.includes("bot_manage"), "bot_manage is not offered on a peer-driven main thread");
    assert.ok(mainDmTools.includes("bot_talk"));
    await new Promise((res) => setTimeout(res, 150)); // session files are written just after the turn
    const dm = store.list().find((m) => m.peer === bot.id && !m.bot);
    assert.ok(dm, "main's DM thread is stored with peer = the bot id and no bot");

    // deleting the bot removes its exchanges
    assert.equal((await http(gw.url, "DELETE", `/bots/${bot.id}`, { headers: a })).status, 200);
    assert.deepEqual((await get("/exchanges")).json.exchanges, []);
    assert.equal((await get(`/exchanges/${card.exchangeId}`)).status, 404);
  } finally { await gw.close(); await fake.close(); }
});
