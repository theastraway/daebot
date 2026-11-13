// Routine noise (2026-11-13): fresh run-scoped context, waiting-on-the-user items surfaced once, no check-ins typed into a live chat,
// a person typing into a routine thread gets an ordinary chat. Real gateway where the behaviour lives there.
process.env.DAEBOT_BOTS_ENABLED = "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg } from "../core/helpers.ts";
import { auth as bearer, http, parseSse, tmpStatic } from "../gateway/helpers.ts";
import { BOT, OWNER, rig } from "./rig.ts";

const stopped = (q: string, title = "Graph Automations") => [{ sessionId: "t1", id: "q1", title, status: "stopped", question: q, updatedAt: 5000 }];

test("every routine run is handed fresh=true and a one-line digest of the last run, nothing more", async () => {
  const r = rig();
  const rt = r.hub.book(OWNER, BOT).add({ name: "tick", prompt: "write the time", kind: "timed", timing: { expression: "*/2 * * * *", tz: "UTC" } });
  const seen: boolean[] = [];
  const orig = r.deps.runTurn;
  r.deps.runTurn = async (a) => { seen.push(a.fresh); return orig(a); };
  const run = async () => { const f = r.runner.runNow(OWNER, BOT, rt.id); await (f as any).done; };
  await run(); await run();
  assert.deepEqual(seen, [true, true]);
  assert.doesNotMatch(r.turns[0].text, /Last run/);
  assert.match(r.turns[1].text, /Last run \(.*ok\): did it/);
  assert.match(r.turns[1].text, /all you remember of earlier runs/);
});

test("heartbeat: a stopped item waiting on the user is surfaced once, then never again unless it changed", async () => {
  const r = rig();
  const bk = r.hub.book(OWNER, BOT);
  const hb = bk.heartbeat();
  r.world.threads = [{ id: "t1", title: "Good morning", updatedAt: 1000 }];
  r.world.board = stopped("Do you want the graph automations?");
  const tick = async () => { const f = r.runner.runNow(OWNER, BOT, hb.id); await (f as any).done; };
  await tick();
  assert.equal(r.turns.length, 1, "first time: surfaced");
  assert.match(r.turns[0].text, /graph automations/);
  // many ticks later, other threads move, the same question still waits: no model call, no message
  for (let i = 0; i < 5; i++) {
    r.world.threads = [{ id: "t1", title: "Good morning", updatedAt: 1000 }, { id: "t2", title: "other " + i, updatedAt: 6000 + i }];
    await tick();
  }
  assert.equal(r.turns.length, 1, "still waiting, nothing changed: silent");
  assert.equal(bk.get(hb.id)!.runs!.at(-1)!.model, false);
  assert.match(bk.get(hb.id)!.runs!.at(-1)!.result!, /nothing new \(1 still waiting on the user\)/);
  // 6 hours later with nothing else moving: still silent (the old 6-hour bucket re-surfaced it)
  r.clock.t += 7 * 3_600_000;
  await tick();
  assert.equal(r.turns.length, 1);
  // the question changes: it is news again
  r.world.board = stopped("Which automations first?");
  await tick();
  assert.equal(r.turns.length, 2);
  assert.match(r.turns[1].text, /Which automations first/);
  // a new, different item is news too, while the old one stays out of the digest
  r.world.board = [...stopped("Which automations first?"), { sessionId: "t1", id: "q2", title: "Ship it", status: "stopped", question: "Merge now?", updatedAt: 9000 }];
  await tick();
  assert.equal(r.turns.length, 3);
  assert.match(r.turns[2].text, /Merge now/);
  assert.doesNotMatch(r.turns[2].text, /Which automations first/);
});

test("heartbeat saved before this change: what is waiting right now counts as already surfaced", async () => {
  const r = rig();
  const bk = r.hub.book(OWNER, BOT);
  const hb = bk.heartbeat();
  r.world.threads = [{ id: "t1", title: "Good morning", updatedAt: 1000 }];
  bk.setHeartbeat(hb.id, { fp: "old-fingerprint", reviewed: true });          // a heartbeat that already ran many times, with no `surfaced` record
  r.world.board = stopped("Do you want the graph automations?");
  const f = r.runner.runNow(OWNER, BOT, hb.id);
  await (f as any).done;
  assert.equal(r.turns.length, 0, "the 59-times-repeated question is not repeated one more time");
});

// ---------------------------------------------------------------- real gateway
async function gwRig() {
  const key = "mind_" + randomBytes(16).toString("hex");
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "routines-quiet-"));
  const provider = new FakeProvider([{ text: "ok" }]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const bots: any = { dir, bus: {} };
  const store = createFileStore(dir);
  const runtime = createRuntime(cfg, { provider, store, bots });
  const st = tmpStatic();
  const gw = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots });
  const a = bearer(gw.token);
  const bot = JSON.parse((await http(gw.url, "POST", "/bots", { headers: a, body: { slug: "quinn", name: "Quinn", purpose: "tests" } })).body).bot;
  const j = async (m: string, p: string, body?: unknown) => { const r = await http(gw.url, m, p, { headers: a, body }); return { status: r.status, json: r.body ? JSON.parse(r.body) : {}, raw: r }; };
  return { gw, a, bot, provider, store, bots, j, close: async () => { await gw.close(); await fake.close(); } };
}
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 25)); };

test("a heartbeat check-in is never typed into a thread the user is chatting in", async () => {
  const r = await gwRig();
  try {
    const { sessionId } = (await r.j("POST", "/sessions", { surface: "web", bot: r.bot.id })).json;
    await http(r.gw.url, "POST", `/sessions/${sessionId}/send`, { headers: r.a, body: { text: "hello quinn" } });
    await until(() => r.provider.requests.length > 0);
    const before = r.provider.requests.length;
    const msg = await r.bots.manage.current.continueThread("owner", r.bot.id, sessionId, "go back to the old board item");
    assert.match(msg, /^not sent: the user is active in that thread/);
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.provider.requests.length, before, "no model turn was started in the chat");
    const hist = (await r.j("GET", `/sessions/${sessionId}/history`)).json;
    assert.ok(!JSON.stringify(hist.events).includes("Check-in from your Heartbeat"));
  } finally { await r.close(); }
});

test("a person typing into a routine thread gets an ordinary chat with its own memory, not the routine's context and not 'no such session'", async () => {
  const r = await gwRig();
  try {
    const rt = (await r.j("POST", `/bots/${r.bot.id}/routines`, { name: "Tick", prompt: "say tick", kind: "trigger", trigger: { type: "webhook" } })).json.routine;
    await http(r.gw.url, "POST", new URL(rt.webhookUrl).pathname, { body: { x: 1 } });
    await until(() => r.store.list().some((m) => m.title === "Routine: Tick"));
    const th = r.store.list().find((m) => m.title === "Routine: Tick")!;
    await until(() => !!r.store.load(th.id) && r.provider.requests.length >= 1);
    await new Promise((res) => setTimeout(res, 150));
    const sent = await http(r.gw.url, "POST", `/sessions/${th.id}/send`, { headers: r.a, body: { text: "what is the weather" } });
    assert.equal(sent.status, 200, sent.body);
    assert.ok(sent.headers["x-daebot-session"] && sent.headers["x-daebot-session"] !== th.id, "the client is told the new session id");
    const ev = parseSse(sent.body);
    const first: any = ev.find((e: any) => e.type === "session");
    assert.equal(first.movedFrom, th.id);
    const hid = String(sent.headers["x-daebot-session"]);
    const last = r.provider.requests.at(-1)!;
    const users = last.messages.filter((m) => m.role === "user").map((m) => m.content);
    assert.deepEqual(users, ["what is the weather"], "none of the routine's messages are in this chat's memory");
    // the routine thread itself got no human message
    const rtHist = JSON.stringify((await r.j("GET", `/sessions/${th.id}/history`)).json.events);
    assert.ok(!rtHist.includes("what is the weather"));
    // a second message goes to the same chat
    const again = await http(r.gw.url, "POST", `/sessions/${th.id}/send`, { headers: r.a, body: { text: "and tomorrow" } });
    assert.equal(again.headers["x-daebot-session"], hid);
  } finally { await r.close(); }
});
