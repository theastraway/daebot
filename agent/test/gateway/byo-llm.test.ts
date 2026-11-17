// BYO LLM gateway (LLM connectors): the signed-in user's MIND key is used on every call to /developer/v1/byo-llm.
// The provider key lives in the body and never in the URL or the answer; MIND stores it server-side.

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

export async function rig(opts: { byoEnabled?: boolean } = {}) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const ownerKey = "server-owner-key-" + rnd();
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob", [ownerKey]: "owner" });
  if (opts.byoEnabled) fake.byo.set({ feature_enabled: true, configured: false, provider: null, base_url: null, key_last4: null });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-byo-"));
  const provider = new FakeProvider([{ text: "hi" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: ownerKey });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "boss", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const auth = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth, sessionStore });
  const cookie = async (key: string) => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    assert.equal(r.status, 200, r.body);
    return { ...H, cookie: String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0] };
  };
  return { gw, fake, keys, ownerKey, cookie, close: async () => { await gw.close(); await fake.close(); } };
}

test("byo-llm needs a session: a hosted gateway answers 401 before the handler; nothing reaches MIND", async () => {
  const r = await rig({ byoEnabled: true });
  try {
    for (const [m, p] of [["GET", "/byo-llm"], ["POST", "/byo-llm"], ["DELETE", "/byo-llm"], ["POST", "/byo-llm/test"]] as const) {
      const x = await http(r.gw.url, m, p, { headers: H, body: m === "POST" ? { provider: "openrouter", api_key: "sk-or-v1-1234567890abcdef" } : undefined });
      assert.equal(x.status, 401, `${m} ${p}: ${x.body}`);
    }
    assert.equal(r.fake.byo.seen.length, 0, "nothing reached MIND without a session");
  } finally { await r.close(); }
});

test("status: the signed-in user's own MIND key reaches /developer/v1/byo-llm; the answer is forwarded with the provider list", async () => {
  const r = await rig({ byoEnabled: true });
  try {
    const alice = await r.cookie(r.keys.alice);
    r.fake.byo.set({ feature_enabled: true, configured: true, provider: "openrouter", base_url: "https://openrouter.ai/api/v1", model: "x/y", key_last4: "abcd" }, r.keys.alice);
    const a = await http(r.gw.url, "GET", "/byo-llm", { headers: alice });
    assert.equal(a.status, 200);
    const j = JSON.parse(a.body);
    assert.equal(j.feature_enabled, true);
    assert.equal(j.configured, true);
    assert.equal(j.provider, "openrouter");
    assert.equal(j.model, "x/y");
    assert.equal(j.key_last4, "abcd");
    assert.ok(Array.isArray(j.providers) && j.providers.length > 5);
    const seen = r.fake.byo.seen.filter((c) => c.path === "/developer/v1/byo-llm" && c.method === "GET");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, r.keys.alice, "MIND is called with the SIGNED-IN USER'S key, never the server owner key");
  } finally { await r.close(); }
});

test("status: when MIND has not enabled BYO (404), the gateway still answers 200 with feature_enabled:false", async () => {
  const r = await rig();
  try {
    const alice = await r.cookie(r.keys.alice);
    const a = await http(r.gw.url, "GET", "/byo-llm", { headers: alice });
    assert.equal(a.status, 200);
    assert.equal(JSON.parse(a.body).feature_enabled, false);
  } finally { await r.close(); }
});

test("save: MIND gets a PUT with provider, the preset base_url, model and api_key; bad input is refused here; the key is never echoed", async () => {
  const r = await rig({ byoEnabled: true });
  try {
    const alice = await r.cookie(r.keys.alice);

    const bad1 = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "rogue", api_key: "sk-or-v1-1234567890abcdef" } });
    assert.equal(bad1.status, 400);
    assert.match(JSON.parse(bad1.body).error, /bad_provider/);

    const bad2 = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "openrouter", api_key: "short" } });
    assert.equal(bad2.status, 400);
    assert.match(JSON.parse(bad2.body).error, /bad_key/);

    const bad3 = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "openrouter", api_key: "sk-or-v1-1234567890abcdef", base_url: "javascript:alert(1)" } });
    assert.equal(bad3.status, 400);
    assert.match(JSON.parse(bad3.body).error, /bad_base_url/);

    const bad4 = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "openai-compat", api_key: "sk-1234567890abcdef" } });
    assert.equal(bad4.status, 400, "an OpenAI-compatible server needs its base URL");
    assert.match(JSON.parse(bad4.body).error, /bad_base_url/);

    const bad5 = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "openai" } });
    assert.equal(bad5.status, 400, "a cloud provider needs a key");
    assert.equal(r.fake.byo.seen.filter((c) => c.method === "PUT").length, 0, "nothing bad reached MIND");

    const ok = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "openrouter", api_key: "sk-or-v1-1234567890abcdef", model: "openai/gpt-5" } });
    assert.equal(ok.status, 200, ok.body);
    assert.doesNotMatch(ok.body, /sk-or-v1-1234567890abcdef/, "the API key is never echoed back to the browser");
    assert.equal(JSON.parse(ok.body).configured, true);
    assert.equal(JSON.parse(ok.body).key_last4, "cdef");

    const seen = r.fake.byo.seen.filter((c) => c.path === "/developer/v1/byo-llm" && c.method === "PUT");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, r.keys.alice);
    assert.equal(seen[0].body.provider, "openrouter");
    assert.equal(seen[0].body.base_url, "https://openrouter.ai/api/v1", "the preset's base URL is filled in (MIND requires one)");
    assert.equal(seen[0].body.model, "openai/gpt-5");
    assert.equal(seen[0].body.api_key, "sk-or-v1-1234567890abcdef");

    // Ollama needs no key: MIND fills a placeholder; the base URL defaults to the local Ollama.
    const oll = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "ollama", model: "qwen3:14b" } });
    assert.equal(oll.status, 200, oll.body);
    const put2 = r.fake.byo.seen.filter((c) => c.method === "PUT").at(-1)!;
    assert.equal(put2.body.base_url, "http://127.0.0.1:11434/v1");
    assert.equal(put2.body.api_key, "");

    // MIND refusing the save comes back as a sentence, not a 502
    r.fake.byo.nextSave = { status: 400, body: { detail: "Key did not pass a live check." } };
    const refused = await http(r.gw.url, "POST", "/byo-llm", { headers: alice, body: { provider: "openrouter", api_key: "sk-or-v1-1234567890abcdef" } });
    assert.equal(refused.status, 400);
    assert.equal(JSON.parse(refused.body).message, "Key did not pass a live check.");
  } finally { await r.close(); }
});

test("test and clear: forwarded to MIND with the user's key; results forwarded; not signed in gets 403", async () => {
  const r = await rig({ byoEnabled: true });
  try {
    const alice = await r.cookie(r.keys.alice);
    r.fake.byo.nextTest = { status: 200, body: { ok: true, reason: "models reachable" } };
    const ok = await http(r.gw.url, "POST", "/byo-llm/test", { headers: alice, body: {} });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).ok, true);
    assert.equal(JSON.parse(ok.body).reason, "models reachable");
    const seen = r.fake.byo.seen.filter((c) => c.path === "/developer/v1/byo-llm/test");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].key, r.keys.alice);

    r.fake.byo.nextTest = { status: 404, body: { detail: "No BYO LLM key is configured." } };
    const none = await http(r.gw.url, "POST", "/byo-llm/test", { headers: alice, body: {} });
    assert.equal(JSON.parse(none.body).ok, false);
    assert.equal(JSON.parse(none.body).reason, "No BYO LLM key is configured.");

    const anon = await http(r.gw.url, "POST", "/byo-llm/test", { headers: H, body: {} });
    assert.equal(anon.status, 401);

    const del = await http(r.gw.url, "DELETE", "/byo-llm", { headers: alice });
    assert.equal(del.status, 200);
    assert.equal(r.fake.byo.seen.filter((c) => c.method === "DELETE" && c.key === r.keys.alice).length, 1);
  } finally { await r.close(); }
});
