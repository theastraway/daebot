import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createPtyHost, isLoopbackPeer, ptySpawnOptions, startPtyHost } from "../src/lib/pty-host.mjs";

const TOKEN = "pty-host-test-token";

function fakeSpawn() {
  const spawned = [];
  const spawnPty = (file, args, opts) => {
    const rec = { file, args, opts, written: [], killed: false, pid: 5100 + spawned.length };
    let onData = () => {};
    let onExit = () => {};
    rec.emit = (chunk) => onData(chunk);
    rec.exit = (code) => onExit({ exitCode: code, signal: 0 });
    const pty = {
      pid: rec.pid,
      write(data) { rec.written.push(data); },
      resize(cols, rows) { rec.size = { cols, rows }; },
      onData(fn) { onData = fn; },
      onExit(fn) { onExit = fn; },
      kill() { rec.killed = true; },
    };
    spawned.push(rec);
    return pty;
  };
  return { spawnPty, spawned };
}

async function authed(port, path, opts = {}) {
  const headers = { authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { ...opts, headers });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* sse or empty */ }
  return { status: res.status, body, text };
}

test("loopback and ConPTY options follow the platform", () => {
  assert.equal(isLoopbackPeer("127.0.0.1"), true);
  assert.equal(isLoopbackPeer("::1"), true);
  assert.equal(isLoopbackPeer("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackPeer("10.1.1.1"), false);
  assert.equal(isLoopbackPeer(""), false);
  const win = ptySpawnOptions("win32", 100, 40);
  assert.equal(win.useConpty, true);
  assert.equal(win.cols, 100);
  assert.equal(win.rows, 40);
  assert.equal(win.name, "xterm-256color");
  for (const platform of ["linux", "darwin"]) {
    const opt = ptySpawnOptions(platform);
    assert.equal(Object.hasOwn(opt, "useConpty"), false, platform);
    assert.equal(opt.cols, 80);
    assert.equal(opt.rows, 24);
  }
});

test("the host refuses a short token, a non-loopback peer, and a bad bearer", async () => {
  assert.throws(() => createPtyHost({ token: "short" }), /token/);
  const { spawnPty } = fakeSpawn();
  const host = createPtyHost({ token: TOKEN, spawnPty, platform: "linux" });
  const denied = await callHandle(host, { remote: "8.8.8.8", path: "/health" });
  assert.equal(denied.status, 403);
  const anon = await callHandle(host, { remote: "127.0.0.1", path: "/health", authorization: "" });
  assert.equal(anon.status, 401);
  const wrong = await callHandle(host, { remote: "127.0.0.1", path: "/health", authorization: "Bearer nope" });
  assert.equal(wrong.status, 401);
  await host.close();
});

function callHandle(host, { remote, path, authorization = `Bearer ${TOKEN}`, method = "GET" }) {
  const req = new EventEmitter();
  req.socket = { remoteAddress: remote };
  req.headers = authorization ? { authorization } : {};
  req.method = method;
  req.url = path;
  const res = {
    status: 0,
    body: "",
    headersSent: false,
    writeHead(status) { this.status = status; },
    end(data) { this.body = data ?? ""; },
  };
  return host.handle(req, res).then(() => ({ status: res.status, body: res.body ? JSON.parse(res.body) : {} }));
}

test("a fake pty opens, writes, resizes, streams, exits, and Windows asks for ConPTY", async () => {
  const { spawnPty, spawned } = fakeSpawn();
  const host = await startPtyHost({ token: TOKEN, spawnPty, platform: "win32" });
  try {
    const health = await authed(host.port, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true, backend: "pty", typeable: true, platform: "win32", conpty: true });
    assert.equal((await authed(host.port, "/health", { headers: { authorization: "Bearer wrong" } })).status, 401);

    const bad = await authed(host.port, "/sessions", { method: "POST", body: JSON.stringify({ id: "nope", file: "bash", args: [], cwd: "/tmp" }) });
    assert.equal(bad.status, 400);
    const shell = await authed(host.port, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "t1", file: "bash", args: ["--noprofile", "--norc", "-i"], cwd: "/work", cols: 90, rows: 30,
        env: { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-secret", TERM: "xterm-256color", OK: "yes" },
      }),
    });
    assert.equal(shell.status, 200, JSON.stringify(shell.body));
    assert.equal(shell.body.pid, 5100);
    assert.equal(spawned[0].opts.useConpty, true);
    assert.equal(spawned[0].opts.cols, 90);
    assert.equal(spawned[0].opts.env.OPENROUTER_API_KEY, undefined);
    assert.equal(spawned[0].opts.env.OK, "yes");
    assert.equal(spawned[0].opts.env.TERM, "xterm-256color");
    assert.equal(spawned[0].file, "bash");

    spawned[0].emit("prompt$ ");
    const stream = await fetch(`http://127.0.0.1:${host.port}/sessions/t1/stream`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const take = async (re) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !re.test(buf)) {
        const step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
      }
      assert.match(buf, re);
    };
    await take(/prompt\$/);
    const wrote = await authed(host.port, "/sessions/t1/write", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "ls\n" }),
    });
    assert.equal(wrote.status, 200);
    assert.deepEqual(spawned[0].written, ["ls\n"]);
    spawned[0].emit("README\n");
    await take(/README/);
    const sized = await authed(host.port, "/sessions/t1/resize", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: 120, rows: 40 }),
    });
    assert.equal(sized.status, 200);
    assert.deepEqual(spawned[0].size, { cols: 120, rows: 40 });
    const clamped = await authed(host.port, "/sessions/t1/resize", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: 1, rows: 10 }),
    });
    assert.equal(clamped.status, 200);
    assert.deepEqual(spawned[0].size, { cols: 2, rows: 10 }, "a too-small size is clamped, not applied raw");
    const missing = await authed(host.port, "/sessions/t1/resize", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: "wide", rows: 10 }),
    });
    assert.equal(missing.status, 400);
    spawned[0].exit(0);
    await take(/event: exit/);
    assert.match(buf, /"code":0/);
    assert.equal((await authed(host.port, "/sessions/t1/write", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: "x" }) })).status, 404);
    await reader.cancel().catch(() => {});
  } finally { await host.close(); }
});

test("unix spawn leaves useConpty unset, and kill drops the session", async () => {
  const { spawnPty, spawned } = fakeSpawn();
  const host = await startPtyHost({ token: TOKEN, spawnPty, platform: "linux" });
  try {
    const health = await authed(host.port, "/health");
    assert.equal(health.body.conpty, false);
    await authed(host.port, "/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t2", file: "zsh", args: [], cwd: "/tmp" }),
    });
    assert.equal(spawned.length, 0, "only the allow-listed shells start");
    const opened = await authed(host.port, "/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t2", file: "bash", args: ["-i"], cwd: "/tmp", cols: 80, rows: 24 }),
    });
    assert.equal(opened.status, 200);
    assert.equal(Object.hasOwn(spawned[0].opts, "useConpty"), false);
    const killed = await authed(host.port, "/sessions/t2/kill", { method: "POST" });
    assert.equal(killed.status, 200);
    assert.equal(spawned[0].killed, true);
    assert.equal((await authed(host.port, "/sessions/t2/stream")).status, 404);
  } finally { await host.close(); }
});

