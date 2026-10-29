import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap, issueSession } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { userIdFor } from "../../src/auth/users.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex"); // throwaway test values
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function rig(rounds: any[] = [{ text: "hi there" }, { text: "second answer" }]) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd(), carol: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [keys.carol]: "carol" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-accts-"));
  const provider = new FakeProvider(rounds);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore, adminLog: { dir, logKey: () => "k".repeat(24) } });
  return { gw, keys, token, dir, sessionStore, provider, close: async () => { await gw.close(); await fake.close(); } };
}

type Res = { headers: Record<string, string | string[] | undefined> };
const setCookies = (r: Res): string[] => ([] as string[]).concat((r.headers["set-cookie"] as string[] | undefined) ?? []);
/** A tiny browser: keeps the latest value of every cookie, honors Max-Age=0 deletion. */
class Jar {
  c = new Map<string, string>();
  take(r: Res): this {
    for (const line of setCookies(r)) {
      const [pair, ...attrs] = line.split(";").map((x) => x.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i), val = pair.slice(i + 1);
      if (attrs.some((a) => /^max-age=0$/i.test(a)) || val === "") this.c.delete(name); else this.c.set(name, val);
    }
    return this;
  }
  copy(): Jar { const j = new Jar(); j.c = new Map(this.c); return j; }
  get headers() { return { ...H, cookie: [...this.c].map(([k, v]) => `${k}=${v}`).join("; ") }; }
}
const signIn = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, key: string) => {
  const r = await http(g.gw.url, "POST", "/auth/key", { headers: jar.headers, body: { key } });
  assert.equal(r.status, 200, r.body);
  jar.take(r);
  return r;
};
const get = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, path: string) => http(g.gw.url, "GET", path, { headers: jar.headers });
const post = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, path: string, body: unknown = {}) => http(g.gw.url, "POST", path, { headers: jar.headers, body });



const patch = (g: Awaited<ReturnType<typeof rig>>, jar: Jar, sid: string, body: unknown) => http(g.gw.url, "PATCH", `/sessions/${encodeURIComponent(sid)}`, { headers: jar.headers, body });
const titleOf = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, sid: string, q = "") =>
  (JSON.parse((await get(g, jar, `/sessions${q}`)).body).sessions as any[]).find((s) => s.id === sid)?.title;
const open = async (g: Awaited<ReturnType<typeof rig>>, jar: Jar, title = "New session") => JSON.parse((await post(g, jar, "/sessions", { surface: "web", title })).body).sessionId as string;


const hist = async (g: G, jar: Jar, sid: string) => JSON.parse((await get(g, jar, `/sessions/${sid}/history`)).body) as { events: any[]; meta: { messages: Record<string, any>; unreadFrom?: string } };
const asstId = async (g: G, jar: Jar, sid: string) => (await hist(g, jar, sid)).events.filter((e) => e.type === "text").pop().id as string;
const settle = () => new Promise((res) => setTimeout(res, 120)); // persist is a fire-and-forget write
type G = Awaited<ReturnType<typeof rig>>;
const react = (g: G, jar: Jar, sid: string, mid: string, emoji: string) => post(g, jar, `/sessions/${sid}/messages/${mid}/react`, { emoji });

async function chat(g: G, jar: Jar, text = "first question") {
  await signIn(g, jar, g.keys.alice);
  const sid = await open(g, jar);
  await post(g, jar, `/sessions/${sid}/send`, { text });
  return sid;
}

test("reply: the quoted message reaches the model as context and is saved above the user's message", async () => {
  const g = await rig([{ text: "The plan has three steps." }, { text: "Step two is the queue." }]);
  try {
    const jar = new Jar();
    const sid = await chat(g, jar);
    const mid = await asstId(g, jar, sid);
    const r = await post(g, jar, `/sessions/${sid}/send`, { text: "what about step two?", quote: { id: mid, text: "client copy is ignored when the id resolves" } });
    assert.equal(r.status, 200);
    const sent = g.provider.requests.at(-1)!.messages.filter((m: any) => m.role === "user").at(-1)!.content as string;
    assert.match(sent, /^Replying to: "The plan has three steps\."/);
    assert.match(sent, /what about step two\?$/);
    assert.ok(!sent.includes("client copy"), "the quote is read from the saved thread, not trusted from the client");
    const events = (await hist(g, jar, sid)).events;
    const u = events.filter((e) => e.type === "user").at(-1);
    assert.equal(u.text, "what about step two?", "the saved bubble shows only what the user wrote");
    assert.deepEqual(u.quote, { id: mid, text: "The plan has three steps." });
    await settle();
    assert.equal(g.sessionStore.load(sid)!.history.filter((e: any) => e.type === "user").at(-1).quote.id, mid);
    // an unknown id falls back to the client's text; no quote at all is a plain message
    await post(g, jar, `/sessions/${sid}/send`, { text: "third", quote: { id: "nope", text: "from the client" } });
    assert.match(g.provider.requests.at(-1)!.messages.filter((m: any) => m.role === "user").at(-1)!.content as string, /^Replying to: "from the client"/);
    await post(g, jar, `/sessions/${sid}/send`, { text: "plain" });
    assert.equal(g.provider.requests.at(-1)!.messages.filter((m: any) => m.role === "user").at(-1)!.content, "plain");
  } finally { await g.close(); }
});

test("unread: PATCH unreadFrom marks the thread, survives a restart, and null clears it", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    const sid = await chat(g, jar);
    const mid = await asstId(g, jar, sid);
    const row = async () => (JSON.parse((await get(g, jar, "/sessions")).body).sessions as any[]).find((s) => s.id === sid);
    assert.equal((await row()).unread, undefined);
    assert.equal((await patch(g, jar, sid, { unreadFrom: mid })).status, 200);
    assert.equal((await row()).unread, true);
    assert.equal((await hist(g, jar, sid)).meta.unreadFrom, mid);
    await settle();
    const reread = createFileStore(g.dir); // a restart: a fresh store scans the files
    assert.equal(reread.load(sid)!.unreadFrom, mid);
    assert.equal(reread.list().find((m) => m.id === sid)!.unread, true);
    assert.equal((await patch(g, jar, sid, { unreadFrom: "no-such-message" })).status, 404);
    assert.equal((await patch(g, jar, sid, { unreadFrom: 42 })).status, 400);
    assert.equal((await patch(g, jar, sid, { unreadFrom: null })).status, 200);
    assert.equal((await row()).unread, undefined);
    await settle();
    assert.equal(createFileStore(g.dir).load(sid)!.unreadFrom, undefined);
  } finally { await g.close(); }
});

test("reactions: toggle on and off, persist in the thread, thumbs exclude each other and double as feedback", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    const sid = await chat(g, jar);
    const mid = await asstId(g, jar, sid);
    let r = JSON.parse((await react(g, jar, sid, mid, "🎉")).body);
    assert.deepEqual(r.reactions, ["🎉"]);
    r = JSON.parse((await react(g, jar, sid, mid, "❤️")).body);
    assert.deepEqual(r.reactions, ["🎉", "❤️"]);
    r = JSON.parse((await react(g, jar, sid, mid, "🎉")).body);
    assert.deepEqual(r.reactions, ["❤️"], "a second tap toggles it off");
    r = JSON.parse((await react(g, jar, sid, mid, "👍")).body);
    assert.deepEqual(r.reactions, ["❤️", "👍"]);
    assert.equal(r.feedback.rating, "up");
    r = JSON.parse((await react(g, jar, sid, mid, "👎")).body);
    assert.deepEqual(r.reactions, ["❤️", "👎"], "thumbs exclude each other");
    assert.equal(r.feedback.rating, "down");
    r = JSON.parse((await react(g, jar, sid, mid, "👎")).body);
    assert.equal(r.feedback, undefined, "taking the thumb back takes the feedback back");
    await react(g, jar, sid, mid, "👀");
    await settle();
    const reread = createFileStore(g.dir).load(sid)!;
    assert.deepEqual(reread.msgMeta![mid].reactions, ["❤️", "👀"]);
    assert.deepEqual((await hist(g, jar, sid)).meta.messages[mid].reactions, ["❤️", "👀"]);
    for (const bad of ["", "abc", "<b>", "x".repeat(40), 5]) assert.equal((await react(g, jar, sid, mid, bad as any)).status, 400, String(bad));
    assert.equal((await react(g, jar, sid, "no-such", "👍")).status, 404);
  } finally { await g.close(); }
});

test("feedback: thumbs + comment are saved with the message; a report is negative feedback and lands in the admin Mistake Log", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    const sid = await chat(g, jar);
    const mid = await asstId(g, jar, sid);
    const fb = await post(g, jar, `/sessions/${sid}/messages/${mid}/feedback`, { rating: "up", comment: "  clear and short  " });
    assert.equal(fb.status, 200, fb.body);
    assert.equal(JSON.parse(fb.body).feedback.comment, "clear and short");
    assert.equal((await post(g, jar, `/sessions/${sid}/messages/${mid}/feedback`, { rating: "meh" })).status, 400);
    const rep = await post(g, jar, `/sessions/${sid}/messages/${mid}/report`, { reason: "Wrong or made up", comment: "step two is wrong" });
    assert.equal(rep.status, 200, rep.body);
    assert.equal((await post(g, jar, `/sessions/${sid}/messages/${mid}/report`, {})).status, 400, "a report needs a reason");
    const meta = (await hist(g, jar, sid)).meta.messages[mid];
    assert.equal(meta.feedback.rating, "down");
    assert.equal(meta.feedback.report, true);
    assert.equal(meta.feedback.reason, "Wrong or made up");
    assert.deepEqual(meta.reactions, ["👎"]);
    const log = JSON.parse((await http(g.gw.url, "GET", "/api/admin/mistakes", { headers: { ...H, "x-daebot-log-key": "k".repeat(24) } })).body);
    const occ = log.occurrences.find((o: any) => /Wrong or made up/.test(o.what));
    assert.ok(occ, "the report is on the admin surface");
    assert.equal(occ.quote, "step two is wrong");
  } finally { await g.close(); }
});

test("learning: 👍/👎 and a report on an admin session are written to the learning store as lessons", async () => {
  const keys = { owner: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.owner]: "owner" });
  const dir = mkdtempSync(join(tmpdir(), "daebot-learn-fb-"));
  try {
    const provider = new FakeProvider([{ text: "Here is a long meandering answer." }]);
    const rt = createRuntime(baseCfg({ mindBaseUrl: fake.base, mindApiKey: keys.owner }), { provider, store: createFileStore(dir), bootCache: new BootCache(), env: { MINDCLAW_LEARNING: "1", DATA_DIR: dir } });
    const s = await rt.openSession({ surface: "web" });
    for await (const _ of s.send("explain it")) { /* drain */ }
    const mid = (rt.history!(s.id)!.filter((e: any) => e.type === "text").pop() as any).id as string;
    const down = await rt.reactMessage!(s.id, mid, "👎");
    assert.ok(typeof down === "object" && down.learned, "a thumbs down on a reply is a lesson");
    const rep = await rt.feedbackMessage!(s.id, mid, { rating: "down", reason: "Too long or unclear", comment: "keep it short", report: true });
    assert.ok(typeof rep === "object" && rep.learned);
    const up = await rt.reactMessage!(s.id, mid, "👍");
    assert.ok(typeof up === "object" && up.learned);
    await new Promise((res) => setTimeout(res, 200));
    const written = JSON.stringify(fake.seen.filter((x) => x.method === "POST").map((x) => x.body));
    assert.match(written, /Lesson - Failure - Reply rated down/);
    assert.match(written, /Lesson - Failure - Reply reported wrong/);
    assert.match(written, /keep it short/);
    assert.match(written, /Lesson - Win - Reply rated up/);
  } finally { await fake.close(); }
});

test("owner isolation: another user can not react to, mark unread, give feedback on or report a message of someone else's thread", async () => {
  const g = await rig();
  try {
    const alice = new Jar();
    const sid = await chat(g, alice);
    const bob = new Jar(); await signIn(g, bob, g.keys.bob);
    const mid = await asstId(g, alice, sid);
    assert.equal((await react(g, bob, sid, mid, "👍")).status, 403);
    assert.equal((await post(g, bob, `/sessions/${sid}/messages/${mid}/feedback`, { rating: "down" })).status, 403);
    assert.equal((await post(g, bob, `/sessions/${sid}/messages/${mid}/report`, { reason: "x" })).status, 403);
    assert.equal((await patch(g, bob, sid, { unreadFrom: mid })).status, 403);
    assert.equal((await get(g, bob, `/sessions/${sid}/history`)).status, 403);
    assert.equal((await react(g, new Jar(), sid, mid, "👍")).status, 401);
    // a saved-only (not live) thread of alice's is just as closed
    await settle();
    await g.sessionStore.save({ ...g.sessionStore.load(sid)!, id: "saved-only-2" });
    assert.equal((await react(g, bob, "saved-only-2", mid, "👍")).status, 403);
    assert.equal((await patch(g, bob, "saved-only-2", { unreadFrom: mid })).status, 403);
    assert.equal(g.sessionStore.load(sid)!.msgMeta, undefined);
    assert.equal(g.sessionStore.load("saved-only-2")!.msgMeta, undefined);
    // and alice can still use her own saved thread
    assert.equal((await react(g, alice, "saved-only-2", mid, "🙏")).status, 200);
    assert.deepEqual(g.sessionStore.load("saved-only-2")!.msgMeta![mid].reactions, ["🙏"]);
  } finally { await g.close(); }
});
