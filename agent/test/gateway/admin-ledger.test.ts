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
import { http, tmpStatic } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const KEY = "log-key-" + rnd();

async function rig() {
  const keys = { alice: "mind_" + rnd(), boss: "mind_" + rnd() };
  const ownerKey = "server-owner-key-" + rnd();
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.boss]: "boss", [ownerKey]: "owner" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-admin-"));
  const provider = new FakeProvider([{ text: "hi" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: ownerKey });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "boss", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore, adminLog: { dir, logKey: () => KEY } });
  const cookie = async (key: string) => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    assert.equal(r.status, 200, r.body);
    return { ...H, cookie: String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0] };
  };
  return { gw, keys, cookie, close: async () => { await gw.close(); await fake.close(); } };
}
const W = { ...H, "x-daebot-log-key": KEY };

test("mistake log: key-only writes, type created then counted, admin-only pages", async () => {
  const r = await rig();
  try {
    // no key, no session
    assert.equal((await http(r.gw.url, "POST", "/api/admin/mistakes", { headers: H, body: { type: "X", what: "y" } })).status, 401);
    assert.equal((await http(r.gw.url, "POST", "/api/admin/mistakes", { headers: { ...H, "x-daebot-log-key": "wrong" }, body: { type: "X", what: "y" } })).status, 401);
    const a = await http(r.gw.url, "POST", "/api/admin/mistakes", { headers: W, body: { type: "Fixes built dark", what: "fix left dark", quote: "why", product: "Atlas", agent: "Dae", when: "2026-10-16T12:00:00Z", source_key: "t1" } });
    assert.equal(a.status, 200, a.body);
    const aj = JSON.parse(a.body);
    assert.equal(aj.created_type, true); assert.equal(aj.count, 1);
    const b = JSON.parse((await http(r.gw.url, "POST", "/api/admin/mistakes", { headers: W, body: { type: "fixes built dark", what: "again" } })).body);
    assert.equal(b.created_type, false); assert.equal(b.count, 2);
    // idempotent seed key
    assert.equal(JSON.parse((await http(r.gw.url, "POST", "/api/admin/mistakes", { headers: W, body: { type: "Fixes built dark", what: "fix left dark", source_key: "t1" } })).body).duplicate, true);
    const boss = await r.cookie(r.keys.boss), alice = await r.cookie(r.keys.alice);
    const view = JSON.parse((await http(r.gw.url, "GET", "/api/admin/mistakes", { headers: boss })).body);
    assert.equal(view.summary.total, 2); assert.equal(view.types[0].count, 2); assert.equal(view.summary.top_repeat.name, "Fixes built dark");
    assert.equal(JSON.parse((await http(r.gw.url, "GET", "/api/admin/mistakes?product=atlas", { headers: boss })).body).occurrences.length, 1);
    assert.equal((await http(r.gw.url, "GET", "/api/admin/mistakes", { headers: alice })).status, 401);
    assert.equal((await http(r.gw.url, "GET", "/api/admin/mistakes", { headers: W })).status, 200);
    // pages
    const page = await http(r.gw.url, "GET", "/admin/mistakes", { headers: boss });
    assert.equal(page.status, 200); assert.match(page.body, /data-page="mistakes"/);
    assert.equal((await http(r.gw.url, "GET", "/admin/kpis", { headers: boss })).status, 200);
    assert.equal((await http(r.gw.url, "GET", "/admin/assets/admin.js", { headers: boss })).status, 200);
    assert.equal((await http(r.gw.url, "GET", "/admin/mistakes", { headers: alice })).status, 403);
    assert.equal((await http(r.gw.url, "GET", "/admin/mistakes", { headers: H })).status, 302);
    // a browser session can not write
    assert.equal((await http(r.gw.url, "POST", "/api/admin/mistakes", { headers: boss, body: { type: "X", what: "y" } })).status, 401);
    // delete
    assert.equal((await http(r.gw.url, "DELETE", `/api/admin/mistakes/occurrence/${aj.occurrence_id}`, { headers: W })).status, 200);
    assert.equal(JSON.parse((await http(r.gw.url, "GET", "/api/admin/mistakes", { headers: boss })).body).summary.total, 1);
  } finally { await r.close(); }
});

test("task KPIs: success rate, medians, stale open tasks, update by id", async () => {
  const r = await rig();
  try {
    const boss = await r.cookie(r.keys.boss);
    const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
    const post = async (body: unknown) => JSON.parse((await http(r.gw.url, "POST", "/api/admin/tasks", { headers: W, body })).body);
    const t1 = await post({ title: "Fix intake sheet", product: "Atlas", requested_at: iso(now - 3600e3), status: "done-verified", completed_at: iso(now - 600e3), verified_on: "https://x/page", prompts_to_satisfaction: 1 });
    await post({ title: "Loss size required", product: "Sarah", requested_at: iso(now - 7200e3), status: "done-verified", completed_at: iso(now - 300e3), prompts_to_satisfaction: 4, repeats: 2, anger_flag: true });
    await post({ title: "Old open one", product: "MIND", requested_at: iso(now - 30 * 3600e3) });
    await post({ title: "Gave up", product: "MIND", status: "abandoned", requested_at: iso(now - 5 * 86400e3) });
    const k = JSON.parse((await http(r.gw.url, "GET", "/api/admin/tasks", { headers: boss })).body);
    assert.equal(k.kpis.verified_all, 2); assert.equal(k.kpis.closed, 3);
    assert.ok(Math.abs(k.kpis.success_rate - 2 / 3) < 1e-9);
    assert.equal(k.kpis.median_prompts, 2.5); assert.equal(k.kpis.one_prompt, 1); assert.equal(k.kpis.three_plus, 1);
    assert.equal(k.kpis.open_over_24h, 1); assert.equal(k.kpis.angry, 1);
    assert.equal(k.top_reasked[0].title, "Loss size required");
    assert.equal(k.trend.length, 12);
    // update by id
    const u = await post({ id: t1.id, prompts_delta: 1 });
    assert.equal(u.created, false);
    assert.equal((await post({ title: "x", status: "bogus" })).error?.includes("status"), true);
  } finally { await r.close(); }
});
