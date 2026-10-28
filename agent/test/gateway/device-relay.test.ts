import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startGateway } from "../../src/gateway/index.ts";
import { DeviceRelay, parseCapabilities } from "../../src/gateway/device-relay.ts";
import { DailyCostCap } from "../../src/hosted.ts";
import { createAuthContext } from "../../src/auth/index.ts";
import { createRuntime } from "../../src/runtime.ts";
import { createFileStore } from "../../src/persist.ts";
import { BootCache } from "../../src/mind/boot-cache.ts";
import type { AgentEvent, AgentSession, DeviceReply, Runtime } from "../../src/types.ts";
import { FakeProvider, baseCfg, call } from "../core/helpers.ts";
import { startFakeMind } from "./fake-mind.ts";
import { auth, http, parseSse, tmpStatic } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = () => randomBytes(18).toString("hex");

// ---------------------------------------------------------------- the relay on its own

function relayRig() {
  const published: AgentEvent[] = [];
  let n = 0;
  const relay = new DeviceRelay({ newId: () => `d${++n}` });
  const bridge = relay.bridge({ sessionId: "s1", owner: "alice", publish: (ev) => { published.push(ev); } });
  return { relay, bridge, published };
}
const req = (op = "status", args: Record<string, unknown> = {}) => ({ tool: "apple_calendar", op, args });

test("relay round trip: the call is published as a device_call, the owner's answer resolves it", async () => {
  const { relay, bridge, published } = relayRig();
  const p = bridge.call(req("events", { start: "a", end: "b" }), { timeoutMs: 1000 });
  assert.deepEqual(published, [{ type: "device_call", id: "d1", tool: "apple_calendar", op: "events", args: { start: "a", end: "b" } }]);
  assert.equal(relay.isPending("d1"), true);
  assert.deepEqual(relay.answer({ sessionId: "s1", owner: "alice", body: { id: "d1", ok: true, result: [{ title: "x" }] } }), { ok: true });
  assert.deepEqual(await p, { ok: true, result: [{ title: "x" }] });
  assert.equal(relay.isPending("d1"), false);
  assert.equal(relay.size(), 0);
});

test("relay: a device error comes back as a plain sentence (clipped), flagged as a device error", async () => {
  const { relay, bridge } = relayRig();
  const p = bridge.call(req("calendars"), { timeoutMs: 1000 });
  relay.answer({ sessionId: "s1", owner: "alice", body: { id: "d1", ok: false, error: "Calendar access is off for Daebot. " + "x".repeat(900) } });
  const r = await p;
  assert.ok(!r.ok && r.code === "device" && r.error.startsWith("Calendar access is off for Daebot.") && r.error.length <= 500);
  const p2 = bridge.call(req(), { timeoutMs: 1000 });
  relay.answer({ sessionId: "s1", owner: "alice", body: { id: "d2", ok: false } });
  const r2 = await p2;
  assert.ok(!r2.ok && /could not run that request/.test(r2.error));
});

test("relay timeout: the call resolves as a timeout, the id expires, and a late answer is refused", async () => {
  const { relay, bridge } = relayRig();
  const r = await bridge.call(req("request"), { timeoutMs: 25 });
  assert.ok(!r.ok && r.code === "timeout");
  assert.equal(relay.size(), 0);
  const late = relay.answer({ sessionId: "s1", owner: "alice", body: { id: "d1", ok: true, result: {} } });
  assert.deepEqual(late, { ok: false, status: 404, error: "no such device request (already answered, expired, or not yours)" });
});

test("relay: only the owner of that session can answer; wrong owner, wrong session and unknown ids are refused and the call stays open", async () => {
  const { relay, bridge } = relayRig();
  const p = bridge.call(req(), { timeoutMs: 2000 });
  const body = { id: "d1", ok: true, result: { access: "granted" } };
  for (const [sessionId, owner, id] of [["s1", "bob", "d1"], ["s2", "alice", "d1"], ["s1", "alice", "nope"], ["s1", "alice", ""]] as const) {
    const r = relay.answer({ sessionId, owner, body: { ...body, id } });
    assert.ok(!r.ok && r.status === 404, `${sessionId}/${owner}/${id}`);
  }
  assert.equal(relay.isPending("d1"), true, "still waiting for its real owner");
  assert.ok(relay.answer({ sessionId: "s1", owner: "alice", body }).ok);
  assert.deepEqual(await p, { ok: true, result: { access: "granted" } });
  // an id answers once
  assert.ok(!relay.answer({ sessionId: "s1", owner: "alice", body }).ok);
});

test("relay: a malformed or oversized answer is refused and does not settle the call", async () => {
  const { relay, bridge } = relayRig();
  const p = bridge.call(req(), { timeoutMs: 2000 });
  const bad = relay.answer({ sessionId: "s1", owner: "alice", body: { id: "d1", ok: "yes" } });
  assert.ok(!bad.ok && bad.status === 400);
  const big = relay.answer({ sessionId: "s1", owner: "alice", body: { id: "d1", ok: true, result: "x".repeat(1_000_000) } });
  assert.ok(!big.ok && big.status === 413);
  assert.equal(relay.isPending("d1"), true);
  relay.answer({ sessionId: "s1", owner: "alice", body: { id: "d1", ok: true, result: null } });
  assert.deepEqual(await p, { ok: true, result: null });
});

test("relay: stopping the turn, ending it, or a failing publish leaves nothing waiting", async () => {
  const { relay, bridge } = relayRig();
  const ac = new AbortController();
  const p = bridge.call(req(), { timeoutMs: 5000, signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.ok(!r.ok && r.code === "aborted");
  const pre = await bridge.call(req(), { timeoutMs: 5000, signal: ac.signal });
  assert.ok(!pre.ok && pre.code === "aborted", "an already-stopped turn does not even ask the device");
  const waiting = bridge.call(req(), { timeoutMs: 5000 });
  relay.endSession("s1");
  const ended = await waiting;
  assert.ok(!ended.ok && ended.code === "closed");
  const broken = new DeviceRelay().bridge({ sessionId: "s", owner: "o", publish: () => { throw new Error("stream gone"); } });
  const b = await broken.call(req(), { timeoutMs: 5000 });
  assert.ok(!b.ok && b.code === "device");
  assert.equal(relay.size(), 0);
});

test("relay: a session cannot pile up more than 8 unanswered device requests", async () => {
  const { relay, bridge } = relayRig();
  const open = Array.from({ length: 8 }, () => bridge.call(req(), { timeoutMs: 5000 }));
  const ninth = await bridge.call(req(), { timeoutMs: 5000 });
  assert.ok(!ninth.ok && /Too many device requests/.test(ninth.error));
  relay.endSession("s1");
  await Promise.all(open);
});

test("capabilities in a send body: known names only, once each", () => {
  assert.deepEqual(parseCapabilities(["apple_calendar", "apple_calendar", "root_shell", 7, null]), ["apple_calendar"]);
  assert.deepEqual(parseCapabilities("apple_calendar"), []);
  assert.deepEqual(parseCapabilities(undefined), []);
});

// ---------------------------------------------------------------- through the gateway (local token auth)

/** A runtime whose turn asks the device for events and prints what came back. */
function deviceRuntime(log: { caps: unknown; hasDevice: boolean }[], timeoutMs = 4000): Runtime {
  return {
    async openSession(o: { surface: string; resumeId?: string }): Promise<AgentSession> {
      return {
        id: o.resumeId ?? "dev-1", surface: o.surface, violations: () => [], close: async () => {},
        async *send(_msg, so) {
          log.push({ caps: so?.capabilities, hasDevice: !!so?.device });
          if (so?.device) {
            const r: DeviceReply = await so.device.call({ tool: "apple_calendar", op: "events", args: { start: "s", end: "e" } }, { timeoutMs, signal: so.signal });
            yield { type: "text", delta: `device said ${JSON.stringify(r)}` };
          } else yield { type: "text", delta: "no device" };
          yield { type: "done", finalText: "x" };
        },
      };
    },
    listSessions: () => [],
  };
}

async function bootLocal(log: Parameters<typeof deviceRuntime>[0], timeoutMs?: number) {
  const st = tmpStatic();
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const gw = await startGateway({ runtime: deviceRuntime(log, timeoutMs), port: 0, staticDir: st.dir, tokenPath: join(home, "tok") });
  const open = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web", title: "t" } });
  return { gw, id: JSON.parse(open.body).sessionId as string, H: auth(gw.token) };
}

/** Starts a send and resolves { done, deviceCall } as soon as the stream carries the device_call. */
function startSend(base: string, id: string, H: Record<string, string>, body: Record<string, unknown>) {
  let acc = "";
  let found!: (id: string) => void;
  const deviceCall = new Promise<string>((r) => { found = r; });
  const done = http(base, "POST", `/sessions/${id}/send`, { headers: H, body, onChunk: (c) => { acc += c; const m = /"type":"device_call","id":"([^"]+)"/.exec(acc); if (m) found(m[1]); } });
  return { done, deviceCall };
}

test("gateway: a send that lists apple_calendar gets a device_call on its stream; the answer posted to device-result resumes the turn", async () => {
  const log: { caps: unknown; hasDevice: boolean }[] = [];
  const { gw, id, H } = await bootLocal(log);
  try {
    const s = startSend(gw.url, id, H, { text: "what is on my calendar today", capabilities: ["apple_calendar"] });
    const callId = await s.deviceCall;
    assert.deepEqual(log, [{ caps: ["apple_calendar"], hasDevice: true }]);
    const post = (body: unknown) => http(gw.url, "POST", `/sessions/${id}/device-result`, { headers: H, body });
    assert.equal((await post({ id: "not-a-real-id", ok: true, result: [] })).status, 404, "unknown id refused");
    assert.equal((await post({ id: callId, ok: "yes" })).status, 400);
    const events = [{ id: "e1", title: "Dentist" }];
    assert.equal((await post({ id: callId, ok: true, result: events })).status, 200);
    assert.equal((await post({ id: callId, ok: true, result: events })).status, 404, "an id answers once");
    const res = await s.done;
    const evs = parseSse(res.body);
    assert.ok(evs.some((e) => e.type === "device_call" && e.tool === "apple_calendar" && e.op === "events"));
    const text = evs.filter((e) => e.type === "text").map((e: any) => e.delta).join("");
    assert.equal(text, `device said ${JSON.stringify({ ok: true, result: events })}`);
    assert.ok(evs.some((e) => e.type === "done"));
    // a page that re-attaches after the answer is not handed the old request again
    const again = await http(gw.url, "GET", `/sessions/${id}/events?after=0`, { headers: H });
    assert.ok(!again.body.includes("device_call"), "an answered device_call is never replayed");
    assert.ok(again.body.includes("device said"));
  } finally { await gw.close(); }
});

test("gateway: a send without the capability gets no relay at all", async () => {
  const log: { caps: unknown; hasDevice: boolean }[] = [];
  const { gw, id, H } = await bootLocal(log);
  try {
    for (const body of [{ text: "plain web" }, { text: "bogus", capabilities: ["root_shell"] }, { text: "wrong type", capabilities: "apple_calendar" }]) {
      const res = await http(gw.url, "POST", `/sessions/${id}/send`, { headers: H, body });
      assert.ok(parseSse(res.body).some((e: any) => e.type === "text" && e.delta === "no device"));
    }
    assert.deepEqual(log, Array(3).fill({ caps: undefined, hasDevice: false }));
  } finally { await gw.close(); }
});

test("gateway: a still-open device_call is replayed to a page that re-attaches mid-turn, and answering it from there works", async () => {
  const log: { caps: unknown; hasDevice: boolean }[] = [];
  const { gw, id, H } = await bootLocal(log);
  try {
    const first = startSend(gw.url, id, H, { text: "calendar", capabilities: ["apple_calendar"] });
    const callId = await first.deviceCall;
    let acc = "";
    const reattach = http(gw.url, "GET", `/sessions/${id}/events?after=0`, { headers: H, onChunk: (c) => { acc += c; } });
    await sleep(150);
    assert.ok(acc.includes(`"id":"${callId}"`), "the pending request is replayed");
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/device-result`, { headers: H, body: { id: callId, ok: true, result: [] } })).status, 200);
    await Promise.all([first.done, reattach]);
  } finally { await gw.close(); }
});

test("gateway: when nobody answers, the tool gets a timeout, not a hang", async () => {
  const log: { caps: unknown; hasDevice: boolean }[] = [];
  const { gw, id, H } = await bootLocal(log, 60);
  try {
    const res = await http(gw.url, "POST", `/sessions/${id}/send`, { headers: H, body: { text: "calendar", capabilities: ["apple_calendar"] } });
    const text = parseSse(res.body).filter((e) => e.type === "text").map((e: any) => e.delta).join("");
    assert.match(text, /"code":"timeout"/);
  } finally { await gw.close(); }
});

test("gateway: stopping the turn stops the wait for the device", async () => {
  const log: { caps: unknown; hasDevice: boolean }[] = [];
  const { gw, id, H } = await bootLocal(log, 20_000);
  try {
    const s = startSend(gw.url, id, H, { text: "calendar", capabilities: ["apple_calendar"] });
    const callId = await s.deviceCall;
    assert.equal(JSON.parse((await http(gw.url, "POST", `/sessions/${id}/abort`, { headers: H })).body).aborted, true);
    const res = await s.done;
    assert.match(parseSse(res.body).filter((e) => e.type === "text").map((e: any) => e.delta).join(""), /"code":"aborted"/);
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/device-result`, { headers: H, body: { id: callId, ok: true, result: [] } })).status, 404, "late answer refused");
  } finally { await gw.close(); }
});

// ---------------------------------------------------------------- hosted, two users, the real runtime and tool

async function hostedRig(provider: FakeProvider) {
  const keys = { alice: "mind_" + rnd(), bob: "mind_" + rnd() };
  const fake = await startFakeMind({ [keys.alice]: "alice", [keys.bob]: "bob" });
  const st = tmpStatic();
  for (const [f, c] of [["login.html", "<!doctype html><title>login</title>"], ["login.js", "export {}"], ["login.css", "body{}"], ["favicon.svg", "<svg/>"]]) writeFileSync(join(st.dir, f), c);
  const token = rnd();
  const dir = mkdtempSync(join(tmpdir(), "daebot-device-"));
  const hostedOpts = { token, allowedHosts: ["daebot.live", "localhost"] };
  const cfg = baseCfg({ mindBaseUrl: fake.base, mindApiKey: "server-owner-key-" + rnd() });
  const globalCap = new DailyCostCap(50);
  const sessionStore = createFileStore(dir);
  const bootCache = new BootCache();
  const ownerRuntime = createRuntime(cfg, { provider, store: sessionStore, bootCache, hosted: { dailyUsdCap: 50, sharedCap: globalCap, exempt: true } });
  const env: NodeJS.ProcessEnv = { DATA_DIR: dir, DAEBOT_SECRET_KEY: rnd() + rnd(), MIND_OAUTH_BASE_URL: fake.url, DAEBOT_PUBLIC_URL: "https://daebot.live" };
  const a = createAuthContext({ env, cfg, hosted: hostedOpts, ownerRuntime, globalCap, provider, sessionStore, bootCache });
  const gw = await startGateway({ runtime: ownerRuntime, port: 0, host: "127.0.0.1", staticDir: st.dir, hosted: hostedOpts, auth: a, sessionStore });
  const H = { host: "daebot.live", "x-forwarded-proto": "https" };
  const login = async (key: string) => {
    const res = await http(gw.url, "POST", "/auth/key", { headers: H, body: { key } });
    assert.equal(res.status, 200, res.body);
    const cookie = String(([] as string[]).concat(res.headers["set-cookie"] as string[]).find((c) => c.startsWith("mc_session="))).split(";")[0];
    return { ...H, cookie };
  };
  return { gw, keys, login, close: async () => { await gw.close(); await fake.close(); } };
}

test("hosted, end to end: the real apple_calendar tool asks the device; another user's answer is refused (403) and only the owner's resumes the turn", async () => {
  const provider = new FakeProvider([{ calls: [call("c1", "apple_calendar", { action: "status" })] }, { text: "Access is on." }]);
  const r = await hostedRig(provider);
  try {
    const A = await r.login(r.keys.alice);
    const B = await r.login(r.keys.bob);
    const sid = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: A, body: { surface: "web", title: "cal" } })).body).sessionId as string;
    const s = startSend(r.gw.url, sid, A, { text: "what is on my calendar today", capabilities: ["apple_calendar"] });
    const callId = await s.deviceCall;
    // bob cannot answer alice's request, by id or by guessing
    assert.equal((await http(r.gw.url, "POST", `/sessions/${sid}/device-result`, { headers: B, body: { id: callId, ok: true, result: { access: "granted" } } })).status, 403);
    // alice answers (a fake device)
    assert.equal((await http(r.gw.url, "POST", `/sessions/${sid}/device-result`, { headers: A, body: { id: callId, ok: true, result: { access: "granted", timeZone: "America/New_York" } } })).status, 200);
    const evs = parseSse((await s.done).body);
    const call1 = evs.find((e) => e.type === "device_call") as any;
    assert.deepEqual([call1.tool, call1.op, call1.args], ["apple_calendar", "status", {}]);
    assert.ok(evs.some((e) => e.type === "toolEnd" && (e as any).tool === "apple_calendar" && (e as any).ok === true));
    assert.ok(evs.some((e) => e.type === "text" && (e as any).delta === "Access is on."));
    // the model saw the device's answer
    const toolMsg = provider.requests[1].messages.filter((m) => m.role === "tool").at(-1)!.content;
    assert.match(toolMsg, /"access":"granted"/);
    assert.match(toolMsg, /America\/New_York/);
    // the tool was offered because the send listed the capability
    assert.ok(provider.requests[0].tools.some((t) => t.name === "apple_calendar"));
  } finally { await r.close(); }
});

test("hosted, end to end: a turn WITHOUT the capability is never offered the tool and the model is told what to say", async () => {
  const provider = new FakeProvider([{ text: "Apple Calendar works in the Daebot iPhone and Mac apps." }]);
  const r = await hostedRig(provider);
  try {
    const A = await r.login(r.keys.alice);
    const sid = JSON.parse((await http(r.gw.url, "POST", "/sessions", { headers: A, body: { surface: "web", title: "cal" } })).body).sessionId as string;
    const res = await http(r.gw.url, "POST", `/sessions/${sid}/send`, { headers: A, body: { text: "what is on my calendar today" } });
    assert.equal(res.status, 200);
    const evs = parseSse(res.body);
    assert.ok(!evs.some((e) => e.type === "device_call"));
    assert.ok(!provider.requests[0].tools.some((t) => t.name === "apple_calendar"), "not offered");
    assert.match(String(provider.requests[0].messages[0].content), /Apple Calendar works in the Daebot iPhone and Mac apps\./);
    assert.ok(evs.some((e) => e.type === "text" && /works in the Daebot iPhone and Mac apps/.test((e as any).delta)));
  } finally { await r.close(); }
});
