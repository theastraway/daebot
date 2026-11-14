import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { startGateway } from "../../src/gateway/index.ts";
import { TerminalRegistry, terminalRegistry } from "../../src/tools/terminal.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import type { FakeMind } from "./fake-mind.ts";
import { auth, fakeRuntime, http, parseSse, tmpStatic } from "./helpers.ts";

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { write: (d: string) => boolean; end: () => void };
  kill: () => boolean;
}

function mockRegistry() {
  const children: FakeChild[] = [];
  const written: string[] = [];
  let live = 0;
  const spawn = () => {
    const child = new EventEmitter() as EventEmitter & FakeChild;
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      write(d: string) { written.push(String(d)); return true; },
      end() {},
    });
    child.kill = () => true;
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const reg = new TerminalRegistry({ spawn, platform: "win32", reapEveryMs: false, env: () => ({ SystemRoot: "C:\\Windows" }) });
  const orig = reg.subscribe.bind(reg);
  reg.subscribe = (owner, id, fn) => {
    live++;
    const un = orig(owner, id, fn);
    let on = true;
    return () => { if (!on) return; on = false; live--; un(); };
  };
  return { reg, children, written, subs: () => live };
}

async function localGateway(extra: { heartbeatMs?: number } = {}) {
  const mocked = mockRegistry();
  const home = mkdtempSync(join(tmpdir(), "mc-term-gw-"));
  const gw = await startGateway({
    runtime: fakeRuntime(),
    port: 0,
    staticDir: tmpStatic().dir,
    tokenPath: join(home, "tok"),
    terminals: mocked.reg,
    ...(extra.heartbeatMs ? { terminalHeartbeatMs: extra.heartbeatMs } : {}),
  });
  const headers = auth(gw.token);
  const openChat = async () => {
    const res = await http(gw.url, "POST", "/sessions", { headers, body: { surface: "web" } });
    assert.equal(res.status, 200, res.body);
    return JSON.parse(res.body).sessionId as string;
  };
  return { ...mocked, gw, headers, openChat };
}

function openSse(base: string, path: string, headers: Record<string, string>) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: () => string; waitFor: (re: RegExp, ms?: number) => Promise<string>; stop: () => void }>((resolve, reject) => {
    let buf = "";
    let settled = false;
    const waiters: { re: RegExp; done: (s: string) => void }[] = [];
    const pump = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (!waiters[i].re.test(buf)) continue;
        waiters.splice(i, 1)[0].done(buf);
      }
    };
    const req = request({ host: u.hostname, port: u.port, method: "GET", path, headers }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => { buf += c; pump(); });
      settled = true;
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => buf,
        waitFor(re, ms = 2000) {
          if (re.test(buf)) return Promise.resolve(buf);
          return new Promise((done, rej) => {
            const t = setTimeout(() => rej(new Error(`sse timeout for ${re}; got ${JSON.stringify(buf.slice(0, 500))}`)), ms);
            waiters.push({ re, done: (s) => { clearTimeout(t); done(s); } });
          });
        },
        stop() { req.destroy(); },
      });
    });
    req.on("error", (e) => { if (!settled) reject(e); });
    req.end();
  });
}

const named = (body: string) => body.split("\n\n").map((block) => {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return data.length ? { event, data: JSON.parse(data.join("\n")) } : null;
}).filter((x): x is { event: string; data: Record<string, unknown> } => !!x);

test("local gateway lists and peeks a chat's own terminal, and refuses every other one", async () => {
  const g = await localGateway();
  try {
    const a = await g.openChat();
    const b = await g.openChat();
    const info = g.reg.open(a, "C:\\work", "bash");
    g.children[0].stdout.emit("data", Buffer.from("0123456789"));
    const list = await http(g.gw.url, "GET", `/sessions/${a}/terminals`, { headers: g.headers });
    assert.equal(list.status, 200);
    const rows = JSON.parse(list.body).terminals;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, info.id);
    assert.equal(rows[0].shell, "bash");
    assert.equal(rows[0].cwd, "C:\\work");
    assert.equal(rows[0].status, "running");
    const otherList = JSON.parse((await http(g.gw.url, "GET", `/sessions/${b}/terminals`, { headers: g.headers })).body);
    assert.deepEqual(otherList.terminals, []);

    const peek = await http(g.gw.url, "GET", `/sessions/${a}/terminals/${info.id}?from=4`, { headers: g.headers });
    assert.equal(peek.status, 200);
    const body = JSON.parse(peek.body);
    assert.equal(body.text, "456789");
    assert.equal(body.total, 10);
    assert.equal(body.dropped, 0);
    assert.equal(body.info.id, info.id);
    const whole = JSON.parse((await http(g.gw.url, "GET", `/sessions/${a}/terminals/${info.id}`, { headers: g.headers })).body);
    assert.equal(whole.text, "0123456789");
    const read = await g.reg.read(a, info.id, { waitMs: 0 });
    assert.equal(read.text, "0123456789", "the pane's peek did not consume the agent's read");

    const stolen = await http(g.gw.url, "GET", `/sessions/${b}/terminals/${info.id}`, { headers: g.headers });
    assert.equal(stolen.status, 404);
    assert.match(stolen.body, /unknown/);
    const missingChat = await http(g.gw.url, "GET", "/sessions/no-such-chat/terminals", { headers: g.headers });
    assert.equal(missingChat.status, 404);
    assert.match(missingChat.body, /no such session/);
    const missingTerm = await http(g.gw.url, "GET", `/sessions/${a}/terminals/nope`, { headers: g.headers });
    assert.equal(missingTerm.status, 404);
    assert.match(missingTerm.body, /unknown/);
    assert.equal((await http(g.gw.url, "GET", `/sessions/${a}/terminals/${info.id}?from=no`, { headers: g.headers })).status, 400);
    assert.equal((await http(g.gw.url, "GET", "/sessions/a/terminals")).status, 401);

    const post = await http(g.gw.url, "POST", `/sessions/${a}/terminals/${info.id}`, { headers: g.headers, body: { text: "rm -rf /" } });
    assert.equal(post.status, 405);
    const put = await http(g.gw.url, "PUT", `/sessions/${a}/terminals`, { headers: g.headers, body: { text: "echo hi" } });
    assert.equal(put.status, 405);
    assert.deepEqual(g.written, [], "the pane has no way to write to the shell");
  } finally { await g.gw.close(); }
});

test("SSE sends a snapshot, then data and status, heartbeats, and unsubscribes when the client leaves", async () => {
  const g = await localGateway({ heartbeatMs: 40 });
  try {
    const id = await g.openChat();
    const info = g.reg.open(id, "C:\\work", "bash");
    g.children[0].stdout.emit("data", Buffer.from("hello\n"));
    const sse = await openSse(g.gw.url, `/sessions/${id}/terminals/${info.id}/stream`, g.headers);
    assert.equal(sse.status, 200);
    assert.match(String(sse.headers["content-type"]), /text\/event-stream/);
    const snap = await sse.waitFor(/event: snapshot/);
    const first = named(snap)[0];
    assert.equal(first.event, "snapshot");
    assert.equal(first.data.text, "hello\n");
    assert.equal(first.data.total, 6);
    assert.equal(g.subs(), 1);
    g.children[0].stdout.emit("data", Buffer.from("more"));
    const withData = await sse.waitFor(/event: data/);
    const data = named(withData).find((e) => e.event === "data");
    assert.deepEqual({ text: data?.data.text, total: data?.data.total }, { text: "more", total: 10 });
    await sse.waitFor(/: ping/);
    sse.stop();
    const start = Date.now();
    while (g.subs() !== 0 && Date.now() - start < 1000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(g.subs(), 0, "the client hanging up detaches the subscription");
    const wakesAtClose = g.subs();
    g.children[0].stdout.emit("data", Buffer.from("after-close"));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(g.subs(), wakesAtClose);

    const again = await openSse(g.gw.url, `/sessions/${id}/terminals/${info.id}/stream`, g.headers);
    await again.waitFor(/event: snapshot/);
    assert.equal(g.subs(), 1);
    g.children[0].emit("close", 9);
    const ended = await again.waitFor(/event: status/);
    const status = named(ended).find((e) => e.event === "status");
    assert.equal(status?.data.status, "exited");
    assert.equal(status?.data.exitCode, 9);
    const start2 = Date.now();
    while (g.subs() !== 0 && Date.now() - start2 < 1000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(g.subs(), 0, "the shell exiting ends the stream and detaches");
    again.stop();
  } finally { await g.gw.close(); }
});

test("SSE tells the pane when a burst overflowed the read cap, and a dead socket still detaches", async () => {
  const g = await localGateway({ heartbeatMs: 40 });
  try {
    const id = await g.openChat();
    const info = g.reg.open(id, "C:\\work", "bash");
    const sse = await openSse(g.gw.url, `/sessions/${id}/terminals/${info.id}/stream`, g.headers);
    await sse.waitFor(/event: snapshot/);
    assert.equal(g.subs(), 1);
    const flood = "y".repeat(80_000);
    g.children[0].stdout.emit("data", Buffer.from(flood));
    const body = await sse.waitFor(/event: data/);
    const data = named(body).find((e) => e.event === "data");
    assert.equal(typeof data?.data.text, "string");
    assert.ok(String(data?.data.text).endsWith("y"));
    assert.equal(String(data?.data.text).length, 30_000);
    assert.equal(data?.data.total, flood.length);
    assert.equal(data?.data.dropped, flood.length - 30_000);
    assert.doesNotMatch(String(data?.data.text), /<script>/);
    sse.stop();
    const start = Date.now();
    while (g.subs() !== 0 && Date.now() - start < 1000) await new Promise((r) => setTimeout(r, 20));
    assert.equal(g.subs(), 0);
  } finally { await g.gw.close(); }
});

test("hosted deployment: terminal routes and /devices are 404 for the signed-in owner and 401 with no login", async () => {
  const mocked = mockRegistry();
  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  const token = randomBytes(18).toString("hex");
  const gw = await startGateway({
    runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir,
    hosted: { token, allowedHosts: ["daebot.live", "localhost"] }, terminals: mocked.reg,
  });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    assert.equal((await http(gw.url, "GET", "/sessions/s/terminals", { headers: H })).status, 401);
    assert.equal((await http(gw.url, "GET", "/devices", { headers: H })).status, 401);
    const lr = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
    assert.equal(lr.status, 200);
    const cookie = String(([] as string[]).concat(lr.headers["set-cookie"] as string[])[0]).split(";")[0];
    const withToken = { ...H, cookie };
    const open = await http(gw.url, "POST", "/sessions", { headers: withToken, body: { surface: "web" } });
    assert.equal(open.status, 200, open.body);
    const id = JSON.parse(open.body).sessionId as string;
    const info = mocked.reg.open(id, "C:\\work", "bash");
    mocked.children[0].stdout.emit("data", Buffer.from("HOSTED_SCROLLBACK"));
    const list = await http(gw.url, "GET", `/sessions/${id}/terminals`, { headers: withToken });
    assert.equal(list.status, 404);
    assert.doesNotMatch(list.body, /HOSTED_SCROLLBACK/);
    const one = await http(gw.url, "GET", `/sessions/${id}/terminals/${info.id}`, { headers: withToken });
    assert.equal(one.status, 404);
    assert.doesNotMatch(one.body, /HOSTED_SCROLLBACK/);
    assert.equal((await http(gw.url, "GET", `/sessions/${id}/terminals/${info.id}/stream`, { headers: withToken })).status, 404);
  } finally { await gw.close(); }
});

const rnd = () => randomBytes(18).toString("hex");
const HOST = { host: "daebot.live", "x-forwarded-proto": "https" };
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) =>
  String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

test("a shared-thread guest is forbidden from terminal output; the owner on the hosted deployment gets 404", async () => {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake: FakeMind = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "daebot-term-share-"));
  const provider = new FakeProvider([{ text: "hi there" }]);
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "nobody", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const authCtx = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const mocked = mockRegistry();
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth: authCtx, sessionStore, sharedTtlMs: 0, terminals: mocked.reg });
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
    const info = mocked.reg.open(id, "/tmp", "bash");
    mocked.children[0].stdout.emit("data", Buffer.from("GUEST_MUST_NOT_SEE"));
    const hist = await http(gw.url, "GET", `/sessions/${id}/history`, { headers: bob });
    assert.equal(hist.status, 200, hist.body);
    const denied = await http(gw.url, "GET", `/sessions/${id}/terminals`, { headers: bob });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /forbidden/);
    assert.doesNotMatch(denied.body, /GUEST_MUST_NOT_SEE/);
    const deniedOne = await http(gw.url, "GET", `/sessions/${id}/terminals/${info.id}`, { headers: bob });
    assert.equal(deniedOne.status, 403);
    assert.doesNotMatch(deniedOne.body, /GUEST_MUST_NOT_SEE/);
    const deniedStream = await http(gw.url, "GET", `/sessions/${id}/terminals/${info.id}/stream`, { headers: bob });
    assert.equal(deniedStream.status, 403);
    const owner = await http(gw.url, "GET", `/sessions/${id}/terminals`, { headers: alice });
    assert.equal(owner.status, 404, "hosted has no shell to show, even to the owner");
    assert.doesNotMatch(owner.body, /GUEST_MUST_NOT_SEE/);
    assert.equal(mocked.subs(), 0);
  } finally {
    await gw.close();
    await fake.close();
  }
});

test("a gateway with no injected registry serves the shared terminalRegistry", { skip: process.platform === "win32" }, async () => {
  const reg = terminalRegistry();
  const home = mkdtempSync(join(tmpdir(), "mc-term-shared-"));
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok") });
  let id = "";
  let tid = "";
  try {
    const open = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web" } });
    id = JSON.parse(open.body).sessionId as string;
    const info = reg.open(id, process.cwd(), "bash");
    tid = info.id;
    const list = JSON.parse((await http(gw.url, "GET", `/sessions/${id}/terminals`, { headers: auth(gw.token) })).body);
    assert.equal(list.terminals.length, 1);
    assert.equal(list.terminals[0].id, tid);
    assert.equal(list.terminals[0].shell, "bash");
  } finally {
    if (id && tid) { try { reg.close(id, tid); } catch { /* already gone */ } }
    await gw.close();
  }
});
