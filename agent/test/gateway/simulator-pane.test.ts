import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startGateway } from "../../src/gateway/index.ts";
import { createSimulatorService } from "../../src/devices/simulator-service.ts";
import type { SimSpawn } from "../../src/devices/simulator-service.ts";
import { MSG_NEEDS_MAC, MSG_UNAVAILABLE } from "../../src/devices/simulator-mac.ts";
import type { SimExec } from "../../src/devices/simulator-mac.ts";
import { RemoteHub } from "../../src/remote/hub.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import { baseCfg, FakeProvider } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import type { FakeMind } from "./fake-mind.ts";
import { auth, fakeRuntime, http, parseSse, tmpStatic } from "./helpers.ts";
import { hostedRig } from "../sync/rig.ts";

const FIXTURE = readFileSync(fileURLToPath(new URL("../devices/fixtures/simctl-list.json", import.meta.url)), "utf8");
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgGBgcGBwgICAgICAkJCQoKCgkJCQkKCgoKCgoMDAwKCgoKCgoKDAwMDA0ODQ0NDA0ODg8PDxISEREVFRUZGR//xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAAAAEQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCNgKP/2Q==",
  "base64",
);
const PHONE = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

function darwinService() {
  const exec: SimExec = async (cmd, args) => {
    if (cmd === "xcode-select") return { code: 0, stdout: "/Applications/Xcode.app/Contents/Developer\n", stderr: "" };
    if (cmd === "xcrun" && args[0] === "--find") return { code: 0, stdout: "/usr/bin/simctl\n", stderr: "" };
    if (cmd === "xcrun" && args[1] === "list") return { code: 0, stdout: FIXTURE, stderr: "" };
    if (cmd === "which") return { code: 1, stdout: "", stderr: "" };
    if (args.includes("screenshot")) { writeFileSync(args[args.length - 1], JPEG); return { code: 0, stdout: "", stderr: "" }; }
    return { code: 0, stdout: "", stderr: "" };
  };
  const spawn: SimSpawn = () => ({ pid: 1, kill() {}, exited: Promise.resolve({ code: null, signal: "SIGINT" }) });
  return createSimulatorService({ platform: "darwin", exec, spawn, mediaDir: mkdtempSync(join(tmpdir(), "sim-pane-media-")), now: () => 2 });
}

function openSse(base: string, path: string, headers: Record<string, string>) {
  const u = new URL(base);
  return new Promise<{ status: number; waitFor: (re: RegExp, ms?: number) => Promise<string>; stop: () => void }>((resolve, reject) => {
    let buf = "";
    const waiters: { re: RegExp; done: (s: string) => void }[] = [];
    const pump = () => { for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].re.test(buf)) waiters.splice(i, 1)[0].done(buf); };
    const req = request({ host: u.hostname, port: u.port, method: "GET", path, headers }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => { buf += c; pump(); });
      resolve({
        status: res.statusCode ?? 0,
        waitFor(re, ms = 2000) {
          if (re.test(buf)) return Promise.resolve(buf);
          return new Promise((done, rej) => {
            const t = setTimeout(() => rej(new Error(`sse timeout ${re} ${JSON.stringify(buf.slice(0, 400))}`)), ms);
            waiters.push({ re, done: (s) => { clearTimeout(t); done(s); } });
          });
        },
        stop() { req.destroy(); },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function session(gw: { url: string; token: string }) {
  const open = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web" } });
  assert.equal(open.status, 200, open.body);
  return JSON.parse(open.body).sessionId as string;
}

test("local pane: state, boot, a jpeg frame, and an SSE snapshot; no auth is 401", async () => {
  const home = mkdtempSync(join(tmpdir(), "sim-gw-"));
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok"), simulator: darwinService(), simulatorFrameMs: 200 });
  try {
    assert.equal((await http(gw.url, "GET", "/sessions/x/simulator")).status, 401);
    const id = await session(gw);
    const headers = auth(gw.token);
    const st = await http(gw.url, "GET", `/sessions/${id}/simulator`, { headers });
    assert.equal(st.status, 200, st.body);
    const body = JSON.parse(st.body);
    assert.equal(body.available, true);
    assert.equal(body.devices.find((d: { udid: string }) => d.udid === PHONE).state, "Booted");
    const shot = await http(gw.url, "GET", `/sessions/${id}/simulator/frame`, { headers });
    assert.equal(shot.status, 200);
    assert.match(String(shot.headers["content-type"]), /jpeg/);
    const sse = await openSse(gw.url, `/sessions/${id}/simulator/stream`, headers);
    const snap = await sse.waitFor(/event: frame/);
    assert.match(snap, /event: snapshot/);
    sse.stop();
    const boot = await http(gw.url, "POST", `/sessions/${id}/simulator`, { headers, body: { action: "boot", udid: PHONE } });
    assert.equal(boot.status, 200, boot.body);
    assert.equal(JSON.parse(boot.body).ok, true);
    const rec = await http(gw.url, "POST", `/sessions/${id}/simulator`, { headers, body: { action: "record", udid: PHONE, op: "start" } });
    assert.equal(rec.status, 200, rec.body);
    assert.equal(JSON.parse(rec.body).recording, true);
    const stop = await http(gw.url, "POST", `/sessions/${id}/simulator`, { headers, body: { action: "record", op: "stop" } });
    assert.equal(stop.status, 200, stop.body);
    assert.equal(JSON.parse(stop.body).recording, false);
  } finally { await gw.close(); }
});

test("linux with no paired Mac: the pane says it needs a Mac and does not pretend to boot", { skip: process.platform === "darwin" && "these assert a gateway host that is not a Mac" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "sim-linux-"));
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok") });
  try {
    const headers = auth(gw.token);
    const devices = JSON.parse((await http(gw.url, "GET", "/devices", { headers })).body);
    assert.equal(devices.ios_simulator.available, false);
    assert.ok(devices.ios_simulator.note.includes(MSG_NEEDS_MAC));
    const id = await session(gw);
    const st = JSON.parse((await http(gw.url, "GET", `/sessions/${id}/simulator`, { headers })).body);
    assert.equal(st.available, false);
    assert.equal(st.note, MSG_UNAVAILABLE);
    const boot = await http(gw.url, "POST", `/sessions/${id}/simulator`, { headers, body: { action: "boot", name: "iPhone 16" } });
    assert.equal(boot.status, 409);
    assert.ok(boot.body.includes(MSG_NEEDS_MAC));
  } finally { await gw.close(); }
});

test("a paired Mac on the hub receives the pane's boot, and GET /devices says so", { skip: process.platform === "darwin" && "these assert a gateway host that is not a Mac" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "sim-route-"));
  const hub = new RemoteHub({ dir: home });
  hub.heartbeat("owner", { id: "d_" + "b".repeat(16), name: "Kitchen Mac", slugs: [], os: "mac", kind: "machine" });
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok"), simulatorHub: hub });
  try {
    const headers = auth(gw.token);
    const devices = JSON.parse((await http(gw.url, "GET", "/devices", { headers })).body);
    assert.match(devices.ios_simulator.note, /Paired Mac "Kitchen Mac" is registered \(online\)/);
    const id = await session(gw);
    const boot = await http(gw.url, "POST", `/sessions/${id}/simulator`, { headers, body: { action: "boot", name: "iPhone SE (3rd generation)" } });
    assert.equal(boot.status, 200, boot.body);
    const body = JSON.parse(boot.body);
    assert.equal(body.routed, true);
    assert.match(body.note, /Sent to Kitchen Mac/);
    const jobs = await hub.wait("owner", "d_" + "b".repeat(16), 0, new AbortController().signal);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].simulator?.action, "boot");
    const erase = await http(gw.url, "POST", `/sessions/${id}/simulator`, { headers, body: { action: "erase" } });
    assert.equal(erase.status, 400);
    const again = await hub.wait("owner", "d_" + "b".repeat(16), 0, new AbortController().signal);
    assert.equal(again.length, 0);
  } finally { await gw.close(); }
});

test("hosted deployment: the simulator pane and /devices are 404", async () => {
  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  const token = randomBytes(18).toString("hex");
  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: { token, allowedHosts: ["daebot.live", "localhost"] }, simulator: darwinService() });
  try {
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    const lr = await http(gw.url, "POST", "/login", { headers: H, body: { token } });
    assert.equal(lr.status, 200, lr.body);
    const cookie = String(([] as string[]).concat(lr.headers["set-cookie"] as string[])[0]).split(";")[0];
    const headers = { ...H, cookie };
    const open = await http(gw.url, "POST", "/sessions", { headers, body: { surface: "web" } });
    const id = JSON.parse(open.body).sessionId as string;
    assert.equal((await http(gw.url, "GET", "/devices", { headers })).status, 404);
    assert.equal((await http(gw.url, "GET", `/sessions/${id}/simulator`, { headers })).status, 404);
    assert.equal((await http(gw.url, "GET", `/sessions/${id}/simulator/stream`, { headers })).status, 404);
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/simulator`, { headers, body: { action: "boot" } })).status, 404);
  } finally { await gw.close(); }
});

const rnd = () => randomBytes(18).toString("hex");
const HOST = { host: "daebot.live", "x-forwarded-proto": "https" };
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) =>
  String(([] as string[]).concat(r.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];

test("a shared-thread guest cannot open the simulator pane", async () => {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake: FakeMind = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const dir = mkdtempSync(join(tmpdir(), "sim-guest-"));
  const provider = new FakeProvider([{ text: "hi" }]);
  const hostedOpts = { token: rnd(), allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const globalCap = new DailyCostCap(50);
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), DAEBOT_ADMINS: "nobody", MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const authCtx = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, cfg, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth: authCtx, sessionStore, sharedTtlMs: 0, simulator: darwinService() });
  const as = async (name: "alice" | "bob") => {
    const r = await http(gw.url, "POST", "/auth/key", { headers: HOST, body: { key: keys[name] } });
    assert.equal(r.status, 200, r.body);
    return { ...HOST, cookie: cookieOf(r) };
  };
  try {
    const alice = await as("alice");
    const bob = await as("bob");
    const opened = await http(gw.url, "POST", "/sessions", { headers: alice, body: { surface: "web" } });
    const id = JSON.parse(opened.body).sessionId as string;
    const sent = await http(gw.url, "POST", `/sessions/${id}/send`, { headers: alice, body: { text: "hello" } });
    assert.ok(parseSse(sent.body).some((e) => e.type === "done"));
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/members`, { headers: alice, body: { username: "bob", role: "viewer" } })).status, 200);
    const denied = await http(gw.url, "GET", `/sessions/${id}/simulator`, { headers: bob });
    assert.equal(denied.status, 403);
    assert.match(denied.body, /forbidden/);
    assert.equal((await http(gw.url, "GET", `/sessions/${id}/simulator/stream`, { headers: bob })).status, 403);
    const owner = await http(gw.url, "GET", `/sessions/${id}/simulator`, { headers: alice });
    assert.equal(owner.status, 404);
  } finally { await gw.close(); await fake.close(); }
});

test("POST /api/sync/simulator queues a job on the owner's paired Mac", async () => {
  const rig = await hostedRig();
  try {
    const mac = "d_" + "a".repeat(16);
    const poll = await rig.host(rig.keys.alice, "POST", "/api/sync/device/poll", { deviceId: mac, name: "Studio Mac", os: "mac", kind: "machine", wait: 0, bots: [] });
    assert.equal(poll.status, 200, poll.body);
    const queued = await rig.host(rig.keys.alice, "POST", "/api/sync/simulator", { sessionId: "sess-remote", action: "screenshot", args: { udid: PHONE } });
    assert.equal(queued.status, 200, queued.body);
    const body = JSON.parse(queued.body);
    assert.equal(body.ok, true);
    assert.equal(body.deviceName, "Studio Mac");
    const again = await rig.host(rig.keys.alice, "POST", "/api/sync/device/poll", { deviceId: mac, name: "Studio Mac", os: "mac", kind: "machine", wait: 0, bots: [] });
    const jobs = JSON.parse(again.body).jobs as { simulator?: { action: string; args: { udid: string } } }[];
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].simulator?.action, "screenshot");
    assert.equal(jobs[0].simulator?.args.udid, PHONE);
    const erased = await rig.host(rig.keys.alice, "POST", "/api/sync/simulator", { sessionId: "sess-remote", action: "erase", args: { udid: PHONE } });
    assert.equal(erased.status, 409);
    const linux = "d_" + "c".repeat(16);
    await rig.host(rig.keys.alice, "POST", "/api/sync/device/poll", { deviceId: linux, name: "Spare PC", os: "linux", kind: "machine", wait: 0, bots: [] });
    const stillMac = await rig.host(rig.keys.alice, "POST", "/api/sync/simulator", { sessionId: "sess-remote", action: "list", args: {} });
    assert.equal(JSON.parse(stillMac.body).deviceId, mac);
  } finally { await rig.close(); }
});
