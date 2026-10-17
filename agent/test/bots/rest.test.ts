// REST for bots, models and bot-aware sessions: hosted (two users + the owner login) and local mode. Fake MIND on localhost only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthContext } from "../../src/auth/index.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { MindCredits } from "../../src/provider/mind.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { FakeProvider, baseCfg } from "../core/helpers.ts";
import { startFakeMind } from "../gateway/fake-mind.ts";
import { auth as bearer, http, parseSse, tmpStatic } from "../gateway/helpers.ts";

const rnd = () => randomBytes(18).toString("hex");
const H = { host: "daebot.live", "x-forwarded-proto": "https" };
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) =>
  String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

const MODELS = [
  { id: "vendor/big", name: "Big paid model", tier: "premium" },
  { id: "vendor/small", name: "Small paid model", tier: "budget" },
  { id: "vendor/free-one:free", name: "A free model", tier: "free" },
];

async function rig() {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  fake.models = MODELS;
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "bots-rest-"));
  const token = rnd();
  const provider = new FakeProvider([{ text: "hi there" }]);
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd(), freeModel: "vendor/free-one:free" });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const credits = new MindCredits({ mindBaseUrl: fake.base });
  const bots = { dir, bus: {} };
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, bots, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const authCtx = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache, credits, bots });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth: authCtx, sessionStore, bots });
  const login = async (key: string) => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    assert.equal(r.status, 200, r.body);
    return { ...H, cookie: cookieOf(r) };
  };
  const call = async (who: Record<string, string>, method: string, path: string, body?: unknown) => {
    const r = await http(gw.url, method, path, { headers: who, body });
    return { status: r.status, json: r.body && r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body) : r.body, raw: r.body };
  };
  return { gw, fake, keys, provider, credits, cfg, dir, login, call, close: async () => { await gw.close(); await fake.close(); } };
}

test("bots REST happy path: create, list, patch, instructions, sessions by bot, delete; keys never appear", async () => {
  const r = await rig();
  try {
    const alice = await r.login(r.keys.alice);
    const c = await r.call(alice, "POST", "/bots", { slug: "sales", name: "Sales", purpose: "pipeline", color: "#aabbcc" });
    assert.equal(c.status, 201, c.raw);
    const bot = c.json.bot;
    assert.match(bot.id, /^b_[0-9a-f]{12}$/);
    assert.equal(bot.slug, "sales");
    assert.equal(bot.color, "#aabbcc");
    assert.ok(r.fake.bots.get("alice")!.has("sales"), "MIND was asked to create the workspace first");
    const post = r.fake.seen.find((x) => x.method === "POST" && x.path === "/developer/v1/bots")!;
    assert.equal(post.key, r.keys.alice, "created with the user's MAIN key");
    assert.deepEqual(post.body, { slug: "sales", label: "Sales" });
    assert.equal(post.bot, undefined);

    let list = await r.call(alice, "GET", "/bots");
    assert.deepEqual(list.json.bots.map((b: any) => b.slug), ["sales"]);

    const p = await r.call(alice, "PATCH", `/bots/${bot.id}`, { name: "Sales Lead", purpose: "owns revenue" });
    assert.equal(p.status, 200);
    assert.equal(p.json.bot.name, "Sales Lead");
    assert.equal((await r.call(alice, "GET", `/bots/${bot.id}`)).json.bot.purpose, "owns revenue");

    assert.equal((await r.call(alice, "GET", `/bots/${bot.id}/instructions`)).json.instructions, "");
    const put = await r.call(alice, "PUT", `/bots/${bot.id}/instructions`, { instructions: "# Sales\nBe brief." });
    assert.equal(put.status, 200);
    assert.equal((await r.call(alice, "GET", `/bots/${bot.id}/instructions`)).json.instructions, "# Sales\nBe brief.");

    // a thread of the bot: hidden from the default list, shown with ?bot=
    const plain = await r.call(alice, "POST", "/sessions", { surface: "web" });
    const bt = await r.call(alice, "POST", "/sessions", { surface: "web", bot: bot.id, title: "Deals" });
    assert.equal(bt.status, 200, bt.raw);
    for (const id of [plain.json.sessionId, bt.json.sessionId]) {
      const send = await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: alice, body: { text: "hello" } });
      assert.equal(send.status, 200);
      assert.equal(parseSse(send.body).at(-1)!.type, "done");
    }
    const all = await r.call(alice, "GET", "/sessions");
    assert.deepEqual(all.json.sessions.map((s: any) => s.id), [plain.json.sessionId], "bot threads are not in the default list");
    const mine = await r.call(alice, "GET", `/sessions?bot=${bot.id}`);
    assert.deepEqual(mine.json.sessions.map((s: any) => [s.id, s.bot]), [[bt.json.sessionId, bot.id]]);
    assert.deepEqual((await r.call(alice, "GET", "/sessions?bot=b_000000000000")).json.sessions, []);
    // the bot thread read the BOT's MIND at boot
    assert.ok(r.fake.seen.some((x) => x.path === "/developer/v1/context" && x.bot === "sales" && x.key === r.keys.alice));

    const del = await r.call(alice, "DELETE", `/bots/${bot.id}`);
    assert.equal(del.status, 200);
    assert.ok(!r.fake.bots.get("alice")!.has("sales"), "MIND deleted the workspace");
    assert.equal((await r.call(alice, "GET", "/bots")).json.bots.length, 0);
    assert.equal((await r.call(alice, "GET", `/bots/${bot.id}`)).status, 404);

    // nothing in any response leaks a key
    for (const text of [c.raw, list.raw, p.raw, put.raw, all.raw, mine.raw]) assert.ok(!/mind_[A-Za-z0-9_-]{12,}/.test(text) && !text.includes(r.keys.alice));
  } finally { await r.close(); }
});

test("bots REST errors: 401, bad slug, duplicate, plan limit 402 (with upgrade info), too-large DAEBOT.md, bad bodies", async () => {
  const r = await rig();
  try {
    assert.equal((await r.call(H, "GET", "/bots")).status, 401);
    assert.equal((await r.call(H, "POST", "/bots", { slug: "x" })).status, 401);
    const alice = await r.login(r.keys.alice);
    for (const slug of ["Bad Slug", "main", "", "x".repeat(33)]) {
      const e = await r.call(alice, "POST", "/bots", slug === "" ? {} : { slug });
      assert.equal(e.status, 400, slug);
      assert.equal(e.json.error, "bad_slug");
    }
    assert.equal((await r.call(alice, "POST", "/bots", { slug: "ops" })).status, 201);
    const dup = await r.call(alice, "POST", "/bots", { slug: "ops" });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, "duplicate");
    r.fake.botLimit = 1;
    const lim = await r.call(alice, "POST", "/bots", { slug: "second" });
    assert.equal(lim.status, 402);
    assert.deepEqual([lim.json.error, lim.json.limit, lim.json.tier, lim.json.upgradeUrl], ["bot_limit", 1, "free", "https://m-i-n-d.ai/#/billing"]);
    assert.equal((await r.call(alice, "GET", "/bots")).json.bots.length, 1, "nothing was created locally");
    const id = (await r.call(alice, "GET", "/bots")).json.bots[0].id;
    const big = await r.call(alice, "PUT", `/bots/${id}/instructions`, { instructions: "x".repeat(8 * 1024 + 1) });
    assert.equal(big.status, 413);
    assert.equal((await r.call(alice, "PUT", `/bots/${id}/instructions`, { instructions: 5 })).status, 400);
    assert.equal((await r.call(alice, "PATCH", `/bots/${id}`, { color: "red" })).status, 400);
    assert.equal((await r.call(alice, "PATCH", `/bots/${id}`, { name: "  " })).status, 400);
    assert.equal((await r.call(alice, "PUT", "/bots", {})).status, 405);
    assert.equal((await r.call(alice, "POST", "/sessions", { surface: "web", bot: "b_000000000000" })).status, 404);
    // MIND down: the list falls back to the local view
    r.fake.botsDown = true;
    assert.equal((await r.call(alice, "GET", "/bots")).json.bots.length, 1);
  } finally { await r.close(); }
});

test("ownership over REST: user B cannot see, read, change, delete or open a session on user A's bot (404)", async () => {
  const r = await rig();
  try {
    const alice = await r.login(r.keys.alice);
    const bob = await r.login(r.keys.bob);
    const bot = (await r.call(alice, "POST", "/bots", { slug: "secret", name: "Secret" })).json.bot;
    await r.call(alice, "PUT", `/bots/${bot.id}/instructions`, { instructions: "alice only" });
    assert.deepEqual((await r.call(bob, "GET", "/bots")).json.bots, []);
    for (const [m, path, body] of [
      ["GET", `/bots/${bot.id}`], ["PATCH", `/bots/${bot.id}`, { name: "pwn" }], ["DELETE", `/bots/${bot.id}`],
      ["GET", `/bots/${bot.id}/instructions`], ["PUT", `/bots/${bot.id}/instructions`, { instructions: "pwn" }],
    ] as [string, string, unknown?][]) {
      const x = await r.call(bob, m, path, body);
      assert.equal(x.status, 404, `${m} ${path}`);
      assert.ok(!x.raw.includes("alice only"));
    }
    assert.equal((await r.call(bob, "POST", "/sessions", { surface: "web", bot: bot.id })).status, 404);
    // bob creates his own bot with the same slug: allowed (per-user namespace), and it does not touch alice's
    assert.equal((await r.call(bob, "POST", "/bots", { slug: "secret" })).status, 201);
    assert.equal((await r.call(alice, "GET", `/bots/${bot.id}/instructions`)).json.instructions, "alice only");
    // and a bot thread of alice's is invisible / forbidden for bob
    const t = await r.call(alice, "POST", "/sessions", { surface: "web", bot: bot.id });
    assert.equal((await r.call(bob, "POST", "/sessions", { surface: "web", resumeId: t.json.sessionId })).status, 403);
    assert.deepEqual((await r.call(bob, "GET", `/sessions?bot=${bot.id}`)).json.sessions, []);
  } finally { await r.close(); }
});

test("models: GET /models proxies MIND's list with free/allowed flags; per-session model on open and PATCH; per-user default", async () => {
  const r = await rig();
  try {
    const alice = await r.login(r.keys.alice);
    const m = await r.call(alice, "GET", "/models");
    assert.equal(m.status, 200);
    assert.equal(m.json.source, "mind");
    assert.deepEqual(m.json.models, [
      { id: "vendor/big", name: "Big paid model", free: false, allowed: true },
      { id: "vendor/small", name: "Small paid model", free: false, allowed: true },
      { id: "vendor/free-one:free", name: "A free model", free: true, allowed: true },
    ]);
    assert.equal(m.json.default, "m/default");
    assert.equal(r.fake.seen.filter((x) => x.path === "/developer/v1/profile/models")[0].key, r.keys.alice);

    const s = await r.call(alice, "POST", "/sessions", { surface: "web", model: "vendor/big" });
    assert.equal(s.status, 200, s.raw);
    const id = s.json.sessionId;
    await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: alice, body: { text: "one" } });
    assert.equal(r.provider.requests.at(-1)!.model, "vendor/big");
    const patch = await r.call(alice, "PATCH", `/sessions/${id}`, { model: "vendor/small" });
    assert.equal(patch.status, 200, patch.raw);
    await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: alice, body: { text: "two" } });
    assert.equal(r.provider.requests.at(-1)!.model, "vendor/small", "the next turn runs on the new model");
    assert.equal((await r.call(alice, "GET", "/sessions")).json.sessions.find((x: any) => x.id === id).model, "vendor/small");
    await r.call(alice, "PATCH", `/sessions/${id}`, { model: null });
    await http(r.gw.url, "POST", `/sessions/${id}/send`, { headers: alice, body: { text: "three" } });
    assert.equal(r.provider.requests.at(-1)!.model, "m/default", "null = back to the default");

    // errors
    assert.equal((await r.call(alice, "POST", "/sessions", { surface: "web", model: "not/in-the-list" })).status, 400);
    assert.equal((await r.call(alice, "POST", "/sessions", { surface: "web", model: "bad model!" })).status, 400);
    assert.equal((await r.call(alice, "PATCH", `/sessions/${id}`, {})).status, 400);
    assert.equal((await r.call(alice, "PATCH", "/sessions/nope", { model: "vendor/big" })).status, 404);
    const bob = await r.login(r.keys.bob);
    assert.equal((await r.call(bob, "PATCH", `/sessions/${id}`, { model: "vendor/big" })).status, 403);

    // the per-user default lives in the user's settings file and applies to new sessions
    assert.equal((await r.call(alice, "PUT", "/models/default", { model: "vendor/small" })).status, 200);
    assert.equal((await r.call(alice, "GET", "/models")).json.default, "vendor/small");
    assert.equal((await r.call(bob, "GET", "/models")).json.default, "m/default", "bob's default is his own");
    const fresh = await r.call(alice, "POST", "/sessions", { surface: "web" });
    await http(r.gw.url, "POST", `/sessions/${fresh.json.sessionId}/send`, { headers: alice, body: { text: "x" } });
    assert.equal(r.provider.requests.at(-1)!.model, "vendor/small");
    assert.equal((await r.call(alice, "PUT", "/models/default", { model: null })).status, 200);
    assert.equal((await r.call(alice, "PUT", "/models/default", { model: "ghost/model" })).status, 400);
    assert.equal((await r.call(alice, "GET", "/models")).json.default, "m/default");
  } finally { await r.close(); }
});

test("free plan: only free models are allowed; anything else is a 402 with the upgrade link", async () => {
  const r = await rig();
  try {
    const alice = await r.login(r.keys.alice);
    r.credits.note(r.keys.alice, { tier: "free", creditsRemaining: 10, upgradeUrl: "https://m-i-n-d.ai/#/billing" });
    const m = await r.call(alice, "GET", "/models");
    assert.equal(m.json.plan, "free");
    assert.deepEqual(m.json.models.map((x: any) => [x.id, x.allowed]), [["vendor/big", false], ["vendor/small", false], ["vendor/free-one:free", true]]);
    const bad = await r.call(alice, "POST", "/sessions", { surface: "web", model: "vendor/big" });
    assert.equal(bad.status, 402);
    assert.equal(bad.json.error, "model_not_in_plan");
    assert.match(bad.json.message, /free plan/);
    assert.equal(bad.json.upgradeUrl, "https://m-i-n-d.ai/#/billing");
    const ok = await r.call(alice, "POST", "/sessions", { surface: "web", model: "vendor/free-one:free" });
    assert.equal(ok.status, 200);
    assert.equal((await r.call(alice, "PATCH", `/sessions/${ok.json.sessionId}`, { model: "vendor/small" })).status, 402);
    assert.equal((await r.call(alice, "PUT", "/models/default", { model: "vendor/big" })).status, 402);
    assert.equal((await r.call(alice, "PUT", "/models/default", { model: "vendor/free-one:free" })).status, 200);
  } finally { await r.close(); }
});

test("MIND's model list unreachable: the catalog falls back to the configured models and the free model", async () => {
  const r = await rig();
  try {
    r.fake.models = undefined; // /profile/models now answers the generic {ok:true}
    const alice = await r.login(r.keys.alice);
    const m = await r.call(alice, "GET", "/models");
    assert.equal(m.json.source, "config");
    assert.deepEqual(m.json.models.map((x: any) => x.id).sort(), ["m/cheap", "m/default", "m/fallback", "vendor/free-one:free"].sort());
    assert.equal(m.json.models.find((x: any) => x.id === "vendor/free-one:free").free, true);
  } finally { await r.close(); }
});

test("local (non-hosted) mode: the owner principal works the same, bearer-token auth, bot_talk bus is wired", async () => {
  const key = "mind_" + rnd();
  const fake = await startFakeMind({ [key]: "pat" });
  const dir = mkdtempSync(join(tmpdir(), "bots-local-"));
  const provider = new FakeProvider([{ text: "hello" }]);
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: key });
  const bots: import("../../src/bots/types.ts").BotsContext = { dir, bus: {} };
  const runtime = createRuntime(cfg, { provider, store: createFileStore(dir), bots });
  const st = tmpStatic();
  const gw = await startGateway({ runtime, cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok"), bots });
  try {
    assert.ok(bots.bus.current, "startGateway set the late-bound bus");
    const a = bearer(gw.token);
    const c = await http(gw.url, "POST", "/bots", { headers: a, body: { slug: "helper", name: "Helper" } });
    assert.equal(c.status, 201, c.body);
    const id = JSON.parse(c.body).bot.id;
    assert.equal((await http(gw.url, "GET", "/bots")).status, 401);
    assert.deepEqual(JSON.parse((await http(gw.url, "GET", "/bots", { headers: a })).body).bots.map((b: any) => b.slug), ["helper"]);
    const s = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: a, body: { surface: "web", bot: id } })).body);
    assert.ok(s.sessionId);
    assert.equal((await http(gw.url, "GET", `/sessions?bot=${id}`, { headers: a })).status, 200);
    // a gateway started WITHOUT a bots context answers 404 for the bots routes (no half-working feature)
    const bare = await startGateway({ runtime: createRuntime(cfg, { provider }), cfg, port: 0, staticDir: st.dir, tokenPath: join(dir, "tok2") });
    assert.equal((await http(bare.url, "GET", "/bots", { headers: bearer(bare.token) })).status, 404);
    await bare.close();
  } finally { await gw.close(); await fake.close(); }
});
