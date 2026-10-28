import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap, HostedConfigError, issueSession, parseSession } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { SealError, deriveDataKey, open, seal } from "../../src/auth/crypto.ts";
import { UserStore, userIdFor } from "../../src/auth/users.ts";
import { MindAuthError, whoami } from "../../src/auth/mind-auth.ts";
import { APP_CALLBACK, AppHandoff, appRedirect, challengeOf, isAppCallback } from "../../src/auth/app-handoff.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import type { FakeMind } from "./fake-mind.ts";
import { fakeRuntime, http, parseSse, tmpStatic, wsConnect } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex"); // throwaway test values
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) =>
  String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

interface Rig {
  gw: Awaited<ReturnType<typeof startGateway>>;
  fake: FakeMind;
  token: string;
  dir: string;
  secret: string;
  provider: FakeProvider;
  bootCache: BootCache;
  keys: { alice: string; bob: string; boss: string };
  close(): Promise<void>;
}

async function rig(o: { env?: Record<string, string>; users?: boolean; dir?: string; secret?: string; oauth?: boolean } = {}): Promise<Rig> {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd(), boss: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [keys.boss]: "boss" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "daebot-auth-"));
  const secret = o.secret ?? rnd() + rnd();
  const provider = new FakeProvider([{ text: "hi there" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = {
    DATA_DIR: dir, ...(o.users === false ? {} : { DAEBOT_SECRET_KEY: secret }), DAEBOT_ADMINS: "boss",
    MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live", ...(o.env ?? {}),
  };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  if (o.oauth === false) auth.oauth = undefined;
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  return { gw, fake, token, dir, secret, provider, bootCache, keys, close: async () => { await gw.close(); await fake.close(); } };
}

const keyLogin = (r: Rig, key: string) => http(r.gw.url, "POST", "/auth/key", { headers: H, body: { key } });
const asUser = async (r: Rig, key: string) => {
  const res = await keyLogin(r, key);
  assert.equal(res.status, 200, res.body);
  return { ...H, cookie: cookieOf(res) };
};

// ---------- crypto ----------
test("seal/open: round trip, wrong key, tamper, truncation and cross-record swap all behave", () => {
  const key = deriveDataKey(rnd() + rnd());
  const payload = { kind: "key", mindKey: "mind_" + rnd() };
  const sealed = seal(key, payload, "u_one");
  assert.ok(sealed.startsWith("v1."));
  assert.ok(!sealed.includes(payload.mindKey), "ciphertext must not contain the plaintext");
  assert.deepEqual(open(key, sealed, "u_one"), payload);
  assert.notEqual(seal(key, payload, "u_one"), sealed, "fresh IV every time");
  // wrong key
  assert.throws(() => open(deriveDataKey(rnd() + rnd()), sealed, "u_one"), SealError);
  // bound to the record id (a blob copied onto another user's record is rejected)
  assert.throws(() => open(key, sealed, "u_two"), SealError);
  // tamper: flip one character in the ciphertext, the tag and the IV
  for (const at of [5, 20, sealed.length - 3]) {
    const bad = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
    assert.throws(() => open(key, bad, "u_one"), SealError, `flip @${at}`);
  }
  assert.throws(() => open(key, sealed.slice(0, 20), "u_one"), SealError);
  assert.throws(() => open(key, "plain text", "u_one"), SealError);
  assert.throws(() => deriveDataKey("short"), SealError);
});

test("UserStore: credentials are encrypted on disk, survive a restart, and a bad key or tamper is detected", () => {
  const dir = mkdtempSync(join(tmpdir(), "daebot-store-"));
  const secret = rnd() + rnd();
  const mk = "mind_" + rnd();
  const s1 = new UserStore({ dir, secretKey: secret, admins: ["boss"] });
  const u = s1.upsert("Alice", { kind: "key", mindKey: mk });
  assert.equal(u.id, userIdFor("alice"), "id is stable and case-insensitive");
  assert.equal(u.tier, "staff");
  assert.equal(s1.upsert("boss", { kind: "key", mindKey: "mind_" + rnd() }).tier, "admin");
  const file = readFileSync(join(dir, "daebot-users.json"), "utf8");
  assert.ok(!file.includes(mk), "the MIND key is not on disk in the clear");
  assert.ok(file.includes("Alice"), "metadata (username) is plain");
  // restart
  const s2 = new UserStore({ dir, secretKey: secret, admins: ["boss"] });
  assert.equal(s2.count(), 2);
  assert.deepEqual(s2.creds(u.id), { kind: "key", mindKey: mk });
  assert.equal(s2.unreadable, 0);
  // wrong key at restart: starts, but nothing decrypts
  const s3 = new UserStore({ dir, secretKey: rnd() + rnd() });
  assert.equal(s3.unreadable, 2);
  assert.equal(s3.creds(u.id), undefined);
  // tamper with one record on disk
  const parsed = JSON.parse(file);
  const rec = parsed.users[u.id];
  rec.secret = rec.secret.slice(0, -4) + (rec.secret.endsWith("AAAA") ? "BBBB" : "AAAA");
  writeFileSync(join(dir, "daebot-users.json"), JSON.stringify(parsed));
  const s4 = new UserStore({ dir, secretKey: secret, admins: ["boss"] });
  assert.equal(s4.unreadable, 1);
  assert.equal(s4.creds(u.id), undefined, "tampered record yields no credentials");
  // a record moved onto another username is dropped on load (id must match username)
  parsed.users[userIdFor("mallory")] = { ...parsed.users[u.id], username: "alice" };
  writeFileSync(join(dir, "daebot-users.json"), JSON.stringify(parsed));
  assert.equal(new UserStore({ dir, secretKey: secret }).get(userIdFor("mallory")), undefined);
});

test("hosted refuses to start with stored users and no (or a short) DAEBOT_SECRET_KEY", () => {
  const dir = mkdtempSync(join(tmpdir(), "daebot-store-"));
  const secret = rnd() + rnd();
  new UserStore({ dir, secretKey: secret }).upsert("alice", { kind: "key", mindKey: "mind_" + rnd() });
  assert.throws(() => new UserStore({ dir }), (e: Error) => e instanceof HostedConfigError && /DAEBOT_SECRET_KEY/.test(e.message));
  assert.throws(() => new UserStore({ dir, secretKey: "tooshort" }), HostedConfigError);
  // no users yet and no key: allowed, user sign-in is simply off
  const empty = new UserStore({ dir: mkdtempSync(join(tmpdir(), "daebot-store-")) });
  assert.equal(empty.enabled, false);
  assert.throws(() => empty.upsert("alice", { kind: "key", mindKey: "mind_x" }));
});

test("session cookie: user id only, signed, expires; owner cookie keeps the legacy shape", () => {
  const t = rnd();
  const uid = userIdFor("alice");
  const c = issueSession(t, 60_000, Date.now(), uid);
  assert.ok(c.value.startsWith(uid + ":"));
  assert.ok(!c.value.includes("alice"));
  assert.deepEqual(parseSession(t, c.value), { uid });
  assert.equal(parseSession(rnd(), c.value), undefined, "other secret");
  assert.equal(parseSession(t, c.value.replace(uid, userIdFor("bob"))), undefined, "uid swap breaks the mac");
  assert.equal(parseSession(t, c.value, Date.now() + 120_000), undefined, "expired");
  const o = issueSession(t, 60_000);
  assert.ok(/^\d+\./.test(o.value));
  assert.deepEqual(parseSession(t, o.value), { uid: "owner" });
  // an owner mac cannot be replayed as a user cookie
  const [, mac] = o.value.split(".");
  assert.equal(parseSession(t, `${uid}:${o.value.split(".")[0]}.${mac}`), undefined);
});

// ---------- MIND key validation ----------
test("whoami: valid key returns the username; invalid, malformed and unreachable fail without leaking the key", async () => {
  const k = "mind_" + rnd();
  const fake = await startFakeMind({ [k]: "alice" });
  try {
    assert.deepEqual(await whoami(fake.base, k), { username: "alice" });
    const bad = "mind_" + rnd();
    await assert.rejects(whoami(fake.base, bad), (e: MindAuthError) => e.status === 401 && !e.message.includes(bad));
    await assert.rejects(whoami(fake.base, "not-a-key"), (e: MindAuthError) => e.status === 400);
    const before = fake.seen.length;
    await assert.rejects(whoami(fake.base, "nope nope"), MindAuthError);
    assert.equal(fake.seen.length, before, "a malformed key never leaves the process");
    await assert.rejects(whoami("http://127.0.0.1:1/developer/v1", k), (e: MindAuthError) => e.status === 502 && !e.message.includes(k));
  } finally { await fake.close(); }
});

// ---------- login flows through the gateway ----------
test("methods: owner always; key and oauth only when DAEBOT_SECRET_KEY is set", async () => {
  const on = await rig();
  const off = await rig({ users: false });
  try {
    assert.deepEqual(JSON.parse((await http(on.gw.url, "GET", "/auth/methods", { headers: H })).body), { owner: true, key: true, oauth: true });
    assert.deepEqual(JSON.parse((await http(off.gw.url, "GET", "/auth/methods", { headers: H })).body), { owner: true, key: false, oauth: false });
    assert.equal((await keyLogin(off, off.keys.alice)).status, 404);
  } finally { await on.close(); await off.close(); }
});

test("owner code still works and maps to the server key, not a user", async () => {
  const r = await rig();
  try {
    const login = await http(r.gw.url, "POST", "/login", { headers: H, body: { token: r.token } });
    assert.equal(login.status, 200);
    const h = { ...H, cookie: cookieOf(login) };
    const me = JSON.parse((await http(r.gw.url, "GET", "/auth/me", { headers: h })).body);
    assert.deepEqual(me, { username: "Owner", owner: true, tier: "admin", bots: false });
    const sid = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: h, body: { surface: "web" } })).body).sessionId;
    await http(r.gw.url, "POST", `/sessions/${sid}/send`, { headers: h, body: { text: "hello" } });
    // the owner's MIND traffic used the server key; no user key was involved
    assert.ok(r.fake.seen.some((s) => s.key.startsWith("server-owner-key-")));
    assert.ok(!r.fake.seen.some((s) => s.key === r.keys.alice));
  } finally { await r.close(); }
});

test("API key sign-in: valid key -> cookie + stored sealed + /auth/me; invalid key -> 401, no cookie, nothing stored", async () => {
  const r = await rig();
  try {
    const bad = await keyLogin(r, "mind_" + rnd());
    assert.equal(bad.status, 401);
    assert.equal(bad.headers["set-cookie"], undefined);
    assert.equal((await keyLogin(r, "garbage")).status, 401);
    assert.equal(existsSync(join(r.dir, "users", "daebot-users.json")), false, "a rejected key stores nothing");

    const ok = await keyLogin(r, r.keys.alice);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).username, "alice");
    const cookie = cookieOf(ok);
    assert.ok(!cookie.includes("alice") && !cookie.includes(r.keys.alice), "cookie carries only the user id");
    assert.match(String(ok.headers["set-cookie"]), /HttpOnly; Secure; SameSite=Strict/);
    const me = JSON.parse((await http(r.gw.url, "GET", "/auth/me", { headers: { ...H, cookie } })).body);
    assert.deepEqual(me, { username: "alice", owner: false, tier: "staff", bots: false });
    const onDisk = readFileSync(join(r.dir, "users", "daebot-users.json"), "utf8");
    assert.ok(!onDisk.includes(r.keys.alice), "key encrypted at rest");
    // admin by DAEBOT_ADMINS
    const boss = await asUser(r, r.keys.boss);
    assert.equal(JSON.parse((await http(r.gw.url, "GET", "/auth/me", { headers: boss })).body).tier, "admin");
    // sign out
    const out = await http(r.gw.url, "POST", "/logout", { headers: { ...H, cookie } });
    assert.equal(out.status, 200);
    assert.match(String(out.headers["set-cookie"]), /Max-Age=0/);
  } finally { await r.close(); }
});

test("API key sign-in is rate limited by IP, and DAEBOT_ALLOWED_USERS gates accounts", async () => {
  const r = await rig({ env: { DAEBOT_ALLOWED_USERS: "alice,boss" } });
  try {
    assert.equal((await keyLogin(r, r.keys.bob)).status, 403, "bob is not on the allow list");
    assert.equal((await keyLogin(r, r.keys.alice)).status, 200);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await keyLogin(r, "mind_" + rnd())).status;
    assert.equal(last, 429);
  } finally { await r.close(); }
});

test("MIND OAuth: code + PKCE end to end, state bound to the browser, single use, Daebot self-registers", async () => {
  const r = await rig();
  try {
    r.fake.consentUser = "alice";
    const start = await http(r.gw.url, "GET", "/auth/mind/start", { headers: H });
    assert.equal(start.status, 302);
    const loc = new URL(String(start.headers.location));
    assert.equal(loc.origin, r.fake.url);
    assert.equal(loc.pathname, "/oauth/mcp/authorize");
    assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
    assert.equal(loc.searchParams.get("redirect_uri"), "https://daebot.live/auth/mind/callback");
    assert.equal(r.fake.registered.length, 1, "registered itself as a public client");
    assert.deepEqual(r.fake.registered[0].redirect_uris, ["https://daebot.live/auth/mind/callback"]);
    const oauthCookie = String(([] as string[]).concat(start.headers["set-cookie"] as string[])[0]);
    assert.match(oauthCookie, /HttpOnly; Secure; SameSite=Lax; Path=\/auth\/mind/);
    const bound = oauthCookie.split(";")[0];

    // The user consents at MIND (fake auto-approves) and MIND redirects back with code + state.
    const consent = await fetch(loc, { redirect: "manual" });
    const cb = new URL(consent.headers.get("location")!);
    assert.equal(cb.origin + cb.pathname, "https://daebot.live/auth/mind/callback");
    const cbPath = cb.pathname + cb.search;

    // Without the browser-bound cookie the callback is refused (login CSRF / code injection)
    const noCookie = await http(r.gw.url, "GET", cbPath, { headers: H });
    assert.equal(noCookie.status, 302);
    assert.match(String(noCookie.headers.location), /^\/login\?e=state/);
    // ...and that attempt burned nothing: but a wrong cookie value is refused too
    const wrong = await http(r.gw.url, "GET", cbPath, { headers: { ...H, cookie: "mc_oauth=" + rnd() } });
    assert.match(String(wrong.headers.location), /e=state/);

    const done = await http(r.gw.url, "GET", cbPath, { headers: { ...H, cookie: bound } });
    assert.equal(done.status, 200);
    assert.match(done.body, /http-equiv="refresh"/);
    assert.ok(r.fake.lastVerifier && r.fake.lastVerifier.length >= 43, "PKCE verifier was sent and matched the challenge");
    const cookie = cookieOf(done);
    const me = JSON.parse((await http(r.gw.url, "GET", "/auth/me", { headers: { ...H, cookie } })).body);
    assert.deepEqual(me, { username: "alice", owner: false, tier: "staff", bots: false });
    const stored = readFileSync(join(r.dir, "users", "daebot-users.json"), "utf8");
    assert.ok(!/mind_rt_/.test(stored) && !/"mind_/.test(stored), "tokens are sealed on disk");

    // replay of the same callback fails (state is single use)
    const replay = await http(r.gw.url, "GET", cbPath, { headers: { ...H, cookie: bound } });
    assert.match(String(replay.headers.location ?? ""), /^\/login\?e=/);

    // the registered client id is reused on the next sign-in
    await http(r.gw.url, "GET", "/auth/mind/start", { headers: H });
    assert.equal(r.fake.registered.length, 1);
  } finally { await r.close(); }
});

test("MIND OAuth: user denies, and a bad code, both come back to the login page with a reason", async () => {
  const r = await rig();
  try {
    const start = await http(r.gw.url, "GET", "/auth/mind/start", { headers: H });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const bound = String(([] as string[]).concat(start.headers["set-cookie"] as string[])[0]).split(";")[0];
    const denied = await http(r.gw.url, "GET", `/auth/mind/callback?error=access_denied&state=${state}`, { headers: { ...H, cookie: bound } });
    assert.match(String(denied.headers.location), /e=denied/);
    const s2 = await http(r.gw.url, "GET", "/auth/mind/start", { headers: H });
    const st2 = new URL(String(s2.headers.location)).searchParams.get("state")!;
    const b2 = String(([] as string[]).concat(s2.headers["set-cookie"] as string[])[0]).split(";")[0];
    const badCode = await http(r.gw.url, "GET", `/auth/mind/callback?code=nope&state=${st2}`, { headers: { ...H, cookie: b2 } });
    assert.match(String(badCode.headers.location), /e=oauth/);
    assert.equal(badCode.headers["set-cookie"] === undefined || !String(badCode.headers["set-cookie"]).includes("mc_session=u_"), true);
  } finally { await r.close(); }
});

// ---------- native app handoff (daebot://auth/callback) ----------
test("app handoff: callback is one exact constant; codes are single use, expire, and need the verifier", () => {
  assert.equal(APP_CALLBACK, "daebot://auth/callback");
  assert.ok(isAppCallback("daebot://auth/callback"));
  for (const bad of ["daebot://auth/callback/", "daebot://auth/callback?x=1", "daebot://evil", "https://daebot.live/", "daebot://auth", "", null, undefined, "DAEBOT://auth/callback"]) assert.ok(!isAppCallback(bad as any), String(bad));
  assert.equal(appRedirect({ code: "c1" }), "daebot://auth/callback?code=c1");
  assert.equal(appRedirect({ error: "denied" }), "daebot://auth/callback?error=denied");
  let t = 1_000;
  const h = new AppHandoff(() => t);
  const verifier = randomBytes(48).toString("base64url");
  const cc = challengeOf(verifier);
  const code = h.mintCode("u_one", cc);
  assert.equal(h.redeem(code, randomBytes(48).toString("base64url")), undefined, "wrong verifier");
  assert.equal(h.redeem(code, verifier), undefined, "a failed try burns the code");
  const c2 = h.mintCode("u_one", cc);
  assert.equal(h.redeem(c2, verifier), "u_one");
  assert.equal(h.redeem(c2, verifier), undefined, "single use");
  const c3 = h.mintCode("u_one", cc);
  t += 61_000;
  assert.equal(h.redeem(c3, verifier), undefined, "expired after 60s");
  assert.equal(h.redeem(undefined, verifier), undefined);
  h.beginFlow("st", cc);
  assert.equal(h.takeFlow("st"), cc);
  assert.equal(h.takeFlow("st"), undefined, "flow is single use");
});

test("app sign-in: OAuth started by the app ends at daebot://auth/callback with a one-time code, exchanged over HTTPS for the session", async () => {
  const r = await rig();
  try {
    r.fake.consentUser = "alice";
    const verifier = randomBytes(48).toString("base64url");
    const cc = challengeOf(verifier);
    // a bad / missing challenge never starts an app flow
    const bad = await http(r.gw.url, "GET", "/auth/mind/start?app=ios&cc=short", { headers: H });
    assert.equal(bad.headers.location, "daebot://auth/callback?error=bad_request");

    const start = await http(r.gw.url, "GET", `/auth/mind/start?app=ios&cc=${cc}`, { headers: H });
    assert.equal(start.status, 302);
    const loc = new URL(String(start.headers.location));
    assert.equal(loc.pathname, "/oauth/mcp/authorize");
    assert.equal(loc.searchParams.get("redirect_uri"), "https://daebot.live/auth/mind/callback", "MIND still redirects to the https callback");
    const bound = String(([] as string[]).concat(start.headers["set-cookie"] as string[])[0]).split(";")[0];
    const consent = await fetch(loc, { redirect: "manual" });
    const cb = new URL(consent.headers.get("location")!);
    const cbPath = cb.pathname + cb.search;

    const done = await http(r.gw.url, "GET", cbPath, { headers: { ...H, cookie: bound } });
    assert.equal(done.status, 302);
    const back = new URL(String(done.headers.location));
    assert.equal(String(done.headers.location).split("?")[0], "daebot://auth/callback");
    assert.ok(!([] as string[]).concat(done.headers["set-cookie"] as string[]).some((c) => c.startsWith("mc_session=")), "no session cookie in the auth sheet");
    const code = back.searchParams.get("code")!;
    assert.ok(code.length >= 40);
    assert.ok(!String(done.headers.location).includes("mind_"), "no key or token in the URL");

    // wrong verifier fails and burns the code; right one works once
    const wrong = await http(r.gw.url, "POST", "/auth/app/exchange", { headers: H, body: { code, verifier: randomBytes(48).toString("base64url") } });
    assert.equal(wrong.status, 401);
    const again = await http(r.gw.url, "POST", "/auth/app/exchange", { headers: H, body: { code, verifier } });
    assert.equal(again.status, 401, "burned by the failed try");

    // full second pass, correct verifier
    const s2 = await http(r.gw.url, "GET", `/auth/mind/start?app=ios&cc=${cc}`, { headers: H });
    const b2 = String(([] as string[]).concat(s2.headers["set-cookie"] as string[])[0]).split(";")[0];
    const c2 = await fetch(new URL(String(s2.headers.location)), { redirect: "manual" });
    const cb2 = new URL(c2.headers.get("location")!);
    const d2 = await http(r.gw.url, "GET", cb2.pathname + cb2.search, { headers: { ...H, cookie: b2 } });
    const code2 = new URL(String(d2.headers.location)).searchParams.get("code")!;
    const ex = await http(r.gw.url, "POST", "/auth/app/exchange", { headers: H, body: { code: code2, verifier } });
    assert.equal(ex.status, 200, ex.body);
    const cookie = cookieOf(ex);
    const me = JSON.parse((await http(r.gw.url, "GET", "/auth/me", { headers: { ...H, cookie } })).body);
    assert.equal(me.username, "alice");
    const replay = await http(r.gw.url, "POST", "/auth/app/exchange", { headers: H, body: { code: code2, verifier } });
    assert.equal(replay.status, 401, "single use");
  } finally { await r.close(); }
});

test("app sign-in: a callback that outlives the in-memory flow still closes the auth sheet at daebot:// (error=expired), never a web page", async () => {
  const r = await rig();
  try {
    r.fake.consentUser = "alice";
    const cc = challengeOf(randomBytes(48).toString("base64url"));
    const start = await http(r.gw.url, "GET", `/auth/mind/start?app=ios&cc=${cc}`, { headers: H });
    const cookies = ([] as string[]).concat(start.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    assert.ok(cookies.some((c) => c === "mc_oauth_app=1"), "app flows mark their sheet");
    const consent = await fetch(new URL(String(start.headers.location)), { redirect: "manual" });
    const cb = new URL(consent.headers.get("location")!);
    const path = cb.pathname + cb.search;
    // first arrival consumes the flow; the same sheet arriving again looks exactly like an expired flow
    const first = await http(r.gw.url, "GET", path, { headers: { ...H, cookie: cookies.join("; ") } });
    assert.match(String(first.headers.location), /^daebot:\/\/auth\/callback\?code=/);
    const late = await http(r.gw.url, "GET", path, { headers: { ...H, cookie: cookies.join("; ") } });
    assert.equal(late.headers.location, "daebot://auth/callback?error=expired");
    assert.ok(!([] as string[]).concat(late.headers["set-cookie"] as string[]).some((c) => c.startsWith("mc_session=")), "no session cookie");
    // a plain browser sign-in (no app marker) is untouched
    const web = await http(r.gw.url, "GET", "/auth/mind/start", { headers: H });
    assert.ok(!([] as string[]).concat(web.headers["set-cookie"] as string[]).some((c) => c.startsWith("mc_oauth_app")), "web flows carry no app marker");
  } finally { await r.close(); }
});

test("app sign-in: denial and a cookie-less callback come back to the app / login, never a session", async () => {
  const r = await rig();
  try {
    const cc = challengeOf(randomBytes(48).toString("base64url"));
    const start = await http(r.gw.url, "GET", `/auth/mind/start?app=ios&cc=${cc}`, { headers: H });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const bound = String(([] as string[]).concat(start.headers["set-cookie"] as string[])[0]).split(";")[0];
    const nocookie = await http(r.gw.url, "GET", `/auth/mind/callback?code=x&state=${state}`, { headers: H });
    assert.match(String(nocookie.headers.location), /^\/login\?e=state/);
    const denied = await http(r.gw.url, "GET", `/auth/mind/callback?error=access_denied&state=${state}`, { headers: { ...H, cookie: bound } });
    assert.equal(denied.headers.location, "daebot://auth/callback?error=denied");
    // exchange with a made-up code is refused
    const ex = await http(r.gw.url, "POST", "/auth/app/exchange", { headers: H, body: { code: rnd(), verifier: randomBytes(48).toString("base64url") } });
    assert.equal(ex.status, 401);
    // the normal (non-app) flow still sets the cookie directly
    r.fake.consentUser = "alice";
    const plain = await http(r.gw.url, "GET", "/auth/mind/start", { headers: H });
    const pb = String(([] as string[]).concat(plain.headers["set-cookie"] as string[])[0]).split(";")[0];
    const pc = await fetch(new URL(String(plain.headers.location)), { redirect: "manual" });
    const pcb = new URL(pc.headers.get("location")!);
    const pd = await http(r.gw.url, "GET", pcb.pathname + pcb.search, { headers: { ...H, cookie: pb } });
    assert.equal(pd.status, 200);
    assert.ok(cookieOf(pd).startsWith("mc_session="));
  } finally { await r.close(); }
});

// ---------- tenancy: isolation ----------
test("cross-user isolation: another user's session cannot be listed, opened, resumed, sent to, aborted, closed or read (403)", async () => {
  const r = await rig();
  try {
    const A = await asUser(r, r.keys.alice);
    const B = await asUser(r, r.keys.bob);
    const sidA = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: A, body: { surface: "web", title: "alice private" } })).body).sessionId as string;
    const turn = await http(r.gw.url, "POST", `/sessions/${sidA}/send`, { headers: A, body: { text: "remember alice secret" } });
    assert.equal(turn.status, 200);
    assert.ok(parseSse(turn.body).some((e) => e.type === "done"));

    // list
    const listB = JSON.parse((await http(r.gw.url, "GET", "/sessions", { headers: B })).body).sessions as { id: string }[];
    assert.ok(!listB.some((s) => s.id === sidA), "B does not see A's session");
    const listA = JSON.parse((await http(r.gw.url, "GET", "/sessions", { headers: A })).body).sessions as { id: string }[];
    assert.ok(listA.some((s) => s.id === sidA));
    // every per-session route is 403 for B
    for (const [m, p, body] of [
      ["POST", `/sessions/${sidA}/send`, { text: "hi" }],
      ["POST", `/sessions/${sidA}/abort`, undefined],
      ["POST", `/sessions/${sidA}/device-result`, { id: "x", ok: true, result: {} }],
      ["GET", `/sessions/${sidA}/violations`, undefined],
      ["DELETE", `/sessions/${sidA}`, undefined],
    ] as const) {
      assert.equal((await http(r.gw.url, m, p, { headers: B, body })).status, 403, `${m} ${p}`);
    }
    // resume by id
    assert.equal((await http(r.gw.url, "POST", "/sessions", { headers: B, body: { surface: "web", resumeId: sidA } })).status, 403);
    // an unknown id is a plain 404 (so 403 is only ever "exists, not yours")
    assert.equal((await http(r.gw.url, "GET", "/sessions/does-not-exist/violations", { headers: B })).status, 404);
    // the owner (server-key) login is a different tenant too
    const owner = { ...H, cookie: cookieOf(await http(r.gw.url, "POST", "/login", { headers: H, body: { token: r.token } })) };
    assert.equal((await http(r.gw.url, "POST", `/sessions/${sidA}/send`, { headers: owner, body: { text: "x" } })).status, 403);
    // A's session is still alive and untouched
    assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/violations`, { headers: A })).status, 200);

    // websocket frames are scoped the same way
    const ws = await wsConnect(r.gw.url, "/ws", { Host: "daebot.live", Cookie: B.cookie });
    ws.sendText(JSON.stringify({ t: "send", sessionId: sidA, text: "hi" }));
    const f1 = await ws.waitFor((f) => f.opcode === 1 && /forbidden/.test(f.payload.toString()));
    assert.match(f1.payload.toString(), /"t":"error"/);
    ws.sendText(JSON.stringify({ t: "abort", sessionId: sidA }));
    ws.sendText(JSON.stringify({ t: "close", sessionId: sidA }));
    ws.sendText(JSON.stringify({ t: "open", surface: "web", resumeId: sidA }));
    await ws.waitFor((f) => f.opcode === 1 && f !== f1 && /forbidden/.test(f.payload.toString()));
    ws.close();
    assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/violations`, { headers: A })).status, 200, "A's session survived B's close frame");
  } finally { await r.close(); }
});

test("each user's session runs on THEIR MIND: their key, their boot context, source key daebot-web; never the server key", async () => {
  const r = await rig();
  try {
    const A = await asUser(r, r.keys.alice);
    const B = await asUser(r, r.keys.bob);
    for (const h of [A, B]) {
      const sid = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: h, body: { surface: "web", title: "t" } })).body).sessionId;
      await http(r.gw.url, "POST", `/sessions/${sid}/send`, { headers: h, body: { text: "hello" } });
      await http(r.gw.url, "DELETE", `/sessions/${sid}`, { headers: h });
    }
    const opens = r.fake.seen.filter((s) => s.path === "/developer/v1/agent-sessions/open");
    assert.equal(opens.length, 2);
    for (const [key, who] of [[r.keys.alice, "alice"], [r.keys.bob, "bob"]] as const) {
      const mine = r.fake.seen.filter((s) => s.key === key && s.path.startsWith("/developer/v1/") && s.path !== "/developer/v1/profile");
      assert.ok(mine.length >= 2, `${who} traffic present`);
      const open = opens.find((o) => o.key === key)!;
      assert.equal(open.body.source_key, "daebot-web", "Agent Sessions go to the user's own MIND under source daebot-web");
      assert.ok(String(open.body.external_session_id).length > 8);
    }
    assert.ok(!r.fake.seen.some((s) => s.key.startsWith("server-owner-key-")), "the server's MIND key was never used for a user");
    // the model saw THAT user's context
    const sys = r.provider.requests.map((q) => q.messages[0].content);
    assert.ok(sys.some((c) => c.includes("MIND of alice") && !c.includes("MIND of bob")));
    assert.ok(sys.some((c) => c.includes("MIND of bob") && !c.includes("MIND of alice")));
  } finally { await r.close(); }
});

test("restart: stored users persist across a restart; rotating GATEWAY_TOKEN signs old cookies out", async () => {
  const r = await rig();
  const A = await asUser(r, r.keys.alice);
  assert.equal((await http(r.gw.url, "GET", "/sessions", { headers: A })).status, 200);
  const dir = r.dir, secret = r.secret;
  await r.close();
  // restart over the same data dir and signing secret
  const r2 = await rig({ dir, secret });
  try {
    // different gateway token => old cookie invalid (rotating GATEWAY_TOKEN signs everyone out) ...
    assert.equal((await http(r2.gw.url, "GET", "/sessions", { headers: A })).status, 401);
    // ... but the stored user is still there and a fresh key sign-in reuses the same record
    assert.equal(new UserStore({ dir: join(dir, "users"), secretKey: secret }).count(), 1);
  } finally { await r2.close(); }
});

// ---------- tenancy: persisted sessions, history, boot cache ----------
test("stored sessions and history are tenant-scoped: records carry the owner, list/history/resume are per user, cross-user history is 403, even after a restart", async () => {
  const r = await rig();
  let dir = r.dir, secret = r.secret;
  const A = await asUser(r, r.keys.alice);
  const B = await asUser(r, r.keys.bob);
  const sidA = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: A, body: { surface: "web" } })).body).sessionId as string;
  await http(r.gw.url, "POST", `/sessions/${sidA}/send`, { headers: A, body: { text: "alice private note" } });
  await new Promise((res) => setTimeout(res, 150)); // persist is async
  const rec = JSON.parse(readFileSync(join(dir, "sessions", `${sidA}.json`), "utf8"));
  assert.equal(rec.owner, userIdFor("alice"), "stored record carries the owning user id");
  // live: history is mine, 403 for bob, 404 for an unknown id
  assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/history`, { headers: A })).status, 200);
  assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/history`, { headers: B })).status, 403);
  assert.equal((await http(r.gw.url, "GET", `/sessions/nope/history`, { headers: B })).status, 404);
  const owner = { ...H, cookie: cookieOf(await http(r.gw.url, "POST", "/login", { headers: H, body: { token: r.token } })) };
  assert.equal((await http(r.gw.url, "GET", `/sessions/${sidA}/history`, { headers: owner })).status, 403);
  // bob and the owner never see it listed
  for (const h of [B, owner]) assert.ok(!JSON.parse((await http(r.gw.url, "GET", "/sessions", { headers: h })).body).sessions.some((x: any) => x.id === sidA));
  await r.close();

  // restart: nothing is live, the record is on disk
  const r2 = await rig({ dir, secret });
  try {
    const A2 = await asUser(r2, r2.keys.alice);
    const B2 = await asUser(r2, r2.keys.bob);
    const listA = JSON.parse((await http(r2.gw.url, "GET", "/sessions", { headers: A2 })).body).sessions as { id: string }[];
    assert.ok(listA.some((x) => x.id === sidA), "alice still lists her saved chat");
    assert.ok(!JSON.parse((await http(r2.gw.url, "GET", "/sessions", { headers: B2 })).body).sessions.some((x: any) => x.id === sidA));
    assert.equal((await http(r2.gw.url, "GET", `/sessions/${sidA}/history`, { headers: B2 })).status, 403, "cross-user history of a persisted session");
    assert.equal((await http(r2.gw.url, "POST", "/sessions", { headers: B2, body: { surface: "web", resumeId: sidA } })).status, 403, "cross-user resume");
    const hist = await http(r2.gw.url, "GET", `/sessions/${sidA}/history`, { headers: A2 });
    assert.equal(hist.status, 200);
    assert.match(hist.body, /alice private note/);
    assert.equal((await http(r2.gw.url, "POST", "/sessions", { headers: A2, body: { surface: "web", resumeId: sidA } })).status, 200, "owner can resume");
    // bob's failed resume did not clobber alice's record
    assert.equal(JSON.parse(readFileSync(join(dir, "sessions", `${sidA}.json`), "utf8")).owner, userIdFor("alice"));
  } finally { await r2.close(); }
});

test("boot cache is per user: keyed by the user's MIND key, so alice's boot context is never served to bob", async () => {
  const r = await rig();
  try {
    const A = await asUser(r, r.keys.alice);
    const B = await asUser(r, r.keys.bob);
    for (const h of [A, B, A, B]) {
      const sid = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: h, body: { surface: "web" } })).body).sessionId;
      await http(r.gw.url, "POST", `/sessions/${sid}/send`, { headers: h, body: { text: "hi" } });
    }
    const contexts = r.fake.seen.filter((s) => s.path === "/developer/v1/context");
    assert.equal(contexts.length, 2, "one boot per user; the second open for each is served from cache");
    assert.deepEqual(contexts.map((c) => c.key).sort(), [r.keys.alice, r.keys.bob].sort());
    const sys = r.provider.requests.map((q) => q.messages[0].content);
    assert.ok(!sys.some((c) => c.includes("MIND of alice") && c.includes("MIND of bob")));
  } finally { await r.close(); }
});
