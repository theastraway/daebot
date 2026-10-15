import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthContext } from "../../src/auth/index.ts";
import { OWNER, userIdFor } from "../../src/auth/users.ts";
import { MindOAuth } from "../../src/auth/mind-auth.ts";
import { createRuntimeHub } from "../../src/auth/tenancy.ts";
import { UserStore } from "../../src/auth/users.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createRuntime } from "../../src/runtime.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { FakeProvider, baseCfg, call, collect } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");

async function world(o: { userCap?: string; globalCap?: number; rounds?: ConstructorParameters<typeof FakeProvider>[0] } = {}) {
  const keys = { alice: "mind_" + rnd(), boss: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.boss]: "boss" });
  const provider = new FakeProvider(o.rounds ?? [{ text: "ok" }]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(o.globalCap ?? 50);
  const ownerRuntime = createRuntime(cfg, { provider, hosted: { dailyUsdCap: 50, sharedCap: globalCap } });
  const hosted = { token: rnd(), allowedHosts: ["daebot.live"] };
  const env = { DATA_DIR: mkdtempSync(join(tmpdir(), "daebot-rt-")), DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "boss", MIND_OAUTH_BASE_URL: fake.url, ...(o.userCap ? { MINDCLAW_USER_DAILY_USD_CAP: o.userCap } : {}) };
  const auth = createAuthContext({ env, cfg, hosted, ownerRuntime, globalCap, provider });
  const principal = (name: string) => {
    auth.store.upsert(name, { kind: "key", mindKey: keys[name as "alice" | "boss"] });
    return auth.store.principal(userIdFor(name))!;
  };
  return { fake, provider, auth, keys, principal, globalCap, close: () => fake.close() };
}

const toolNames = (p: FakeProvider) => p.requests[0].tools.map((t) => t.name);

test("tiers: a signed-in user is staff (no public/outward/irreversible tools); DAEBOT_ADMINS users are admin", async () => {
  const w = await world();
  try {
    const alice = w.principal("alice");
    const boss = w.principal("boss");
    assert.equal(alice.tier, "staff");
    assert.equal(boss.tier, "admin");
    // staff sessions: the tool list excludes the feed-post (public) tool; admin keeps it
    const sa = await w.auth.runtimeFor(alice).openSession({ surface: "web" });
    await collect(sa.send("please post this to the feed"));
    const staffTools = toolNames(w.provider);
    assert.ok(staffTools.includes("mind_query"));
    assert.ok(!staffTools.includes("mind_feed_post"), "staff cannot post publicly");
    const sb = await w.auth.runtimeFor(boss).openSession({ surface: "web" });
    await collect(sb.send("please post this to the feed"));
    assert.ok(w.provider.requests[1].tools.map((t) => t.name).includes("mind_feed_post"), "admin keeps the public tool");
    // a caller cannot lift the tier: asking the staff runtime for "admin" is overridden
    const sneaky = await w.auth.runtimeFor(alice).openSession({ surface: "web", identity: "admin" });
    await collect(sneaky.send("please post this to the feed"));
    assert.ok(!w.provider.requests[2].tools.map((t) => t.name).includes("mind_feed_post"));
    // and a model that calls a tool above the tier is blocked (here: shell-less hosted, so use the public feed tool)
    const w2 = await world({ rounds: [{ calls: [call("c1", "mind_feed_post", { content: "x" })] }, { text: "done" }] });
    try {
      const s = await w2.auth.runtimeFor(w2.principal("alice")).openSession({ surface: "web" });
      const ev = await collect(s.send("please post this to the feed"));
      assert.ok(!ev.some((e) => e.type === "toolStart" && (e as any).tool === "mind_feed_post"));
      assert.ok(!w2.fake.seen.some((x) => x.path.includes("feed")), "nothing reached the feed");
    } finally { await w2.close(); }
  } finally { await w.close(); }
});

test("per-user daily cost cap: stops that user only; admins exempt from both caps; non-admin spend counts toward the global cap", async () => {
  // each provider round costs 0.001 (see FakeProvider); user cap 0.001 is spent by one turn
  const w = await world({ userCap: "0.001" });
  try {
    const alice = w.principal("alice");
    const boss = w.principal("boss");
    const rtA = w.auth.runtimeFor(alice);
    const s1 = await rtA.openSession({ surface: "web" });
    const first = await collect(s1.send("one"));
    assert.ok(first.some((e) => e.type === "text"), "first turn runs");
    const second = await collect(s1.send("two"));
    const notice = second.find((e) => e.type === "notice") as any;
    assert.match(notice.text, /Your daily cost cap reached/);
    assert.ok(!second.some((e) => e.type === "text"), "no model call after the cap");
    // a fresh session for the same user is capped too (cap is per user, not per session)
    const s1b = await rtA.openSession({ surface: "web" });
    assert.match(String((await collect(s1b.send("three"))).find((e) => e.type === "notice")?.["text" as never]), /Your daily cost cap/);
    // admin is not subject to the per-user cap
    const sb = await w.auth.runtimeFor(boss).openSession({ surface: "web" });
    await collect(sb.send("a"));
    assert.ok((await collect(sb.send("b"))).some((e) => e.type === "text"));
    // non-admin spend counts toward the global cap; once it is hit, non-admins stop but admins keep working
    w.globalCap.add(1000);
    const s2 = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    assert.ok((await collect(s2.send("d"))).some((e) => e.type === "notice"), "non-admin blocked by the global cap");
    assert.ok((await collect(sb.send("c"))).some((e) => e.type === "text"), "admin is exempt from the global cap");
  } finally { await w.close(); }
});

test("default per-user cap is $1 and MINDCLAW_USER_DAILY_USD_CAP overrides it", async () => {
  const { parseUserCap } = await import("../../src/auth/index.ts");
  assert.equal(parseUserCap(undefined), 1);
  assert.equal(parseUserCap(""), 1);
  assert.equal(parseUserCap("nope"), 1);
  assert.equal(parseUserCap("-2"), 1);
  assert.equal(parseUserCap("2.5"), 2.5);
});

test("OAuth user: when MIND answers 401 the key pair is refreshed (rotated), stored sealed, and the call is retried", async () => {
  const fake = await startFakeMind();
  try {
    fake.consentUser = "carol";
    const dir = mkdtempSync(join(tmpdir(), "daebot-rt-"));
    const store = new UserStore({ dir, secretKey: rnd() + rnd() });
    const oauth = new MindOAuth({ baseUrl: fake.url, publicUrl: "https://daebot.live", dataDir: dir });
    // do the sign-in dance against the fake
    const { url, state } = await oauth.start();
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    const t = await oauth.finish(back.searchParams.get("code")!, back.searchParams.get("state")!);
    assert.equal(back.searchParams.get("state"), state);
    store.upsert("carol", { kind: "oauth", accessToken: t.accessToken, refreshToken: t.refreshToken, clientId: t.clientId });
    const uid = userIdFor("carol");

    const provider = new FakeProvider([{ text: "ok" }]);
    const hub = createRuntimeHub({
      baseCfg: baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() }), store, oauth,
      ownerRuntime: createRuntime(baseCfg(), { provider }), globalCap: new DailyCostCap(50), userCapUsd: 1, provider,
    });
    const p = store.principal(uid)!;
    const old = t.accessToken;
    // MIND revokes the access key out from under us (rotated elsewhere / revoked)
    fake.keys.delete(old);
    const s = await hub.runtimeFor(p).openSession({ surface: "web" });
    const ev = await collect(s.send("hello"));
    assert.ok(ev.some((e) => e.type === "text"), "the turn ran after the transparent refresh");
    const creds = store.creds(uid)!;
    assert.equal(creds.kind, "oauth");
    assert.notEqual((creds as any).accessToken, old, "the rotated key replaced the old one");
    assert.ok(fake.seen.some((x) => x.path === "/oauth/mcp/token" && String(x.body).includes("grant_type=refresh_token")));
    assert.ok(fake.seen.some((x) => x.path === "/developer/v1/context" && x.key === (creds as any).accessToken), "retry used the new key");
  } finally { await fake.close(); }
});

test("a user with unreadable credentials gets a runtime that fails closed (never the server key)", async () => {
  const w = await world();
  try {
    const alice = w.principal("alice");
    // simulate loss of decryptability: reopen the store under a different key
    const other = new UserStore({ dir: (w.auth.store as any).path.replace(/\/daebot-users\.json$/, ""), secretKey: rnd() + rnd() });
    const hub = createRuntimeHub({ baseCfg: baseCfg({ mindApiKey: "server-owner-key-x" }), store: other, ownerRuntime: createRuntime(baseCfg(), { provider: w.provider }), globalCap: new DailyCostCap(5), userCapUsd: 1, provider: w.provider });
    await assert.rejects(hub.runtimeFor(alice).openSession({ surface: "web" }), /sign in again/i);
    assert.equal(hub.runtimeFor(OWNER) !== undefined, true);
  } finally { await w.close(); }
});

test("admin spend does not count toward the global cap (strangers cannot be blamed on, or lock out, an admin)", async () => {
  const w = await world();
  try {
    const sb = await w.auth.runtimeFor(w.principal("boss")).openSession({ surface: "web" });
    await collect(sb.send("one"));
    assert.equal(w.globalCap.total(), 0);
    const sa = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    await collect(sa.send("one"));
    assert.ok(w.globalCap.total() > 0, "non-admin spend is counted");
  } finally { await w.close(); }
});
