import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TerminalRegistry, createTerminalTool, isIrreversibleShell, shellSpec } from "../../src/tools/terminal.ts";
import type { TermBackend, TermHandle, TermSpawnSpec } from "../../src/tools/terminal.ts";
import { announcePty, attachPtyBackend, createPtyBackend, isLoopbackPeer, withTerminalBackend } from "../../src/devices/pty-bridge.ts";
import { deviceSupport } from "../../src/devices/index.ts";
import { terminalsApi } from "../../src/gateway/terminals.ts";
import type { TerminalCtx } from "../../src/gateway/terminals.ts";
import { dangerGate } from "../../src/kernel/danger.ts";
import { effectiveClass } from "../../src/tool-class.ts";
import { evaluate, factsOf } from "../../src/permissions/rules.ts";
import type { PermissionRule } from "../../src/permissions/rules.ts";
import { call, state } from "../kernel/helpers.ts";
import { startGateway } from "../../src/gateway/index.ts";
import { auth, fakeRuntime, http, tmpStatic } from "../gateway/helpers.ts";

interface Opened {
  spec: TermSpawnSpec;
  written: string[];
  resized: { cols: number; rows: number }[];
  killed: boolean;
  emit(chunk: string): void;
  exit(code: number | null): void;
}

function fakePty() {
  const opened: Opened[] = [];
  const backend: TermBackend = {
    kind: "pty",
    typeable: true,
    async openAsync(spec) {
      let out: (chunk: string) => void = () => {};
      let exit: (code: number | null) => void = () => {};
      const rec: Opened = {
        spec,
        written: [],
        resized: [],
        killed: false,
        emit(chunk) { out(chunk); },
        exit(code) { exit(code); },
      };
      const handle: TermHandle = {
        pid: 7000 + opened.length,
        write(data) { rec.written.push(data); },
        resize(cols, rows) { rec.resized.push({ cols, rows }); },
        onStdout(fn) { out = fn; },
        onStderr() {},
        onError() {},
        onExit(fn) { exit = fn; },
        interrupt() { rec.written.push("\x03"); return { sent: true, note: "sent Ctrl-C" }; },
        kill() { rec.killed = true; },
      };
      opened.push(rec);
      return handle;
    },
  };
  return { backend, opened };
}

const rule = (effect: "allow" | "deny", tool: string, kind: PermissionRule["matcher"]["kind"], value?: string): PermissionRule =>
  ({ id: `r-${effect}-${tool}`, effect, tool, matcher: value === undefined ? { kind } : { kind, value }, scope: "t", createdAt: 1, uses: 0 });

test("a fake PTY opens, resizes, writes, reads stripped text, keeps raw bytes, and reaps when idle", async () => {
  const { backend, opened } = fakePty();
  let now = 1_000;
  const reg = new TerminalRegistry({ backend, now: () => now, idleMs: 30 * 60_000, reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/usr/bin" }) });
  const info = await reg.openSession("chat", "/work", "bash");
  assert.equal(info.backend, "pty");
  assert.equal(info.typeable, true);
  assert.equal(info.pid, 7000);
  assert.deepEqual(opened[0].spec.args, ["--noprofile", "--norc", "-i"]);
  assert.equal(opened[0].spec.env.TERM, "xterm-256color");
  assert.equal(opened[0].spec.cols, 80);
  assert.equal(opened[0].spec.rows, 24);
  assert.throws(() => reg.open("chat", "/work"), /desktop host/);

  reg.send("chat", info.id, "echo hi");
  assert.deepEqual(opened[0].written, ["echo hi\n"]);
  opened[0].emit("\x1b[31mred\x1b[0m\n");
  const peek = reg.peek("chat", info.id);
  assert.equal(peek.text, "red\n");
  assert.equal(peek.screen, "\x1b[31mred\x1b[0m\n");
  assert.equal(peek.screenTotal, peek.screen!.length);
  const read = await reg.read("chat", info.id, { waitMs: 0 });
  assert.equal(read.text, "red\n");
  assert.equal(reg.peek("chat", info.id).text, "red\n", "a read does not erase the pane buffer");

  const before = reg.status("chat", info.id).lastActiveAt;
  reg.peek("chat", info.id);
  assert.equal(reg.userActivity("chat", info.id).length, 0);
  assert.equal(reg.status("chat", info.id).lastActiveAt, before, "a look is not activity");

  assert.deepEqual(reg.input("chat", info.id, ""), { bytes: 0 });
  assert.equal(opened[0].written.length, 1);
  const typed = reg.input("chat", info.id, "secret-keystroke");
  assert.deepEqual(typed, { bytes: 16 });
  assert.deepEqual(opened[0].written.at(-1), "secret-keystroke");
  const activity = reg.userActivity("chat", info.id);
  assert.deepEqual(activity.map((a) => a.bytes), [16]);
  assert.equal(JSON.stringify(activity).includes("secret"), false);
  assert.throws(() => reg.input("chat", info.id, "x".repeat(8001)), /too long/);
  assert.throws(() => reg.input("other", info.id, "x"), /unknown session/);

  now += 5_000;
  const sized = reg.resize("chat", info.id, 120, 40);
  assert.equal(sized.lastActiveAt, now);
  assert.deepEqual(opened[0].resized, [{ cols: 120, rows: 40 }]);
  assert.throws(() => reg.resize("chat", info.id, 1, 40), /cols out of range/);
  assert.throws(() => reg.resize("chat", info.id, 80, 0), /rows out of range/);

  for (let i = 0; i < 40; i++) reg.input("chat", info.id, "ab");
  assert.equal(reg.userActivity("chat", info.id).length, 32);

  const hit = reg.interrupt("chat", info.id);
  assert.equal(hit.sent, true);
  assert.equal(opened[0].written.at(-1), "\x03");

  opened[0].exit(3);
  assert.equal(reg.status("chat", info.id).status, "exited");
  assert.equal(reg.status("chat", info.id).exitCode, 3);
  assert.throws(() => reg.input("chat", info.id, "x"), /has exited/);
  now += 5 * 60_000;
  assert.deepEqual(reg.reap(), [], "an exited session lingers so a late read still sees it");
  now += 1;
  assert.deepEqual(reg.reap(), [info.id]);

  const again = await reg.openSession("chat", "/work");
  now = reg.status("chat", again.id).lastActiveAt + 30 * 60_000;
  reg.input("chat", again.id, "a");
  now = reg.status("chat", again.id).lastActiveAt + 30 * 60_000;
  assert.deepEqual(reg.reap(), []);
  now += 1;
  assert.deepEqual(reg.reap(), [again.id]);
  assert.equal(opened[1].killed, true);
  reg.killAll();
});

test("a pipe session stays read-only and its peek has no raw screen", async () => {
  const { EventEmitter } = await import("node:events");
  const spawn = () => {
    const c: any = new EventEmitter();
    c.pid = 9;
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.stdin = Object.assign(new EventEmitter(), { write() { return true; }, end() {} });
    c.kill = () => true;
    return c;
  };
  const reg = new TerminalRegistry({ spawn, platform: "linux", reapEveryMs: false, env: () => ({ PATH: "/usr/bin" }) });
  const info = reg.open("chat", "/work");
  assert.equal(info.backend, "pipe");
  assert.equal(info.typeable, false);
  assert.deepEqual((shellSpec("bash", "linux") as { args: string[] }).args, ["--noprofile", "--norc"]);
  assert.throws(() => reg.input("chat", info.id, "x"), /pipe, not a PTY/);
  assert.throws(() => reg.resize("chat", info.id, 80, 24), /pipe, not a PTY/);
  const peek = reg.peek("chat", info.id);
  assert.equal("screen" in peek, false);
  reg.killAll();
});

test("pty shells drop the pipe-only flags", () => {
  const bash = shellSpec("bash", "linux", { pty: true }) as { args: string[] };
  assert.deepEqual(bash.args, ["--noprofile", "--norc", "-i"]);
  const pwsh = shellSpec("pwsh", "linux", { pty: true }) as { args: string[] };
  assert.deepEqual(pwsh.args, ["-NoLogo", "-NoProfile"]);
  assert.equal(pwsh.args.includes("-NonInteractive"), false);
  const ps = shellSpec("powershell", "win32", { pty: true }) as { args: string[] };
  assert.equal(ps.args.includes("-NonInteractive"), false);
  assert.equal(ps.args.includes("-Command"), false);
  const cmd = shellSpec("cmd", "win32", { pty: true }) as { args: string[] };
  assert.deepEqual(cmd.args, ["/Q", "/D"]);
});

test("destructive sends are irreversible and need the user's go; a bash deny still applies; a plain send does not", () => {
  const yes = [
    "rm -rf /tmp/x",
    "rm -fr /tmp/x",
    "rm -r -f /tmp/x",
    "rm -Rf /tmp/x",
    "rm --recursive --force /tmp/x",
    "sudo rm -rf /tmp/x",
    "FOO=1 rm -rf /tmp/x",
    "/bin/rm -rf /tmp/x",
    "time rm -rf x",
    "git push --force",
    "git push -f origin",
    "git push --force-with-lease",
    "npm run deploy",
    "flyctl deploy",
    "deploy production",
    "terraform destroy",
    "terraform destroy -auto-approve",
    "echo hi && rm -rf x",
  ];
  const no = [
    "rm file",
    "rm -r file",
    "rm -f file",
    "git push origin main",
    "echo hi",
    "echo \"rm -rf /\"",
    "echo 'rm -rf /'",
    "npm test",
    "terraform apply",
    "echo deploy",
  ];
  for (const text of yes) assert.equal(isIrreversibleShell(text), true, text);
  for (const text of no) assert.equal(isIrreversibleShell(text), false, text);

  const { backend } = fakePty();
  const tool = createTerminalTool(new TerminalRegistry({ backend, reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/bin" }) }));
  assert.equal(effectiveClass(tool, { action: "send" }), "write");
  assert.equal(effectiveClass(tool, { action: "send", text: "echo hi" }), "write");
  assert.equal(effectiveClass(tool, { action: "send", text: "rm -rf /tmp/x" }), "irreversible");
  const blocked = dangerGate.preTool!(state(), call("terminal", { action: "send", session: "t1", text: "rm -rf /tmp/x" }), tool);
  assert.equal(blocked?.action, "needs-confirmation");
  assert.match(blocked?.reason ?? "", /rm -rf/);
  assert.equal(dangerGate.preTool!(state(), call("terminal", { action: "send", session: "t1", text: "echo hi" }), tool), undefined);
  const facts = factsOf("terminal", "irreversible", { action: "send", session: "t1", text: "rm -rf /tmp/x" }, "/proj");
  assert.equal(evaluate([rule("deny", "bash", "prefix", "rm")], facts).effect, "deny");
  assert.equal(evaluate([rule("allow", "bash", "prefix", "rm")], facts).effect, "none");
});

test("loopback checks and a refused announce", async () => {
  assert.equal(isLoopbackPeer("127.0.0.1"), true);
  assert.equal(isLoopbackPeer("::1"), true);
  assert.equal(isLoopbackPeer("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackPeer("8.8.8.8"), false);
  assert.equal(isLoopbackPeer(undefined), false);
  const { backend } = fakePty();
  const reg = new TerminalRegistry({ backend, reapEveryMs: false });
  assert.deepEqual(await announcePty({ hosted: true, remoteAddress: "127.0.0.1", port: 1, token: "t", registry: reg }), { status: 404, body: { error: "not found" } });
  const denied = await announcePty({ hosted: false, remoteAddress: "10.0.0.8", port: 9, token: "t", registry: reg });
  assert.equal(denied.status, 403);
  const bad = await announcePty({ hosted: false, remoteAddress: "127.0.0.1", port: "nope", token: "t", registry: reg });
  assert.equal(bad.status, 400);
  assert.equal(reg.backendKind(), "pty", "the registry in this test was constructed as a pty; announce did not have to swap it");
});

interface Hosted {
  port: number;
  writes(id: string): string[];
  push(id: string, data: string): void;
  close(): Promise<void>;
}

function startFakeHost(token: string, health: Record<string, unknown> = { ok: true, backend: "pty" }): Promise<Hosted> {
  const sessions = new Map<string, { written: string[]; clients: ServerResponse[]; buffer: string }>();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized " + token);
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }
    if (url.pathname === "/sessions" && req.method === "POST") {
      const body = JSON.parse(await readReq(req)) as { id: string };
      sessions.set(body.id, { written: [], clients: [], buffer: "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pid: 4242 }));
      return;
    }
    const one = /^\/sessions\/(t\d+)\/(write|resize|stream|kill)$/.exec(url.pathname);
    if (!one) { res.writeHead(404); res.end("no"); return; }
    const session = sessions.get(one[1]);
    if (!session) { res.writeHead(404); res.end("no session"); return; }
    if (one[2] === "stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      session.clients.push(res);
      if (session.buffer) res.write(`event: data\ndata: ${JSON.stringify({ data: session.buffer })}\n\n`);
      res.on("close", () => { session.clients = session.clients.filter((c) => c !== res); });
      return;
    }
    const raw = one[2] === "kill" ? "{}" : await readReq(req);
    const body = JSON.parse(raw || "{}") as { data?: string; cols?: number; rows?: number };
    if (one[2] === "write" && typeof body.data === "string") {
      session.written.push(body.data);
      const frame = `event: data\ndata: ${JSON.stringify({ data: body.data })}\n\n`;
      session.buffer += body.data;
      for (const client of session.clients) client.write(frame);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        writes(id) { return sessions.get(id)?.written ?? []; },
        push(id, data) {
          const session = sessions.get(id);
          if (!session) return;
          session.buffer += data;
          const frame = `event: data\ndata: ${JSON.stringify({ data })}\n\n`;
          for (const client of session.clients) client.write(frame);
        },
        close() {
        for (const session of sessions.values()) {
          for (const client of session.clients) { try { client.end(); } catch { /* already gone */ } }
        }
        return new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections?.();
        });
      },
      });
    });
  });
}

function readReq(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

test("the gateway PTY client talks only to an authenticated loopback host", async () => {
  const token = randomBytes(32).toString("hex");
  const host = await startFakeHost(token);
  const reg = new TerminalRegistry({ reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/usr/bin" }) });
  try {
    const wrong = await announcePty({ hosted: false, remoteAddress: "127.0.0.1", port: host.port, token: "not-the-token", registry: reg });
    assert.equal(wrong.status, 502);
    assert.equal(JSON.stringify(wrong.body).includes(token), false, "the token is not echoed in the error");
    assert.equal(reg.backendKind(), "pipe");
    const ok = await announcePty({ hosted: false, remoteAddress: "::ffff:127.0.0.1", port: host.port, token, registry: reg });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, backend: "pty", typeable: true });
    assert.equal(reg.backendKind(), "pty");
    const info = await reg.openSession("chat", "/work");
    reg.send("chat", info.id, "echo hi");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && host.writes(info.id).join("") === "") await new Promise((r) => setTimeout(r, 20));
    assert.match(host.writes(info.id).join(""), /echo hi\n/);
    reg.send("chat", info.id, "one");
    reg.send("chat", info.id, "two");
    const untilOrder = Date.now() + 2000;
    let ordered = "";
    while (Date.now() < untilOrder) {
      ordered = host.writes(info.id).join("");
      if (ordered.includes("one\n") && ordered.includes("two\n")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(ordered, /echo hi\none\ntwo\n/);
    host.push(info.id, "\x1b[32mhi\x1b[0m\n");
    let screen = "";
    const untilScreen = Date.now() + 1500;
    while (Date.now() < untilScreen) {
      screen = reg.peek("chat", info.id).screen ?? "";
      if (screen.includes("\x1b[32m")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.match(screen, /\x1b\[32m/);
    const seen = await reg.read("chat", info.id, { waitMs: 0 });
    assert.match(seen.text, /hi/);
    assert.equal(seen.text.includes("\x1b"), false);
    reg.killAll();
  } finally { await host.close(); }
});

test("a health check that is not a pty is refused and the message is redacted", async () => {
  const token = randomBytes(32).toString("hex");
  const host = await startFakeHost(token, { ok: true, backend: "pipe" });
  const reg = new TerminalRegistry({ reapEveryMs: false });
  try {
    await assert.rejects(attachPtyBackend({ port: host.port, token, registry: reg }), /not a pty/);
    assert.equal(reg.backendKind(), "pipe");
    await assert.rejects(attachPtyBackend({ port: 0, token, registry: reg }), /bad pty port/);
  } finally { await host.close(); }
});

function pipeSpawn() {
  const c: any = new EventEmitter();
  c.pid = 42;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.stdin = Object.assign(new EventEmitter(), { write() { return true; }, end() {} });
  c.kill = () => true;
  return c;
}

function fakeRes() {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; body: string; headersSent: boolean; writableEnded: boolean; destroyed: boolean; writable: boolean; writeHead: (status: number) => void; write: (chunk: string) => boolean; end: (chunk?: string) => void };
  res.statusCode = 0;
  res.body = "";
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.writable = true;
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.write = (chunk: string) => { res.body += chunk; return true; };
  res.end = (chunk?: string) => { if (chunk) res.body += chunk; res.writableEnded = true; };
  return res;
}

function ctxFor(reg: TerminalRegistry, over: Partial<TerminalCtx> = {}): TerminalCtx {
  return {
    hosted: false,
    viewer: false,
    access: () => "ok",
    registry: reg,
    sendJson(res, status, body) {
      const out = res as unknown as { statusCode: number; body: string };
      out.statusCode = status;
      out.body = JSON.stringify(body);
    },
    async readJson() { return {}; },
    ...over,
  };
}

test("guests are forbidden and the hosted deployment never serves terminal input, even to the owner", async () => {
  const { backend, opened } = fakePty();
  const reg = new TerminalRegistry({ backend, reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/bin" }) });
  const info = await reg.openSession("chat", "/work");
  const path = `/sessions/chat/terminals/${info.id}/input`;
  const guest = fakeRes();
  await terminalsApi({} as IncomingMessage, guest as unknown as ServerResponse, path, new URLSearchParams(), "POST", ctxFor(reg, { viewer: true, hosted: true, async readJson() { return { data: "x" }; } }));
  assert.equal(guest.statusCode, 403);
  assert.equal(opened[0].written.length, 0);
  const hosted = fakeRes();
  await terminalsApi({} as IncomingMessage, hosted as unknown as ServerResponse, path, new URLSearchParams(), "POST", ctxFor(reg, { hosted: true, async readJson() { return { data: "x" }; } }));
  assert.equal(hosted.statusCode, 404);
  assert.equal(opened[0].written.length, 0);
  const resize = fakeRes();
  await terminalsApi({} as IncomingMessage, resize as unknown as ServerResponse, `/sessions/chat/terminals/${info.id}/resize`, new URLSearchParams(), "POST", ctxFor(reg, { viewer: true }));
  assert.equal(resize.statusCode, 403);
  reg.killAll();
});

test("the pane stream sends raw PTY bytes and a pipe snapshot stays stripped", async () => {
  const { backend, opened } = fakePty();
  const reg = new TerminalRegistry({ backend, reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/bin" }) });
  const info = await reg.openSession("chat", "/work");
  opened[0].emit("\x1b[31mred\x1b[0m\n");
  const res = fakeRes();
  const hit = await terminalsApi({} as IncomingMessage, res as unknown as ServerResponse, `/sessions/chat/terminals/${info.id}/stream`, new URLSearchParams(), "GET", ctxFor(reg, { heartbeatMs: 60_000 }));
  assert.equal(hit, true);
  assert.match(res.body, /event: snapshot/);
  assert.match(res.body, /\\u001b\[31mred/);
  res.emit("close");
  const pipe = new TerminalRegistry({
    spawn: () => {
      const c: any = new EventEmitter();
      c.pid = 3; c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin = Object.assign(new EventEmitter(), { write() { return true; }, end() {} });
      c.kill = () => true;
      queueMicrotask(() => c.stdout.emit("data", Buffer.from("\x1b[31mred\x1b[0m\n")));
      return c;
    },
    platform: "linux", reapEveryMs: false, env: () => ({ PATH: "/bin" }),
  });
  const pinfo = pipe.open("chat", "/work");
  await new Promise((r) => setTimeout(r, 20));
  const pres = fakeRes();
  await terminalsApi({} as IncomingMessage, pres as unknown as ServerResponse, `/sessions/chat/terminals/${pinfo.id}/stream`, new URLSearchParams(), "GET", ctxFor(pipe, { heartbeatMs: 60_000 }));
  assert.match(pres.body, /"text":"red\\n"/);
  assert.equal(pres.body.includes("screen"), false);
  pres.emit("close");
  reg.killAll();
  pipe.killAll();
});

test("GET /devices reports the live backend, and the routes keep pipe sessions read-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-pty-gw-"));
  const token = randomBytes(32).toString("hex");
  const tokenPath = join(home, "gateway-token");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const reg = new TerminalRegistry({ spawn: pipeSpawn, reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/usr/bin" }) });
  const support = deviceSupport("linux", () => false);
  assert.equal(support.terminal.pty, false);
  assert.match(support.terminal.note, /no PTY/);
  const over = withTerminalBackend(support, reg);
  assert.equal(over.terminal.pty, false);
  assert.equal(over.terminal.backend, "pipe");
  assert.equal(over.terminal.typeable, false);
  assert.match(over.terminal.reason, /read-only/);
  assert.match(over.terminal.note, /no PTY/);

  const gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath, terminals: reg });
  const host = await startFakeHost(token);
  try {
    assert.equal(gw.token, token);
    const headers = auth(gw.token);
    const listed = await http(gw.url, "GET", "/devices", { headers });
    assert.equal(listed.status, 200);
    const body = JSON.parse(listed.body);
    assert.equal(body.terminal.pty, false);
    assert.equal(body.terminal.backend, "pipe");
    assert.equal(body.terminal.typeable, false);
    assert.match(body.terminal.note, /no PTY/);
    assert.equal(body.browser.available, false);
    const open = await http(gw.url, "POST", "/sessions", { headers, body: { surface: "web" } });
    const id = JSON.parse(open.body).sessionId as string;
    const info = reg.open(id, "/work", "bash");
    assert.equal((await http(gw.url, "POST", `/sessions/${id}/terminals/${info.id}`, { headers, body: { data: "rm -rf /" } })).status, 405);
    const input = await http(gw.url, "POST", `/sessions/${id}/terminals/${info.id}/input`, { headers, body: { data: "ls\n" } });
    assert.equal(input.status, 409);
    assert.match(input.body, /pipe, not a PTY/);
    const sized = await http(gw.url, "POST", `/sessions/${id}/terminals/${info.id}/resize`, { headers, body: { cols: 100, rows: 30 } });
    assert.equal(sized.status, 409);
    const announced = await http(gw.url, "POST", "/devices/pty", { headers, body: { port: host.port } });
    assert.equal(announced.status, 200, announced.body);
    const after = JSON.parse((await http(gw.url, "GET", "/devices", { headers })).body);
    assert.equal(after.terminal.backend, "pty");
    assert.equal(after.terminal.typeable, true);
    assert.equal(after.terminal.pty, true);
    assert.match(after.terminal.reason, /typeable/);
    const pty = await reg.openSession(id, "/work");
    const typed = await http(gw.url, "POST", `/sessions/${id}/terminals/${pty.id}/input`, { headers, body: { data: "uname\n" } });
    assert.equal(typed.status, 200, typed.body);
    assert.equal(JSON.parse(typed.body).bytes, 6);
    const activity = reg.userActivity(id, pty.id);
    assert.deepEqual(activity.map((a) => a.bytes), [6]);
    assert.equal(JSON.stringify(activity).includes("uname"), false);
    const resized = await http(gw.url, "POST", `/sessions/${id}/terminals/${pty.id}/resize`, { headers, body: { cols: 100, rows: 30 } });
    assert.equal(resized.status, 200, resized.body);
    reg.killAll();
  } finally {
    await gw.close();
    await host.close();
  }
});

test("the smoke port is attached before ready, a bad port stays pipes, and hosted never attaches", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-pty-smoke-"));
  const token = randomBytes(32).toString("hex");
  const tokenPath = join(home, "tok");
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  const host = await startFakeHost(token);
  const reg = new TerminalRegistry({ reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/bin" }) });
  const prev = process.env.DAEBOT_PTY_PORT;
  const restorePort = () => { if (prev === undefined) delete process.env.DAEBOT_PTY_PORT; else process.env.DAEBOT_PTY_PORT = prev; };
  process.env.DAEBOT_PTY_PORT = String(host.port);
  let gw: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    gw = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath, terminals: reg });
    assert.equal(reg.backendKind(), "pty");
    assert.equal(reg.typeable(), true);
  } finally { restorePort(); await gw?.close(); await host.close(); }

  const stale = new TerminalRegistry({ reapEveryMs: false });
  process.env.DAEBOT_PTY_PORT = "1";
  let plain: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    plain = await startGateway({ runtime: fakeRuntime(), port: 0, staticDir: tmpStatic().dir, tokenPath: join(home, "tok2"), terminals: stale });
    assert.equal(stale.backendKind(), "pipe");
  } finally { delete process.env.DAEBOT_PTY_PORT; await plain?.close(); }

  const hostedReg = new TerminalRegistry({ spawn: pipeSpawn, reapEveryMs: false, platform: "linux", env: () => ({ PATH: "/bin" }) });
  const st = tmpStatic();
  writeFileSync(join(st.dir, "login.html"), "<!doctype html><title>login</title>");
  const hostedToken = randomBytes(18).toString("hex");
  process.env.DAEBOT_PTY_PORT = "9";
  let hosted: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    hosted = await startGateway({
      runtime: fakeRuntime(), port: 0, host: "127.0.0.1", staticDir: st.dir, terminals: hostedReg,
      hosted: { token: hostedToken, allowedHosts: ["daebot.live", "localhost"] },
    });
    if (!hosted) throw new Error("hosted gateway did not start");
    assert.equal(hostedReg.backendKind(), "pipe");
    const H = { host: "daebot.live", "x-forwarded-proto": "https" };
    assert.equal((await http(hosted.url, "POST", "/devices/pty", { headers: H, body: { port: 9 } })).status, 401);
    const lr = await http(hosted.url, "POST", "/login", { headers: H, body: { token: hostedToken } });
    const cookie = String(([] as string[]).concat(lr.headers["set-cookie"] as string[])[0]).split(";")[0];
    const authed = { ...H, cookie };
    assert.equal((await http(hosted.url, "POST", "/devices/pty", { headers: authed, body: { port: 9 } })).status, 404);
    assert.equal((await http(hosted.url, "GET", "/devices", { headers: authed })).status, 404);
    const open = await http(hosted.url, "POST", "/sessions", { headers: authed, body: { surface: "web" } });
    const id = JSON.parse(open.body).sessionId as string;
    const info = hostedReg.open(id, "/work", "bash");
    assert.equal((await http(hosted.url, "POST", `/sessions/${id}/terminals/${info.id}/input`, { headers: authed, body: { data: "x" } })).status, 404);
  } finally { delete process.env.DAEBOT_PTY_PORT; await hosted?.close(); }
});

test("withTerminalBackend flips only the live registry", () => {
  const support = deviceSupport("darwin", (name) => name === "bash" || name === "simctl");
  const pipe = withTerminalBackend(support, { backendKind: () => "pipe", typeable: () => false });
  assert.equal(pipe.terminal.pty, false);
  assert.equal(pipe.ios_simulator.available, true);
  const pty = withTerminalBackend(support, { backendKind: () => "pty", typeable: () => true });
  assert.equal(pty.terminal.pty, true);
  assert.equal(pty.terminal.typeable, true);
  assert.equal(pty.terminal.backend, "pty");
  assert.equal(support.terminal.pty, false, "deviceSupport() itself stays pipes");
});


