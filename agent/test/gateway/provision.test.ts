import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { EntryCodes, RuntimeAllowList, bearerOf, provisionTokenOk } from "../../src/auth/provision.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex"); // throwaway test values
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function rig(o: { env?: Record<string, string>; dir?: string; secret?: string } = {}) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const ptoken = rnd() + rnd();
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "daebot-prov-"));
  const secret = o.secret ?? rnd() + rnd();
  const provider = new FakeProvider([{ text: "hi" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = {
    DATA_DIR: dir, DAEBOT_SECRET_KEY: secret, DAEBOT_ADMINS: "boss", DAEBOT_PUBLIC_URL: "https://daebot.live",
    MIND_OAUTH_BASE_URL: fake.url, DAEBOT_ALLOWED_USERS: "zed", DAEBOT_PROVISION_TOKEN: ptoken, ...(o.env ?? {}),
  };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  const prov = (mindKey: unknown, headers: Record<string, string> = { authorization: `Bearer ${ptoken}` }) =>
    http(gw.url, "POST", "/auth/provision", { headers: { ...H, ...headers }, body: { mindKey } });
  return { gw, fake, keys, dir, secret, ptoken, prov, close: async () => { await gw.close(); await fake.close(); } };
}

const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) =>
  String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

test("provisionTokenOk / bearerOf: constant-time compare, weak or missing token never matches", () => {
  const t = rnd() + rnd();
  assert.equal(provisionTokenOk(t, t), true);
  assert.equal(provisionTokenOk(t + "x", t), false);
  assert.equal(provisionTokenOk("", t), false);
  assert.equal(provisionTokenOk(undefined, t), false);
  assert.equal(provisionTokenOk("short", "short"), false, "a configured token under 24 chars is refused outright");
  assert.equal(provisionTokenOk(t, undefined), false);
  assert.equal(bearerOf(`Bearer ${t}`), t);
  assert.equal(bearerOf(`bearer ${t}`), t);
  assert.equal(bearerOf("Basic abc"), "");
  assert.equal(bearerOf(undefined), "");
});

test("EntryCodes: single use, expiry, malformed refused", () => {
  let now = 1_000;
  const c = new EntryCodes(() => now);
  const a = c.mint("u_a");
  assert.equal(c.redeem(a), "u_a");
  assert.equal(c.redeem(a), undefined, "second redeem fails");
  const b = c.mint("u_b");
  now += 5 * 60 * 1000 + 1;
  assert.equal(c.redeem(b), undefined, "expired");
  assert.equal(c.redeem("nope"), undefined);
  assert.equal(c.redeem(123), undefined);
});

test("RuntimeAllowList: persists, lowercases, survives a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "daebot-allow-"));
  const a = new RuntimeAllowList(dir);
  a.add("  Alice ");
  a.add("alice");
  assert.deepEqual(a.list(), ["alice"]);
  assert.ok(existsSync(join(dir, "daebot-allowed.json")));
  const b = new RuntimeAllowList(dir);
  assert.equal(b.has("ALICE"), true);
  assert.equal(b.has("bob"), false);
  writeFileSync(join(dir, "daebot-allowed.json"), "{not json");
  assert.deepEqual(new RuntimeAllowList(dir).list(), [], "a corrupt file reads as empty, never throws");
});

test("POST /auth/provision: wrong or missing token is 401, no state written", async () => {
  const r = await rig();
  try {
    assert.equal((await r.prov(r.keys.alice, {})).status, 401);
    assert.equal((await r.prov(r.keys.alice, { authorization: "Bearer " + rnd() + rnd() })).status, 401);
    assert.equal((await http(r.gw.url, "POST", "/auth/key", { headers: H, body: { key: r.keys.alice } })).status, 403, "alice is not on the env allow-list and was not provisioned");
  } finally { await r.close(); }
});

test("POST /auth/provision: off (404) when DAEBOT_PROVISION_TOKEN is unset; browser Origin and http refused", async () => {
  const off = await rig({ env: { DAEBOT_PROVISION_TOKEN: "" } });
  try { assert.equal((await off.prov(off.keys.alice, { authorization: "Bearer anything-anything-anything" })).status, 404); } finally { await off.close(); }
  const r = await rig();
  try {
    assert.equal((await r.prov(r.keys.alice, { authorization: `Bearer ${r.ptoken}`, origin: "https://evil.example" })).status, 403);
    const plain = await http(r.gw.url, "POST", "/auth/provision", { headers: { host: "daebot.live", "x-forwarded-proto": "http", authorization: `Bearer ${r.ptoken}` }, body: { mindKey: r.keys.alice } });
    assert.equal(plain.status, 400);
    assert.equal((await http(r.gw.url, "GET", "/auth/provision", { headers: { ...H, authorization: `Bearer ${r.ptoken}` } })).status, 405);
  } finally { await r.close(); }
});

test("POST /auth/provision: bad MIND key is refused and nothing is allow-listed", async () => {
  const r = await rig();
  try {
    const bad = await r.prov("mind_" + rnd());
    assert.equal(bad.status, 401);
    assert.equal((await r.prov("not-a-key")).status, 422);
    assert.equal(existsSync(join(r.dir, "users", "daebot-allowed.json")), false);
  } finally { await r.close(); }
});

test("provision -> one-time link signs the client in as staff, once; allow-list persists past an env list that excludes them", async () => {
  const r = await rig();
  try {
    const p = await r.prov(r.keys.alice);
    assert.equal(p.status, 200, p.body);
    const j = JSON.parse(p.body);
    assert.equal(j.username, "alice");
    assert.equal(j.tier, "staff");
    assert.ok(j.url.startsWith("https://daebot.live/auth/provision/enter?c="));
    assert.ok(!p.body.includes(r.keys.alice), "the MIND key is never echoed");
    const code = new URL(j.url).searchParams.get("c")!;
    const enter = await http(r.gw.url, "GET", `/auth/provision/enter?c=${code}`, { headers: H });
    assert.equal(enter.status, 200);
    const cookie = cookieOf(enter);
    const me = await http(r.gw.url, "GET", "/auth/me", { headers: { ...H, cookie } });
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(me.body).username, "alice");
    assert.equal(JSON.parse(me.body).tier, "staff");
    // single use
    const again = await http(r.gw.url, "GET", `/auth/provision/enter?c=${code}`, { headers: H });
    assert.equal(again.status, 302);
    assert.ok(String(again.headers.location).includes("e=expired"));
    // alice may now also use the normal key sign-in, bob (not provisioned, not on env list) may not
    assert.equal((await http(r.gw.url, "POST", "/auth/key", { headers: H, body: { key: r.keys.alice } })).status, 200);
    assert.equal((await http(r.gw.url, "POST", "/auth/key", { headers: H, body: { key: r.keys.bob } })).status, 403);
    // persisted
    assert.deepEqual(JSON.parse(readFileSync(join(r.dir, "users", "daebot-allowed.json"), "utf8")).users, ["alice"]);
  } finally { await r.close(); }
});

test("provision is idempotent and mints a fresh link each call; garbage code refused", async () => {
  const r = await rig();
  try {
    const a = JSON.parse((await r.prov(r.keys.alice)).body);
    const b = JSON.parse((await r.prov(r.keys.alice)).body);
    assert.equal(a.userId, b.userId);
    assert.notEqual(a.url, b.url);
    const bad = await http(r.gw.url, "GET", "/auth/provision/enter?c=" + "A".repeat(43), { headers: H });
    assert.equal(bad.status, 302);
    assert.equal((await http(r.gw.url, "GET", "/auth/provision/enter", { headers: H })).status, 302);
  } finally { await r.close(); }
});
