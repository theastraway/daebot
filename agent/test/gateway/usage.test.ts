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
import { usageFromMind } from "../../src/gateway/usage.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function hostedRig() {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  fake.usage.set("alice", { plan: "pro", percentUsed: 38, available: true, enabled: false, rateNote: "Billed at the provider's cost plus 12%, on your regular invoice." });
  fake.usage.set("bob", { plan: "pro", percentUsed: 90, available: true, enabled: false });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-usage-"));
  const provider = new FakeProvider([]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  const cookie = async (key: string) => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    assert.equal(r.status, 200, r.body);
    return String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
  };
  return { gw, fake, keys, token, cookie, close: async () => { await gw.close(); await fake.close(); } };
}

test("hosted /usage: needs a session; a user sees only their own plan, read with their own key", async () => {
  const r = await hostedRig();
  try {
    assert.equal((await http(r.gw.url, "GET", "/usage", { headers: H })).status, 401);
    assert.equal((await http(r.gw.url, "PUT", "/usage/additional", { headers: H, body: { enabled: true } })).status, 401);
    const a = JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: { ...H, cookie: await r.cookie(r.keys.alice) } })).body);
    assert.equal(a.source, "mind"); assert.equal(a.planName, "Pro"); assert.equal(a.percentLeft, 62); assert.equal(a.state, "normal");
    assert.equal(a.resetAt, "2026-11-01T00:00:00.000Z");
    assert.equal(a.additional.available, true); assert.equal(a.additional.enabled, false);
    assert.equal(a.manageUrl, r.fake.url);
    assert.doesNotMatch(JSON.stringify(a), /credits|mind_/i, "usage language only; no credit counts, no keys");
    const b = JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: { ...H, cookie: await r.cookie(r.keys.bob) } })).body);
    assert.equal(b.percentLeft, 10); assert.equal(b.state, "low");
    const seen = r.fake.seen.filter((s) => s.path === "/developer/v1/usage");
    assert.deepEqual(seen.map((s) => s.key), [r.keys.alice, r.keys.bob], "each call carried that user's key, never the server's");
  } finally { await r.close(); }
});

test("hosted /usage/additional: toggle round trip through MIND, isolated per user, survives a re-read", async () => {
  const r = await hostedRig();
  try {
    const ca = await r.cookie(r.keys.alice), cb = await r.cookie(r.keys.bob);
    const put = (cookie: string, enabled: unknown) => http(r.gw.url, "PUT", "/usage/additional", { headers: { ...H, cookie }, body: { enabled } });
    assert.equal((await put(ca, "yes")).status, 400);
    const on = JSON.parse((await put(ca, true)).body);
    assert.equal(on.additional.enabled, true); assert.equal(on.additional.active, true);
    assert.equal(r.fake.usage.get("alice")!.enabled, true, "MIND holds the new state");
    assert.equal(r.fake.usage.get("bob")!.enabled, false, "the other user is untouched");
    const again = JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: { ...H, cookie: ca } })).body);
    assert.equal(again.additional.enabled, true, "a reload still shows it on");
    const bobView = JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: { ...H, cookie: cb } })).body);
    assert.equal(bobView.additional.enabled, false);
    const off = JSON.parse((await put(ca, false)).body);
    assert.equal(off.additional.enabled, false); assert.equal(r.fake.usage.get("alice")!.enabled, false);
    assert.equal((await http(r.gw.url, "POST", "/usage/additional", { headers: { ...H, cookie: ca }, body: { enabled: true } })).status, 405);
    assert.equal((await http(r.gw.url, "POST", "/usage", { headers: { ...H, cookie: ca }, body: {} })).status, 405);
  } finally { await r.close(); }
});

test("hosted: a free plan cannot switch on (plain sentence), MIND down is reported as unavailable, the owner login has no plan", async () => {
  const r = await hostedRig();
  try {
    r.fake.usage.set("alice", { plan: "free", percentUsed: 2, available: false, enabled: false });
    const ca = await r.cookie(r.keys.alice);
    const v = JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: { ...H, cookie: ca } })).body);
    assert.equal(v.planName, "Explorer"); assert.equal(v.additional.available, false);
    const refused = await http(r.gw.url, "PUT", "/usage/additional", { headers: { ...H, cookie: ca }, body: { enabled: true } });
    assert.equal(refused.status, 409); assert.match(JSON.parse(refused.body).error, /paid plan/);
    r.fake.usage.set("alice", { plan: "pro", percentUsed: 10, available: true, enabled: false, putStatus: 503 });
    assert.equal((await http(r.gw.url, "PUT", "/usage/additional", { headers: { ...H, cookie: ca }, body: { enabled: true } })).status, 502);
    r.fake.keys.delete(r.keys.alice); // MIND stops accepting the key
    assert.deepEqual(JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: { ...H, cookie: ca } })).body), { source: "mind", error: "unavailable" });
    const ow = await http(r.gw.url, "POST", "/login", { headers: H, body: { token: r.token } });
    const ownerCookie = String(([] as string[]).concat(ow.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
    assert.deepEqual(JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: { ...H, cookie: ownerCookie } })).body), { source: "owner" });
    assert.equal((await http(r.gw.url, "PUT", "/usage/additional", { headers: { ...H, cookie: ownerCookie }, body: { enabled: true } })).status, 200, "owner path answers without touching a customer account");
  } finally { await r.close(); }
});

async function desktopRig(opts: { billing: "mind" | "openrouter"; withKey: boolean }) {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "dana" });
  fake.usage.set("dana", { plan: "plus", percentUsed: 50, available: true, enabled: false });
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: opts.withKey ? key : undefined, billing: opts.billing });
  const runtime = createRuntime(cfg, { provider: new FakeProvider([]) });
  const gw = await startGateway({ runtime, cfg, port: 0, host: "127.0.0.1", staticDir: tmpStatic().dir });
  const h = { authorization: "Bearer " + gw.token };
  return { gw, fake, key, h, close: async () => { await gw.close(); await fake.close(); } };
}

test("desktop signed in with MIND: token required, usage and the switch use the app's MIND key", async () => {
  const r = await desktopRig({ billing: "mind", withKey: true });
  try {
    assert.equal((await http(r.gw.url, "GET", "/usage")).status, 401);
    const v = JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: r.h })).body);
    assert.equal(v.planName, "Plus"); assert.equal(v.percentLeft, 50);
    const on = JSON.parse((await http(r.gw.url, "PUT", "/usage/additional", { headers: r.h, body: { enabled: true } })).body);
    assert.equal(on.additional.enabled, true);
    assert.ok(r.fake.seen.filter((s) => s.path.startsWith("/developer/v1/usage")).every((s) => s.key === r.key));
  } finally { await r.close(); }
});

test("desktop with no MIND sign-in (own API key): a calm state, nothing sent to MIND", async () => {
  for (const o of [{ billing: "openrouter" as const, withKey: false }, { billing: "openrouter" as const, withKey: true }, { billing: "mind" as const, withKey: false }]) {
    const r = await desktopRig(o);
    try {
      assert.deepEqual(JSON.parse((await http(r.gw.url, "GET", "/usage", { headers: r.h })).body), { source: "own-key" });
      assert.deepEqual(JSON.parse((await http(r.gw.url, "PUT", "/usage/additional", { headers: r.h, body: { enabled: true } })).body), { source: "own-key" });
      assert.equal(r.fake.seen.filter((s) => s.path.startsWith("/developer/v1/usage")).length, 0);
    } finally { await r.close(); }
  }
});

test("usageFromMind: normal, near limit, exhausted, unlimited, overage on, no allowance; a partial body still renders", () => {
  const base = { plan: "pro", reset_at: "2026-11-01T00:00:00+00:00", additional_usage: { available: true, enabled: false, active: false, automatic: false } };
  assert.equal(usageFromMind({ ...base, percent_used: 38 }).state, "normal");
  assert.equal(usageFromMind({ ...base, percent_used: 85 }).state, "low");
  assert.equal(usageFromMind({ ...base, percent_used: 80 }).state, "low");
  const out = usageFromMind({ ...base, percent_used: 140 });
  assert.equal(out.state, "empty"); assert.equal(out.percentLeft, 0, "clamped, never negative");
  const on = usageFromMind({ ...base, percent_used: 120, additional_usage: { available: true, enabled: true, active: true, rate_note: "cost plus 12%" } });
  assert.equal(on.state, "empty"); assert.equal(on.additional.active, true); assert.equal(on.additional.rateNote, "cost plus 12%");
  const un = usageFromMind({ plan: "max", unlimited: true });
  assert.equal(un.state, "unlimited"); assert.equal(un.percentLeft, null);
  const none = usageFromMind({ plan: "payg" });
  assert.equal(none.percentLeft, null); assert.equal(none.state, "normal"); assert.equal(none.additional.rateNote, null, "no price unless MIND sent one");
  assert.equal(usageFromMind({}).planName, "Explorer");
  assert.equal(usageFromMind({ plan: "pro", percent_used: 10, reset_at: "garbage" }).resetAt, null);
});
