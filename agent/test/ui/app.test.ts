import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Violation } from "../../src/types.ts";
import { TuiApp } from "../../src/ui/app.ts";
import type { InStream, OutStream } from "../../src/ui/app.ts";
import { createGatewayClient, createLocalClient } from "../../src/ui/client.ts";
import type { SessionClient, SessionInfo } from "../../src/ui/client.ts";
import { createDemoRuntime } from "../../src/ui/demo.ts";
import { stripAnsi } from "../../src/ui/ansi.ts";

// ---------- fakes ----------
class FakeIn extends EventEmitter {
  isTTY: boolean;
  raw = false;
  constructor(isTTY: boolean) { super(); this.isTTY = isTTY; }
  setRawMode(v: boolean) { this.raw = v; }
  setEncoding() {}
  resume() {}
  pause() {}
  feed(s: string) { this.emit("data", s); }
  end() { this.emit("end"); }
}
class FakeOut extends EventEmitter {
  isTTY: boolean; columns = 80; rows = 24; buf = "";
  constructor(isTTY: boolean) { super(); this.isTTY = isTTY; }
  write(s: string) { this.buf += s; return true; }
  get text() { return stripAnsi(this.buf); }
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition"); await tick(10); } }

interface FakeClientOpts { script?: (text: string, signal?: AbortSignal) => AsyncIterable<AgentEvent>; violations?: Violation[]; sessions?: SessionInfo[] }
function fakeClient(o: FakeClientOpts = {}): SessionClient & { sent: string[]; closed: string[]; aborted: string[]; opened: { title?: string; resumeId?: string }[] } {
  const sent: string[] = [], closed: string[] = [], aborted: string[] = [], opened: { title?: string; resumeId?: string }[] = [];
  let n = 0;
  return {
    mode: "local", label: "local", connected: () => true, sent, closed, aborted, opened,
    async info() { return { model: "test/model", kernel: "shadow" }; },
    async open(a) { opened.push(a); return a.resumeId ?? `sess-${++n}-aaaaaaaa`; },
    send(_id, text, signal) {
      sent.push(text);
      return o.script ? o.script(text, signal) : (async function* () { yield { type: "text", delta: `echo: ${text}\n` } as AgentEvent; yield { type: "done", finalText: `echo: ${text}` } as AgentEvent; })();
    },
    async abort(id) { aborted.push(id); },
    async list() { return o.sessions ?? [{ id: "sess-1-aaaaaaaa", surface: "tui", title: "Terminal session", updatedAt: Date.now() - 5000 }]; },
    async violations() { return o.violations ?? []; },
    async close(id) { closed.push(id); },
  };
}

// ---------- non-TTY fallback ----------
test("non-TTY: plain line mode, no ANSI escapes, pipes work, exits 0 at EOF", async () => {
  const stdin = new FakeIn(false), stdout = new FakeOut(false);
  const client = fakeClient();
  const app = new TuiApp({ client, stdin: stdin as unknown as InStream, stdout: stdout as unknown as OutStream, env: {} });
  assert.equal(app.interactive, false);
  const done = app.run();
  await tick();
  stdin.feed("hello world\n/cost\n");
  stdin.feed("second");   // no trailing newline: delivered at EOF
  stdin.end();
  assert.equal(await done, 0);
  assert.doesNotMatch(stdout.buf, /\x1b/);
  assert.match(stdout.buf, /\* echo: hello world/);
  assert.match(stdout.buf, /cost this session: \$0\.00/);
  assert.match(stdout.buf, /echo: second/);
  assert.deepEqual(client.sent, ["hello world", "second"]);
  assert.equal(client.closed.length, 1, "session closed on exit");
  assert.equal(stdin.raw, false, "never touched raw mode");
});

test("non-TTY: renders tool, gate, confirm and notice rows as ascii text", async () => {
  const script = async function* (): AsyncGenerator<AgentEvent> {
    yield { type: "notice", level: "info", text: "pending MIND reply: use Q3" };
    yield { type: "toolStart", receiptId: "c1", tool: "mind_query", args: { query: "bob" } };
    yield { type: "toolEnd", receiptId: "c1", tool: "mind_query", ok: true, preview: "Bob Lee" };
    yield { type: "gate", verdict: { gate: "danger", action: "needs-confirmation", reason: "needs go-ahead" }, enforced: true };
    yield { type: "gate", verdict: { gate: "receipt", action: "block", reason: "no receipt" }, enforced: false };
    yield { type: "confirm", id: "k", tool: "send_email", args: { to: "a@b.c" }, reason: "outward" };
    yield { type: "done", finalText: "waiting" };
  };
  const stdin = new FakeIn(false), stdout = new FakeOut(false);
  const app = new TuiApp({ client: fakeClient({ script }), stdin: stdin as unknown as InStream, stdout: stdout as unknown as OutStream, env: {} });
  const done = app.run(); await tick();
  stdin.feed("email bob\n"); stdin.end();
  await done;
  const t = stdout.buf;
  assert.match(t, /pending MIND reply: use Q3/);
  assert.match(t, /mind_query\(query: "bob"\) ok Bob Lee/);
  assert.match(t, /gate:danger .*ENFORCED/);
  assert.match(t, /gate:receipt .*SHADOW/);
  assert.match(t, /\+- Confirm/);
  assert.match(t, /"send it"/);
  assert.ok(t.indexOf("pending MIND reply") < t.indexOf("mind_query"), "notice renders at the top of the turn");
  assert.doesNotMatch(t, /[^\x00-\x7f]/);
});

test("slash commands in plain mode: /help /sessions /new /resume /model /shadow /violations /expand /clear /quit", async () => {
  const violations: Violation[] = [
    { at: 1, sessionId: "s", gate: "receipt", action: "block", reason: "no receipt", enforced: false },
    { at: 2, sessionId: "s", gate: "danger", action: "needs-confirmation", reason: "confirm", enforced: true },
  ];
  const script = async function* (): AsyncGenerator<AgentEvent> {
    yield { type: "toolStart", receiptId: "c1", tool: "bash", args: { command: "ls" } };
    yield { type: "toolEnd", receiptId: "c1", tool: "bash", ok: true, preview: "a\nb\nc" };
    yield { type: "done", finalText: "" };
  };
  const client = fakeClient({ violations, script });
  const stdin = new FakeIn(false), stdout = new FakeOut(false);
  const app = new TuiApp({ client, stdin: stdin as unknown as InStream, stdout: stdout as unknown as OutStream, env: {} });
  const done = app.run(); await tick();
  stdin.feed(["/help", "/sessions", "run it", "/expand last", "/model", "/shadow", "/violations", "/resume sess-1", "/resume nope", "/new", "/nonsense", "/clear", "/quit", "never reached"].join("\n") + "\n");
  assert.equal(await done, 0);
  const t = stdout.buf;
  assert.match(t, /\/resume <id>/);
  assert.match(t, /\* sess-1-aaaaaaaa +tui +\d+s ago +Terminal session/);
  assert.match(t, /- bash\(command: "ls"\) ok a \(\+2 lines\)/);
  assert.match(t, /bash\(command: "ls"\) ok\n {4}a\n {4}b\n {4}c/);
  assert.match(t, /model: test\/model/);
  assert.match(t, /kernel: shadow/);
  assert.match(t, /1 enforced, 1 shadow-logged/);
  assert.match(t, /SHADOW +receipt \[block\] no receipt/);
  assert.match(t, /ENFORCED danger \[needs-confirmation\] confirm/);
  assert.match(t, /already in that session/);
  assert.match(t, /no session matching nope/);
  assert.match(t, /new session sess-2-/);
  assert.match(t, /unknown command \/nonsense/);
  assert.deepEqual(client.sent, ["run it"], "nothing after /quit is processed");
});

test("session open failure prints the error and exits 1", async () => {
  const client = fakeClient();
  client.open = async () => { throw new Error("cannot reach gateway at http://x"); };
  const stdin = new FakeIn(false), stdout = new FakeOut(false);
  const code = await new TuiApp({ client, stdin: stdin as unknown as InStream, stdout: stdout as unknown as OutStream, env: {} }).run();
  assert.equal(code, 1);
  assert.match(stdout.buf, /cannot reach gateway/);
});

// ---------- interactive (fake TTY) ----------
function tty(client: SessionClient, extra: { env?: Record<string, string>; history?: string | null; now?: () => number } = {}) {
  const stdin = new FakeIn(true), stdout = new FakeOut(true);
  const app = new TuiApp({ client, stdin: stdin as unknown as InStream, stdout: stdout as unknown as OutStream, env: { TERM: "xterm-256color", ...(extra.env ?? {}) }, historyPath: extra.history ?? null, now: extra.now });
  return { app, stdin, stdout, done: app.run() };
}

test("interactive: raw mode on, typing + Enter streams a reply, redraws only the live region, Ctrl+D quits", async () => {
  const { app, stdin, stdout, done } = tty(fakeClient());
  assert.equal(app.interactive, true);
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  assert.equal(stdin.raw, true);
  assert.match(stdout.buf, /\x1b\[\?2004h/, "bracketed paste enabled");
  stdin.feed("hi there");
  await until(() => stdout.text.includes("hi there"));
  stdin.feed("\r");
  await until(() => stdout.text.includes("echo: hi there"));
  assert.match(stdout.text, /kernel shadow/);
  assert.match(stdout.text, /test\/model/);
  assert.match(stdout.buf, /\x1b\[\?2026h/, "synchronized output wraps each frame");
  stdin.feed("\x04");
  assert.equal(await done, 0);
  assert.equal(stdin.raw, false, "raw mode restored");
  assert.match(stdout.buf, /\x1b\[\?2004l/);
});

test("interactive: NO_COLOR emits no SGR colour sequences but still positions the cursor", async () => {
  const { stdin, stdout, done } = tty(fakeClient(), { env: { NO_COLOR: "1" } });
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("x\r");
  await until(() => stdout.text.includes("echo: x"));
  assert.doesNotMatch(stdout.buf, /\x1b\[[0-9;]*m/);
  assert.match(stdout.buf, /\x1b\[\d+G/);
  stdin.feed("\x04"); await done;
});

test("interactive: with colour, rows carry SGR", async () => {
  const { stdin, stdout, done } = tty(fakeClient());
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("x\r");
  await until(() => stdout.text.includes("echo: x"));
  assert.match(stdout.buf, /\x1b\[3[0-9]m/);
  stdin.feed("\x04"); await done;
});

test("interactive: Ctrl+C aborts the running turn; a second Ctrl+C within 2s quits", async () => {
  let t = 10_000;
  const script = async function* (_text: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { type: "text", delta: "streaming part one " };
    await new Promise<void>((res) => signal?.addEventListener("abort", () => res(), { once: true }));
  };
  const client = fakeClient({ script: (text, signal) => script(text, signal) });
  const { stdin, stdout, done } = tty(client, { now: () => t });
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("go\r");
  await until(() => stdout.text.includes("streaming part one"));
  stdin.feed("\x03");
  await until(() => stdout.text.includes("turn aborted"));
  assert.deepEqual(client.aborted, ["sess-1-aaaaaaaa"]);
  t += 1000;
  stdin.feed("\x03");   // second Ctrl+C inside the 2s window
  assert.equal(await done, 0);
  assert.equal(client.closed.length, 1);
});

test("interactive: a lone Ctrl+C when idle does not quit; after 2s it does not count as a double press", async () => {
  let t = 1000;
  const { stdin, stdout, done } = tty(fakeClient(), { now: () => t });
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("\x03");
  await until(() => stdout.text.includes("press ctrl+c again to quit"));
  t += 2500;
  stdin.feed("\x03");   // outside window: starts a new window, still alive
  await tick(60);
  stdin.feed("typed\r");
  await until(() => stdout.text.includes("echo: typed"));
  t += 100;
  stdin.feed("\x03\x03");
  assert.equal(await done, 0);
});

test("interactive: Ctrl+D with text in the buffer does not quit", async () => {
  const { stdin, stdout, done } = tty(fakeClient());
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("ab\x01\x04");   // Ctrl+A, Ctrl+D deletes forward
  await tick(60);
  stdin.feed("\r");
  await until(() => stdout.text.includes("echo: b"));
  stdin.feed("\x04"); await done;
});

test("interactive: Shift+Enter inserts a newline, Enter sends the multi-line message", async () => {
  const client = fakeClient();
  const { stdin, stdout, done } = tty(client);
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("line1\x1b[13;2uline2\r");
  await until(() => client.sent.length === 1);
  assert.deepEqual(client.sent, ["line1\nline2"]);
  stdin.feed("\x04"); await done;
});

test("interactive: messages typed during a turn are queued and sent afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const client = fakeClient({
    script: (text) => (async function* (): AsyncGenerator<AgentEvent> {
      if (text === "first") await gate;
      yield { type: "done", finalText: `done ${text}` };
    })(),
  });
  const { stdin, stdout, done } = tty(client);
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("first\r");
  await until(() => client.sent.length === 1);
  stdin.feed("second\r");
  await until(() => stdout.text.includes("queued (1)"));
  release();
  await until(() => client.sent.length === 2);
  assert.deepEqual(client.sent, ["first", "second"]);
  stdin.feed("\x04"); await done;
});

test("interactive: history persists to the history file and is recalled with Up in the next run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-hist-"));
  const path = join(dir, "history");
  const a = tty(fakeClient(), { history: path });
  await until(() => a.stdout.buf.includes("MINDClaw terminal"));
  a.stdin.feed("remember me\r");
  await until(() => a.stdout.text.includes("echo: remember me"));
  a.stdin.feed("\x04"); await a.done;
  assert.deepEqual(readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)), ["remember me"]);

  writeFileSync(path, JSON.stringify("older") + "\n" + JSON.stringify("multi\nline") + "\n");
  const client = fakeClient();
  const b = tty(client, { history: path });
  await until(() => b.stdout.buf.includes("MINDClaw terminal"));
  b.stdin.feed("\x1b[A");           // Up: newest entry (multi-line)
  b.stdin.feed("\x1b[A");           // Up inside the multi-line buffer: cursor to first row
  b.stdin.feed("\x1b[A");           // Up at row 0: older entry
  await tick(60);
  b.stdin.feed("\r");
  await until(() => client.sent.length === 1);
  assert.deepEqual(client.sent, ["older"]);
  b.stdin.feed("\x04"); await b.done;
});

test("interactive: terminal resize redraws the live region at the new width", async () => {
  const { stdin, stdout, done } = tty(fakeClient());
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  const before = stdout.buf.length;
  stdout.columns = 50;
  stdout.emit("resize");
  await until(() => stdout.buf.length > before);
  const frame = stdout.buf.slice(before);
  assert.match(stripAnsi(frame), /─{10,}/);
  for (const l of stripAnsi(frame).split("\n")) assert.ok([...l].length <= 52, `line too wide for 50 cols: ${l.length}`);
  stdin.feed("\x04"); await done;
});

test("interactive: Tab completes a unique slash command", async () => {
  const client = fakeClient();
  const { stdin, stdout, done } = tty(client);
  await until(() => stdout.buf.includes("MINDClaw terminal"));
  stdin.feed("/viol\t\r");
  await until(() => stdout.text.includes("No violations recorded"));
  stdin.feed("\x04"); await done;
});

// ---------- gateway client against a fake fetch ----------
function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
}

test("gateway client: bearer auth, POST /sessions, SSE send with split chunks, violations, sessions, abort, delete", async () => {
  const calls: { url: string; method: string; auth: string | null; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: h.get("authorization"), body: String(init.body ?? "") });
    const path = new URL(url).pathname;
    if (path === "/health") return Response.json({ ok: true, model: "m/x", kernel: "on", shadow: true });
    if (path === "/sessions" && init.method === "POST") return Response.json({ sessionId: "s-123456789" });
    if (path === "/sessions") return Response.json({ sessions: [{ id: "s-123456789", surface: "tui", title: "t", updatedAt: 1 }] });
    if (path.endsWith("/send")) {
      const ev1 = JSON.stringify({ type: "text", delta: "hel" }), ev2 = JSON.stringify({ type: "done", finalText: "hel" });
      const wire = `: open\n\ndata: ${ev1}\n\ndata: ${ev2}\n\n`;
      const cut = Math.floor(wire.length / 2) + 3;
      return new Response(sseBody([wire.slice(0, 9), wire.slice(9, cut), wire.slice(cut)]), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/violations")) return Response.json({ violations: [{ at: 1, sessionId: "s", gate: "g", action: "block", reason: "r", enforced: true }] });
    if (path.endsWith("/abort")) return Response.json({ aborted: true });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const c = createGatewayClient({ url: "http://127.0.0.1:7777/", token: "tok", fetchImpl });
  assert.deepEqual(await c.info(), { model: "m/x", kernel: "shadow" });
  const id = await c.open({ title: "T", resumeId: "old" });
  assert.equal(id, "s-123456789");
  const evs: AgentEvent[] = [];
  for await (const e of c.send(id, "hi")) evs.push(e);
  assert.deepEqual(evs.map((e) => e.type), ["text", "done"]);
  assert.equal((await c.violations(id)).length, 1);
  assert.equal((await c.list())[0].id, "s-123456789");
  await c.abort(id); await c.close(id);
  assert.ok(calls.every((x) => x.auth === "Bearer tok"));
  assert.ok(calls.every((x) => x.url.startsWith("http://127.0.0.1:7777/") && !x.url.includes("//sessions")));
  const post = calls.find((x) => x.method === "POST" && x.url.endsWith("/sessions"))!;
  assert.deepEqual(JSON.parse(post.body), { surface: "tui", title: "T", resumeId: "old" });
  assert.deepEqual(JSON.parse(calls.find((x) => x.url.endsWith("/send"))!.body), { text: "hi" });
  assert.equal(calls.find((x) => x.method === "DELETE")?.url.endsWith("/sessions/s-123456789"), true);
  assert.equal(c.connected(), true);
});

test("gateway client: 409 busy becomes a warn notice; unreachable gateway marks offline and throws on open", async () => {
  const busy = (async () => Response.json({ error: "session is busy with another turn" }, { status: 409 })) as unknown as typeof fetch;
  const c = createGatewayClient({ url: "http://h", token: "t", fetchImpl: busy });
  const evs: AgentEvent[] = [];
  for await (const e of c.send("s", "x")) evs.push(e);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, "notice");
  assert.match((evs[0] as { text: string }).text, /409 session is busy/);

  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const d = createGatewayClient({ url: "http://h", token: "t", fetchImpl: down });
  await assert.rejects(d.open({}), /cannot reach gateway at http:\/\/h/);
  assert.equal(d.connected(), false);
  assert.deepEqual(await d.info(), {});
});

test("gateway client: aborting mid-stream ends quietly", async () => {
  const ac = new AbortController();
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"text","delta":"a"}\n\n')); init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError"))); },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  const c = createGatewayClient({ url: "http://h", token: "t", fetchImpl });
  const evs: AgentEvent[] = [];
  for await (const e of c.send("s", "x", ac.signal)) { evs.push(e); ac.abort(); }
  assert.deepEqual(evs.map((e) => e.type), ["text"]);
});

test("the full TUI runs over a gateway client (plain mode) against a fake fetch", async () => {
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    if (path === "/health") return Response.json({ ok: true });
    if (path === "/sessions" && init.method === "POST") return Response.json({ sessionId: "gw-session-1" });
    if (path.endsWith("/send")) return new Response(`data: ${JSON.stringify({ type: "text", delta: "from gateway\n" })}\n\ndata: ${JSON.stringify({ type: "done", finalText: "from gateway" })}\n\n`);
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const stdin = new FakeIn(false), stdout = new FakeOut(false);
  const app = new TuiApp({ client: createGatewayClient({ url: "http://g", token: "t", fetchImpl }), stdin: stdin as unknown as InStream, stdout: stdout as unknown as OutStream, env: {} });
  const done = app.run(); await tick();
  stdin.feed("ping\n"); stdin.end();
  assert.equal(await done, 0);
  assert.match(stdout.buf, /gateway http:\/\/g/);
  assert.match(stdout.buf, /\* from gateway/);
});

// ---------- local client + demo runtime ----------
test("local client drives the demo runtime: gate + confirm flow, then approval", async () => {
  const client = createLocalClient(createDemoRuntime({ delayMs: 0 }), {});
  const id = await client.open({ title: "t" });
  const types: string[] = [];
  for await (const e of client.send(id, "email bob")) types.push(e.type);
  assert.ok(types.includes("gate") && types.includes("confirm") && types.at(-1) === "done");
  const v = await client.violations(id);
  assert.equal(v.length, 1);
  const after: string[] = [];
  for await (const e of client.send(id, "send it")) after.push(e.type);
  assert.ok(after.includes("toolEnd"));
  assert.equal((await client.list()).length, 1);
  await client.close(id);
});

test("local client reports kernel mode from env", async () => {
  const rt = createDemoRuntime();
  assert.equal((await createLocalClient(rt, { MINDCLAW_SHADOW: "1" }).info()).kernel, "shadow");
  assert.equal((await createLocalClient(rt, { MINDCLAW_KERNEL: "0" }).info()).kernel, "off");
  assert.equal((await createLocalClient(rt, {}).info()).kernel, "on");
});
