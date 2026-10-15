import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway, registerWebhook } from "../../src/gateway/index.ts";
import type { AgentEvent, ServerFrame } from "../../src/types.ts";
import { auth, defaultScript, fakeRuntime, http, maskedFrame, parseSse, tmpStatic, waitAbort, wsConnect } from "./helpers.ts";

async function boot(opts: Parameters<typeof fakeRuntime>[0] = {}) {
  const runtime = fakeRuntime(opts);
  const st = tmpStatic();
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const gw = await startGateway({ runtime, port: 0, staticDir: st.dir, tokenPath: join(home, "tok") });
  return { gw, runtime, st, home };
}

test("token file is created 0600 with 32 random bytes hex under a temp HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir });
    const p = join(home, ".mindclaw", "gateway-token");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.match(readFileSync(p, "utf8").trim(), /^[0-9a-f]{64}$/);
    assert.equal(gw.token, readFileSync(p, "utf8").trim());
    await gw.close();
    // second start reuses the same token
    const gw2 = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir });
    assert.equal(gw2.token, gw.token);
    await gw2.close();
  } finally {
    process.env.HOME = prev;
  }
});

test("auth: health is open, everything else needs the bearer token", async () => {
  const { gw } = await boot();
  try {
    assert.equal((await http(gw.url, "GET", "/health")).status, 200);
    assert.equal((await http(gw.url, "GET", "/sessions")).status, 401);
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: auth("wrong") })).status, 401);
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: auth(gw.token) })).status, 200);
    assert.equal((await http(gw.url, "POST", "/sessions", { body: {} })).status, 401);
    // no permissive CORS
    const r = await http(gw.url, "GET", "/health");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
    // ?token= is NOT accepted on plain HTTP routes
    assert.equal((await http(gw.url, "GET", `/sessions?token=${gw.token}`)).status, 401);
  } finally { await gw.close(); }
});

test("Host header must be loopback (DNS rebinding) and Origin must be loopback", async () => {
  const { gw } = await boot();
  try {
    for (const h of ["evil.example", "evil.example:80", "127.0.0.1.evil.com"]) {
      assert.equal((await http(gw.url, "GET", "/health", { headers: { host: h } })).status, 403, h);
      assert.equal((await http(gw.url, "GET", "/sessions", { headers: { host: h, ...auth(gw.token) } })).status, 403, h);
    }
    for (const h of ["localhost:1234", "127.0.0.1:1", "[::1]:9"]) {
      assert.equal((await http(gw.url, "GET", "/health", { headers: { host: h } })).status, 200, h);
    }
    assert.equal((await http(gw.url, "POST", "/sessions", { headers: { ...auth(gw.token), origin: "https://evil.example" }, body: {} })).status, 403);
  } finally { await gw.close(); }
});

test("SSE send streams events in order and ends with done", async () => {
  const { gw } = await boot();
  try {
    const open = await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: { surface: "web", title: "t" } });
    const { sessionId } = JSON.parse(open.body);
    assert.ok(sessionId);
    const r = await http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: auth(gw.token), body: { text: "hi" } });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /text\/event-stream/);
    const evs = parseSse(r.body);
    assert.deepEqual(evs.map((e) => e.type), ["text", "toolStart", "toolEnd", "gate", "usage", "done"]);
    // next turn works after done
    const r2 = await http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: auth(gw.token), body: { text: "again" } });
    assert.equal(parseSse(r2.body).at(-1)?.type, "done");
    // validation
    assert.equal((await http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: auth(gw.token), body: { text: "" } })).status, 400);
    assert.equal((await http(gw.url, "POST", `/sessions/nope/send`, { headers: auth(gw.token), body: { text: "x" } })).status, 404);
    const list = JSON.parse((await http(gw.url, "GET", "/sessions", { headers: auth(gw.token) })).body);
    assert.equal(list.sessions[0].id, sessionId);
  } finally { await gw.close(); }
});

test("concurrent send returns 409; abort ends the busy turn with done", async () => {
  async function* slow(_m: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { type: "text", delta: "working" };
    await waitAbort(signal);
    if (signal?.aborted) return; // runtime stops without done; gateway must synthesize it
    yield { type: "done", finalText: "" };
  }
  const { gw } = await boot({ script: slow });
  try {
    const { sessionId } = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: {} })).body);
    let started!: () => void;
    const gotFirst = new Promise<void>((r) => (started = r));
    const first = http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: auth(gw.token), body: { text: "a" }, onChunk: (c) => { if (c.includes("working")) started(); } });
    await gotFirst;
    const second = await http(gw.url, "POST", `/sessions/${sessionId}/send`, { headers: auth(gw.token), body: { text: "b" } });
    assert.equal(second.status, 409);
    const ab = await http(gw.url, "POST", `/sessions/${sessionId}/abort`, { headers: auth(gw.token) });
    assert.deepEqual(JSON.parse(ab.body), { aborted: true });
    const r = await first;
    const evs = parseSse(r.body);
    assert.equal(evs.at(-1)?.type, "done");
    assert.ok(evs.some((e) => e.type === "notice" && /abort/i.test(e.text)));
    // idle again: abort is a no-op, and a new turn is accepted
    assert.deepEqual(JSON.parse((await http(gw.url, "POST", `/sessions/${sessionId}/abort`, { headers: auth(gw.token) })).body), { aborted: false });
  } finally { await gw.close(); }
});

test("violations route and DELETE closes the session", async () => {
  const { gw, runtime } = await boot();
  try {
    const { sessionId } = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: {} })).body);
    const v = JSON.parse((await http(gw.url, "GET", `/sessions/${sessionId}/violations`, { headers: auth(gw.token) })).body);
    assert.equal(v.violations[0].gate, "receipt");
    assert.equal((await http(gw.url, "DELETE", `/sessions/${sessionId}`, { headers: auth(gw.token) })).status, 200);
    assert.deepEqual(runtime.closed, [sessionId]);
    assert.equal((await http(gw.url, "GET", `/sessions/${sessionId}/violations`, { headers: auth(gw.token) })).status, 404);
  } finally { await gw.close(); }
});

test("static: serves files, blocks traversal and dotfiles", async () => {
  const { gw } = await boot();
  try {
    const idx = await http(gw.url, "GET", "/");
    assert.equal(idx.status, 200);
    assert.match(String(idx.headers["content-type"]), /text\/html/);
    assert.match(String(idx.headers["content-security-policy"]), /default-src 'self'/);
    assert.match(String((await http(gw.url, "GET", "/app.js")).headers["content-type"]), /javascript/);
    assert.match(String((await http(gw.url, "GET", "/style.css")).headers["content-type"]), /text\/css/);
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/%2E%2E%2Fpackage.json", "/..%2fpackage.json", "/a/../../package.json", "/.secret", "/%2esecret", "/.git/config", "/.git%2fconfig", "/app.js%00.png", "/%5c..%5cpackage.json", "/nope"]) {
      const r = await http(gw.url, "GET", p);
      assert.ok(r.status === 404 || r.status === 403 || r.status === 400, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes("secret"), p);
    }
    assert.equal((await http(gw.url, "POST", "/index.html", { body: {} })).status, 405);
  } finally { await gw.close(); }
});

test("one-time cookie from /?token= authorizes later API calls", async () => {
  const { gw } = await boot();
  try {
    const bad = await http(gw.url, "GET", "/?token=nope");
    assert.equal(bad.headers["set-cookie"], undefined);
    const r = await http(gw.url, "GET", `/?token=${gw.token}`);
    const cookie = String((r.headers["set-cookie"] as string[])[0]);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const pair = cookie.split(";")[0];
    assert.equal((await http(gw.url, "GET", "/sessions", { headers: { cookie: pair } })).status, 200);
  } finally { await gw.close(); }
});

test("webhooks: token by default, open only when the adapter opts out", async () => {
  const { gw } = await boot();
  const seen: string[] = [];
  const off1 = registerWebhook("sendblue", (req) => { seen.push(`${req.channel}:${req.text}:${req.query.x}`); return { status: 202, body: { ok: true } }; }, { auth: "none" });
  const off2 = registerWebhook("guarded", () => ({ body: "hi" }));
  try {
    const r = await http(gw.url, "POST", "/hooks/sendblue?x=1", { body: { a: 1 } });
    assert.equal(r.status, 202);
    assert.deepEqual(seen, ['sendblue:{"a":1}:1']);
    assert.equal((await http(gw.url, "POST", "/hooks/guarded", { body: {} })).status, 401);
    const g = await http(gw.url, "POST", "/hooks/guarded", { headers: auth(gw.token), body: {} });
    assert.equal(g.status, 200);
    assert.equal(g.body, "hi");
    assert.equal((await http(gw.url, "POST", "/hooks/unknown", { headers: auth(gw.token), body: {} })).status, 404);
  } finally { off1(); off2(); await gw.close(); }
});

test("WebSocket: auth, handshake, round trip, masked + fragmented client frames, ping/pong", async () => {
  const { gw } = await boot();
  try {
    assert.equal((await wsConnect(gw.url, "/ws").catch(() => ({ status: -1 }))).status, 401);
    assert.equal((await wsConnect(gw.url, `/ws?token=wrong`).catch(() => ({ status: -1 }))).status, 401);
    assert.equal((await wsConnect(gw.url, `/ws?token=${gw.token}`, { Origin: "https://evil.example" }).catch(() => ({ status: -1 }))).status, 403);
    assert.equal((await wsConnect(gw.url, `/ws?token=${gw.token}`, { Host: "evil.example" }).catch(() => ({ status: -1 }))).status, 403);

    const c = await wsConnect(gw.url, "/ws", auth(gw.token)); // header auth also works
    assert.equal(c.status, 101);
    const text = (f: { payload: Buffer }) => JSON.parse(f.payload.toString("utf8")) as ServerFrame;

    c.sendText(JSON.stringify({ t: "open", surface: "web", title: "ws" }));
    const opened = text(await c.waitFor((f) => f.opcode === 1 && text(f).t === "opened"));
    assert.equal(opened.t, "opened");
    const sessionId = (opened as { sessionId: string }).sessionId;

    // fragmented + masked: split one JSON text message into 3 frames (text, continuation, continuation)
    const msg = Buffer.from(JSON.stringify({ t: "send", sessionId, text: "héllo wörld" }));
    const a = msg.subarray(0, 7), b = msg.subarray(7, 20), d = msg.subarray(20);
    c.socket.write(maskedFrame(0x1, a, false));
    c.socket.write(maskedFrame(0x0, b, false));
    c.socket.write(maskedFrame(0x0, d, true));
    const done = await c.waitFor((f) => f.opcode === 1 && (() => { const s = text(f); return s.t === "event" && s.event.type === "done"; })());
    assert.equal(text(done).t, "event");
    const types = c.frames.filter((f) => f.opcode === 1).map(text).filter((s) => s.t === "event").map((s) => (s as { event: AgentEvent }).event.type);
    assert.deepEqual(types, ["text", "toolStart", "toolEnd", "gate", "usage", "done"]);

    // ping -> pong with payload echoed
    c.socket.write(maskedFrame(0x9, Buffer.from("pp")));
    const pong = await c.waitFor((f) => f.opcode === 0xa);
    assert.equal(pong.payload.toString(), "pp");

    // 16-bit length frame (payload > 125 bytes) still parsed
    c.sendText(JSON.stringify({ t: "send", sessionId: "none", text: "x".repeat(300) }));
    const err = text(await c.waitFor((f) => f.opcode === 1 && text(f).t === "error"));
    assert.equal((err as { message: string }).message, "no such session");

    // bad JSON is answered with an error frame, connection stays up
    c.sendText("not json");
    await c.waitFor((f) => f.opcode === 1 && (text(f) as { message?: string }).message === "invalid JSON frame");

    // close handshake
    c.socket.write(maskedFrame(0x8, Buffer.from([0x03, 0xe8])));
    const closeFrame = await c.waitFor((f) => f.opcode === 8);
    assert.equal(closeFrame.payload.readUInt16BE(0), 1000);
    c.close();
  } finally { await gw.close(); }
});

test("WebSocket: unmasked client frame is a protocol error (1002); oversize is 1009", async () => {
  const { gw } = await boot();
  try {
    const c = await wsConnect(gw.url, `/ws?token=${gw.token}`);
    c.socket.write(Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from("hi")])); // unmasked
    const cf = await c.waitFor((f) => f.opcode === 8);
    assert.equal(cf.payload.readUInt16BE(0), 1002);
    c.close();

    const c2 = await wsConnect(gw.url, `/ws?token=${gw.token}`);
    c2.socket.write(maskedFrame(0x1, Buffer.alloc(2 * 1024 * 1024, 0x61)));
    const cf2 = await c2.waitFor((f) => f.opcode === 8);
    assert.equal(cf2.payload.readUInt16BE(0), 1009);
    c2.close();
  } finally { await gw.close(); }
});

test("WebSocket: busy session returns an error frame; abort frame stops the turn", async () => {
  async function* slow(_m: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { type: "text", delta: "go" };
    await waitAbort(signal);
  }
  const { gw } = await boot({ script: slow });
  try {
    const c = await wsConnect(gw.url, `/ws?token=${gw.token}`);
    const text = (f: { payload: Buffer }) => JSON.parse(f.payload.toString("utf8")) as ServerFrame;
    c.sendText(JSON.stringify({ t: "open", surface: "web" }));
    const sessionId = (text(await c.waitFor((f) => text(f).t === "opened")) as { sessionId: string }).sessionId;
    c.sendText(JSON.stringify({ t: "send", sessionId, text: "one" }));
    await c.waitFor((f) => { const s = text(f); return s.t === "event" && s.event.type === "text"; });
    c.sendText(JSON.stringify({ t: "send", sessionId, text: "two" }));
    const busy = text(await c.waitFor((f) => text(f).t === "error"));
    assert.match((busy as { message: string }).message, /busy/);
    c.sendText(JSON.stringify({ t: "abort", sessionId }));
    await c.waitFor((f) => { const s = text(f); return s.t === "event" && s.event.type === "done"; });
    c.close();
  } finally { await gw.close(); }
});

test("idle sweep closes sessions after the idle window", async () => {
  const runtime = fakeRuntime();
  const home = mkdtempSync(join(tmpdir(), "mc-home-"));
  const gw = await startGateway({ runtime, port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "t"), idleMs: 1 });
  try {
    const { sessionId } = JSON.parse((await http(gw.url, "POST", "/sessions", { headers: auth(gw.token), body: {} })).body);
    await new Promise((r) => setTimeout(r, 20));
    const { SessionManager } = await import("../../src/gateway/sessions.ts");
    const m = new SessionManager(runtime, { idleMs: 1, sweepMs: 3_600_000 });
    const ls = await m.open({ surface: "web" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await m.sweep(), 1);
    assert.ok(runtime.closed.includes(ls.id));
    await m.closeAll();
    void sessionId; void defaultScript;
  } finally { await gw.close(); }
});
