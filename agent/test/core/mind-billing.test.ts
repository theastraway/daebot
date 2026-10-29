// DAEBOT_BILLING=mind: every user is a MIND user billed by their plan and credits. Fake fetch only; nothing here touches the network
// except the localhost fake MIND server the gateway tests already use for sign-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthContext } from "../../src/auth/index.ts";
import { userIdFor } from "../../src/auth/users.ts";
import { loadConfig } from "../../src/config.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { MindBillingError, MindCredits, createMindProvider, usageLeftPct } from "../../src/provider/mind.ts";
import { createProvider } from "../../src/provider/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import type { StreamEvent } from "../../src/types.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { http, tmpStatic } from "../gateway/helpers.ts";
import { baseCfg, collect } from "./helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const UPGRADE = "https://m-i-n-d.ai/pricing-test";

const sseBody = (chunks: (object | string)[]): ReadableStream<Uint8Array> =>
  new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(chunks.map((x) => `data: ${typeof x === "string" ? x : JSON.stringify(x)}\n\n`).join(""))); c.close(); } });
const okStream = (text = "hi", cost = 0.001, headers: Record<string, string> = {}): Response =>
  new Response(sseBody([{ choices: [{ delta: { content: text } }] }, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, cost } }, "[DONE]"]), { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
const refuse = (error: "insufficient_credits" | "model_not_in_plan", tier = "starter", left = 0): Response =>
  new Response(JSON.stringify({ error, tier, credits_remaining: left, upgrade_url: UPGRADE }), { status: 402, headers: { "content-type": "application/json" } });
const errorChunk = (): Response => new Response(sseBody([{ error: { message: "upstream said no" } }]), { status: 200, headers: { "content-type": "text/event-stream" } });
const drain = async (it: AsyncIterable<StreamEvent>) => { const out: StreamEvent[] = []; for await (const e of it) out.push(e); return out; };
const text = (ev: StreamEvent[]) => ev.filter((e) => e.type === "text").map((e: any) => e.delta).join("");

interface LlmCall { url: string; key: string; auth: string | undefined; model: string; body: any }

/** A fake MIND LLM + credits surface behind one fetch. `script` answers the Nth LLM call; `tiers` maps a MIND key to its plan. */
function fakeMindFetch(o: { script?: (n: number, model: string, key: string) => Response; tiers?: Record<string, string>; credits?: Record<string, number>; limit?: number | null; routing?: Record<string, Record<string, unknown>>; passthrough?: typeof fetch } = {}) {
  const llm: LlmCall[] = [];
  const creditGets: string[] = [];
  const other: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (url.endsWith("/llm/chat/completions")) {
      const body = JSON.parse(String(init?.body));
      llm.push({ url, key: h["X-API-Key"], auth: h["Authorization"], model: body.model, body });
      return (o.script ?? (() => okStream()))(llm.length - 1, body.model, h["X-API-Key"]);
    }
    if (url.endsWith("/credits")) {
      creditGets.push(h["X-API-Key"]);
      const tier = o.tiers?.[h["X-API-Key"]] ?? "starter";
      return new Response(JSON.stringify({ tier, credits_balance: o.credits?.[h["X-API-Key"]] ?? 412, credits_limit: o.limit === undefined ? 500 : o.limit, upgrade_url: UPGRADE }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/llm/account") && o.routing?.[h["X-API-Key"]]) return new Response(JSON.stringify(o.routing[h["X-API-Key"]]), { status: 200, headers: { "content-type": "application/json" } });
    other.push(url);
    if (o.passthrough) return o.passthrough(input as never, init);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { f, llm, creditGets, other };
}

const mindCfg = (over = {}) => baseCfg({ mindBaseUrl: "https://mind.test/developer/v1", openrouterKey: "", billing: "mind", freeModel: "m/free", ...over });

function provider(over: Parameters<typeof fakeMindFetch>[0] = {}, key = "mind_user_key", cfgOver = {}, ttlMs?: number, now?: () => number) {
  const fake = fakeMindFetch(over);
  const cfg = mindCfg(cfgOver);
  const credits = new MindCredits({ mindBaseUrl: cfg.mindBaseUrl, fetchImpl: fake.f, ttlMs, now });
  return { ...fake, credits, cfg, p: createMindProvider(cfg, { getKey: () => key, credits, fetchImpl: fake.f, backoffMs: 0 }) };
}
const ask = (p: ReturnType<typeof provider>["p"], model = "m/default") => drain(p.stream({ model, messages: [{ role: "user", content: "hi" }], tools: [] }));

// ---------- provider ----------
test("mind provider: POSTs to MIND's LLM endpoint with the given user's X-API-Key, no Authorization header, OpenRouter-style body", async () => {
  const w = provider();
  const ev = await ask(w.p);
  assert.equal(text(ev), "hi");
  assert.equal(w.llm.length, 1);
  assert.equal(w.llm[0].url, "https://mind.test/developer/v1/llm/chat/completions");
  assert.equal(w.llm[0].key, "mind_user_key");
  assert.equal(w.llm[0].auth, undefined, "no bearer header (and so no OpenRouter key) on the MIND route");
  assert.equal(w.llm[0].body.stream, true);
  assert.deepEqual(w.llm[0].body.usage, { include: true });
  assert.equal(w.llm[0].model, "m/default");
  assert.deepEqual(w.creditGets, ["mind_user_key"], "the credits lookup uses the same user key");
  assert.equal((ev.at(-1) as any).usage.costUsd, 0.001);
});

test("402 model_not_in_plan: no fall through to cfg.models.fallback; one retry on the free model; if that also refuses the upgrade message surfaces", async () => {
  // retry succeeds: default model refused, free model answers
  const a = provider({ script: (_n, model) => (model === "m/default" ? refuse("model_not_in_plan") : okStream("from free")) });
  assert.equal(text(await ask(a.p)), "from free");
  assert.deepEqual(a.llm.map((c) => c.model), ["m/default", "m/free"], "default then DAEBOT_FREE_MODEL, never m/fallback");

  // the free model refuses too: clear error with the upgrade link, exactly two calls
  const b = provider({ script: () => refuse("model_not_in_plan") });
  await assert.rejects(ask(b.p), (e: any) => {
    assert.ok(e instanceof MindBillingError);
    assert.equal(e.code, "model_not_in_plan");
    assert.match(e.userNotice, /needs a paid MIND plan/);
    assert.ok(e.userNotice.includes(UPGRADE));
    return true;
  });
  assert.deepEqual(b.llm.map((c) => c.model), ["m/default", "m/free"]);
});

test("402 insufficient_credits: one call, no fall through, no free retry; message says plan usage is used up + link; credits cache goes to 0", async () => {
  const w = provider({ script: () => refuse("insufficient_credits", "starter", 0) });
  await assert.rejects(ask(w.p), (e: any) => {
    assert.ok(e instanceof MindBillingError);
    assert.equal(e.code, "insufficient_credits");
    assert.match(e.userNotice, /^You've used this month's plan usage/);
    assert.ok(e.userNotice.includes(UPGRADE));
    assert.equal(e.status, 402);
    return true;
  });
  assert.deepEqual(w.llm.map((c) => c.model), ["m/default"]);
  assert.equal(w.credits.peek("mind_user_key")?.creditsRemaining, 0);
});

test("400 model_not_available behaves like model_not_in_plan: one retry on the free model, then the message surfaces", async () => {
  const gone = () => new Response(JSON.stringify({ error: "model_not_available" }), { status: 400 });
  const a = provider({ script: (_n, model) => (model === "m/default" ? gone() : okStream("from free")) });
  assert.equal(text(await ask(a.p)), "from free");
  assert.deepEqual(a.llm.map((c) => c.model), ["m/default", "m/free"]);
  const b = provider({ script: gone });
  await assert.rejects(ask(b.p), (e: any) => e instanceof MindBillingError && e.code === "model_not_available" && /not available on MIND/.test(e.userNotice));
  assert.deepEqual(b.llm.map((c) => c.model), ["m/default", "m/free"], "no m/fallback");
  // an unrelated 400 keeps the generic error path (falls through like today)
  const c = provider({ script: (_n, model) => (model === "m/default" ? new Response('{"error":"bad_request"}', { status: 400 }) : okStream("fb")) });
  assert.equal(text(await ask(c.p)), "fb");
});

test("404 from the LLM route (MIND flag off) gives a plain user message, no fall through", async () => {
  const w = provider({ script: () => new Response("Not Found", { status: 404 }) });
  await assert.rejects(ask(w.p), (e: any) => e instanceof MindBillingError && e.code === "endpoint_disabled" && /can.t reach the AI on your MIND account/.test(e.userNotice) && !/DAEBOT_BILLING|Operator/.test(e.userNotice));
  assert.equal(w.llm.length, 1);
});

test("free tier (Explorer) runs on DAEBOT_FREE_MODEL and never offers a paid fallback; paid tiers use the requested model", async () => {
  const free = provider({ tiers: { mind_user_key: "free" } });
  await ask(free.p, "m/default");
  await ask(free.p, "m/cheap"); // even the compaction model is swapped
  assert.deepEqual(free.llm.map((c) => c.model), ["m/free", "m/free"]);
  assert.equal((await free.credits.get("mind_user_key"))?.tierName, "Explorer");

  // a free-tier stream error before output has no paid fallback to fall to
  const dead = provider({ tiers: { mind_user_key: "free" }, script: () => errorChunk() });
  await assert.rejects(ask(dead.p), /upstream said no/);
  assert.deepEqual(dead.llm.map((c) => c.model), ["m/free"]);

  const paid = provider({ tiers: { mind_user_key: "starter" } });
  await ask(paid.p, "m/default");
  assert.deepEqual(paid.llm.map((c) => c.model), ["m/default"]);
  assert.equal((await paid.credits.get("mind_user_key"))?.tierName, "Starter");
});

test("credits are cached ~5 minutes per user and refetched after", async () => {
  let t = 1_000_000;
  const w = provider({}, "mind_user_key", {}, undefined, () => t);
  await ask(w.p);
  await ask(w.p);
  assert.equal(w.creditGets.length, 1);
  t += 4 * 60_000;
  await ask(w.p);
  assert.equal(w.creditGets.length, 1);
  t += 2 * 60_000;
  await ask(w.p);
  assert.equal(w.creditGets.length, 2);
});

test("pre-output stream error falls back to the next model; an error after output propagates", async () => {
  const a = provider({ script: (_n, model) => (model === "m/default" ? errorChunk() : okStream("from fallback")) });
  assert.equal(text(await ask(a.p)), "from fallback");
  assert.deepEqual(a.llm.map((c) => c.model), ["m/default", "m/fallback"]);

  const midstream = () => new Response(sseBody([{ choices: [{ delta: { content: "par" } }] }, { error: { message: "cut off" } }]), { status: 200 });
  const b = provider({ script: midstream });
  const got: StreamEvent[] = [];
  await assert.rejects((async () => { for await (const e of b.p.stream({ model: "m/default", messages: [], tools: [] })) got.push(e); })(), /cut off/);
  assert.equal(text(got), "par");
  assert.deepEqual(b.llm.map((c) => c.model), ["m/default"], "committed to the model once text was out");
});

test("5xx on the MIND route retries once then falls to the next model; 401 stops (a bad key helps no model)", async () => {
  const a = provider({ script: (_n, model) => (model === "m/default" ? new Response("boom", { status: 503 }) : okStream("ok")) });
  await ask(a.p);
  assert.deepEqual(a.llm.map((c) => c.model), ["m/default", "m/default", "m/fallback"]);
  const b = provider({ script: () => new Response("no", { status: 401 }) });
  await assert.rejects(ask(b.p), /401/);
  assert.equal(b.llm.length, 1);
});

test("X-MIND-Credits-Remaining / X-MIND-Tier response headers refresh the cached plan without another lookup", async () => {
  const w = provider({ script: () => okStream("x", 0.001, { "x-mind-credits-remaining": "399.5", "x-mind-tier": "starter" }) });
  await ask(w.p);
  const b = w.credits.peek("mind_user_key");
  assert.equal(b?.creditsRemaining, 399.5);
  assert.equal(b?.tier, "starter");
  assert.equal(w.creditGets.length, 1, "no extra /credits call");
});

test("openrouter mode is unchanged: OpenRouter URL + bearer key, and a non-retryable 4xx (even 402) still falls through to the next model", async () => {
  const seen: { url: string; auth: string; model: string }[] = [];
  const f = (async (url: string, init: any) => {
    const model = JSON.parse(init.body).model;
    seen.push({ url, auth: init.headers.Authorization, model });
    return model === "m/default" ? new Response('{"error":"payment required"}', { status: 402 }) : okStream("fine");
  }) as any;
  const cfg = baseCfg(); // billing unset = openrouter
  const p = createProvider(cfg, f);
  assert.equal(p.name, "openrouter");
  assert.equal(text(await drain(p.stream({ model: "m/default", messages: [], tools: [] }))), "fine");
  assert.deepEqual(seen.map((s) => s.model), ["m/default", "m/fallback"]);
  assert.ok(seen.every((s) => s.url === "https://openrouter.ai/api/v1/chat/completions" && s.auth === "Bearer or-test"));
  assert.equal(createProvider(mindCfg(), f).name, "mind");
});

// ---------- config ----------
test("config: DAEBOT_BILLING defaults to openrouter; mind only on an explicit value; DAEBOT_FREE_MODEL overrides a tool-calling free default", () => {
  const e = { MINDCLAW_CONFIG: "/nonexistent/none.json", HOME: "/nonexistent" };
  const d = loadConfig(e);
  assert.equal(d.billing, "openrouter");
  assert.equal(d.freeModel, "nvidia/nemotron-3-super-120b-a12b:free");
  assert.equal(loadConfig({ ...e, DAEBOT_BILLING: " MIND " }).billing, "mind");
  assert.equal(loadConfig({ ...e, DAEBOT_BILLING: "bogus" }).billing, "openrouter");
  assert.equal(loadConfig({ ...e, DAEBOT_FREE_MODEL: "google/gemma-4-31b-it:free" }).freeModel, "google/gemma-4-31b-it:free");
  assert.equal(d.openrouterKey, "", "no OpenRouter key is required to load mind config");
});

// ---------- hosted multi-tenancy ----------
async function world(o: { limit?: number | null; script?: NonNullable<Parameters<typeof fakeMindFetch>[0]>["script"]; userCap?: string; globalCap?: number; credits?: Record<string, number>; routing?: (keys: { alice: string; boss: string }) => Record<string, Record<string, unknown>> } = {}) {
  const keys = { alice: "mind_" + rnd(), boss: "mind_" + rnd() };
  const serverKey = "mind_server_" + rnd();
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.boss]: "boss", [serverKey]: "anthony" });
  const tiers = { [keys.alice]: "starter", [keys.boss]: "professional", [serverKey]: "scale" };
  const llm = fakeMindFetch({ script: o.script, tiers, credits: o.credits, limit: o.limit, routing: o.routing?.(keys), passthrough: (u, i) => fetch(u as never, i) });
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: serverKey, openrouterKey: "", billing: "mind", freeModel: "m/free" });
  const credits = new MindCredits({ mindBaseUrl: cfg.mindBaseUrl, fetchImpl: llm.f });
  const globalCap = new DailyCostCap(o.globalCap ?? 50);
  const ownerRuntime = createRuntime(cfg, { fetchImpl: llm.f, credits, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const hosted = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const dir = mkdtempSync(join(tmpdir(), "daebot-mb-"));
  const env = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "boss", MIND_OAUTH_BASE_URL: fake.url, ...(o.userCap ? { MINDCLAW_USER_DAILY_USD_CAP: o.userCap } : {}) };
  const auth = createAuthContext({ env, cfg, hosted, ownerRuntime, globalCap, fetchImpl: llm.f, credits });
  const principal = (name: "alice" | "boss") => { auth.store.upsert(name, { kind: "key", mindKey: keys[name] }); return auth.store.principal(userIdFor(name))!; };
  return { fake, llm, auth, keys, serverKey, cfg, credits, ownerRuntime, principal, hosted, dir, close: () => fake.close() };
}

test("hosted mind mode: each user's calls carry THEIR key; the owner login uses the server MIND key; the server key never reaches a user call; OpenRouter is never contacted", async () => {
  const w = await world();
  try {
    const alice = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    assert.ok((await collect(alice.send("hello"))).some((e) => e.type === "text"));
    const boss = await w.auth.runtimeFor(w.principal("boss")).openSession({ surface: "web" });
    await collect(boss.send("hello"));
    const owner = await w.ownerRuntime.openSession({ surface: "web" });
    await collect(owner.send("hello"));

    assert.deepEqual(w.llm.llm.map((c) => c.key), [w.keys.alice, w.keys.boss, w.serverKey]);
    assert.ok(w.llm.llm.every((c) => c.auth === undefined && c.url.endsWith("/developer/v1/llm/chat/completions")));
    assert.ok(!w.llm.other.some((u) => u.includes("openrouter.ai")), "OPENROUTER_API_KEY is not needed and OpenRouter is not called");
    // alice's tier lookup used alice's key only
    assert.ok(w.llm.creditGets.includes(w.keys.alice));
  } finally { await w.close(); }
});

test("hosted mind mode skips Daebot's own USD caps: MIND credits are the cap", async () => {
  // each provider call reports cost 0.5; the per-user and global caps are 0.001, which would stop turn two in openrouter mode
  const w = await world({ userCap: "0.001", globalCap: 0.001, script: () => okStream("ok", 0.5) });
  try {
    const s = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    const first = await collect(s.send("one"));
    const second = await collect(s.send("two"));
    const third = await collect(s.send("three"));
    for (const turn of [first, second, third]) {
      assert.ok(turn.some((e) => e.type === "text"), "every turn runs");
      assert.ok(!turn.some((e) => e.type === "notice" && /cost cap/i.test((e as any).text)), "no Daebot cost-cap notice");
    }
    assert.equal(w.llm.llm.length, 3);
  } finally { await w.close(); }
});

test("a MIND refusal reaches the user as a notice with the upgrade link, not as an 'error:' line", async () => {
  const w = await world({ script: () => refuse("insufficient_credits") });
  try {
    const s = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    const ev = await collect(s.send("hello"));
    const n = ev.find((e) => e.type === "notice" && (e as any).level === "warn") as any;
    assert.ok(n, "a notice is shown");
    assert.match(n.text, /^You've used this month's plan usage/);
    assert.ok(!/credit/i.test(n.text), "usage language only");
    assert.ok(n.text.includes(UPGRADE));
    assert.equal(w.llm.llm.length, 1, "no other model was tried");
  } finally { await w.close(); }
});

test("a free-tier user's session runs on DAEBOT_FREE_MODEL end to end", async () => {
  const w = await world();
  try {
    w.llm.llm.length = 0;
    // make alice free by pointing her key at the free plan in the credits cache
    w.credits.note(w.keys.alice, { tier: "free", creditsRemaining: 50 });
    const s = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    await collect(s.send("hello"));
    assert.equal(w.llm.llm[0].model, "m/free");
    assert.equal(w.llm.llm[0].key, w.keys.alice);
  } finally { await w.close(); }
});

test("GET /auth/me in mind mode adds {planTier, tierName, creditsRemaining, upgradeUrl}; ?fresh=1 picks up the header value from the last turn", async () => {
  const w = await world({ credits: {}, script: () => okStream("ok", 0.001, { "x-mind-credits-remaining": "407", "x-mind-tier": "starter" }) });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const gw = await startGateway({ runtime: w.ownerRuntime, cfg: w.cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: w.hosted, auth: w.auth });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    const login = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key: w.keys.alice } });
    assert.equal(login.status, 200, login.body);
    const cookie = String(([] as string[]).concat(login.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
    const get = async (path = "/auth/me") => JSON.parse((await http(gw.url, "GET", path, { headers: { ...H, cookie } })).body);
    const before = await get();
    assert.deepEqual(before, { username: "alice", owner: false, tier: "staff", bots: false, planTier: "starter", tierName: "Starter", creditsRemaining: 412, creditsLimit: 500, usageLeftPct: 82, upgradeUrl: UPGRADE });
    assert.ok(w.llm.creditGets.every((k) => k === w.keys.alice), "the plan lookup used alice's key");

    const s = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    await collect(s.send("hello")); // the response header says 407 left
    const gets = w.llm.creditGets.length;
    const after = await get("/auth/me?fresh=1");
    assert.equal(after.creditsRemaining, 407);
    assert.equal(after.usageLeftPct, 81, "balance from the header, limit from /credits");
    assert.equal(w.llm.creditGets.length, gets, "the header already refreshed it: no re-fetch");

    // the owner login shows the server MIND account's plan
    const ow = await http(gw.url, "POST", "/login", { headers: H, body: { token: w.hosted.token } });
    const ownerCookie = String(([] as string[]).concat(ow.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
    const me = JSON.parse((await http(gw.url, "GET", "/auth/me", { headers: { ...H, cookie: ownerCookie } })).body);
    assert.equal(me.owner, true);
    assert.equal(me.tierName, "Scale");
    assert.ok(w.llm.creditGets.includes(w.serverKey));
  } finally { await gw.close(); await w.close(); }
});

test("usageLeftPct: balance / limit as a clamped percent; null for no allowance (pay as you go) or an unknown balance", () => {
  assert.equal(usageLeftPct({ creditsRemaining: 310, creditsLimit: 500 }), 62);
  assert.equal(usageLeftPct({ creditsRemaining: 0, creditsLimit: 500 }), 0);
  assert.equal(usageLeftPct({ creditsRemaining: 900, creditsLimit: 500 }), 100);
  assert.equal(usageLeftPct({ creditsRemaining: -5, creditsLimit: 500 }), 0);
  assert.equal(usageLeftPct({ creditsRemaining: 10, creditsLimit: 0 }), null);
  assert.equal(usageLeftPct({ creditsRemaining: 10, creditsLimit: null }), null);
  assert.equal(usageLeftPct({ creditsRemaining: null, creditsLimit: 500 }), null);
});

test("/auth/me: no credits_limit (pay as you go) -> usageLeftPct null so the UI shows 'Usage billed as you go' with no bar", async () => {
  const w = await world({ limit: 0 });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const gw = await startGateway({ runtime: w.ownerRuntime, cfg: w.cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: w.hosted, auth: w.auth });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    const login = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key: w.keys.alice } });
    const cookie = String(([] as string[]).concat(login.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
    const me = JSON.parse((await http(gw.url, "GET", "/auth/me", { headers: { ...H, cookie } })).body);
    assert.equal(me.usageLeftPct, null);
    assert.equal(me.creditsLimit, 0);
    assert.equal(me.tierName, "Starter");
  } finally { await gw.close(); await w.close(); }
});

test("a paid user's call that retried on the free model shows 'Answered on the free model' once, after the answer", async () => {
  const w = await world({ script: (_n, model) => (model === "m/default" ? refuse("model_not_in_plan") : okStream("free answer")) });
  try {
    const s = await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" });
    const ev = await collect(s.send("hello"));
    const notes = ev.filter((e) => e.type === "notice" && (e as any).text === "Answered on the free model");
    assert.equal(notes.length, 1);
    assert.equal((notes[0] as any).level, "info");
    assert.ok(ev.some((e) => e.type === "text" && /free answer/.test((e as any).delta)));
    assert.deepEqual(w.llm.llm.map((c) => c.model), ["m/default", "m/free"]);
    // a plain paid call has no such notice
    const ok = await world();
    try {
      const s2 = await ok.auth.runtimeFor(ok.principal("alice")).openSession({ surface: "web" });
      assert.ok(!(await collect(s2.send("hello"))).some((e) => e.type === "notice" && /free model/.test((e as any).text)));
    } finally { await ok.close(); }
  } finally { await w.close(); }
});

// ---------- the MIND account's own key and chosen model ----------
function routingFetch(routing: Record<string, unknown> | undefined, tier = "starter") {
  const gets: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    gets.push(url);
    if (url.endsWith("/llm/account")) return routing ? new Response(JSON.stringify(routing), { status: 200 }) : new Response("{}", { status: 404 });
    if (url.endsWith("/credits")) return new Response(JSON.stringify({ tier, credits_balance: 10, credits_limit: 100, upgrade_url: UPGRADE }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { f, gets };
}

test("MindCredits reads the account's chosen model and key source from GET /llm/account; an older MIND (404) just has none", async () => {
  const a = routingFetch({ model: "anthropic/claude-haiku-5.5", model_source: "account", key_source: "byo", provider: "openrouter" });
  const c = new MindCredits({ mindBaseUrl: "https://mind.test/developer/v1", fetchImpl: a.f });
  const b = await c.get("k1");
  assert.equal(b?.accountModel, "anthropic/claude-haiku-5.5");
  assert.equal(b?.keySource, "byo");
  assert.equal(b?.provider, "openrouter");
  const old = routingFetch(undefined);
  const b2 = await new MindCredits({ mindBaseUrl: "https://mind.test/developer/v1", fetchImpl: old.f }).get("k2");
  assert.equal(b2?.tier, "starter");
  assert.ok(!b2?.accountModel);
  assert.equal(b2?.keySource, undefined);
});

test("the X-MIND-Key-Source header updates the cached key source after a call", async () => {
  const w = provider({}, "mind_user_key");
  await w.credits.get("mind_user_key");
  w.credits.note("mind_user_key", { keySource: "byo" });
  assert.equal(w.credits.peek("mind_user_key")?.keySource, "byo");
});

test("an account on its own key is NOT forced onto the free model even on the MIND free tier; a platform free account still is", async () => {
  const own = provider({ tiers: { mind_user_key: "free" } }, "mind_user_key");
  own.credits.note("mind_user_key", { tier: "free", keySource: "byo" });
  await own.credits.get("mind_user_key"); // cached (byo) state stands
  await ask(own.p, "m/default");
  assert.equal(own.llm[0].model, "m/default", "own key: the requested model runs");
  const plat = provider({ tiers: { mind_user_key: "free" } }, "mind_user_key");
  await ask(plat.p, "m/default");
  assert.equal(plat.llm[0].model, "m/free", "platform free tier: the free model");
});

test("model precedence end to end: session pick > the MIND account's model > Daebot's configured default", async () => {
  const w = await world({ routing: (k) => ({ [k.alice]: { model: "acct/model-x", model_source: "account", key_source: "platform", provider: null } }) });
  try {
    const rt = w.auth.runtimeFor(w.principal("alice"));
    // 1. never touched the picker: the MIND account's model
    w.llm.llm.length = 0;
    await collect((await rt.openSession({ surface: "web" })).send("hi"));
    assert.equal(w.llm.llm[0].model, "acct/model-x");
    // 2/3. a model picked for this very thread beats both
    w.llm.llm.length = 0;
    await collect((await rt.openSession({ surface: "web", model: "thread/pick-z" })).send("hi"));
    assert.equal(w.llm.llm[0].model, "thread/pick-z");
    // an account with no routing (older MIND / no choice) keeps Daebot's configured default
    const boss = w.auth.runtimeFor(w.principal("boss"));
    w.llm.llm.length = 0;
    await collect((await boss.openSession({ surface: "web" })).send("hi"));
    assert.equal(w.llm.llm[0].model, w.cfg.models.default);
  } finally { await w.close(); }
});

test("an own-key free-tier account runs the requested model end to end, not the free model", async () => {
  const w = await world({ routing: (k) => ({ [k.alice]: { model: "acct/model-x", key_source: "byo", provider: "openrouter" } }) });
  try {
    await w.credits.get(w.keys.alice); // reads the plan and the own-key routing together
    w.credits.note(w.keys.alice, { tier: "free", creditsRemaining: 0 });
    w.llm.llm.length = 0;
    await collect((await w.auth.runtimeFor(w.principal("alice")).openSession({ surface: "web" })).send("hello"));
    assert.equal(w.llm.llm[0].model, "acct/model-x");
  } finally { await w.close(); }
});

test("pickDefaultModel: the default the user picked in Daebot beats the MIND account's model; resolveTurnModel puts bot and session picks above both", async () => {
  const { pickDefaultModel, resolveTurnModel } = await import("../../src/bots/model.ts");
  assert.equal(pickDefaultModel("picked/y", "acct/x"), "picked/y");
  assert.equal(pickDefaultModel(undefined, "acct/x"), "acct/x");
  assert.equal(pickDefaultModel(undefined, null), undefined);
  assert.equal(pickDefaultModel("bad id", "acct/x"), "acct/x");
  const d = pickDefaultModel(undefined, "acct/x");
  assert.equal(resolveTurnModel({ botModel: "bot/m", sessionModel: "sess/m", userDefault: d }), "bot/m");
  assert.equal(resolveTurnModel({ sessionModel: "sess/m", userDefault: d }), "sess/m");
  assert.equal(resolveTurnModel({ userDefault: d }), "acct/x");
  assert.equal(resolveTurnModel({}), undefined);
});

test("404 relayed from OpenRouter (one model unavailable) falls through to the fallback model, not the route-off message", async () => {
  const w = provider({ script: (_n, model) => (model === "m/default" ? new Response('{"error":{"message":"No endpoints found for m/default.","code":404}}', { status: 404 }) : okStream("fb")) });
  assert.equal(text(await ask(w.p)), "fb");
});
