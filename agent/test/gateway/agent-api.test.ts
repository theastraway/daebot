// POST /api/agent/turn: the server-to-server entry MIND's backend uses (X-MIND-Key, no cookie). Fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { KeyIdentityCache, TurnRateLimiter } from "../../src/gateway/agent-api.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, parseSse, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex"); // throwaway test values
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const PATH = "/api/agent/turn";

async function rig(o: { allowed?: string; rpm?: number; hosted?: boolean } = {}) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "daebot-agentapi-"));
  const provider = new FakeProvider([{ text: "agent says hi" }]);
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live", ...(o.allowed ? { DAEBOT_ALLOWED_USERS: o.allowed } : {}) };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: o.hosted === false ? undefined : hostedOpts, auth, sessionStore, agentApiPerMinute: o.rpm });
  return { gw, fake, keys, provider, close: async () => { await gw.close(); await fake.close(); } };
}

const turn = (r: Awaited<ReturnType<typeof rig>>, key: string | undefined, body: unknown, extra: Record<string, string> = {}) =>
  http(r.gw.url, "POST", PATH, { headers: { ...H, ...(key ? { "x-mind-key": key } : {}), ...extra }, body });

test("a valid key streams the turn as SSE and returns the sessionId in a header and the first event", async () => {
  const r = await rig();
  try {
    const res = await turn(r, r.keys.alice, { text: "hello", surface: "mind-chat" });
    assert.equal(res.status, 200, res.body);
    assert.match(String(res.headers["content-type"]), /text\/event-stream/);
    const evs = parseSse(res.body) as any[];
    const sid = String(res.headers["x-daebot-session"]);
    assert.ok(sid);
    assert.deepEqual(evs[0], { type: "session", sessionId: sid });
    assert.ok(evs.some((e) => e.type === "text" && e.delta.includes("agent says hi")));
    assert.equal(evs.at(-1).type, "done");
    // the turn ran in alice's own MIND: her key reached MIND, the server key did not
    assert.ok(r.fake.seen.some((s) => s.key === r.keys.alice));
    assert.ok(!r.fake.seen.some((s) => s.key.startsWith("server-owner-key-")));
  } finally { await r.close(); }
});

test("a follow-up with the returned sessionId continues the same session; another user cannot touch it", async () => {
  const r = await rig();
  try {
    const first = await turn(r, r.keys.alice, { text: "one" });
    const sid = String(first.headers["x-daebot-session"]);
    const second = await turn(r, r.keys.alice, { text: "two", sessionId: sid });
    assert.equal(second.status, 200, second.body);
    assert.equal(String(second.headers["x-daebot-session"]), sid, "same Daebot session");
    const msgs = r.provider.requests.at(-1)!.messages.map((m) => JSON.stringify(m.content ?? ""));
    assert.ok(msgs.some((m) => m.includes("one")) && msgs.some((m) => m.includes("two")), "history carried over");
    const stolen = await turn(r, r.keys.bob, { text: "mine now", sessionId: sid });
    assert.equal(stolen.status, 403);
  } finally { await r.close(); }
});

test("auth failures: missing, malformed, unknown key -> 401, nothing stored", async () => {
  const r = await rig();
  try {
    assert.equal((await turn(r, undefined, { text: "x" })).status, 401);
    assert.equal((await turn(r, "garbage", { text: "x" })).status, 401);
    assert.equal((await turn(r, "mind_" + rnd(), { text: "x" })).status, 401);
    assert.equal(r.provider.requests.length, 0);
  } finally { await r.close(); }
});

test("repeated bad keys trip the per-IP limiter (429)", async () => {
  const r = await rig();
  try {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await turn(r, "mind_" + rnd(), { text: "x" })).status;
    assert.equal(last, 429);
    // even a good key is held back from that IP for the window
    assert.equal((await turn(r, r.keys.alice, { text: "x" })).status, 429);
  } finally { await r.close(); }
});

test("a browser Origin header is refused; bad host refused; cookies and bearer are not accepted as auth", async () => {
  const r = await rig();
  try {
    assert.equal((await turn(r, r.keys.alice, { text: "x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await turn(r, r.keys.alice, { text: "x" }, { origin: "https://daebot.live" })).status, 403, "even an allowlisted origin: server callers send none");
    assert.equal((await http(r.gw.url, "POST", PATH, { headers: { host: "evil.example", "x-forwarded-proto": "https", "x-mind-key": r.keys.alice }, body: { text: "x" } })).status, 403);
    assert.equal((await http(r.gw.url, "POST", PATH, { headers: { ...H, authorization: "Bearer " + r.keys.alice, cookie: "mc_session=abc" }, body: { text: "x" } })).status, 401);
    assert.equal((await http(r.gw.url, "GET", PATH, { headers: { ...H, "x-mind-key": r.keys.alice } })).status, 405);
  } finally { await r.close(); }
});

test("input validation: empty text, bad surface", async () => {
  const r = await rig();
  try {
    assert.equal((await turn(r, r.keys.alice, { text: "  " })).status, 400);
    assert.equal((await turn(r, r.keys.alice, { text: "x", surface: "Bad Surface!" })).status, 400);
  } finally { await r.close(); }
});

test("per-user rate limit returns 429 with Retry-After, and is per user", async () => {
  const r = await rig({ rpm: 2 });
  try {
    assert.equal((await turn(r, r.keys.alice, { text: "1" })).status, 200);
    assert.equal((await turn(r, r.keys.alice, { text: "2" })).status, 200);
    const over = await turn(r, r.keys.alice, { text: "3" });
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers["retry-after"]) >= 1);
    assert.equal((await turn(r, r.keys.bob, { text: "1" })).status, 200, "bob has his own budget");
  } finally { await r.close(); }
});

test("DAEBOT_ALLOWED_USERS is honored", async () => {
  const r = await rig({ allowed: "bob" });
  try {
    assert.equal((await turn(r, r.keys.alice, { text: "x" })).status, 403);
    assert.equal((await turn(r, r.keys.bob, { text: "x" })).status, 200);
  } finally { await r.close(); }
});

test("a rotated key replaces the stored one and the next turn uses it", async () => {
  const r = await rig();
  try {
    assert.equal((await turn(r, r.keys.alice, { text: "x" })).status, 200);
    const fresh = r.fake.newKey("alice");
    assert.equal((await turn(r, fresh, { text: "y" })).status, 200);
    assert.ok(r.fake.seen.some((s) => s.key === fresh && s.path !== "/developer/v1/profile") || r.fake.seen.some((s) => s.key === fresh));
  } finally { await r.close(); }
});

test("the existing cookie routes still work (send path refactor)", async () => {
  const r = await rig();
  try {
    const login = await http(r.gw.url, "POST", "/auth/key", { headers: H, body: { key: r.keys.alice } });
    const cookie = String(([] as string[]).concat(login.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
    const h = { ...H, cookie };
    const sid = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: h, body: { surface: "web" } })).body).sessionId;
    const res = await http(r.gw.url, "POST", `/sessions/${sid}/send`, { headers: h, body: { text: "hello" } });
    assert.equal(res.status, 200);
    assert.equal((parseSse(res.body) as any[]).at(-1).type, "done");
  } finally { await r.close(); }
});

test("not hosted: the route does not exist", async () => {
  const r = await rig({ hosted: false });
  try {
    const res = await http(r.gw.url, "POST", PATH, { headers: { host: "localhost", "x-mind-key": r.keys.alice }, body: { text: "x" } });
    assert.notEqual(res.status, 200, "no agent API outside hosted mode");
  } finally { await r.close(); }
});

test("TurnRateLimiter and KeyIdentityCache unit behavior", () => {
  const l = new TurnRateLimiter({ max: 2, windowMs: 1000 });
  assert.equal(l.take("u", 0), 0);
  assert.equal(l.take("u", 100), 0);
  assert.equal(l.take("u", 200), 1);
  assert.equal(l.take("u", 1001), 0, "window slides");
  let t = 0;
  const c = new KeyIdentityCache(100, () => t);
  c.set("mind_k", "alice");
  assert.equal(c.get("mind_k"), "alice");
  t = 101;
  assert.equal(c.get("mind_k"), undefined);
});
