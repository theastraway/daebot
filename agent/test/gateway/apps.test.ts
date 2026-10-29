import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../../src/gateway/index.ts";
import { normalizeProviders, normalizeReferral } from "../../src/gateway/apps.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function rig() {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const ownerKey = "server-owner-key-" + rnd();
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [ownerKey]: "owner" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-apps-"));
  const provider = new FakeProvider([{ text: "hi" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: ownerKey });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "boss", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore, apps: { returnTo: "https://daebot.live/" } });
  const cookie = async (key: string) => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    assert.equal(r.status, 200, r.body);
    return { ...H, cookie: String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0] };
  };
  const ownerCookie = async () => {
    const r = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
    return { ...H, cookie: String(([] as string[]).concat(r.headers["set-cookie"] as string[])[0]).split(";")[0] };
  };
  return { gw, fake, keys, ownerKey, cookie, ownerCookie, close: async () => { await gw.close(); await fake.close(); } };
}

test("apps need a session", async () => {
  const r = await rig();
  try {
    assert.equal((await http(r.gw.url, "GET", "/apps/integrations", { headers: H })).status, 401);
    assert.equal((await http(r.gw.url, "POST", "/apps/integrations/google/connect", { headers: H, body: {} })).status, 401);
  } finally { await r.close(); }
});

test("list: the user's OWN statuses from MIND, trimmed to the card's fields, key never echoed", async () => {
  const r = await rig();
  try {
    r.fake.integrations.set("alice", new Map([["google", "alice@example.com"]]));
    const alice = await r.cookie(r.keys.alice);
    const bob = await r.cookie(r.keys.bob);
    const a = await http(r.gw.url, "GET", "/apps/integrations", { headers: alice });
    assert.equal(a.status, 200);
    const aj = JSON.parse(a.body);
    assert.equal(aj.signedIn, true);
    assert.deepEqual(aj.providers.map((p: any) => [p.provider, p.connected]), [["google", true], ["microsoft", false], ["apple", false], ["dropbox", false], ["github", false]]);
    assert.equal(aj.providers[0].account, "alice@example.com");
    assert.equal(aj.providers[2].auth, "credentials");
    assert.equal(aj.providers[4].configured, false);
    assert.doesNotMatch(a.body, /must-not-leak|mind_/);
    const b = JSON.parse((await http(r.gw.url, "GET", "/apps/integrations", { headers: bob })).body);
    assert.ok(b.providers.every((p: any) => !p.connected), "bob does not see alice's connections");
    const calls = r.fake.seen.filter((s) => s.path === "/developer/v1/integrations");
    assert.deepEqual(calls.map((c) => c.key), [r.keys.alice, r.keys.bob]);
  } finally { await r.close(); }
});

test("connect returns MIND's https OAuth URL and asks MIND to bounce back to daebot.live; credentials providers return a setup link", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    const c = await http(r.gw.url, "POST", "/apps/integrations/google/connect", { headers: alice, body: {} });
    assert.equal(c.status, 200, c.body);
    const cj = JSON.parse(c.body);
    assert.equal(cj.authType, "oauth");
    assert.match(cj.authUrl, /^https:\/\/accounts\.example\.test\/google\?state=alice\./);
    const seen = r.fake.seen.filter((s) => s.path === "/developer/v1/integrations/google/connect")[0];
    assert.equal(seen.key, r.keys.alice);
    assert.deepEqual(seen.body, { return_to: "https://daebot.live/" });
    const ap = JSON.parse((await http(r.gw.url, "POST", "/apps/integrations/apple/connect", { headers: alice, body: {} })).body);
    assert.equal(ap.authType, "credentials");
    assert.match(ap.setupUrl, /^https:\/\/www\.m-i-n-d\.ai\//);
  } finally { await r.close(); }
});

test("disconnect acts on the signed-in user's own connection only", async () => {
  const r = await rig();
  try {
    r.fake.integrations.set("alice", new Map([["google", "a@x.com"]]));
    r.fake.integrations.set("bob", new Map([["google", "b@x.com"]]));
    const alice = await r.cookie(r.keys.alice);
    const d = await http(r.gw.url, "POST", "/apps/integrations/google/disconnect", { headers: alice, body: {} });
    assert.equal(d.status, 200);
    assert.equal(r.fake.integrations.get("alice")!.has("google"), false);
    assert.equal(r.fake.integrations.get("bob")!.has("google"), true);
  } finally { await r.close(); }
});

test("owner access-code login: a plain sign-in-with-MIND answer, MIND is never called with the server key", async () => {
  const r = await rig();
  try {
    const owner = await r.ownerCookie();
    const l = JSON.parse((await http(r.gw.url, "GET", "/apps/integrations", { headers: owner })).body);
    assert.equal(l.signedIn, false);
    assert.match(l.message, /Sign in with MIND/);
    assert.deepEqual(l.providers, []);
    const c = await http(r.gw.url, "POST", "/apps/integrations/google/connect", { headers: owner, body: {} });
    assert.equal(c.status, 403);
    assert.equal(JSON.parse(c.body).error, "sign_in_with_mind");
    assert.equal(r.fake.seen.filter((s) => s.path.includes("/integrations")).length, 0);
  } finally { await r.close(); }
});

test("MIND failures are mapped, bad provider names refused, raw bodies never leak", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    assert.equal((await http(r.gw.url, "POST", "/apps/integrations/..%2Fadmin/connect", { headers: alice, body: {} })).status, 400);
    assert.equal((await http(r.gw.url, "POST", "/apps/integrations/Google!/connect", { headers: alice, body: {} })).status, 400);
    r.fake.integrationsStatus = 404;
    assert.equal((await http(r.gw.url, "GET", "/apps/integrations", { headers: alice })).status, 503);
    r.fake.integrationsStatus = 500;
    const e = await http(r.gw.url, "GET", "/apps/integrations", { headers: alice });
    assert.equal(e.status, 502);
    assert.doesNotMatch(e.body, /detail/);
    r.fake.integrationsStatus = undefined;
    r.fake.keys.delete(r.keys.alice);
    assert.equal((await http(r.gw.url, "GET", "/apps/integrations", { headers: alice })).status, 401);
  } finally { await r.close(); }
});

test("normalizeProviders: drops malformed rows, flags reconnects", () => {
  const n = normalizeProviders({ integrations_enabled: false, providers: [null, { provider: "../x" }, { provider: "google", display_name: "Google", connected: true, status: "reauth_required", account_label: "a@b.c" }, { provider: "dropbox", connected: false }] });
  assert.equal(n.enabled, false);
  assert.deepEqual(n.providers.map((p) => [p.provider, p.name, p.connected, p.needsReconnect]), [["google", "Google", true, true], ["dropbox", "dropbox", false, false]]);
});

import { readFileSync } from "node:fs";
const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "..", "web", f), "utf8");

test("web wiring: Apps button at the bottom of the sidebar, the card, brand marks from MIND's files, no innerHTML, only /apps requests", () => {
  const html = web("index.html");
  for (const id of ["btn-apps", "apps-modal", "apps-close", "apps-sections", "apps-live", "i-apps"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.ok(html.indexOf('id="btn-apps"') > html.indexOf('id="acct-btn"') && html.indexOf('id="btn-apps"') < html.indexOf("</aside>"), "the Apps icon sits in the sidebar's bottom bar, next to the account avatar");
  assert.match(web("app.js"), /from "\/apps\.js"/);
  for (const f of ["apps.js", "apps-icons.js"]) assert.doesNotMatch(web(f).replace(/^\s*\/\/.*$/gm, ""), /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/, f);
  assert.doesNotMatch(web("apps.js"), /fetch\(/, "apps.js goes through the app's own api helper");
  assert.match(web("apps.js"), /\/apps\/integrations/);
  const icons = web("apps-icons.js");
  assert.doesNotMatch(web("apps.js").replace(/^\s*\/\/.*$/gm, ""), /Unavailable|unavailable/, "no greyed Unavailable rows: an app that cannot connect is not listed");
  assert.doesNotMatch(icons, /https?:\/\/[^\s"']+\.(png|svg|ico)/i, "logos are same-origin files, never fetched from a vendor or CDN at runtime");
});

test("logos: every mapped file ships, every shipped file is mapped, each has a recorded vendor source; the live apps all have one", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const dir = join(import.meta.dirname, "..", "..", "web", "logos");
  // @ts-ignore the browser module is plain JS with no declaration file
  const { LOGO_EXT, logoSrc } = await import("../../web/apps-icons.js") as any;
  const src = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")).logos;
  for (const [k, ext] of Object.entries(LOGO_EXT)) {
    assert.ok(existsSync(join(dir, `${k}.${ext}`)), `${k}.${ext} is missing`);
    assert.match(src[k]?.source ?? "", /^https:\/\//, `${k}: source recorded`);
    assert.equal(logoSrc(k), `/logos/${k}.${ext}`);
  }
  const files = readdirSync(dir).filter((f) => f !== "sources.json").sort();
  assert.deepEqual(files, Object.entries(LOGO_EXT).map(([k, e]) => `${k}.${e}`).sort());
  assert.equal(logoSrc("../x"), null);
  assert.equal(logoSrc("constructor"), null);
  // the 49 MCP connectors and 5 integrations MIND lists on 2026-10-23
  const live = "notion linear stripe sentry asana hubspot slack cloudflare atlassian render vercel github intercom square figma datadog pagerduty webflow supabase neon clickup box monday salesforce calendly gong fireflies otter airtable todoist evernote zoom aws digitalocean gitlab posthog zapier make paypal meta-ads miro dropbox wix klaviyo huggingface netlify heroku mongodb trello google microsoft apple".split(" ");
  for (const k of live) assert.ok(logoSrc(k), `${k} has an official logo file`);
});


test("desktop (no hosted auth): the Apps card uses the key the app signed in with", async () => {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "desk" });
  fake.integrations.set("desk", new Map([["google", "desk@example.com"]]));
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const runtime = createRuntime(cfg, { provider: new FakeProvider([]) });
  const st = tmpStatic();
  const gw = await startGateway({ runtime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir });
  try {
    const r = await http(gw.url, "GET", "/apps/integrations", { headers: { authorization: "Bearer " + gw.token } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.signedIn, true);
    assert.equal(j.providers.find((p: any) => p.provider === "google").connected, true);
    assert.doesNotMatch(r.body, /mind_/);
  } finally { await gw.close(); await fake.close(); }
});

test("referral: each user gets their OWN MIND link and the real terms, with their own key; owner login and a MIND failure get no link", async () => {
  const r = await rig();
  try {
    assert.equal((await http(r.gw.url, "GET", "/apps/referral", { headers: H })).status, 401);
    const alice = await r.cookie(r.keys.alice);
    const bob = await r.cookie(r.keys.bob);
    const a = JSON.parse((await http(r.gw.url, "GET", "/apps/referral", { headers: alice })).body);
    const b = JSON.parse((await http(r.gw.url, "GET", "/apps/referral", { headers: bob })).body);
    assert.deepEqual(a, { signedIn: true, url: "https://m-i-n-d.ai/register?ref=REFALICE", code: "REFALICE", referrerCredits: 100, refereeCredits: 50 });
    assert.equal(b.url, "https://m-i-n-d.ai/register?ref=REFBOB");
    assert.deepEqual(r.fake.seen.filter((s) => s.path === "/developer/v1/referral").map((c) => c.key), [r.keys.alice, r.keys.bob]);
    assert.equal((await http(r.gw.url, "POST", "/apps/referral", { headers: alice, body: {} })).status, 405);
    assert.deepEqual(JSON.parse((await http(r.gw.url, "GET", "/apps/referral", { headers: await r.ownerCookie() })).body), { signedIn: false });
    r.fake.referralStatus = 404;
    assert.equal((await http(r.gw.url, "GET", "/apps/referral", { headers: alice })).status, 503);
    r.fake.referralStatus = 500;
    assert.equal((await http(r.gw.url, "GET", "/apps/referral", { headers: alice })).status, 502);
  } finally { await r.close(); }
});

test("normalizeReferral accepts only an https MIND link with both credit amounts", () => {
  const ok = { code: "ABCD2345", url: "https://m-i-n-d.ai/register?ref=ABCD2345", referrer_credits: 100, referee_credits: 50 };
  assert.deepEqual(normalizeReferral(ok), { url: ok.url, code: "ABCD2345", referrerCredits: 100, refereeCredits: 50 });
  assert.equal(normalizeReferral({ ...ok, url: "http://m-i-n-d.ai/register?ref=A" }), null);
  assert.equal(normalizeReferral({ ...ok, url: "https://evil.example/register?ref=A" }), null);
  assert.equal(normalizeReferral({ ...ok, referee_credits: 0 }), null);
  assert.equal(normalizeReferral({ ...ok, referrer_credits: "100" }), null);
  assert.equal(normalizeReferral(null), null);
});
