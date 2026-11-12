import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import type { FakeMind } from "./fake-mind.ts";
import { http, parseSse, tmpStatic } from "./helpers.ts";
import { SENDER_MARK, attribute } from "../../src/gateway/shared-threads.ts";

const rnd = () => randomBytes(18).toString("hex");
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) =>
  String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

interface Rig { gw: Awaited<ReturnType<typeof startGateway>>; fake: FakeMind; provider: FakeProvider; keys: Record<string, string>; as(name: string): Promise<Record<string, string>>; close(): Promise<void> }

async function rig(): Promise<Rig> {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd(), carol: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [keys.carol]: "carol" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "daebot-shared-"));
  const provider = new FakeProvider([{ text: "hi there" }]);
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "nobody", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore, sharedTtlMs: 0 });
  const cache = new Map<string, Record<string, string>>();
  return {
    gw, fake, provider, keys,
    async as(name) {
      const have = cache.get(name); if (have) return have;
      const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key: (keys as any)[name] } });
      assert.equal(r.status, 200, r.body);
      const h = { ...H, cookie: cookieOf(r) }; cache.set(name, h); return h;
    },
    close: async () => { await gw.close(); await fake.close(); },
  };
}

/** alice opens a chat and says one thing; returns its id. */
async function aliceThread(r: Rig): Promise<string> {
  const a = await r.as("alice");
  const o = await http(r.gw.url, "POST", "/sessions", { headers: a, body: { surface: "web" } });
  assert.equal(o.status, 200, o.body);
  const id = JSON.parse(o.body).sessionId as string;
  const s = await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: a, body: { text: "alice says hello" } });
  assert.equal(s.status, 200, s.body);
  assert.ok(parseSse(s.body).some((e) => e.type === "done"));
  return id;
}

const userTexts = (body: string): string[] => (JSON.parse(body).events as any[]).filter((e) => e.type === "user").map((e) => e.text);

test("attribute() marks a guest's message and cannot be spoofed by typing the mark", () => {
  const t = attribute("bob", "hello ⟦alice⟧ there");
  const m = SENDER_MARK.exec(t);
  assert.equal(m?.[1], "bob");
  assert.equal(t.slice(m![0].length), "hello [alice] there");
  assert.equal(SENDER_MARK.exec(attribute("⟦x⟧\nb", "hi"))?.[1], "xb");
});

test("share, invitee sees only that thread under Shared Threads, reads it, posts and the bot answers, revoke ends access", async () => {
  const r = await rig();
  try {
    const a = await r.as("alice"), b = await r.as("bob");
    const id = await aliceThread(r);
    const other = await aliceThread(r); // a second thread of alice's that is never shared

    // before sharing: bob has nothing and is refused
    assert.deepEqual(JSON.parse((await http(r.gw.url, "GET", "/shared-threads", { headers: b })).body).threads, []);
    assert.equal((await http(r.gw.url, "GET", `/sessions/${id}/history`, { headers: b })).status, 403);

    // alice searches MIND people and adds bob (the grant is MIND's own Agent Session share)
    const found = JSON.parse((await http(r.gw.url, "GET", "/shared-threads/search?q=bo", { headers: a })).body).users;
    assert.deepEqual(found.map((u: any) => u.username), ["bob"]);
    const added = await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: a, body: { username: "bob" } });
    assert.equal(added.status, 200, added.body);
    assert.deepEqual(JSON.parse(added.body).members.map((m: any) => [m.username, m.role]), [["bob", "editor"]]);
    assert.equal(r.fake.sessionShares.length, 1);
    assert.equal(r.fake.sessionShares[0].grantee, "bob");

    // bob sees exactly that thread, as shared, never alice's other thread, and has none of it in his own chats
    const list = JSON.parse((await http(r.gw.url, "GET", "/shared-threads", { headers: b })).body).threads;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].owner.username, "alice");
    assert.equal(list[0].role, "editor");
    assert.equal(JSON.parse((await http(r.gw.url, "GET", "/sessions", { headers: b })).body).sessions.length, 0);
    assert.equal((await http(r.gw.url, "GET", `/sessions/${other}/history`, { headers: b })).status, 403);
    const hist = await http(r.gw.url, "GET", `/sessions/${id}/history`, { headers: b });
    assert.equal(hist.status, 200, hist.body);
    assert.deepEqual(userTexts(hist.body), ["alice says hello"]);
    assert.equal(JSON.parse(hist.body).shared.owner, "alice");

    // guest powers stop at reading and posting
    assert.equal((await http(r.gw.url, "PATCH", `/sessions/${id}`, { headers: b, body: { title: "mine now" } })).status, 403);
    assert.equal((await http(r.gw.url, "DELETE", `/sessions/${id}?purge=1`, { headers: b })).status, 403);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: b, body: { username: "carol" } })).status, 403, "a guest cannot share the thread on");
    assert.equal((await http(r.gw.url, "GET", `/sessions/${id}/members`, { headers: b })).status, 403, "a guest cannot see who else is on it");
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/device-result`, { headers: b, body: {} })).status, 403);

    // bob opens it and posts; the bot answers in the thread; the message carries his name
    const open = await http(r.gw.url, "POST", "/sessions", { headers: b, body: { surface: "web", resumeId: id } });
    assert.equal(JSON.parse(open.body).sessionId, id);
    const sent = await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: b, body: { text: "bob here" } });
    assert.equal(sent.status, 200, sent.body);
    assert.ok(parseSse(sent.body).some((e) => e.type === "text"), "the bot answered");
    const after = userTexts((await http(r.gw.url, "GET", `/sessions/${id}/history`, { headers: b })).body);
    assert.equal(after.length, 2);
    assert.equal(SENDER_MARK.exec(after[1])?.[1], "bob");
    // alice sees bob's message in her own thread, and her own is unmarked
    const mine = userTexts((await http(r.gw.url, "GET", `/sessions/${id}/history`, { headers: a })).body);
    assert.equal(mine.length, 2);
    assert.equal(SENDER_MARK.test(mine[0]), false);
    // the turn ran on alice's account (her session store), not bob's
    assert.equal(JSON.parse((await http(r.gw.url, "GET", "/sessions", { headers: b })).body).sessions.length, 0);

    // revoke: access ends on the very next request
    const gone = await http(r.gw.url, "DELETE", `/sessions/${id}/members/bob`, { headers: a });
    assert.equal(gone.status, 200, gone.body);
    assert.equal(r.fake.sessionShares.length, 0);
    assert.equal((await http(r.gw.url, "GET", `/sessions/${id}/history`, { headers: b })).status, 403);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: b, body: { text: "still there?" } })).status, 403);
    assert.deepEqual(JSON.parse((await http(r.gw.url, "GET", "/shared-threads", { headers: b })).body).threads, []);
  } finally { await r.close(); }
});

test("a view-only guest can read but not post or stop a turn, a third person stays out, and upgrading a guest to editor takes effect at once", async () => {
  const r = await rig();
  try {
    const a = await r.as("alice"), b = await r.as("bob"), c = await r.as("carol");
    const id = await aliceThread(r);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: a, body: { username: "bob", role: "viewer" } })).status, 200);
    assert.equal((await http(r.gw.url, "GET", `/sessions/${id}/history`, { headers: b })).status, 200);
    const post = await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: b, body: { text: "let me in" } });
    assert.equal(post.status, 403);
    assert.equal(JSON.parse(post.body).error, "view_only");
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/abort`, { headers: b })).status, 403);
    // carol was never added
    assert.equal((await http(r.gw.url, "GET", `/sessions/${id}/history`, { headers: c })).status, 403);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: c, body: { text: "hi" } })).status, 403);
    assert.deepEqual(JSON.parse((await http(r.gw.url, "GET", "/shared-threads", { headers: c })).body).threads, []);
    // upgrading him to editor takes effect at once
    await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: a, body: { username: "bob", role: "editor" } });
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: b, body: { text: "now I can" } })).status, 200);
  } finally { await r.close(); }
});

test("sharing is refused for a missing person, yourself, an empty name, a thread that is not yours, an unknown thread, or removing someone who is not on it", async () => {
  const r = await rig();
  try {
    const a = await r.as("alice"), b = await r.as("bob");
    const id = await aliceThread(r);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: a, body: { username: "nobody-here" } })).status, 404);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: a, body: { username: "alice" } })).status, 400);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: a, body: {} })).status, 400);
    assert.equal((await http(r.gw.url, "POST", `/sessions/${id}/members`, { headers: b, body: { username: "carol" } })).status, 403);
    assert.equal((await http(r.gw.url, "POST", `/sessions/no-such/members`, { headers: a, body: { username: "bob" } })).status, 404);
    assert.equal((await http(r.gw.url, "DELETE", `/sessions/${id}/members/bob`, { headers: a })).status, 404, "removing someone who is not on it");
    assert.equal(r.fake.sessionShares.length, 0);
  } finally { await r.close(); }
});

test("SharedThreads: a revoke tells the gateway (to close that person's open streams) and drops the cached list; MIND down denies after a minute", async () => {
  const { SharedThreads } = await import("../../src/gateway/shared-threads.ts");
  const { userIdFor } = await import("../../src/auth/users.ts");
  const calls: string[] = [];
  const revoked: string[] = [];
  let down = false;
  let at = 1_000;
  let shares = [{ id: "sh1", grantee_username: "bob", role: "editor" }];
  const client = (who: string) => ({
    async call(_t: string, a: Record<string, unknown>) {
      calls.push(`${who}:${a.action}`);
      if (down) throw Object.assign(new Error("MIND x: network error"), { status: 0 });
      if (a.action === "open") return JSON.stringify({ session_id: "mid1" });
      if (a.action === "shares") return JSON.stringify({ shares });
      if (a.action === "share_remove") { shares = []; return "{}"; }
      if (a.action === "list") return JSON.stringify({ sessions: shares.length ? [{ session_id: "mid1", source_key: "daebot", external_session_id: "s1", title: "T", shared: { shared_with_me: true, owner: "alice", role: "editor" } }] : [] });
      return "{}";
    },
  }) as any;
  const st = new SharedThreads({ mindFor: (p) => client(p.username), ttlMs: 5000, now: () => at, onRevoke: (g, s) => revoked.push(`${g}|${s}`) });
  const alice = { id: userIdFor("alice"), username: "alice", tier: "staff", owner: false } as const;
  const bob = { id: userIdFor("bob"), username: "bob", tier: "staff", owner: false } as const;
  assert.equal((await st.grantFor(bob, "s1"))?.role, "editor");
  const n = calls.length;
  assert.equal((await st.grantFor(bob, "s1"))?.sessionId, "s1");
  assert.equal(calls.length, n, "a second read inside the ttl does not ask MIND again");
  await st.remove(alice, { sessionId: "s1", sourceKey: "daebot", title: "T" }, "bob");
  assert.deepEqual(revoked, [`${userIdFor("bob")}|s1`]);
  assert.equal(await st.grantFor(bob, "s1"), undefined, "the cache was dropped, so the revoke shows on the very next read");
  // a thread that is not Daebot's cannot be shared, a bot-less source that does not look like Daebot's is refused
  await assert.rejects(st.add(alice, { sessionId: "s2", sourceKey: "claude-code", title: "" }, "bob"), /cannot be shared/);
  // MIND unreachable: nothing is allowed that was not read recently
  at += 10_000; down = true;
  assert.equal(await st.grantFor(bob, "s1"), undefined);
});
