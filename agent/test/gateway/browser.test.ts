import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { createBrowserBridge } from "../../src/browser/bridge.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import type { FakeMind } from "./fake-mind.ts";
import { auth, fakeRuntime, http, parseSse, tmpStatic } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("browser channel requires the gateway bearer token and reports the desktop connection on /devices", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-browser-ch-"));
  const bridge = createBrowserBridge();
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok"), browser: bridge, browserHeartbeatMs: 60_000 });
  try {
    assert.equal((await http(gw.url, "GET", "/browser/poll?waitMs=0")).status, 401);
    assert.equal((await http(gw.url, "POST", "/browser/state", { body: { tabs: [] } })).status, 401);
    const devices = JSON.parse((await http(gw.url, "GET", "/devices", { headers: auth(gw.token) })).body);
    assert.equal(devices.browser.available, false);
    assert.match(devices.browser.note, /no desktop connected/);

    const poll = http(gw.url, "GET", "/browser/poll?waitMs=3000", { headers: auth(gw.token) });
    await sleep(40);
    assert.equal(bridge.connected(), true);
    const live = JSON.parse((await http(gw.url, "GET", "/devices", { headers: auth(gw.token) })).body);
    assert.equal(live.browser.available, true);
    assert.equal(live.browser.partition, "persist:daebot-browser");

    const pending = bridge.call("open", { url: "http://127.0.0.1:9/" });
    const polled = JSON.parse((await poll).body);
    assert.equal(polled.commands.length, 1);
    assert.equal(polled.commands[0].op, "open");
    const id = polled.commands[0].id as string;
    const posted = await http(gw.url, "POST", "/browser/result", { headers: auth(gw.token), body: { id, ok: true, result: { tabId: "t1", url: "http://127.0.0.1:9/" } } });
    assert.equal(posted.status, 200);
    assert.deepEqual(await pending, { tabId: "t1", url: "http://127.0.0.1:9/" });
    const unknown = await http(gw.url, "POST", "/browser/result", { headers: auth(gw.token), body: { id: "missing", ok: true } });
    assert.equal(unknown.status, 404);

    const open = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web" } });
    const sid = JSON.parse(open.body).sessionId as string;
    const state = await http(gw.url, "POST", "/browser/state", {
      headers: auth(gw.token),
      body: { gatewayOrigin: gw.url, pane: { open: true, width: 500 }, tabs: [{ id: "t1", url: "http://127.0.0.1:9/", title: "Shop", active: true, control: "agent" }] },
    });
    assert.equal(state.status, 200);
    const pane = JSON.parse((await http(gw.url, "GET", `/sessions/${sid}/browser`, { headers: auth(gw.token) })).body);
    assert.equal(pane.tabs[0].title, "Shop");
    assert.equal(pane.partition, "persist:daebot-browser");
    assert.equal((await http(gw.url, "GET", `/sessions/${sid}/browser`, { headers: auth(gw.token) })).status, 200);

    const controlPoll = http(gw.url, "GET", "/browser/poll?waitMs=3000", { headers: auth(gw.token) });
    await sleep(30);
    const control = http(gw.url, "POST", `/sessions/${sid}/browser/control`, { headers: auth(gw.token), body: { action: "take" } });
    const cmd = JSON.parse((await controlPoll).body).commands[0];
    assert.equal(cmd.op, "setControl");
    await http(gw.url, "POST", "/browser/result", { headers: auth(gw.token), body: { id: cmd.id, ok: true, result: {} } });
    const after = JSON.parse((await control).body);
    assert.equal(after.tabs[0].control, "user");
  } finally { await gw.close(); }
});

test("hosted deployment: browser routes are 404 for the signed-in owner", async () => {
  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  const token = randomBytes(18).toString("hex");
  const gw = await startGateway({
    runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir,
    hosted: { token, allowedHosts: ["daebot.live", "localhost"] },
    browserShots: true,
  });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    assert.equal((await http(gw.url, "GET", "/browser/poll", { headers: H })).status, 401);
    const lr = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
    assert.equal(lr.status, 200);
    const cookie = String(([] as string[]).concat(lr.headers["set-cookie"] as string[])[0]).split(";")[0];
    const withToken = { ...H, cookie };
    const open = await http(gw.url, "POST", "/sessions", { headers: withToken, body: { surface: "web" } });
    const id = JSON.parse(open.body).sessionId as string;
    assert.equal((await http(gw.url, "GET", `/sessions/${id}/browser`, { headers: withToken })).status, 404);
    assert.equal((await http(gw.url, "GET", `/sessions/${id}/browser/stream`, { headers: withToken })).status, 404);
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/browser/control`, { headers: withToken, body: { action: "take" } })).status, 404);
    assert.equal((await http(gw.url, "GET", "/browser/poll?waitMs=0", { headers: withToken })).status, 404);
    assert.equal((await http(gw.url, "POST", "/browser/shots", { headers: withToken, body: { action: "tabs" } })).status, 404);
    assert.equal((await http(gw.url, "GET", "/devices", { headers: withToken })).status, 404);
  } finally { await gw.close(); }
});

const rnd = () => randomBytes(18).toString("hex");
const HOST = { host: "daebot.live", "x-forwarded-proto": "https" };
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) =>
  String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

test("a shared-thread guest is forbidden from the browser pane", async () => {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake: FakeMind = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "daebot-browser-share-"));
  const provider = new FakeProvider([{ text: "hi there" }]);
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "nobody", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const authCtx = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth: authCtx, sessionStore, sharedTtlMs: 0 });
  const as = async (name: "alice" | "bob") => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: HOST, body: { key: keys[name] } });
    assert.equal(r.status, 200, r.body);
    return { ...HOST, cookie: cookieOf(r) };
  };
  try {
    const alice = await as("alice");
    const bob = await as("bob");
    const opened = await http(gw.url, "POST", "/sessions", { headers: alice, body: { surface: "web" } });
    assert.equal(opened.status, 200, opened.body);
    const id = JSON.parse(opened.body).sessionId as string;
    const sent = await http(gw.url, "POST", `/sessions/${id}/send`, { headers: alice, body: { text: "alice says hello" } });
    assert.equal(sent.status, 200, sent.body);
    assert.ok(parseSse(sent.body).some((e) => e.type === "done"));
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/members`, { headers: alice, body: { username: "bob", role: "viewer" } })).status, 200);
    const denied = await http(gw.url, "GET", `/sessions/${id}/browser`, { headers: bob });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /browser pane is only visible to the owner/);
    const owner = await http(gw.url, "GET", `/sessions/${id}/browser`, { headers: alice });
    assert.equal(owner.status, 404);
  } finally {
    await gw.close();
    await fake.close();
  }
});
