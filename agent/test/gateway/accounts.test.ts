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

async function rig() {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd(), carol: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [keys.carol]: "carol" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-accts-"));
  const provider = new FakeProvider([{ text: "hi there" }, { text: "hi there" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  return { gw, keys, token, close: async () => { await gw.close(); await fake.close(); } };
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

test("sign in once, remember: a second sign-in keeps the first account, cookies are HttpOnly + Secure, list is signed", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    const first = await signIn(g, jar, g.keys.alice);
    assert.equal(JSON.parse((await get(g, jar, "/auth/me")).body).username, "alice");
    const second = await signIn(g, jar, g.keys.bob);
    assert.equal(JSON.parse((await get(g, jar, "/auth/me")).body).username, "bob", "the newest sign-in is active");
    const accts = JSON.parse((await get(g, jar, "/auth/accounts")).body).accounts;
    assert.deepEqual(accts.map((a: any) => [a.username, a.active]), [["bob", true], ["alice", false]]);
    for (const line of [...setCookies(first), ...setCookies(second)]) assert.match(line, /HttpOnly/);
    for (const line of setCookies(second)) assert.match(line, /Secure/);
    assert.match(setCookies(second).find((l) => l.startsWith("mc_accounts="))!, /SameSite=Lax/);
    assert.match(setCookies(second).find((l) => l.startsWith("mc_session="))!, /SameSite=Strict/);
    assert.ok(!JSON.stringify(accts).includes(g.keys.alice), "no key ever leaves the server");
  } finally { await g.close(); }
});

test("switching accounts: no re-login, and account A can never see account B's sessions (nor the reverse)", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    const a = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "alice private" })).body).sessionId;
    assert.equal((await post(g, jar, `/sessions/${a}/send`, { text: "hello from alice" })).status, 200);
    await signIn(g, jar, g.keys.bob);
    const b = JSON.parse((await post(g, jar, "/sessions", { surface: "web", title: "bob private" })).body).sessionId;
    assert.equal((await post(g, jar, `/sessions/${b}/send`, { text: "hello from bob" })).status, 200);
    assert.ok(JSON.stringify(JSON.parse((await get(g, jar, "/sessions")).body)).includes(b), "bob sees his own");
    // bob is active: alice's session is invisible and untouchable
    assert.ok(!JSON.stringify(JSON.parse((await get(g, jar, "/sessions")).body)).includes(a));
    assert.equal((await get(g, jar, `/sessions/${a}/history`)).status, 403);
    assert.equal((await http(g.gw.url, "DELETE", `/sessions/${a}`, { headers: jar.headers })).status, 403);
    // switch to alice with one call
    const sw = await post(g, jar, "/auth/switch", { account: userIdFor("alice") });
    assert.equal(sw.status, 200, sw.body);
    jar.take(sw);
    assert.equal(JSON.parse((await get(g, jar, "/auth/me")).body).username, "alice");
    const aliceList = JSON.stringify(JSON.parse((await get(g, jar, "/sessions")).body));
    assert.ok(aliceList.includes(a) && !aliceList.includes(b), "alice sees hers, not bob's");
    assert.equal((await get(g, jar, `/sessions/${b}/history`)).status, 403);
    // and both stay remembered
    assert.deepEqual(JSON.parse((await get(g, jar, "/auth/accounts")).body).accounts.map((x: any) => [x.username, x.active]), [["alice", true], ["bob", false]]);
  } finally { await g.close(); }
});

test("switch is refused for an account that was never signed in on this browser, for a forged list, and without a session", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    // carol exists on the server but was never signed in here
    await signIn(g, new Jar(), g.keys.carol);
    assert.equal((await post(g, jar, "/auth/switch", { account: userIdFor("carol") })).status, 404);
    assert.equal(JSON.parse((await get(g, jar, "/auth/me")).body).username, "alice", "nothing changed");
    // a hand-made list entry (wrong signature) is ignored, as is a session signed by another secret
    const forged = jar.copy();
    const other = issueSession("x".repeat(40), 60_000, Date.now(), userIdFor("carol")).value;
    forged.c.set("mc_accounts", `${forged.c.get("mc_session")}~${other}~u_${"0".repeat(24)}:9999999999999.AAAA`);
    assert.equal((await post(g, forged, "/auth/switch", { account: userIdFor("carol") })).status, 404);
    assert.deepEqual(JSON.parse((await get(g, forged, "/auth/accounts")).body).accounts.map((x: any) => x.username), ["alice"]);
    // anonymous
    assert.equal((await post(g, new Jar(), "/auth/switch", { account: userIdFor("alice") })).status, 401);
    assert.equal((await get(g, new Jar(), "/auth/accounts")).status, 401);
  } finally { await g.close(); }
});

test("sign out signs out only the ACTIVE account and hands over to the next; sign out of all clears everything", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    await signIn(g, jar, g.keys.alice);
    await signIn(g, jar, g.keys.bob);
    const out = await post(g, jar, "/logout", {});
    assert.equal(out.status, 200);
    assert.equal(JSON.parse(out.body).remaining, 1);
    jar.take(out);
    assert.equal(JSON.parse((await get(g, jar, "/auth/me")).body).username, "alice", "alice takes over; bob is signed out");
    assert.deepEqual(JSON.parse((await get(g, jar, "/auth/accounts")).body).accounts.map((x: any) => x.username), ["alice"]);
    // sign out of the last account: signed out
    const last = await post(g, jar, "/logout", {});
    assert.equal(JSON.parse(last.body).remaining, 0);
    jar.take(last);
    assert.equal((await get(g, jar, "/auth/me")).status, 401);
    // all at once
    const j2 = new Jar();
    await signIn(g, j2, g.keys.alice); await signIn(g, j2, g.keys.bob); await signIn(g, j2, g.keys.carol);
    j2.take(await post(g, j2, "/logout", { all: true }));
    assert.equal((await get(g, j2, "/auth/me")).status, 401);
    assert.equal(j2.c.size, 0);
  } finally { await g.close(); }
});

test("the owner access code is an account too", async () => {
  const g = await rig();
  try {
    const jar = new Jar();
    jar.take(await http(g.gw.url, "POST", "/login", { headers: jar.headers, body: { token: g.token } }));
    await signIn(g, jar, g.keys.alice);
    const accts = JSON.parse((await get(g, jar, "/auth/accounts")).body).accounts;
    assert.deepEqual(accts.map((x: any) => [x.username, x.owner]), [["alice", false], ["Owner", true]]);
    const sw = await post(g, jar, "/auth/switch", { account: "owner" });
    assert.equal(sw.status, 200);
    jar.take(sw);
    assert.equal(JSON.parse((await get(g, jar, "/auth/me")).body).owner, true);
  } finally { await g.close(); }
});
