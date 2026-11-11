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
import { capsFromMind, toMindBody, SpendCapsError } from "../../src/gateway/spendcaps.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const H = { host: "daebot.live", "x-forwarded-proto": "https" };

async function rig() {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "alice" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "daebot-caps-"));
  const provider = new FakeProvider([]);
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
  const cookie = String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
  return { gw, fake, cookie, close: async () => { await gw.close(); await fake.close(); } };
}

test("/spend-caps: needs a session; GET/PUT go to MIND with the user's own key; the account cap and a bot cap round-trip", async () => {
  const r = await rig();
  try {
    assert.equal((await http(r.gw.url, "GET", "/spend-caps", { headers: H })).status, 401);
    const h = { ...H, cookie: r.cookie };
    const none = JSON.parse((await http(r.gw.url, "GET", "/spend-caps", { headers: h })).body);
    assert.equal(none.source, "mind"); assert.equal(none.caps.account.cap, null); assert.equal(none.caps.account.spentUsd, 0.02);
    const put = await http(r.gw.url, "PUT", "/spend-caps", { headers: h, body: { account: { usd: 0.01, period: "daily", alertPct: 80 }, bots: { "bot-one": { usd: 5, period: "weekly", alertPct: null } } } });
    assert.equal(put.status, 200, put.body);
    const j = JSON.parse(put.body).caps;
    assert.deepEqual(j.account.cap, { usd: 0.01, period: "daily", alertPct: 80 });
    assert.equal(j.account.reached, true);
    assert.deepEqual(j.bots["bot-one"].cap, { usd: 5, period: "weekly", alertPct: null });
    const one = JSON.parse((await http(r.gw.url, "GET", "/spend-caps?bot=bot-two", { headers: h })).body);
    assert.equal(one.caps.bots["bot-two"].cap, null);
    const clr = JSON.parse((await http(r.gw.url, "PUT", "/spend-caps", { headers: h, body: { account: null, bots: { "bot-one": null } } })).body).caps;
    assert.equal(clr.account.cap, null); assert.deepEqual(Object.keys(clr.bots), []);
    assert.equal((await http(r.gw.url, "PUT", "/spend-caps", { headers: h, body: { account: { usd: -1, period: "daily" } } })).status, 400);
    assert.equal((await http(r.gw.url, "GET", "/spend-caps?bot=../x", { headers: h })).status, 400);
    assert.equal((await http(r.gw.url, "POST", "/spend-caps", { headers: h, body: {} })).status, 405);
  } finally { await r.close(); }
});

test("toMindBody validates what the browser sends; capsFromMind tolerates a partial body", () => {
  assert.deepEqual(toMindBody({ account: { usd: 5, period: "weekly", alertPct: 80 } }), { account: { usd: 5, period: "weekly", alert_pct: 80 } });
  assert.deepEqual(toMindBody({ bots: { a1: null } }), { bots: { a1: null } });
  for (const bad of [{}, { account: { usd: 0, period: "daily" } }, { account: { usd: 1, period: "hourly" } }, { account: { usd: 1, period: "daily", alertPct: 101 } }, { bots: { "a b": null } }, { bots: [] }])
    assert.throws(() => toMindBody(bad), SpendCapsError);
  const c = capsFromMind({});
  assert.equal(c.account.cap, null); assert.equal(c.reached, false); assert.deepEqual(c.bots, {});
});
